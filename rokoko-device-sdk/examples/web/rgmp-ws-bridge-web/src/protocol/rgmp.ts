// React binding for RgmpClient.
//
// RGMP streams data at high rates (60-120 Hz across many streams), so we must
// NOT re-render React on every data frame. Instead the client writes into a
// mutable snapshot held in a ref (cheap, no React), and a throttled timer
// (~15 Hz) publishes that snapshot to React state and recomputes per-group
// rates. Definitions, disconnects, and errors are low-rate and update state
// directly.
//
// All protocol/transport/decoding logic lives in rgmp-client.ts and
// rgmp-layout.ts (framework-agnostic).

import { useCallback, useEffect, useRef, useState } from "react";
import {
  RgmpClient,
  reconcileStatusError,
  type ConnectionStatus,
  type DataFrame,
} from "./rgmp-client.ts";
import type { DecodedStream, StreamDefinition } from "./rgmp-layout.ts";

export type { ConnectionStatus, DataFrame } from "./rgmp-client.ts";
export type { DecodedStream, StreamValue } from "./rgmp-layout.ts";

/** ~15 Hz: re-render cadence for the live data view. */
const RENDER_INTERVAL_MS = 66;

/** A group's latest decoded state, as rendered. */
export interface GroupView {
  groupId: number;
  name: string;
  expectedRateHz: number;
  /** Measured update rate over the last render interval. */
  measuredHz: number;
  timestampUs: bigint;
  /**
   * Aliases the device's live decode target (see decodeGroup): the stream
   * objects and values mutate in place as frames arrive, so this always shows
   * the latest values. Display-only consumers read it as-is; copy to snapshot.
   */
  streams: DecodedStream[];
}

/** A device's latest state, as rendered. */
export interface DeviceView {
  deviceId: number;
  deviceType?: string;
  definition: StreamDefinition;
  groups: GroupView[];
}

/**
 * Read-only view of a group's latest frame, for render-rate consumers.
 *
 * Unlike GroupView this is a live window into the mutable snapshot: the
 * object identity is stable but its fields change as frames arrive. Read it,
 * don't retain the streams array across frames.
 */
export interface LiveGroup {
  readonly groupId: number;
  readonly name: string;
  readonly timestampUs: bigint;
  readonly streams: readonly DecodedStream[];
}

/** Read-only view of a device's live state. See LiveGroup. */
export interface LiveDevice {
  readonly deviceId: number;
  readonly deviceType?: string;
  readonly definition: StreamDefinition;
  readonly groups: ReadonlyMap<number, LiveGroup>;
}

export interface UseRgmp {
  status: ConnectionStatus;
  /** Set on a connection error or the most recent bridge_error. */
  error: string | null;
  devices: DeviceView[];
  /**
   * Latest-wins access to the live snapshot, bypassing the ~15 Hz React
   * publish. For consumers that poll on their own clock (the 3D view reads
   * this once per animation frame); never causes a React re-render.
   */
  live: () => ReadonlyMap<number, LiveDevice>;
  connect: (url: string) => void;
  disconnect: () => void;
}

export interface UseRgmpOptions {
  /**
   * Called with every decoded data frame, at full stream rate.
   *
   * The snapshot above is latest-wins, which is all the views need; a consumer
   * that has to see *every* frame — the solver comparison buffers frames by
   * timestamp (see compare/pose-ring.ts) — taps them here. The frame and its
   * streams are the layout's reusable decode target, so copy anything that must
   * outlive the call. Keep it cheap: it runs on the socket's message handler.
   */
  onFrame?: (frame: DataFrame) => void;
  /**
   * Called whenever the snapshot is dropped — a disconnect, an error, or a new
   * connection replacing the old one. Anything derived from the stream is stale
   * at that point and should be discarded too.
   */
  onReset?: () => void;
}

// Internal mutable snapshot (ref-held; never triggers React on its own).
interface GroupSnapshot {
  groupId: number;
  name: string;
  expectedRateHz: number;
  timestampUs: bigint;
  streams: DecodedStream[];
  /** Total frames seen so far. */
  frameCount: number;
  /**
   * (time, frameCount) samples taken once per render tick, trimmed to a
   * RATE_WINDOW_MS window. The rate is the slope across this window — a sliding
   * average that smooths out the per-tick jitter of counting only a few frames
   * at a time.
   */
  rateSamples: RateSample[];
  measuredHz: number;
}

interface RateSample {
  /** `performance.now()` timestamp in ms. */
  t: number;
  count: number;
}

/** Width of the rate-averaging window, in milliseconds. */
const RATE_WINDOW_MS = 2000;

/**
 * Record a (time, frameCount) sample for `group`, drop samples older than the
 * window, and return the rate as the slope of frameCount over the retained
 * span — a sliding average over (up to) the last RATE_WINDOW_MS. Returns 0
 * until there are at least two samples spanning a non-zero interval. When
 * frames stop arriving, frameCount stops climbing while time advances, so the
 * reported rate decays smoothly to 0 as the window slides past the last frame.
 */
function sampleRate(group: GroupSnapshot, now: number): number {
  const samples = group.rateSamples;
  samples.push({ t: now, count: group.frameCount });
  // Keep the oldest sample at or just before the window edge so the span stays
  // close to RATE_WINDOW_MS; drop anything older.
  const cutoff = now - RATE_WINDOW_MS;
  while (samples.length > 2 && samples[1].t <= cutoff) samples.shift();

  const first = samples[0];
  const last = samples[samples.length - 1];
  const spanS = (last.t - first.t) / 1000;
  return spanS > 0 ? (last.count - first.count) / spanS : 0;
}

interface DeviceSnapshot {
  deviceId: number;
  deviceType?: string;
  definition: StreamDefinition;
  groups: Map<number, GroupSnapshot>;
}

export function useRgmp(options: UseRgmpOptions = {}): UseRgmp {
  const [status, setStatus] = useState<ConnectionStatus>("disconnected");
  const [error, setError] = useState<string | null>(null);
  const [devices, setDevices] = useState<DeviceView[]>([]);

  const snapshotRef = useRef<Map<number, DeviceSnapshot>>(new Map());

  // The client outlives every render, so the callbacks below cannot close over
  // `options` — they read it through a ref that each render refreshes.
  const optionsRef = useRef(options);
  optionsRef.current = options;

  // One client per hook instance, created lazily on first render.
  const clientRef = useRef<RgmpClient | null>(null);
  if (clientRef.current === null) {
    clientRef.current = new RgmpClient({
      onStatus: (nextStatus, nextError) => {
        setStatus(nextStatus);
        setError((prev) => reconcileStatusError(prev, nextStatus, nextError));
        if (nextStatus === "disconnected" || nextStatus === "error") {
          snapshotRef.current.clear();
          optionsRef.current.onReset?.();
        }
      },
      onDefinition: ({ deviceId, definition }) => {
        // Replacing a definition resets that device's groups (new layout).
        snapshotRef.current.set(deviceId, {
          deviceId,
          deviceType: definition.device_type,
          definition,
          groups: new Map(),
        });
      },
      onData: (frame) => {
        // Before the snapshot update, so a tap sees the frame even for a device
        // whose definition we somehow lack.
        optionsRef.current.onFrame?.(frame);
        const device = snapshotRef.current.get(frame.deviceId);
        if (!device) return;
        let group = device.groups.get(frame.groupId);
        if (!group) {
          const layoutGroup = device.definition.groups?.[frame.groupId];
          group = {
            groupId: frame.groupId,
            name: layoutGroup?.name ?? `group ${frame.groupId}`,
            expectedRateHz: layoutGroup?.expected_rate_hz ?? 0,
            timestampUs: frame.timestampUs,
            streams: frame.streams,
            frameCount: 0,
            rateSamples: [],
            measuredHz: 0,
          };
          device.groups.set(frame.groupId, group);
        }
        group.streams = frame.streams;
        group.timestampUs = frame.timestampUs;
        group.frameCount++;
      },
      onDisconnect: (deviceId) => {
        snapshotRef.current.delete(deviceId);
      },
      onBridgeError: (message) => setError(message),
    });
  }
  const client = clientRef.current;

  // Publish the snapshot to React state on a fixed cadence, recomputing each
  // group's measured rate as a sliding average over the last RATE_WINDOW_MS.
  useEffect(() => {
    const id = setInterval(() => {
      const now = performance.now();

      const snapshot = snapshotRef.current;
      if (snapshot.size === 0) {
        // Avoid a re-render when already idle (same reference => no update).
        setDevices((prev) => (prev.length === 0 ? prev : []));
        return;
      }

      const view: DeviceView[] = [];
      for (const device of snapshot.values()) {
        const groups: GroupView[] = [];
        for (const group of device.groups.values()) {
          group.measuredHz = sampleRate(group, now);
          groups.push({
            groupId: group.groupId,
            name: group.name,
            expectedRateHz: group.expectedRateHz,
            measuredHz: group.measuredHz,
            timestampUs: group.timestampUs,
            streams: group.streams,
          });
        }
        groups.sort((a, b) => a.groupId - b.groupId);
        view.push({
          deviceId: device.deviceId,
          deviceType: device.deviceType,
          definition: device.definition,
          groups,
        });
      }
      view.sort((a, b) => a.deviceId - b.deviceId);
      setDevices(view);
    }, RENDER_INTERVAL_MS);

    return () => clearInterval(id);
  }, []);

  const live = useCallback(() => snapshotRef.current, []);

  const connect = useCallback((url: string) => client.connect(url), [client]);
  const disconnect = useCallback(() => {
    client.disconnect();
    snapshotRef.current.clear();
    optionsRef.current.onReset?.();
    setDevices([]);
  }, [client]);

  // Close the socket if the component unmounts.
  useEffect(() => () => client.disconnect(), [client]);

  return { status, error, devices, live, connect, disconnect };
}
