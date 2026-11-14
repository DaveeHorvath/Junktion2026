# rcsp-ws-bridge-web

A browser console for driving an RCSP server (the Rokoko SDK Driver) through
the **RCSP bridge** — a local WebSocket ↔ TCP bridge. Browsers can't open raw
TCP sockets, so this app talks to the bridge over WebSocket and the bridge
relays to the RCSP server. The bridge is the `rkk-ws-bridge` binary bundled in
the SDK's `bin/` directory; run it alongside this app.

Built with Vite + React + TypeScript. Part of the `web/` pnpm workspace; the
WebSocket lifecycle, the connection bar, and the shared stylesheet come from the
[`@rkk/bridge-web-core`](../bridge-web-core) package.

## Layout

Three files, in the order worth reading them:

- `src/rcsp-client.ts` — framework-agnostic RCSP client (the protocol): the JSON
  envelope, TrackId assignment, and inbound decoding. Composes `SocketConnection`
  from `@rkk/bridge-web-core` for the connection lifecycle. No React dependency.
  **If you are writing your own client, this is the file worth copying** — it has
  no dependency on React or on this app.
- `src/rcsp.ts` — thin React adapter (`useRcsp`) over `RcspClient`: mirrors the
  client's status into React state and accumulates the message stream into a log
  array for rendering.
- `src/App.tsx` — the console UI (uses the shared `ConnectionBar`): quick
  commands, a free-form command form, and the message log.

The same split appears in the RGMP viewer next door — protocol logic with no
framework dependency, then a thin React layer over it.

## Running

```sh
pnpm install
pnpm dev        # http://localhost:5180
```

Start the bundled bridge (the `rkk-ws-bridge` binary in the SDK's `bin/`
directory) alongside this app:

```sh
rkk-ws-bridge --rcsp-only
```

Then open the app, confirm the bridge URL (`ws://127.0.0.1:8137`), and Connect.
The address you enter is remembered across reloads.

Also available:

```sh
pnpm typecheck  # type-check without emitting
pnpm build      # type-check + production bundle
pnpm preview    # serve the built bundle
```

Start with the **Info** or **ListCommands** quick command to see what the driver
exposes, then **Subscribe (events)** to watch device and log events arrive
unprompted. Every message, in both directions, is logged with its type and
TrackId, so a command and its response can be paired up.

## Wire contract

The bridge speaks tagged JSON envelopes in both directions. Browser → bridge:

```json
{ "type": "command", "payload": { "Command": "ListDevices", "TrackId": "1", "Version": 1 } }
```

Bridge → browser: `{ "type": <name>, "payload": <json> }`, where `<name>` is an
RCSP payload type (`response_ok`, `response_error`, `event`) or the bridge's own
`bridge_error`. See the RCSP spec (`/reference/rcsp` on the docs site) for the
protocol itself.
