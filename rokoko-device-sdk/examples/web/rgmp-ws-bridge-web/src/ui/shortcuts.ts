// The single source of truth for keyboard shortcuts: every binding's key,
// display form, and help text. Registration sites (App.tsx, SceneView.tsx,
// dev/PerfMonitor.tsx) take their keys from here, HelpDialog renders it, and
// shortcuts.test.ts checks the README's shortcut table against it — so a
// rebinding is one edit here and the docs cannot silently drift.
//
// Kept free of JSX, three.js, and `import.meta.env` so the node-environment
// test can import it; the dev-build gate is the `dev` data flag, applied by
// consumers.

/** The section headings the help dialog groups shortcuts under. */
export type ShortcutGroup = "General" | "Layout" | "3D data" | "3D viewport";

export interface ShortcutDef {
  /**
   * Normalized key as `useShortcuts` matches it: single characters lowercased
   * ("v", "1"), named keys as `KeyboardEvent.key` verbatim ("Home").
   */
  key: string;
  /** The key as the help dialog and README show it ("V", "Esc"). */
  display: string;
  description: string;
  group: ShortcutGroup;
  /** Exists only in dev builds; consumers gate on `import.meta.env.DEV`. */
  dev?: true;
  /**
   * Listed in help but not registered through `useShortcuts` — HelpDialog
   * handles it in its own capture-phase listener.
   */
  displayOnly?: true;
}

/** Every shortcut, in help-dialog display order within each group. */
export const SHORTCUTS = {
  help: { key: "?", display: "?", description: "Toggle this help screen", group: "General" },
  closeHelp: {
    key: "Escape",
    display: "Esc",
    description: "Close this help screen",
    group: "General",
    displayOnly: true,
  },
  connect: {
    key: "c",
    display: "C",
    description: "Connect / disconnect to device driver",
    group: "General",
  },
  compare: {
    key: "s",
    display: "S",
    description: "Connect / disconnect to external solver",
    group: "General",
  },
  perfOverlay: {
    key: "d",
    display: "D",
    description: "Toggle perf overlay",
    group: "General",
    dev: true,
  },
  layoutStreams: { key: "1", display: "1", description: "Streams pane only", group: "Layout" },
  layoutBoth: { key: "2", display: "2", description: "Both panes", group: "Layout" },
  layout3d: { key: "3", display: "3", description: "3D pane only", group: "Layout" },
  cycleDisplay: {
    key: "m",
    display: "M",
    description: "Cycle mesh / sensors / angles",
    group: "3D data",
  },
  toggleCoil: {
    key: "p",
    display: "P",
    description: "Show / hide the Coil Pro model (if present)",
    group: "3D data",
  },
  toggleEmf: {
    key: "e",
    display: "E",
    description: "Show / hide EMF residual halos",
    group: "3D data",
  },
  toggleObb: {
    key: "o",
    display: "O",
    description: "Show / hide sensor bounding boxes (OBBs)",
    group: "3D data",
  },
  toggleXr: {
    key: "x",
    display: "X",
    description: "Show / hide OpenXR joints (solver compare)",
    group: "3D data",
  },
  recenter: {
    key: "v",
    display: "V",
    description: "Recenter glove heading (forearms forward)",
    group: "3D data",
  },
  viewHome: {
    key: "Home",
    display: "Home",
    description: 'Default view ("first person")',
    group: "3D viewport",
  },
  reframe: {
    key: "a",
    display: "A",
    description: "Frame the live gloves and Coil Pro in view",
    group: "3D viewport",
  },
  viewTop: { key: "t", display: "T", description: "Top view", group: "3D viewport" },
  viewFront: { key: "f", display: "F", description: "Front view", group: "3D viewport" },
  viewBack: { key: "b", display: "B", description: "Back view", group: "3D viewport" },
  viewLeft: { key: "l", display: "L", description: "Side (left) view", group: "3D viewport" },
  viewRight: { key: "r", display: "R", description: "Side (right) view", group: "3D viewport" },
} as const satisfies Record<string, ShortcutDef>;

const GROUP_ORDER: readonly ShortcutGroup[] = ["General", "Layout", "3D data", "3D viewport"];

/**
 * The registry grouped for display, in registry order. `includeDev` is the
 * caller's `import.meta.env.DEV` (a parameter so this module stays importable
 * outside Vite).
 */
export function shortcutGroups(
  includeDev: boolean,
): { title: ShortcutGroup; items: ShortcutDef[] }[] {
  const all: ShortcutDef[] = Object.values(SHORTCUTS);
  return GROUP_ORDER.map((title) => ({
    title,
    items: all.filter((s) => s.group === title && (includeDev || !s.dev)),
  }));
}
