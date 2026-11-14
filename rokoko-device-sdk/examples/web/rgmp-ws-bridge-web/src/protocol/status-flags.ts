// Decoding and lookup of RGMP STATUS_FLAGS bits.
//
// A STATUS_FLAGS stream's value is a bit field; the stream definition's
// `bit_mapping` names each bit (decimal index → name). Everything here keys
// on those names, never on hard-coded bit positions, so it survives firmware
// moving a flag to a different bit. The solver resolves its flags by name
// too (see flagBitsFor in solver/smartglove.ts), falling back to the
// historical fixed indices when a definition carries no bit_mapping.

import type { DecodedStream, StreamValue } from "./rgmp-layout.ts";

/** One named bit of a STATUS_FLAGS value. */
export interface FlagBit {
  bit: number;
  name: string;
  set: boolean;
}

/** Whether `bit` is set in `value`. UINT64 flag words decode to bigint. */
export function isBitSet(value: StreamValue, bit: number): boolean {
  if (typeof value === "bigint") return ((value >> BigInt(bit)) & 1n) === 1n;
  // Number bitwise ops truncate to 32 bits, which covers every non-bigint
  // flag word (INT32/UINT32); wider words arrive as bigint above.
  return ((value >>> bit) & 1) === 1;
}

/**
 * Expand a flag word into its named bits, in bit order. Bits the mapping
 * doesn't name are omitted — the raw value still carries them.
 */
export function decodeFlagBits(bitMapping: Record<string, string>, value: StreamValue): FlagBit[] {
  return Object.entries(bitMapping)
    .map(([bit, name]) => ({ bit: Number(bit), name }))
    .filter(({ bit }) => Number.isInteger(bit) && bit >= 0)
    .sort((a, b) => a.bit - b.bit)
    .map(({ bit, name }) => ({ bit, name, set: isBitSet(value, bit) }));
}

/** A device-level diagnostic derived from a named status flag. */
export interface Diagnostic {
  /** The flag's name in the bit_mapping. */
  name: string;
  /** Short badge text. */
  label: string;
  /** Tooltip explaining the flag's current state. */
  title: string;
  set: boolean;
}

// The calibration/initialization flags surfaced as status-bar badges (see
// the Smartgloves docs' status-flags table). Both start false on boot and
// flip true once the corresponding estimate converges, so a badge reads as
// init progress: amber = still converging, green = settled.
const DIAGNOSTIC_FLAGS: {
  name: string;
  label: string;
  describe: (set: boolean) => string;
}[] = [
  {
    name: "is_heading_reliable",
    label: "heading",
    describe: (set) =>
      set
        ? "is_heading_reliable — the hub orientation's heading (yaw) has converged"
        : "is_heading_reliable — heading (yaw) still converging; hands may point the wrong way",
  },
  {
    name: "emf_flip_decided",
    label: "emf flip",
    describe: (set) =>
      set
        ? "emf_flip_decided — the EMF initialization ambiguity is resolved"
        : "emf_flip_decided — EMF flip undecided; the world-anchored position may be vertically inverted",
  },
];

/**
 * Scan a device's live streams for the diagnostic flags above, in that order.
 * A flag appears only when some STATUS_FLAGS stream's bit_mapping declares it
 * (Smartgloves I never report `is_heading_reliable`; without a Coil Pro there
 * is no `emf_flip_decided`), so absent hardware produces no badge rather than
 * a permanently-amber one.
 */
export function collectDiagnostics(streams: Iterable<DecodedStream>): Diagnostic[] {
  // First declaration wins should a name ever appear on two streams.
  const found = new Map<string, boolean>();
  for (const stream of streams) {
    if (!stream.bitMapping || stream.values.length < 1) continue;
    for (const [bit, name] of Object.entries(stream.bitMapping)) {
      if (!found.has(name)) found.set(name, isBitSet(stream.values[0], Number(bit)));
    }
  }
  return DIAGNOSTIC_FLAGS.flatMap((flag) => {
    const set = found.get(flag.name);
    if (set === undefined) return [];
    return [{ name: flag.name, label: flag.label, title: flag.describe(set), set }];
  });
}
