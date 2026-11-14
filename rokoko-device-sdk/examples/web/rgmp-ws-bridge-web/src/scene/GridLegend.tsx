// A scale key for the 3D pane's grid: a 2D drawing of one small tile and of one
// large tile (an n x n block of small ones), each with its size.
//
// It is a key, not a scale bar. The camera is a perspective one, so a 3D scene
// has no single on-screen scale — the same tile is bigger near the camera than
// far from it — and a fixed-size figure never claims one. Read it as "this is
// what a 5 cm tile and a 25 cm tile are", then count tiles in the scene.

import { Fragment } from "react";
import { GRID_UNITS, gridLegend } from "./grid.ts";

/** Drawn size of one small tile, in CSS pixels. */
const TILE_PX = 10;

export function GridLegend() {
  const { cellLabel, sectionLabel, tilesPerSide } = gridLegend(GRID_UNITS);
  const section = TILE_PX * tilesPerSide;
  // The lines that divide the large tile into small ones, at tile boundaries.
  const dividers = Array.from({ length: tilesPerSide - 1 }, (_, i) => (i + 1) * TILE_PX);

  return (
    <div
      className="grid-legend"
      role="img"
      aria-label={`Grid scale: small tiles ${cellLabel}, large tiles ${sectionLabel}, each ${tilesPerSide} by ${tilesPerSide} small tiles`}
    >
      <figure>
        <svg
          width={TILE_PX}
          height={TILE_PX}
          viewBox={`0 0 ${TILE_PX} ${TILE_PX}`}
          aria-hidden="true"
        >
          <rect
            className="grid-legend-tile"
            x={0.5}
            y={0.5}
            width={TILE_PX - 1}
            height={TILE_PX - 1}
          />
        </svg>
        <figcaption>{cellLabel}</figcaption>
      </figure>
      <figure>
        <svg
          width={section}
          height={section}
          viewBox={`0 0 ${section} ${section}`}
          aria-hidden="true"
        >
          {dividers.map((p) => (
            <Fragment key={p}>
              <line className="grid-legend-tile" x1={p + 0.5} y1={0} x2={p + 0.5} y2={section} />
              <line className="grid-legend-tile" x1={0} y1={p + 0.5} x2={section} y2={p + 0.5} />
            </Fragment>
          ))}
          <rect
            className="grid-legend-section"
            x={0.75}
            y={0.75}
            width={section - 1.5}
            height={section - 1.5}
          />
        </svg>
        <figcaption>{sectionLabel}</figcaption>
      </figure>
    </div>
  );
}
