// Shared building blocks for the bridge web apps: the WebSocket transport, the
// connection bar and segmented control, and a couple of generic React hooks.
// Protocol-specific decoding stays in each app.

export { SocketConnection } from "./lib/socket-connection.ts";
export type {
  ConnectionStatus,
  SocketConnectionHandlers,
  SocketConnectionOptions,
} from "./lib/socket-connection.ts";

export { TopBar } from "./components/TopBar.tsx";
export type { TopBarProps } from "./components/TopBar.tsx";

export { ConnControls } from "./components/ConnControls.tsx";
export type { ConnControlsProps } from "./components/ConnControls.tsx";

export { Segmented } from "./components/Segmented.tsx";
export type { SegmentedOption } from "./components/Segmented.tsx";

export { usePersistedState } from "./lib/use-persisted-state.ts";
export { useShortcuts } from "./lib/use-shortcuts.ts";
export type { ShortcutMap } from "./lib/use-shortcuts.ts";
