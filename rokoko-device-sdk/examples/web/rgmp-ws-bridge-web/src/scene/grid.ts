// The 3D pane's grid: its tile sizes, and the figures the scale key draws from
// them. Pure, so the grid in SceneView, the scale key and the help dialog all
// read one set of numbers.

/**
 * Grid spacing in meters: the small tiles, and the larger tiles (sections) made
 * of them. Exported so the help dialog and the scale key can describe it.
 */
export const GRID_UNITS = { cell: 0.05, section: 0.25 } as const;

/** What the scale key shows. */
export interface GridLegend {
  /** The label under the small tile, e.g. "5 cm". */
  cellLabel: string;
  /** The label under the large tile, e.g. "25 cm". */
  sectionLabel: string;
  /** The large tile is this many small tiles on a side. */
  tilesPerSide: number;
}

/** Meters as centimeters, without a decimal when it is whole: 0.05 → "5 cm". */
function cm(meters: number): string {
  return `${Math.round(meters * 1000) / 10} cm`;
}

export function gridLegend(units: { cell: number; section: number } = GRID_UNITS): GridLegend {
  return {
    cellLabel: cm(units.cell),
    sectionLabel: cm(units.section),
    tilesPerSide: Math.round(units.section / units.cell),
  };
}
