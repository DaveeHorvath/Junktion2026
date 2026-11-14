// useState backed by localStorage, so UI selections survive a reload or the
// dev server's hot reload. Keyed by a string; the value is JSON-serialized.

import { useEffect, useRef, useState } from "react";

/**
 * Like useState, but the value is read from localStorage on first mount and
 * written back whenever it changes. Falls back to `initial` (and silently
 * carries on) if storage is unavailable or the stored value won't parse.
 */
export function usePersistedState<T>(
  key: string,
  initial: T,
): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? initial : (JSON.parse(raw) as T);
    } catch {
      return initial;
    }
  });

  // Keep the latest key in a ref so the write effect doesn't also fire when the
  // key itself changes (it shouldn't, but avoids writing a value under a new
  // key before the read has run).
  const keyRef = useRef(key);
  keyRef.current = key;

  useEffect(() => {
    try {
      localStorage.setItem(keyRef.current, JSON.stringify(value));
    } catch {
      // Storage full or blocked (private mode) — persistence is best-effort.
    }
  }, [value]);

  return [value, setValue];
}
