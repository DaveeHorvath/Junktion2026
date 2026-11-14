// Global keyboard shortcuts as a React hook.
//
// Each call registers one window-level keydown listener for the lifetime of
// the component, so shortcut keys are active exactly while their owner is
// mounted (e.g. the 3D-view keys go away with the scene pane).

import { useEffect, useRef } from "react";

/**
 * Map of normalized key to handler. Single characters are lowercased
 * ("1", "m"); named keys match `KeyboardEvent.key` verbatim ("Home").
 */
export type ShortcutMap = Record<string, () => void>;

export function useShortcuts(shortcuts: ShortcutMap): void {
  // The map is re-read on every keydown so handlers see the latest render's
  // closures without re-subscribing the listener.
  const mapRef = useRef(shortcuts);
  mapRef.current = shortcuts;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Plain keys only — never shadow browser/OS shortcuts.
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      // No auto-repeat: holding a key fires its action once.
      if (e.repeat) return;
      // Don't steal keystrokes from text entry.
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      ) {
        return;
      }

      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      const handler = mapRef.current[key];
      if (handler) {
        e.preventDefault();
        handler();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
