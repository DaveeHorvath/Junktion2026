// React binding for RcspClient: mirrors the client's status/error into React
// state and accumulates the message stream into a log array for rendering.
//
// All protocol/transport logic lives in rcsp-client.ts (framework-agnostic).

import { useCallback, useEffect, useRef, useState } from "react";
import { RcspClient, type ClientMessage, type ConnectionStatus } from "./rcsp-client.ts";

export type { ConnectionStatus, MessageType } from "./rcsp-client.ts";

/** A logged message: what the client saw, plus a render id and a receipt time. */
export interface LogEntry extends ClientMessage {
  id: number;
  timestamp: number;
}

export interface UseRcsp {
  status: ConnectionStatus;
  /** Set when status is "error" or after a disconnect with a reason. */
  error: string | null;
  log: LogEntry[];
  connect: (url: string) => void;
  disconnect: () => void;
  clearLog: () => void;
  /** Send a command; returns the auto-assigned TrackId (or null if not connected). */
  sendCommand: (command: string, args?: unknown) => string | null;
}

export function useRcsp(): UseRcsp {
  const [status, setStatus] = useState<ConnectionStatus>("disconnected");
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const entryIdRef = useRef(0);

  // One client per hook instance, created lazily on first render.
  const clientRef = useRef<RcspClient | null>(null);
  if (clientRef.current === null) {
    clientRef.current = new RcspClient({
      onStatus: (nextStatus, nextError) => {
        setStatus(nextStatus);
        setError(nextError);
      },
      onMessage: (message) => {
        setLog((prev) => [
          ...prev,
          { ...message, id: entryIdRef.current++, timestamp: Date.now() },
        ]);
      },
    });
  }
  const client = clientRef.current;

  const connect = useCallback((url: string) => client.connect(url), [client]);
  const disconnect = useCallback(() => client.disconnect(), [client]);
  const sendCommand = useCallback(
    (command: string, args?: unknown) => client.sendCommand(command, args),
    [client],
  );
  const clearLog = useCallback(() => setLog([]), []);

  // Close the socket if the component unmounts.
  useEffect(() => () => client.disconnect(), [client]);

  return { status, error, log, connect, disconnect, clearLog, sendCommand };
}
