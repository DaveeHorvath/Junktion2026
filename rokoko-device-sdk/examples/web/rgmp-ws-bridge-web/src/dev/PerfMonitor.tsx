// Dev-only main-thread health instrument.
//
// Diagnoses periodic UI freezes by separating causes that look identical from
// the outside:
//
//   • Allocation CHURN — the heap fills with short-lived garbage, a major GC
//     collects it, the main thread stalls, repeat. The post-GC low-water mark
//     ("floor") stays flat: the live set isn't growing, we're just allocating
//     too fast (the per-frame solver math is the prime suspect at two gloves).
//   • LEAK — something is retained across frames, so the floor climbs every
//     cycle; GC runs more often and takes longer, and the pauses worsen.
//   • NOT THE PAGE — the freeze came from outside this app. Three flavors, all
//     observed in the field (2026-07):
//       – Chrome's occluded-window throttling runs rAF at ~1 Hz while
//         document.visibilityState still reads "visible". Cold-started windows
//         can begin in this state; moving the window to another display forces
//         Chrome to rebuild its frame sink, which clears it for the session.
//       – The bridge/driver stops sending, so the hands freeze while the page
//         renders on happily.
//       – A browser extension leaking listeners. Unlike the other two this one
//         really does stall the main thread, and every number below points at
//         the page. See "The extension trap".
//
// It runs a rAF loop measuring the frame gap (a gap past STALL_MS is a stall),
// samples the JS heap per second to track the floor and its drift, and probes
// WebSocket message arrivals to time the data path. Surfaced in a corner
// overlay plus a console.warn per event. Readings:
//
//   • Stall with a large reclaim and flat drift  → churn.
//   • Stall with a climbing drift               → leak, or an extension.
//   • Stall with ~0 reclaim                     → not GC; see the vis/ws hints
//     on the warn line.
//   • "ws gap" warn with no stall               → upstream (bridge/driver).
//   • The occlusion banner                      → Chrome throttling, not us.
//
// # The extension trap
//
// Rule out extensions before believing a LEAK verdict. A stall caused by one
// produces exactly the numbers an app-side leak would: a multi-second pause, a
// large reclaim, and a floor that ratchets up every cycle.
//
// The reason the readings mislead is that the pause is not JS-heap work. Blink's
// C++ heap runs a pre-finalizer per dead object, and that sweep is O(n) over the
// pile; an extension whose content script reconnects in a tight loop can add
// thousands of ports and listeners per second, and the JS heap figures this
// instrument samples are a side effect of the same GC rather than its cost. So
// the heap looks guilty while nothing in the app allocated any of it.
//
// The tell is in DevTools' Performance monitor, not here: "JS event listeners"
// climbing by thousands per second on an idle page holding a few dozen DOM
// nodes. Nothing in this app creates listeners at that rate. Confirm by toggling
// the extension and checking that the stalls follow it.
//
// The instance seen here was React DevTools (react/react#27025), whose storm
// also hits unrelated idle tabs — so a second, idle window stalling the same way
// is a strong hint it was never this app.
//
// Frame gaps that span a visibilitychange (tab switch, minimize) are not
// stalls and are skipped; they also reset the floor history, since heap
// samples bucketed across a throttled background period make the drift — and
// its LEAK verdict — meaningless until a fresh window accumulates.
//
// Mounted only under import.meta.env.DEV (see SceneView.tsx), so it never
// ships in a production build. Heap figures need performance.memory (Chromium
// only; launch with --enable-precise-memory-info for exact numbers). Where it
// is absent the overlay still reports fps, stall timing, and the ws probe.
//
// The overlay line is hidden by default; "D" toggles it (persisted). The
// instrument itself always runs — stalls hit the console and the heap/ws
// history stays warm, so showing the line mid-session has the full picture.

import { useEffect, useRef } from "react";
import { usePersistedState, useShortcuts } from "@rkk/bridge-web-core";
import { SHORTCUTS } from "../ui/shortcuts.ts";

/** A frame gap longer than this (ms) is treated as a stall worth recording. */
const STALL_MS = 100;
/** Heap floor is bucketed at this resolution (ms). */
const BUCKET_MS = 1000;
/** How many 1 s buckets to retain (~1 min of floor history). */
const MAX_BUCKETS = 60;
/** "now"/"baseline" floors are the min over this many buckets at each end. */
const EDGE_BUCKETS = 5;
/** Need at least this much span before reporting a drift rate (ms). */
const MIN_DRIFT_SPAN_MS = 15_000;
/** Drift past this (MB/min) with stalls present points at a leak, not churn. */
const LEAK_DRIFT_MB_PER_MIN = 5;
/** Overlay text refresh rate — throttled well below frame rate. */
const OVERLAY_INTERVAL_MS = 250;
/** An inter-message gap past this (ms) is an upstream data stall. */
const WS_GAP_MS = 300;
/**
 * Occlusion throttling shows as steady ~1 s frame gaps while "visible". A gap
 * in this range is a throttle tick; THROTTLE_RUN consecutive ones raise the
 * occlusion banner (one real stutter can't, since 60 fps frames reset the run).
 */
const THROTTLE_TICK_MS: [number, number] = [500, 2500];
const THROTTLE_RUN = 3;

const MB = 1024 * 1024;

/** Chromium-only, non-standard. Undefined elsewhere. */
interface MemoryInfo {
  readonly usedJSHeapSize: number;
  readonly totalJSHeapSize: number;
  readonly jsHeapSizeLimit: number;
}
function readMemory(): MemoryInfo | null {
  const mem = (performance as Performance & { memory?: MemoryInfo }).memory;
  return mem ?? null;
}

interface Bucket {
  t: number;
  minUsed: number;
}

// ── WebSocket probe ──────────────────────────────────────────────────────────
//
// Times message arrivals on the bridge socket so a frozen display can be told
// apart from a frozen page: frames stop arriving → the gap shows up here with
// no rAF stall. Installed once per page (module singleton — StrictMode mounts
// the component twice) by patching the constructor; the bridge reconnects by
// creating a new socket, so patching before the first connect covers all of
// them. Sockets pointed at the dev server itself (Vite HMR) are ignored — HMR
// traffic is sparse and every quiet spell would read as a fake gap.

interface WsProbe {
  /** performance.now() of the latest bridge message; 0 before the first. */
  lastMsgAt: number;
  /** Total bridge messages seen (all sockets). */
  msgCount: number;
  /** End time and length of the most recent completed gap > WS_GAP_MS. */
  lastGapAt: number;
  lastGapMs: number;
}

let wsProbe: WsProbe | null = null;

function installWsProbe(): WsProbe {
  if (wsProbe) return wsProbe;
  const probe: WsProbe = { lastMsgAt: 0, msgCount: 0, lastGapAt: 0, lastGapMs: 0 };
  wsProbe = probe;

  const Native = window.WebSocket;
  function Probed(url: string | URL, protocols?: string | string[]): WebSocket {
    const ws = protocols === undefined ? new Native(url) : new Native(url, protocols);
    if (String(url).includes(location.host)) return ws; // Vite HMR — not data
    probe.lastMsgAt = 0; // new connection: don't count downtime as a gap
    ws.addEventListener("message", () => {
      const now = performance.now();
      if (probe.lastMsgAt > 0) {
        const gap = now - probe.lastMsgAt;
        if (gap > WS_GAP_MS) {
          probe.lastGapAt = now;
          probe.lastGapMs = gap;
          console.warn(
            `[perf] ws gap ${gap.toFixed(0)}ms — no bridge frames (upstream stall?) · vis ${document.visibilityState}`,
          );
        }
      }
      probe.lastMsgAt = now;
      probe.msgCount += 1;
    });
    return ws;
  }
  Probed.prototype = Native.prototype;
  Object.assign(Probed, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  window.WebSocket = Probed as unknown as typeof WebSocket;
  return probe;
}

export function PerfMonitor() {
  const overlayRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = usePersistedState<boolean>("rgmp.perfOverlay", false);
  // Mirrored into a ref so the rAF loop (subscribed once) sees toggles without
  // re-running the effect, which would reset the stall tally and heap history.
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  useShortcuts({ [SHORTCUTS.perfOverlay.key]: () => setVisible((v) => !v) });

  useEffect(() => {
    const overlay = overlayRef.current;
    const ws = installWsProbe();
    let raf = 0;
    let running = true;

    const start = performance.now();
    let last = start;
    let prevUsed = readMemory()?.usedJSHeapSize ?? 0;

    // fps and ws rate over the overlay refresh interval.
    let frames = 0;
    let fpsWindowStart = start;
    let fps = 0;
    let wsCountAtWindow = ws.msgCount;
    let wsRate = 0;

    // Heap floor history (per-second minima of usedJSHeapSize).
    const buckets: Bucket[] = [];
    let bucketStart = start;
    let bucketMin = prevUsed;

    // Stall tally and the most recent stall's signature.
    let stalls = 0;
    let lastStallMs = 0;
    let lastReclaimedMB = 0;

    // Occlusion-throttle detection (consecutive ~1 s ticks while visible).
    let throttleRun = 0;
    let throttled = false;

    // Wall time of the last visibilitychange; a frame gap that spans it is a
    // tab switch, not a stall. The heap history resets with it: buckets that
    // straddle a background period poison the drift reading.
    let lastVisFlip = 0;
    const resetHeapHistory = (now: number, used: number) => {
      buckets.length = 0;
      bucketStart = now;
      bucketMin = used;
    };
    const onVisibility = () => {
      lastVisFlip = performance.now();
      resetHeapHistory(lastVisFlip, readMemory()?.usedJSHeapSize ?? 0);
      frames = 0;
      fpsWindowStart = lastVisFlip;
      wsCountAtWindow = ws.msgCount;
    };
    document.addEventListener("visibilitychange", onVisibility);

    let lastOverlayPaint = start;

    const edgeMin = (slice: Bucket[]) => slice.reduce((m, b) => Math.min(m, b.minUsed), Infinity);

    // floorNow, baseline, and drift (MB/min) from the bucket ring; null heap
    // figures when performance.memory is unavailable.
    const computeFloor = (): { floorMB: number; driftMBPerMin: number | null } | null => {
      if (buckets.length === 0) return null;
      const recent = buckets.slice(-EDGE_BUCKETS);
      const floorBytes = edgeMin(recent);
      const oldest = buckets.slice(0, EDGE_BUCKETS);
      const oldestBytes = edgeMin(oldest);
      const spanMs = buckets[buckets.length - 1].t - buckets[0].t;
      const driftMBPerMin =
        spanMs >= MIN_DRIFT_SPAN_MS ? (floorBytes - oldestBytes) / MB / (spanMs / 60_000) : null;
      return { floorMB: floorBytes / MB, driftMBPerMin };
    };

    const paint = (now: number) => {
      if (!overlay || !visibleRef.current) return;
      const floor = computeFloor();
      const mem = readMemory();
      const parts = [`${fps.toFixed(0)}fps`];
      if (ws.msgCount > 0) {
        const sinceMsg = now - ws.lastMsgAt;
        parts.push(
          sinceMsg > WS_GAP_MS
            ? `ws stalled ${(sinceMsg / 1000).toFixed(1)}s`
            : `ws ${wsRate.toFixed(0)}/s`,
        );
      }
      if (mem) {
        parts.push(`used ${(mem.usedJSHeapSize / MB).toFixed(0)}MB`);
        if (floor) {
          parts.push(`floor ${floor.floorMB.toFixed(0)}MB`);
          if (floor.driftMBPerMin !== null) {
            const d = floor.driftMBPerMin;
            parts.push(`drift ${d >= 0 ? "+" : ""}${d.toFixed(1)}MB/min`);
          }
        }
      } else {
        parts.push("heap n/a");
      }
      if (stalls > 0) {
        const sig = mem ? `, −${lastReclaimedMB.toFixed(0)}MB` : "";
        parts.push(`stalls ${stalls} (last ${lastStallMs.toFixed(0)}ms${sig})`);
      }
      // Verdict hint. Occlusion throttling trumps the heap read: the page is
      // fine, Chrome just isn't scheduling frames for this window.
      let verdict = "";
      if (throttled) {
        verdict = "  ⚠ rAF throttled while visible — occluded window? (move/refocus to reset)";
      } else if (stalls > 0 && floor?.driftMBPerMin != null) {
        verdict = floor.driftMBPerMin > LEAK_DRIFT_MB_PER_MIN ? "  ⚠ LEAK?" : "  ~ churn";
      }
      const text = `perf · ${parts.join(" · ")}${verdict}`;
      if (overlay.textContent !== text) overlay.textContent = text;
      lastOverlayPaint = now;
    };

    const tick = () => {
      if (!running) return;
      const now = performance.now();
      const gapStart = last;
      const dt = now - gapStart;
      last = now;
      frames += 1;

      const used = readMemory()?.usedJSHeapSize ?? 0;
      const visible = document.visibilityState === "visible";

      // Occlusion-throttle tracking: steady ~1 s ticks while visible. Any
      // normally-paced frame ends the run.
      if (visible && dt >= THROTTLE_TICK_MS[0] && dt <= THROTTLE_TICK_MS[1]) {
        throttleRun += 1;
        if (!throttled && throttleRun >= THROTTLE_RUN) {
          throttled = true;
          console.warn(
            `[perf] rAF running at ~${(1000 / dt).toFixed(1)}Hz while document is visible — ` +
              `Chrome is occlusion-throttling this window; the page is not stalled. ` +
              `Moving the window to another display (or refocusing it) resets the state.`,
          );
        }
      } else if (dt < STALL_MS) {
        if (throttled) console.warn(`[perf] occlusion throttling ended — back to frame rate`);
        throttleRun = 0;
        throttled = false;
      }

      if (dt > STALL_MS) {
        if (lastVisFlip > gapStart || !visible) {
          // The gap spans a tab switch / hide — not a stall. History was reset
          // by the visibility handler; just resync the GC baseline.
        } else if (throttled) {
          // Throttle ticks are counted by the banner, not the stall tally —
          // one occluded minute would otherwise read as ~60 stalls.
        } else {
          // A real stall. GC during the gap shows up as `used` having dropped
          // below the pre-gap sample — that drop is the reclaim; ~0 means the
          // stall was NOT GC (long task, shader compile, compositor, …).
          stalls += 1;
          lastStallMs = dt;
          lastReclaimedMB = Math.max(0, prevUsed - used) / MB;
          const floor = computeFloor();
          const driftStr =
            floor?.driftMBPerMin != null
              ? `${floor.driftMBPerMin >= 0 ? "+" : ""}${floor.driftMBPerMin.toFixed(1)}MB/min`
              : "n/a";
          // Did the data path gap across the same window? If frames also
          // stopped arriving, suspect upstream; if ws kept flowing, the freeze
          // was ours alone.
          const wsHint =
            ws.msgCount === 0
              ? "no data yet"
              : ws.lastGapAt >= gapStart || now - ws.lastMsgAt > WS_GAP_MS
                ? `ws gapped too (${(ws.lastGapAt >= gapStart ? ws.lastGapMs : now - ws.lastMsgAt).toFixed(0)}ms)`
                : "ws flowed";
          console.warn(
            `[perf] stall ${dt.toFixed(0)}ms · used ${(used / MB).toFixed(0)}MB · ` +
              `reclaimed ${lastReclaimedMB.toFixed(0)}MB · ` +
              `floor ${floor ? floor.floorMB.toFixed(0) + "MB" : "n/a"} · drift ${driftStr} · ` +
              `${wsHint} · vis ${document.visibilityState}`,
          );
        }
      }
      prevUsed = used;

      // Roll the heap-floor bucket once per second.
      bucketMin = Math.min(bucketMin, used);
      if (now - bucketStart >= BUCKET_MS) {
        buckets.push({ t: now, minUsed: bucketMin });
        if (buckets.length > MAX_BUCKETS) buckets.shift();
        bucketStart = now;
        bucketMin = used;
      }

      // fps and ws rate over the overlay window.
      if (now - fpsWindowStart >= OVERLAY_INTERVAL_MS) {
        const spanS = (now - fpsWindowStart) / 1000;
        fps = frames / spanS;
        wsRate = (ws.msgCount - wsCountAtWindow) / spanS;
        frames = 0;
        wsCountAtWindow = ws.msgCount;
        fpsWindowStart = now;
      }

      if (now - lastOverlayPaint >= OVERLAY_INTERVAL_MS) paint(now);

      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => {
      running = false;
      cancelAnimationFrame(raf);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  // Kept mounted while hidden so the ref (captured once by the effect) stays
  // stable; display:none also stops the 4 Hz text writes via the paint guard.
  return (
    <div
      className="perf-overlay"
      ref={overlayRef}
      style={visible ? undefined : { display: "none" }}
    />
  );
}
