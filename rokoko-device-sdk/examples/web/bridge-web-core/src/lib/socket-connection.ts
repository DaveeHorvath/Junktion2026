// The WebSocket lifecycle shared by every bridge client.
//
// Each bridge protocol (RCSP, RGMP, …) differs only in what it does with the
// frames once they arrive — text command/response envelopes, binary data
// frames, etc. The transport beneath that is identical: open a socket, track a
// (status, error) state, surface raw frames to the owner, and tear down
// cleanly. SocketConnection owns exactly that, and nothing protocol-specific.
//
// It is framework-agnostic (no React) and is composed into a protocol client,
// not subclassed: the client holds a SocketConnection and feeds it a frame
// handler. See rcsp-client.ts / rgmp-client.ts for the two consumers.

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

export interface SocketConnectionHandlers {
  /** Called on every connection-status change, with the current error (if any). */
  onStatus?: (status: ConnectionStatus, error: string | null) => void;
  /**
   * A frame arrived. A text frame is a string; a binary frame is an
   * ArrayBuffer when `binaryType` is "arraybuffer" (the default Blob otherwise).
   */
  onMessage: (data: string | ArrayBuffer) => void;
}

export interface SocketConnectionOptions {
  /** Set to "arraybuffer" to receive binary frames as ArrayBuffers. */
  binaryType?: BinaryType;
  /**
   * Called whenever a connection is torn down or (re)started — from connect()
   * (via its internal disconnect), disconnect(), and a remote close — so the
   * owner can drop per-connection state (e.g. decode layouts). Runs before the
   * status flips to "disconnected".
   */
  onReset?: () => void;
}

export class SocketConnection {
  private socket: WebSocket | null = null;
  private statusValue: ConnectionStatus = "disconnected";
  private errorValue: string | null = null;

  // The (status, error) pair last delivered to onStatus, so we can suppress
  // notifications that don't actually change it. Seeded with the initial state
  // so the no-op "disconnected" that connect()'s internal disconnect() emits
  // is never reported.
  private lastNotifiedStatus: ConnectionStatus = "disconnected";
  private lastNotifiedError: string | null = null;

  constructor(
    private readonly handlers: SocketConnectionHandlers,
    private readonly options: SocketConnectionOptions = {},
  ) {}

  get status(): ConnectionStatus {
    return this.statusValue;
  }

  get error(): string | null {
    return this.errorValue;
  }

  /** True when there is an open socket ready to send on. */
  get isOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  /** Open a connection to `url`, replacing any existing one. */
  connect(url: string): void {
    this.disconnect();
    this.errorValue = null;
    this.setStatus("connecting");

    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch (e) {
      this.fail(e instanceof Error ? e.message : String(e));
      return;
    }
    if (this.options.binaryType) socket.binaryType = this.options.binaryType;
    this.socket = socket;

    socket.onopen = () => this.setStatus("connected");
    socket.onmessage = (ev) => this.handlers.onMessage(ev.data);

    socket.onerror = () => {
      // The browser hides the real reason; surface a generic hint.
      this.fail(`WebSocket error — is the bridge running at ${url}?`);
    };

    socket.onclose = (ev) => {
      if (this.socket === socket) {
        this.socket = null;
        this.options.onReset?.();
        if (!ev.wasClean) {
          this.errorValue = `Connection closed (code ${ev.code}).`;
        }
        this.setStatus("disconnected");
      }
    };
  }

  /** Close the connection, if any. Leaves the last error in place. */
  disconnect(): void {
    const socket = this.socket;
    this.socket = null;
    this.options.onReset?.();
    if (socket) {
      // Drop handlers so the close doesn't flip us into an error state.
      socket.onclose = null;
      socket.onerror = null;
      socket.close();
    }
    this.setStatus("disconnected");
  }

  /** Send a text frame; returns false if there is no open connection. */
  send(data: string): boolean {
    if (!this.isOpen) return false;
    this.socket!.send(data);
    return true;
  }

  private setStatus(status: ConnectionStatus): void {
    this.statusValue = status;
    // Status is a state, not an event: only notify when the (status, error)
    // pair actually changes. Comparing both — not status alone — ensures a new
    // error message that arrives under an unchanged status is still reported.
    if (status === this.lastNotifiedStatus && this.errorValue === this.lastNotifiedError) {
      return;
    }
    this.lastNotifiedStatus = status;
    this.lastNotifiedError = this.errorValue;
    this.handlers.onStatus?.(status, this.errorValue);
  }

  private fail(message: string): void {
    this.errorValue = message;
    this.setStatus("error");
  }
}
