import { useEffect, useMemo, useState } from 'react';

export interface Pagination<T> {
  /** The tiles to render for the current page — length is always <= maxTiles. */
  tiles: T[];
  currentPage: number;
  totalPageCount: number;
  nextPage: () => void;
  prevPage: () => void;
}

/**
 * Ported from LiveKit Meet's `usePagination` (@livekit/components-react) — the piece that
 * makes `selectGridLayout` safe to use with any participant count. `selectGridLayout` picks
 * the smallest grid that fits the container's actual pixel size, which can have a lower
 * `maxTiles` than the real tile count (e.g. a narrow phone can't fit a 2x2 grid, so it steps
 * down to a layout that only holds 2). Without pagination those extra tiles would have no
 * grid cell to render into; this slices `allTiles` into `maxTiles`-sized pages instead, with
 * next/prev to page through the rest — same as Meet's swipeable/paginated grid.
 */
export function usePagination<T>(maxTiles: number, allTiles: T[]): Pagination<T> {
  const totalPageCount = maxTiles > 0 ? Math.max(1, Math.ceil(allTiles.length / maxTiles)) : 1;
  const [currentPage, setCurrentPage] = useState(0);

  useEffect(() => {
    setCurrentPage((page) => Math.min(page, totalPageCount - 1));
  }, [totalPageCount]);

  const tiles = useMemo(() => {
    const start = currentPage * maxTiles;
    return allTiles.slice(start, start + maxTiles);
  }, [allTiles, currentPage, maxTiles]);

  return {
    tiles,
    currentPage,
    totalPageCount,
    nextPage: () => setCurrentPage((p) => Math.min(p + 1, totalPageCount - 1)),
    prevPage: () => setCurrentPage((p) => Math.max(p - 1, 0)),
  };
}
