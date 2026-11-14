import { useMemo, useState } from "react";
import { TopBar, usePersistedState } from "@rkk/bridge-web-core";
import { useRcsp, type LogEntry, type MessageType } from "./rcsp.ts";

const DEFAULT_URL = "ws://127.0.0.1:8137";

// Commands with no required arguments — one click each. Everything else goes
// through the custom command form below.
const QUICK_COMMANDS = [
  "Info",
  "ListCommands",
  "ListDevices",
  "ListErrorCodes",
  "ListPublishers",
] as const;

// A ready-made Subscribe payload so events are easy to demonstrate.
const SUBSCRIBE_EVENTS_ARGS = {
  Publishers: [
    { Publisher: "DeviceEvents", Topics: ["Connected", "Disconnected"] },
    { Publisher: "Logs", Topics: ["Error", "Warning", "Info"] },
  ],
};

const TYPE_LABELS: Record<MessageType, string> = {
  command: "CMD",
  response_ok: "OK",
  response_error: "ERR",
  event: "EVENT",
  bridge_error: "BRIDGE",
  unknown: "?",
};

export function App() {
  const rcsp = useRcsp();
  const [url, setUrl] = usePersistedState("rcsp.url", DEFAULT_URL);
  const [commandName, setCommandName] = useState("GetDeviceInfo");
  const [argsText, setArgsText] = useState('{\n  "DeviceId": 1\n}');
  const [argsError, setArgsError] = useState<string | null>(null);
  const [hideEvents, setHideEvents] = useState(false);

  const connected = rcsp.status === "connected";
  const busy = connected || rcsp.status === "connecting";

  const visibleLog = useMemo(
    () => (hideEvents ? rcsp.log.filter((e) => e.type !== "event") : rcsp.log),
    [rcsp.log, hideEvents],
  );

  function sendCustom() {
    let args: unknown = undefined;
    const trimmed = argsText.trim();
    if (trimmed.length > 0) {
      try {
        args = JSON.parse(trimmed);
      } catch (e) {
        setArgsError(e instanceof Error ? e.message : String(e));
        return;
      }
    }
    setArgsError(null);
    rcsp.sendCommand(commandName.trim(), args);
  }

  return (
    <div className="app">
      <TopBar
        title="RCSP Bridge Console"
        url={url}
        onUrlChange={setUrl}
        status={rcsp.status}
        busy={busy}
        onConnect={() => rcsp.connect(url)}
        onDisconnect={rcsp.disconnect}
        error={rcsp.error}
      />

      <div className="body">
        <aside className="controls">
          <section>
            <h2>Quick commands</h2>
            <div className="quick">
              {QUICK_COMMANDS.map((cmd) => (
                <button key={cmd} disabled={!connected} onClick={() => rcsp.sendCommand(cmd)}>
                  {cmd}
                </button>
              ))}
              <button
                disabled={!connected}
                onClick={() => rcsp.sendCommand("Subscribe", SUBSCRIBE_EVENTS_ARGS)}
                title="Subscribe to DeviceEvents + Logs"
              >
                Subscribe (events)
              </button>
            </div>
          </section>

          <section>
            <h2>Custom command</h2>
            <label>
              Command
              <input
                value={commandName}
                onChange={(e) => setCommandName(e.target.value)}
                spellCheck={false}
              />
            </label>
            <label>
              Arguments (JSON, optional)
              <textarea
                value={argsText}
                onChange={(e) => setArgsText(e.target.value)}
                rows={8}
                spellCheck={false}
              />
            </label>
            {argsError && <div className="hint error">{argsError}</div>}
            <button
              className="primary"
              disabled={!connected || commandName.trim() === ""}
              onClick={sendCustom}
            >
              Send
            </button>
          </section>
        </aside>

        <main className="log-pane">
          <div className="log-bar">
            <span>{visibleLog.length} messages</span>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={hideEvents}
                onChange={(e) => setHideEvents(e.target.checked)}
              />
              Hide events
            </label>
            <button onClick={rcsp.clearLog} disabled={rcsp.log.length === 0}>
              Clear
            </button>
          </div>
          <ol className="log">
            {visibleLog.map((entry) => (
              <LogRow key={entry.id} entry={entry} />
            ))}
            {visibleLog.length === 0 && (
              <li className="empty">
                {connected
                  ? "Connected. Send a command to get started."
                  : "Not connected. Enter the bridge URL and hit Connect."}
              </li>
            )}
          </ol>
        </main>
      </div>
    </div>
  );
}

function LogRow({ entry }: { entry: LogEntry }) {
  const time = new Date(entry.timestamp).toLocaleTimeString(undefined, {
    hour12: false,
  });
  const arrow = entry.direction === "out" ? "▸" : "◂";
  return (
    <li className={`row dir-${entry.direction} type-${entry.type}`}>
      <span className="meta">
        <span className="arrow">{arrow}</span>
        <span className={`badge badge-${entry.type}`}>{TYPE_LABELS[entry.type]}</span>
        {entry.trackId && <span className="track">#{entry.trackId}</span>}
        <span className="time">{time}</span>
      </span>
      <pre className="payload">{JSON.stringify(entry.payload, null, 2)}</pre>
    </li>
  );
}
