// RGMP v2 stream-definition parsing and data-frame decoding.
//
// This is a TypeScript port of the decoding scheme in the Python reference
// client (`rgmp_core/layout.py`). A Stream Definition frame is a JSON blob
// describing, per group, an ordered list of streams; a Data frame is a 16-byte
// inner header followed by those streams' values, tightly packed in definition
// order. `StreamLayout` precomputes each stream's byte offset within a group so
// data frames can be decoded cheaply.
//
// All values are little-endian, matching the wire format.

/** The RGMP base data types and their byte sizes. */
export type BaseType = "INT32" | "UINT32" | "INT64" | "UINT64" | "FLOAT" | "DOUBLE";

const BASE_BYTES: Record<BaseType, number> = {
  INT32: 4,
  UINT32: 4,
  INT64: 8,
  UINT64: 8,
  FLOAT: 4,
  DOUBLE: 8,
};

// `INT64`/`UINT64` decode to bigint (they don't fit a JS number safely); every
// other base type decodes to number.
export type StreamValue = number | bigint;

/** Size (16 bytes) of a Data frame's inner header: device, group, timestamp. */
export const DATA_INNER_HEADER_SIZE = 16;

// FLOAT, FLOAT[7], DOUBLE[3,3], etc. Group 1 is the base type, 2/3 the dims.
const DATA_TYPE_RE = /^(INT32|UINT32|INT64|UINT64|FLOAT|DOUBLE)(?:\[(\d+)(?:,\s*(\d+))?\])?$/;

export interface ParsedDataType {
  base: BaseType;
  /** Total element count (rows * cols). */
  count: number;
  /** Total byte size of the packed value(s). */
  byteSize: number;
}

/**
 * Parse an RGMP `data_type` string into its base type, element count, and byte
 * size. `FLOAT` -> 1 element / 4 bytes; `FLOAT[7]` -> 7 / 28; `DOUBLE[3,3]` ->
 * 9 / 72. Throws on an unrecognized type.
 */
export function parseDataType(raw: string): ParsedDataType {
  const m = DATA_TYPE_RE.exec(raw.trim());
  if (!m) throw new Error(`Unknown data_type: ${raw}`);
  const base = m[1] as BaseType;
  const cols = m[2] ? Number(m[2]) : 1;
  const rows = m[3] ? Number(m[3]) : 1;
  const count = rows * cols;
  return { base, count, byteSize: BASE_BYTES[base] * count };
}

function readValue(base: BaseType, view: DataView, offset: number): StreamValue {
  switch (base) {
    case "INT32":
      return view.getInt32(offset, true);
    case "UINT32":
      return view.getUint32(offset, true);
    case "INT64":
      return view.getBigInt64(offset, true);
    case "UINT64":
      return view.getBigUint64(offset, true);
    case "FLOAT":
      return view.getFloat32(offset, true);
    case "DOUBLE":
      return view.getFloat64(offset, true);
  }
}

/**
 * Unpack `count` values of `base` from `view`, starting at `offset`. The
 * allocating form, for readability and tests; decodeGroup unpacks into its
 * reusable decode target instead.
 */
export function unpackValues(
  base: BaseType,
  count: number,
  view: DataView,
  offset: number,
): StreamValue[] {
  const out: StreamValue[] = new Array(count);
  unpackValuesInto(base, count, view, offset, out);
  return out;
}

/** unpackValues into a caller-owned array (must have length >= count). */
function unpackValuesInto(
  base: BaseType,
  count: number,
  view: DataView,
  offset: number,
  out: StreamValue[],
): void {
  const size = BASE_BYTES[base];
  for (let i = 0; i < count; i++) {
    out[i] = readValue(base, view, offset + i * size);
  }
}

// ── Stream definition shapes (a subset of the JSON; see /reference/rgmp) ──

export interface StreamEntry {
  data_type: string;
  measure_type: string;
  target_frame: string;
  reference_frame?: string;
  custom_label?: string;
  bit_mapping?: Record<string, string>;
}

/**
 * A static_data entry: a StreamEntry plus its inline JSON value. Unlike group
 * streams, static entries carry their data in the definition itself — a flat
 * array, object, or scalar matching data_type — rather than in binary frames.
 */
export interface StaticDataEntry extends StreamEntry {
  value?: unknown;
}

export interface GroupEntry {
  name: string;
  expected_rate_hz: number;
  streams: StreamEntry[];
}

export interface StreamDefinition {
  protocol_name?: string;
  protocol_version?: string;
  device_id: number;
  device_type?: string;
  timestamp_epoch?: string;
  device_info?: unknown;
  static_data?: StaticDataEntry[];
  groups: GroupEntry[];
}

// ── Layout (precomputed decode plan) ─────────────────────────────────────────

/** One stream's position and shape within a group's packed payload. */
export interface StreamSlot {
  offset: number;
  base: BaseType;
  count: number;
  byteSize: number;
  entry: StreamEntry;
}

/** A group's decode plan: its slots and the total packed payload size. */
export interface GroupLayout {
  groupId: number;
  name: string;
  expectedRateHz: number;
  slots: StreamSlot[];
  payloadSize: number;
}

/**
 * One decoded stream from a data frame.
 *
 * Decoding is latest-wins and in place: for a given (device, group) the
 * DecodedStream objects and their `values` arrays are reused across frames
 * (see decodeGroup). Read the values, don't retain the arrays across frames —
 * copy anything that must outlive the current one.
 */
export interface DecodedStream {
  measureType: string;
  targetFrame: string;
  referenceFrame?: string;
  /** `custom_label` if present, else the target frame — a display label. */
  label: string;
  dataType: string;
  /** Bit index (decimal string) → flag name, for STATUS_FLAGS streams. */
  bitMapping?: Record<string, string>;
  values: StreamValue[];
}

/** Precomputed decoding plan for a single device's stream definition. */
export class StreamLayout {
  readonly definition: StreamDefinition;
  /** Group layouts indexed by group id (the array index, per the spec). */
  readonly groups: GroupLayout[];
  /**
   * Per-group reusable decode targets: the DecodedStream objects (and their
   * values arrays) that decodeGroup fills in place. Streams arrive at up to
   * ~100 Hz per device; fresh objects per frame were measurable GC churn.
   */
  private readonly decoded: DecodedStream[][];

  constructor(definition: StreamDefinition) {
    this.definition = definition;
    this.groups = (definition.groups ?? []).map((group, groupId) => {
      let offset = 0;
      const slots: StreamSlot[] = (group.streams ?? []).map((entry) => {
        const { base, count, byteSize } = parseDataType(entry.data_type);
        const slot: StreamSlot = { offset, base, count, byteSize, entry };
        offset += byteSize;
        return slot;
      });
      return {
        groupId,
        name: group.name ?? "",
        expectedRateHz: group.expected_rate_hz ?? 0,
        slots,
        payloadSize: offset,
      };
    });
    this.decoded = this.groups.map((group) =>
      group.slots.map((slot) => ({
        measureType: slot.entry.measure_type,
        targetFrame: slot.entry.target_frame,
        referenceFrame: slot.entry.reference_frame,
        label: slot.entry.custom_label ?? slot.entry.target_frame,
        dataType: slot.entry.data_type,
        bitMapping: slot.entry.bit_mapping,
        values: new Array<StreamValue>(slot.count),
      })),
    );
  }

  /**
   * Decode one group's packed values from `view`, where the group's payload
   * begins at `payloadOffset`. Returns `null` if `groupId` is unknown.
   *
   * Latest-wins, in place: the returned array, its DecodedStream objects, and
   * their values arrays are this layout's reusable decode target for the
   * group — the next data frame for the same group overwrites them. Copy
   * anything that must survive the current frame.
   */
  decodeGroup(groupId: number, view: DataView, payloadOffset: number): DecodedStream[] | null {
    const group = this.groups[groupId];
    if (!group) return null;
    const streams = this.decoded[groupId];
    for (let i = 0; i < group.slots.length; i++) {
      const slot = group.slots[i];
      unpackValuesInto(slot.base, slot.count, view, payloadOffset + slot.offset, streams[i].values);
    }
    return streams;
  }
}
