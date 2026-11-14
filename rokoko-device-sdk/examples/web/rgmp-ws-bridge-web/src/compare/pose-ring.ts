// Buffering both solver streams and pairing them by timestamp. Pure and
// framework-free, generic over the slot type; `use-compare.ts` owns the rings
// and `pose-delta.ts` measures the paired frames.
//
// # Why the timestamps matter
//
// The sidecar solves every frame and re-emits the source timestamp unchanged,
// so the two streams are the same input twice. But the sidecar adds a hop, so
// its newest frame is normally a frame or two behind the driver's. At ~83 Hz
// that is 12-24 ms of hand motion — several mm at the fingertips, which is
// larger than the solver divergence we are looking for. Overlaying "newest from
// each" would drown a real 0.5 mm bug in latency noise.
//
// So both streams are buffered in timestamp-keyed rings and the comparison runs
// on the newest timestamp present in *both* (`matchNewest`). Identical input,
// identical timestamp; the display lags real time by the sidecar hop, which is
// a few milliseconds and invisible. Anything left over is genuine divergence.

/**
 * Ring capacity, in frames. ~1.5 s at 83 Hz: far more slack than the sidecar
 * hop needs, and small enough that a newest-first scan is trivial.
 */
export const RING_CAPACITY = 128;

/**
 * A fixed-size ring of timestamped slots, written in arrival order.
 *
 * The slots are caller-owned objects created once and refilled in place, so
 * buffering a frame allocates nothing — which matters because both streams push
 * at ~83 Hz per device and the decoded frames they arrive in are themselves
 * reused (see `StreamLayout.decodeGroup`), so they *must* be copied.
 */
export class PoseRing<T> {
  private readonly stamps: bigint[];
  private readonly slots: T[];
  /** Where the next claim lands. */
  private write = 0;
  private filled = 0;

  constructor(capacity: number, makeSlot: () => T) {
    this.stamps = new Array<bigint>(capacity).fill(0n);
    this.slots = Array.from({ length: capacity }, makeSlot);
  }

  get capacity(): number {
    return this.slots.length;
  }

  get size(): number {
    return this.filled;
  }

  /**
   * Stamp and hand back the next slot for the caller to fill. Overwrites the
   * oldest entry once full — dropping stale frames is the right failure for
   * realtime motion data.
   */
  claim(timestampUs: bigint): T {
    const i = this.write;
    this.stamps[i] = timestampUs;
    this.write = (i + 1) % this.slots.length;
    if (this.filled < this.slots.length) this.filled++;
    return this.slots[i];
  }

  /** The slot stamped `timestampUs`, or null if it isn't buffered (any more). */
  get(timestampUs: bigint): T | null {
    const i = this.indexOf(timestampUs);
    return i < 0 ? null : this.slots[i];
  }

  has(timestampUs: bigint): boolean {
    return this.indexOf(timestampUs) >= 0;
  }

  /**
   * The newest buffered entry whose timestamp satisfies `accept`, or null.
   * Newest-first, so the common case — the very latest frame matches — costs
   * one probe.
   */
  newestWhere(accept: (timestampUs: bigint) => boolean): {
    timestampUs: bigint;
    slot: T;
  } | null {
    for (let n = 0; n < this.filled; n++) {
      const i = (this.write - 1 - n + this.slots.length * 2) % this.slots.length;
      if (accept(this.stamps[i])) return { timestampUs: this.stamps[i], slot: this.slots[i] };
    }
    return null;
  }

  /** The newest buffered timestamp, or null when empty. */
  newest(): bigint | null {
    if (this.filled === 0) return null;
    return this.stamps[(this.write - 1 + this.slots.length) % this.slots.length];
  }

  /** Forget everything buffered, keeping the slots for reuse. */
  clear(): void {
    this.filled = 0;
    this.write = 0;
  }

  private indexOf(timestampUs: bigint): number {
    for (let n = 0; n < this.filled; n++) {
      const i = (this.write - 1 - n + this.slots.length * 2) % this.slots.length;
      if (this.stamps[i] === timestampUs) return i;
    }
    return -1;
  }
}

/**
 * The slot stamped exactly `timestampUs`, or failing that the newest one
 * before it, or null when the ring holds nothing that old.
 *
 * This exists for a sibling group riding a matched stream: the sidecar encodes
 * `joints_world` and `joints_openxr` from one solve with one timestamp, but
 * they travel as separate messages, world first. A lookup keyed on the world
 * match therefore races the sibling's arrival — a render tick that lands
 * between the two messages would miss, and an overlay that hides on a miss
 * blinks at stream rate. Falling back one frame (~12 ms at 83 Hz) is invisible;
 * null is reserved for a ring with nothing to show at all.
 */
export function frameAtOrBefore<T>(ring: PoseRing<T>, timestampUs: bigint): T | null {
  return ring.get(timestampUs) ?? ring.newestWhere((ts) => ts < timestampUs)?.slot ?? null;
}

/** A timestamp both streams have a frame for, with both frames. */
export interface MatchedFrame<G, S> {
  timestampUs: bigint;
  glove: G;
  solved: S;
}

/**
 * The newest timestamp buffered by both rings, with both slots — the frame the
 * comparison runs on. Null when the rings have nothing in common yet (the usual
 * case for the first moments after connecting, or if one stream has stalled
 * long enough to fall out of the other's window).
 *
 * Driven from the solved ring because it is the later of the two: every solved
 * frame's timestamp came from a glove frame, so scanning it hits on the first
 * probe at steady state, whereas scanning the glove ring would miss on however
 * many frames the sidecar is behind.
 */
export function matchNewest<G, S>(
  glove: PoseRing<G>,
  solved: PoseRing<S>,
): MatchedFrame<G, S> | null {
  const hit = solved.newestWhere((ts) => glove.has(ts));
  if (hit === null) return null;
  const gloveSlot = glove.get(hit.timestampUs);
  if (gloveSlot === null) return null; // unreachable: has() just said otherwise
  return { timestampUs: hit.timestampUs, glove: gloveSlot, solved: hit.slot };
}
