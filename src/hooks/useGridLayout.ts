import { useMemo } from 'react';
import { useElementSize } from './useElementSize';
import { GRID_LAYOUTS, selectGridLayout, type GridLayoutInfo } from '../lib/gridLayout';

/**
 * Measures the grid container and picks rows/cols via `selectGridLayout` — attach
 * `ref` to the grid div and apply `layout.columns`/`layout.rows` as CSS grid-template.
 */
export function useGridLayout(tileCount: number): {
  ref: ReturnType<typeof useElementSize>['ref'];
  layout: GridLayoutInfo;
  size: { width: number; height: number };
} {
  const { ref, size } = useElementSize<HTMLDivElement>();
  const layout = useMemo(
    () => selectGridLayout(tileCount, size.width, size.height, GRID_LAYOUTS),
    [tileCount, size.width, size.height],
  );
  return { ref, layout, size };
}

/**
 * Exact pixel size for a 16:9 tile in the chosen grid, so tiles can be laid out at
 * their true aspect ratio and centered rather than stretched to fill the cell.
 *
 * Stretching is what made small calls look wrong: two people on a 1400x900 window
 * got a 2x1 grid of ~690x790 cells, i.e. near-portrait boxes that `object-cover`
 * then cropped the sides off. Sizing to `min(cellWidth, cellHeight * 16/9)` keeps
 * every tile a real 16:9 frame, and letting them wrap in a centered flex row also
 * centers a partially-filled last row the way Meet does.
 */
export function computeTileSize(
  size: { width: number; height: number },
  layout: GridLayoutInfo,
  gap: number,
): { width: number; height: number } | null {
  if (size.width <= 0 || size.height <= 0) return null;
  const cellWidth = (size.width - gap * (layout.columns - 1)) / layout.columns;
  const cellHeight = (size.height - gap * (layout.rows - 1)) / layout.rows;
  if (cellWidth <= 0 || cellHeight <= 0) return null;
  const width = Math.min(cellWidth, (cellHeight * 16) / 9);
  return { width, height: (width * 9) / 16 };
}
