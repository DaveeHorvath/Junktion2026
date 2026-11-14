// What the 3D pane's Coil button says, and whether it can be pressed. Pure, so
// the rules are testable without rendering a button.
//
// The Coil Pro model is shown as soon as a glove's stream reports a Coil Pro,
// and the user can hide it. With none present there is nothing to show or hide,
// so the button only works while one is present; the rest of the time it is
// greyed out.

export interface CoilToggle {
  title: string;
  /** Pressing does nothing while no Coil Pro is in the stream. */
  disabled: boolean;
}

/**
 * @param present Some glove's stream reports a Coil Pro present.
 * @param shown The model is on screen: not hidden by the user, and `present`.
 */
export function coilToggle(present: boolean, shown: boolean): CoilToggle {
  if (!present) return { title: "No Coil Pro in the stream", disabled: true };
  return {
    title: shown ? "Hide the Coil Pro model (P)" : "Show the Coil Pro model (P)",
    disabled: false,
  };
}
