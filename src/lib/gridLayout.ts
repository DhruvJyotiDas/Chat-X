// Container-size + orientation aware grid picker, ported from LiveKit Meet's
// `selectGridLayout` (@livekit/components-core/helper/grid-layouts.ts) — the algorithm
// @livekit/components-react's <GridLayout> uses under the hood. Replaces a pure
// tile-count breakpoint table with one that also looks at the grid's actual pixel size,
// so a wide desktop window and a narrow phone don't get forced into the same rows/cols.

export interface GridLayoutDefinition {
  columns: number;
  rows: number;
  /** Minimum container width (px) required before upgrading to this layout. */
  minWidth?: number;
  /** Minimum container height (px) required before upgrading to this layout. */
  minHeight?: number;
  /** Restrict this definition to landscape or portrait containers; omit for both. */
  orientation?: 'landscape' | 'portrait';
}

export interface GridLayoutInfo {
  columns: number;
  rows: number;
  maxTiles: number;
  minWidth: number;
  minHeight: number;
  orientation?: 'landscape' | 'portrait';
}

// Ordered smallest -> largest by tile capacity. Tuned down from upstream's table since
// IB Connect is mesh WebRTC (every extra tile is a full extra P2P connection), so calls
// realistically top out well before LiveKit's 5x5.
export const GRID_LAYOUTS: GridLayoutDefinition[] = [
  { columns: 1, rows: 1 },
  { columns: 1, rows: 2, orientation: 'portrait' },
  { columns: 2, rows: 1, orientation: 'landscape' },
  { columns: 2, rows: 2, minWidth: 480 },
  { columns: 2, rows: 3, minWidth: 360, orientation: 'portrait' },
  { columns: 3, rows: 2, minWidth: 640, orientation: 'landscape' },
  { columns: 3, rows: 3, minWidth: 760 },
  { columns: 4, rows: 3, minWidth: 960, orientation: 'landscape' },
  { columns: 3, rows: 4, minWidth: 640, orientation: 'portrait' },
  { columns: 4, rows: 4, minWidth: 1100 },
];

function expandAndSort(defs: GridLayoutDefinition[]): GridLayoutInfo[] {
  return defs
    .map((d) => ({
      columns: d.columns,
      rows: d.rows,
      maxTiles: d.columns * d.rows,
      minWidth: d.minWidth ?? 0,
      minHeight: d.minHeight ?? 0,
      orientation: d.orientation,
    }))
    .sort((a, b) => (a.maxTiles !== b.maxTiles ? a.maxTiles - b.maxTiles : a.minWidth - b.minWidth));
}

/**
 * Picks the smallest grid that still fits `tileCount` tiles, preferring the definition
 * that matches the container's current orientation, then falls back to a smaller layout
 * if the container is too small (minWidth/minHeight) for that pick.
 */
export function selectGridLayout(
  tileCount: number,
  width: number,
  height: number,
  layoutDefs: GridLayoutDefinition[] = GRID_LAYOUTS,
): GridLayoutInfo {
  const layouts = expandAndSort(layoutDefs);
  if (layouts.length === 0) return { columns: 1, rows: 1, maxTiles: 1, minWidth: 0, minHeight: 0 };
  if (width <= 0 || height <= 0) return layouts[0];

  const orientation: 'landscape' | 'portrait' = width / height > 1 ? 'landscape' : 'portrait';

  let pickIndex = 0;
  let pick = layouts.find((candidate, index, all) => {
    pickIndex = index;
    const biggerSameCapacityExists = all.some(
      (l, i) =>
        i > index &&
        l.maxTiles === candidate.maxTiles &&
        (!l.orientation || l.orientation === orientation),
    );
    return candidate.maxTiles >= tileCount && !biggerSameCapacityExists;
  });

  if (!pick) pick = layouts[layouts.length - 1];

  if ((width < pick.minWidth || height < pick.minHeight) && pickIndex > 0) {
    const smaller = layouts[pickIndex - 1];
    return selectGridLayout(smaller.maxTiles, width, height, layouts.slice(0, pickIndex));
  }

  return pick;
}
