// Framework-agnostic client for the rgmp-ws-bridge WebSocket contract.
//
// RGMP v2 is push-only: the bridge streams a device's data to the browser and
// the browser never sends anything back. The bridge forwards frames in a hybrid
// shape:
//
//   text   { "type": "definition", "payload": <stream definition JSON> }
//   binary <device_id u32><group_id u32><timestamp_us u64><packed values...>
//   text   { "type": "disconnect", "device_id": N }
//   text   { "type": "bridge_error", "payload": { "message": ... } }
//
// This module owns the RGMP decoding: it builds a StreamLayout from each
// definition and uses it to decode the binary data frames, reporting everything
// through callbacks. The socket lifecycle is delegated to SocketConnection
// (@rkk/bridge-web-core). It has no React dependency; `useRgmp` (rgmp.ts) is a
// thin React adapter over it.
//
// The README's "Wire contract" section documents the envelope above; the
// RGMP v2 specification documents what the payloads mean.

import { SocketConnection, type ConnectionStatus } from "@rkk/bridge-web-core";
import {
  StreamLayout,
  DATA_INNER_HEADER_SIZE,
  type DecodedStream,
  type StreamDefinition,
} from "./rgmp-layout.ts";

// Re-exported so existing `./rgmp-client.ts` importers keep their import site.
export type { ConnectionStatus };

/**
 * Fold a status change into the error a UI shows.
 *
 * When the bridge cannot reach the RGMP server it sends one explanatory
 * `bridge_error` and then closes the socket. That close is clean, so it
 * carries no error of its own — and the naive `shown = statusError` would
 * blank the explanation a moment after it appeared, leaving a silent
 * disconnect. A status change therefore only replaces the shown error when it
 * brings one; the exception is "connecting", where a fresh attempt starts
 * with a clean slate.
 */
export function reconcileStatusError(
  shown: string | null,
  status: ConnectionStatus,
  statusError: string | null,
): string | null {
  if (status === "connecting") return statusError;
  return statusError ?? shown;
}

/** A device whose stream definition has arrived, with its decode plan. */
export interface DeviceDefinition {
  deviceId: number;
  definition: StreamDefinition;
  layout: StreamLayout;
}

/** One decoded data frame for a (device, group). */
export interface DataFrame {
  deviceId: number;
  groupId: number;
  /** Capture time in microseconds since the definition's `timestamp_epoch`. */
  timestampUs: bigint;
  /** Decoded streams in definition order; empty if the group has no streams. */
  streams: DecodedStream[];
}

export interface RgmpClientHandlers {
  /** Called on every connection-status change, with the current error (if any). */
  onStatus?: (status: ConnectionStatus, error: string | null) => void;
  /** A device's stream definition arrived (or was replaced). */
  onDefinition?: (device: DeviceDefinition) => void;
  /** A decoded data frame arrived. */
  onData?: (frame: DataFrame) => void;
  /** A device disconnected; its layout is dropped. */
  onDisconnect?: (deviceId: number) => void;
  /** The bridge reported a problem (server unreachable, dropped, malformed). */
  onBridgeError?: (message: string) => void;
}

export class RgmpClient {
  private readonly conn: SocketConnection;

  // Per-device decode plans, keyed by device_id, built from definition frames.
  private layouts = new Map<number, StreamLayout>();

  constructor(private readonly handlers: RgmpClientHandlers = {}) {
    this.conn = new SocketConnection(
      {
        onStatus: (status, error) => this.handlers.onStatus?.(status, error),
        onMessage: (data) => this.handleMessage(data),
      },
      {
        // Data frames arrive as binary; we want them as ArrayBuffers to decode.
        binaryType: "arraybuffer",
        // Drop decode plans whenever the connection turns over.
        onReset: () => this.layouts.clear(),
      },
    );
  }

  get status(): ConnectionStatus {
    return this.conn.status;
  }

  get error(): string | null {
    return this.conn.error;
  }

  /** Open a connection to `url`, replacing any existing one. */
  connect(url: string): void {
    this.conn.connect(url);
  }

  /** Close the connection, if any. Leaves the last error in place. */
  disconnect(): void {
    this.conn.disconnect();
  }

  private handleMessage(data: string | ArrayBuffer): void {
    if (typeof data === "string") {
      this.handleText(data);
    } else if (data instanceof ArrayBuffer) {
      this.handleBinary(data);
    }
    // Anything else (e.g. a Blob, if binaryType wasn't honored) is ignored.
  }

  private handleText(text: string): void {
    let envelope: { type?: string; payload?: unknown; device_id?: unknown };
    try {
      envelope = JSON.parse(text);
    } catch {
      // A non-JSON text frame shouldn't happen; treat as a bridge problem.
      this.handlers.onBridgeError?.(`unparseable text frame: ${text}`);
      return;
    }

    switch (envelope.type) {
      case "definition":
        this.handleDefinition(envelope.payload);
        break;
      case "disconnect": {
        const deviceId = Number(envelope.device_id);
        if (Number.isFinite(deviceId)) {
          this.layouts.delete(deviceId);
          this.handlers.onDisconnect?.(deviceId);
        }
        break;
      }
      case "bridge_error": {
        const message =
          envelope.payload && typeof envelope.payload === "object" && "message" in envelope.payload
            ? String((envelope.payload as { message: unknown }).message)
            : "bridge error";
        this.handlers.onBridgeError?.(message);
        break;
      }
      // Unknown text types are ignored: the bridge owns this vocabulary.
    }
  }

  private handleDefinition(payload: unknown): void {
    if (!payload || typeof payload !== "object") return;
    const definition = payload as StreamDefinition;
    const deviceId = Number(definition.device_id);
    if (!Number.isFinite(deviceId)) return;

    let layout: StreamLayout;
    try {
      layout = new StreamLayout(definition);
    } catch (e) {
      this.handlers.onBridgeError?.(
        `invalid stream definition: ${e instanceof Error ? e.message : String(e)}`,
      );
      return;
    }
    this.layouts.set(deviceId, layout);
    this.handlers.onDefinition?.({ deviceId, definition, layout });
  }

  private handleBinary(buffer: ArrayBuffer): void {
    if (buffer.byteLength < DATA_INNER_HEADER_SIZE) return; // not a data frame
    const view = new DataView(buffer);
    const deviceId = view.getUint32(0, true);
    const groupId = view.getUint32(4, true);
    const timestampUs = view.getBigUint64(8, true);

    const layout = this.layouts.get(deviceId);
    // A data frame for a device we have no definition for can't be decoded;
    // the spec disallows it, so we drop it rather than guess.
    if (!layout) return;

    const streams = layout.decodeGroup(groupId, view, DATA_INNER_HEADER_SIZE);
    if (streams === null) return; // unknown group id
    this.handlers.onData?.({ deviceId, groupId, timestampUs, streams });
  }
}
