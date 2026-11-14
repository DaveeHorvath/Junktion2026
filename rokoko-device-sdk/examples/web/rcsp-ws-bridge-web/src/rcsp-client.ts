// Framework-agnostic client for the rcsp-bridge WebSocket contract.
//
// The bridge speaks tagged JSON envelopes in both directions:
//   browser -> bridge : { "type": "command", "payload": <rcsp_cmd> }
//   bridge  -> browser: { "type": <name>,    "payload": <json> }
// where <name> is one of the RCSP payload types ("response_ok",
// "response_error", "event") plus the bridge's own "bridge_error" / "unknown".
//
// This module has no React (or other framework) dependency: it owns the RCSP
// protocol and reports everything through two callbacks, delegating the socket
// lifecycle to SocketConnection (@rkk/bridge-web-core). `useRcsp` (rcsp.ts) is a
// thin React adapter over it.
//
// The README's "Wire contract" section documents the envelope above; the RCSP
// specification documents the command/response/event shapes it carries.

import { SocketConnection, type ConnectionStatus } from "@rkk/bridge-web-core";

// Re-exported so existing `./rcsp-client.ts` importers keep their import site.
export type { ConnectionStatus };

export type MessageType =
  "command" | "response_ok" | "response_error" | "event" | "bridge_error" | "unknown";

/** One message crossing the wire, as seen by the client. */
export interface ClientMessage {
  direction: "out" | "in";
  type: MessageType;
  /** TrackId, if the payload carries one — used to pair commands with responses. */
  trackId?: string;
  payload: unknown;
}

export interface RcspClientHandlers {
  /** Called on every connection-status change, with the current error (if any). */
  onStatus?: (status: ConnectionStatus, error: string | null) => void;
  /** Called for each message sent or received. */
  onMessage?: (message: ClientMessage) => void;
}

/** The RCSP command envelope (`rcsp_cmd`). */
interface CommandEnvelope {
  Command: string;
  TrackId: string;
  Version: number;
  Arguments?: unknown;
}

const PROTOCOL_VERSION = 1;

function extractTrackId(payload: unknown): string | undefined {
  if (payload && typeof payload === "object" && "TrackId" in payload) {
    const id = (payload as { TrackId: unknown }).TrackId;
    return typeof id === "string" ? id : undefined;
  }
  return undefined;
}

export class RcspClient {
  private readonly conn: SocketConnection;
  private trackIdCounter = 0;

  constructor(private readonly handlers: RcspClientHandlers = {}) {
    this.conn = new SocketConnection({
      onStatus: (status, error) => this.handlers.onStatus?.(status, error),
      onMessage: (data) => this.handleMessage(data),
    });
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

  /**
   * Send a command; returns the auto-assigned TrackId, or `null` if there is
   * no open connection.
   */
  sendCommand(command: string, args?: unknown): string | null {
    if (!this.conn.isOpen) return null;

    const trackId = String(++this.trackIdCounter);
    const payload: CommandEnvelope = {
      Command: command,
      TrackId: trackId,
      Version: PROTOCOL_VERSION,
    };
    if (args !== undefined) payload.Arguments = args;

    this.conn.send(JSON.stringify({ type: "command", payload }));
    this.emit({ direction: "out", type: "command", trackId, payload });
    return trackId;
  }

  private handleMessage(data: string | ArrayBuffer): void {
    // The RCSP bridge only ever sends text envelopes; anything else is opaque.
    if (typeof data !== "string") {
      this.emit({ direction: "in", type: "unknown", payload: data });
      return;
    }

    let envelope: { type?: string; payload?: unknown };
    try {
      envelope = JSON.parse(data);
    } catch {
      this.emit({ direction: "in", type: "unknown", payload: data });
      return;
    }
    const type = (envelope.type ?? "unknown") as MessageType;
    this.emit({
      direction: "in",
      type,
      trackId: extractTrackId(envelope.payload),
      payload: envelope.payload,
    });
  }

  private emit(message: ClientMessage): void {
    this.handlers.onMessage?.(message);
  }
}
