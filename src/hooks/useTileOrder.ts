// Stateful wrapper around `orderTiles`: tracks who spoke when, and remembers the
// previous order so tile positions survive re-renders.
//
// The "last spoke at" map is the piece an SFU would normally hand you. Zoom and Meet
// get dominant-speaker ranking from the server, which sees every participant's audio
// energy. Here it is derived from `useAudioLevels`, which already analyses every peer's
// stream locally — including peers whose tiles are not currently rendered, because the
// audio elements for them exist regardless of pagination.

import { useEffect, useMemo, useRef } from 'react';
import { orderTiles, type TileRankInput } from '../lib/tileOrder';

export interface OrderableTile {
  id: string;
  isLocal: boolean;
  isPresenting: boolean;
  hasVideo: boolean;
}

/**
 * Returns tile ids in the order they should occupy grid slots.
 *
 * `speakingIds` must cover every participant, not just the visible ones — ranking
 * off-page speakers is the entire point, and a set that only covered rendered tiles
 * would silently reduce this to arrival order.
 */
export function useTileOrder(
  tiles: OrderableTile[],
  speakingIds: ReadonlySet<string>,
  maxTiles: number,
  currentPage: number,
): string[] {
  // Mutated, not state: these change on every speech event and must not each cause a
  // render of the whole grid. The order they feed into is recomputed during render.
  const lastSpokeAtRef = useRef<Map<string, number>>(new Map());
  const promotedAtRef = useRef<Map<string, number>>(new Map());
  const previousRef = useRef<string[]>([]);

  // Stamp speech times as a side effect so the render below stays pure.
  useEffect(() => {
    const now = performance.now();
    speakingIds.forEach((id) => lastSpokeAtRef.current.set(id, now));
  }, [speakingIds]);

  // Anyone who has left should not keep a slot reserved by stale bookkeeping.
  useEffect(() => {
    const live = new Set(tiles.map((t) => t.id));
    [lastSpokeAtRef.current, promotedAtRef.current].forEach((map) => {
      map.forEach((_, id) => { if (!live.has(id)) map.delete(id); });
    });
  }, [tiles]);

  const order = useMemo(() => {
    const now = performance.now();

    const inputs: TileRankInput[] = tiles.map((t, i) => ({
      id: t.id,
      isLocal: t.isLocal,
      isPresenting: t.isPresenting,
      isSpeaking: speakingIds.has(t.id),
      // Read directly rather than via the effect above, so the very first render after
      // someone starts talking already ranks them — waiting a frame is a visible lag
      // when the point is to bring a speaker on screen.
      lastSpokeAt: speakingIds.has(t.id) ? now : (lastSpokeAtRef.current.get(t.id) ?? 0),
      hasVideo: t.hasVideo,
      joinIndex: i,
    }));

    const { order: next, promoted } = orderTiles(inputs, {
      maxTiles,
      currentPage,
      previous: previousRef.current,
      promotedAt: promotedAtRef.current,
      now,
    });

    promoted.forEach((id) => promotedAtRef.current.set(id, now));
    previousRef.current = next;
    return next;
  }, [tiles, speakingIds, maxTiles, currentPage]);

  return order;
}
