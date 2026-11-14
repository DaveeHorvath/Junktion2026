// A segmented button group: a row of mutually-exclusive options where the
// selected one is highlighted.
//
// Styling lives in styles.css (.segmented), like the rest of the shared chrome.
// Pass `className` to position an instance; the RGMP viewer uses one in the top
// bar (inside TopBar's children) and one in the corner of its 3D pane.

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  /** Tooltip text, e.g. a keyboard-shortcut hint. */
  title?: string;
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  className,
}: {
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
  /** Extra class(es) appended to the `segmented` wrapper. */
  className?: string;
}) {
  return (
    <div
      className={className ? `segmented ${className}` : "segmented"}
      role="group"
      aria-label={ariaLabel}
    >
      {options.map((opt) => (
        <button
          key={opt.value}
          className={value === opt.value ? "active" : ""}
          title={opt.title}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
