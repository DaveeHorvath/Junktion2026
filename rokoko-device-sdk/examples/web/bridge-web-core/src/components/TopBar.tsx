// The top bar every bridge web app shares: a title, the ConnControls cluster
// (URL field, Connect/Disconnect toggle, status pill), and the error banner
// that sits directly beneath it. App-specific controls (a view switch, a help
// button) are passed as `children` and render after the status pill.
//
// Styling lives in styles.css (.top-bar / .conn / .banner); this component
// only owns the markup so both apps stay pixel-identical.

import type { ReactNode } from "react";
import { ConnControls, type ConnControlsProps } from "./ConnControls.tsx";

export interface TopBarProps extends Omit<ConnControlsProps, "inputId"> {
  title: string;
  /** The current error, rendered as a banner below the bar; null hides it. */
  error?: string | null;
  /** Extra controls rendered after the status pill. */
  children?: ReactNode;
}

export function TopBar({ title, error, children, ...conn }: TopBarProps) {
  return (
    <>
      <header className="top-bar">
        <h1>{title}</h1>
        <div className="conn">
          <ConnControls {...conn} />
          {children}
        </div>
      </header>

      {error && <div className="banner error">{error}</div>}
    </>
  );
}
