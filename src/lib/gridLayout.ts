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
  // minWidth is compared against the GRID CONTAINER, not the viewport, and the
  // container is the viewport minus the stage padding (~16px at phone widths). At 360
  // it therefore needed a >=376px viewport, so every 360px-wide Android — Galaxy S8/S9/
  // S10e and most budget phones — fell back to 1x2 and showed TWO people, turning a
  // six-person call into three pages. Measured container widths: 360px viewport -> 344,
  // 390px -> 374. 340 clears the smallest of those.
  { columns: 2, rows: 3, minWidth: 340, orientation: 'portrait' },
  { columns: 3, rows: 2, minWidth: 640, orientation: 'landscape' },
  { columns: 3, rows: 3, minWidth: 760 },
  // Was 960 (upstream's number). Portrait reaches 12 tiles at 640px via 3x4, but
  // landscape had no 12-tile option until 960 — so dragging a window from 900 to 920px
  // wide flipped the container from portrait to landscape, dropped capacity 12 -> 9, and
  // cost a page in a large call. Widening a window should never show fewer people. 900
  // closes the gap and still leaves 221x124 tiles at that width.
  { columns: 4, rows: 3, minWidth: 900, orientation: 'landscape' },
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
 * Picks the smallest grid that holds `tileCount` tiles *and* actually fits the container.
 *
 * The original port picked the smallest layout by capacity first and, if the container
 * turned out to be too narrow for it, recursed onto a layout with LESS capacity. That
 * produced a non-monotonic result: on a measured 374px-wide phone, 3 people got a 2-tile
 * layout and paginated, while 6 people got a 6-tile layout and did not. The cause is that
 * 3 tiles selected `2x2` (which needs 480px), the container failed that, and the fallback
 * stepped down to 2 instead of considering `2x3` — a TALLER layout that needs only 340px
 * and holds twice as many. Capacity and container-fit are independent constraints, so
 * they have to be applied independently rather than one after the other.
 *
 * Filtering by what the container can accommodate first, then taking the smallest
 * sufficient capacity, is both simpler and monotonic — more participants can never mean
 * more pages for the same container.
 */
export function selectGridLayout(
  tileCount: number,
  width: number,
  height: number,
  layoutDefs: GridLayoutDefinition[] = GRID_LAYOUTS,
): GridLayoutInfo {
  const layouts = expandAndSort(layoutDefs);
  if (layouts.length === 0) return { columns: 1, rows: 1, maxTiles: 1, minWidth: 0, minHeight: 0 };
  // Container not measured yet (first render, before the ResizeObserver fires).
  if (width <= 0 || height <= 0) return layouts[0];

  const orientation: 'landscape' | 'portrait' = width / height > 1 ? 'landscape' : 'portrait';

  const fits = layouts.filter((l) => (
    width >= l.minWidth
    && height >= l.minHeight
    && (!l.orientation || l.orientation === orientation)
  ));

  // 1x1 carries no minimum and no orientation, so this only triggers on a
  // pathological definition table.
  if (fits.length === 0) return layouts[0];

  // Smallest capacity that shows everyone, or the largest the container can manage —
  // `usePagination` covers whoever is left over.
  return fits.find((l) => l.maxTiles >= tileCount) ?? fits[fits.length - 1];
}
