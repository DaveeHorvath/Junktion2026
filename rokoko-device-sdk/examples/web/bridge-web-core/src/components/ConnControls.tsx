// The connection controls cluster: a URL field and a Connect/Disconnect
// toggle with a colored status dot. TopBar wraps it for the app's top
// bar; secondary connections (like the RGMP viewer's compare row) use it
// directly.
//
// Styling lives in styles.css (.url / .status-dot); the surrounding flex row
// is the caller's.

import type { ConnectionStatus } from "../lib/socket-connection.ts";

export interface ConnControlsProps {
  url: string;
  onUrlChange: (url: string) => void;
  status: ConnectionStatus;
  /** True while connected or connecting: disables the URL field and shows Disconnect. */
  busy: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
  /** Tooltip for the Connect button (e.g. a shortcut hint). */
  connectTitle?: string;
  /** Tooltip for the Disconnect button. */
  disconnectTitle?: string;
  /** Id for the URL input, so a caller's <label htmlFor> can point at it. */
  inputId?: string;
}

export function ConnControls({
  url,
  onUrlChange,
  status,
  busy,
  onConnect,
  onDisconnect,
  connectTitle,
  disconnectTitle,
  inputId,
}: ConnControlsProps) {
  return (
    <>
      <input
        id={inputId}
        className="url"
        value={url}
        onChange={(e) => onUrlChange(e.target.value)}
        disabled={busy}
        spellCheck={false}
      />
      {busy ? (
        <button title={disconnectTitle} onClick={onDisconnect}>
          Disconnect
          <StatusDot status={status} />
        </button>
      ) : (
        <button className="primary" title={connectTitle} onClick={onConnect}>
          Connect
          <StatusDot status={status} />
        </button>
      )}
    </>
  );
}

/** Colored dot inside the toggle button; its tooltip spells out the status. */
function StatusDot({ status }: { status: ConnectionStatus }) {
  return <span className={`status-dot status-${status}`} title={status} />;
}
