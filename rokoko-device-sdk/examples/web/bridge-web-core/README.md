# bridge-web-core

The building blocks shared by the two bridge web apps
([`rcsp-ws-bridge-web`](../rcsp-ws-bridge-web) and
[`rgmp-ws-bridge-web`](../rgmp-ws-bridge-web)): the WebSocket transport, the
top-bar chrome, and a couple of generic React hooks. Protocol-specific decoding
stays in each app — nothing here knows what RCSP or RGMP are.

There is no build step: the package's `exports` point straight at the
TypeScript source (`./src/index.ts` and `./src/styles.css`), and each app's
Vite/tsc compiles it as part of its own build.

## Layout

- `src/lib/socket-connection.ts` — the WebSocket lifecycle every bridge client
  composes: open, (status, error) tracking, raw frames to the owner, clean
  teardown. Framework-agnostic; see `rcsp-client.ts` / `rgmp-client.ts` in the
  apps for the two consumers.
- `src/components/TopBar.tsx` — the top bar both apps share: title, the
  `ConnControls` cluster, and the error banner. App-specific controls render
  as `children`.
- `src/components/ConnControls.tsx` — the URL field + Connect/Disconnect
  toggle + status dot, used inside `TopBar` and standalone (the RGMP viewer's
  compare row).
- `src/components/Segmented.tsx` — a segmented button group of mutually
  exclusive options.
- `src/lib/use-persisted-state.ts` — `useState` backed by `localStorage`, so
  UI selections survive reloads.
- `src/lib/use-shortcuts.ts` — one window-level keydown listener mapping
  normalized keys to handlers; ignores modifier chords, key repeat, and
  focused text fields.
- `src/styles.css` — the shared chrome's styling; apps import it as
  `@rkk/bridge-web-core/styles.css`.
