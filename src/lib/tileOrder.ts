// Which faces occupy the visible grid slots.
//
// The problem this solves: `GRID_LAYOUTS` caps at 16 tiles and `usePagination` slices
// everyone else onto later pages, but the tile order was just `[...peers, local]` —
// signalling arrival order. So in a call big enough to page, whether you could see
// someone depended entirely on when they happened to join, and if a person on page 2
// started talking you never saw them. Their tile lit up on a page nobody was looking at.
//
// How Zoom and Meet avoid this: both run an SFU that performs server-side dominant
// speaker detection, ranks participants by who spoke most recently, and only forwards
// video for tiles the client is actually rendering. The grid is a window onto a
// *sorted* list, so the interesting people are always in it.
//
// IB Connect has no SFU — but it turns out it does not need one for the ordering half.
// `useAudioLevels` already runs an analyser over EVERY peer, not only the rendered
// ones, because `PeerAudio` mounts an element per peer outside the grid. The speaking
// signal for off-page participants is therefore already being computed; it was simply
// never used for anything but the highlight ring. That is enough to rank tiles locally.
//
// What is still missing without an SFU is the *bandwidth* half: Zoom and Meet stop
// sending video for tiles you cannot see. In a mesh every peer sends to every peer
// regardless, so paging saves rendering but not uplink. That does not block this fix,
// it just means the ceiling stays where it is.
//
// Structure follows LiveKit's `sortParticipants` + `useVisualStableUpdate`
// (@livekit/components-core), which is what suitenumerique/meet leans on via
// `usePagination` and its own `useSpeakerPromotionTrigger`.

/** Everything the ranking needs to know about one tile. */
export interface TileRankInput {
  id: string;
  isLocal: boolean;
  isPresenting: boolean;
  isSpeaking: boolean;
  /** performance.now() of the last time this tile was speaking; 0 = never heard. */
  lastSpokeAt: number;
  hasVideo: boolean;
  /** Position in the raw arrival list — the tiebreaker, so ordering is deterministic. */
  joinIndex: number;
}

/**
 * Ideal priority order, most important first. This is what the grid *would* show if
 * visual stability did not matter.
 *
 * The local tile is excluded here and slotted separately by `orderTiles` — it is not
 * competing for attention with everyone else, it just has to stay on screen.
 */
export function rankTiles(inputs: TileRankInput[]): string[] {
  return [...inputs]
    .sort((a, b) => {
      // Someone sharing their screen is the reason the call is happening.
      if (a.isPresenting !== b.isPresenting) return a.isPresenting ? -1 : 1;
      // Talking right now beats having talked.
      if (a.isSpeaking !== b.isSpeaking) return a.isSpeaking ? -1 : 1;
      // Then most recent speaker first. Never-spoken sorts last via lastSpokeAt = 0.
      if (a.lastSpokeAt !== b.lastSpokeAt) return b.lastSpokeAt - a.lastSpokeAt;
      // A camera-off tile is an avatar; prefer to spend a slot on a face.
      if (a.hasVideo !== b.hasVideo) return a.hasVideo ? -1 : 1;
      return a.joinIndex - b.joinIndex;
    })
    .map((t) => t.id);
}

export interface OrderOptions {
  /** Tiles per page for the current layout. */
  maxTiles: number;
  /** Page the user is actually looking at — promotion targets that window, not page 1. */
  currentPage: number;
  /** Order from the previous render, so positions can be preserved. */
  previous: string[];
  /** ids promoted recently, with the timestamp, so they cannot be instantly demoted. */
  promotedAt: Map<string, number>;
  now: number;
}

/**
 * A tile promoted into view stays for at least this long. Without a hold, two people
 * talking over each other trade the same slot several times a second and the grid
 * becomes unreadable — the failure mode that makes naive "sort by who is speaking"
 * worse than no sorting at all.
 */
export const PROMOTE_HOLD_MS = 5000;

/** Someone who spoke this recently still counts as worth a slot. */
export const RECENT_SPEECH_MS = 30_000;

export interface OrderResult {
  order: string[];
  /** ids newly swapped into the visible window this pass. */
  promoted: string[];
}

/**
 * Produce the tile order for this render: stable where it can be, promoting a hidden
 * speaker into the visible window where it must.
 *
 * The rule is deliberately conservative. Tiles are NOT re-sorted into ideal order on
 * every speech event — that would make the whole grid jump around constantly. Instead
 * the previous order is carried forward, and a swap happens only when someone worth
 * seeing is off-screen: they trade places with the least interesting tile that is
 * currently visible. Everything already on screen stays exactly where it was.
 */
export function orderTiles(inputs: TileRankInput[], opts: OrderOptions): OrderResult {
  const { maxTiles, currentPage, previous, promotedAt, now } = opts;

  const byId = new Map(inputs.map((t) => [t.id, t]));
  const local = inputs.find((t) => t.isLocal);
  const remotes = inputs.filter((t) => !t.isLocal);
  const ideal = rankTiles(remotes);
  const idealRank = new Map(ideal.map((id, i) => [id, i]));

  // ── Stable base ────────────────────────────────────────────────────────────
  // Keep last render's order, drop whoever left, append whoever joined in ideal
  // order. This alone is what stops tiles shuffling on every render.
  const liveRemotes = new Set(remotes.map((t) => t.id));
  const carried = previous.filter((id) => liveRemotes.has(id) && byId.get(id)?.isLocal !== true);
  const seen = new Set(carried);
  const order = [...carried, ...ideal.filter((id) => !seen.has(id))];

  // ── Promotion into the page being viewed ───────────────────────────────────
  const promoted: string[] = [];
  if (maxTiles > 0) {
    // The local tile takes one slot on the first page (placed at the end of the loop
    // below), so the first page holds one fewer remote than later pages.
    const start = currentPage * maxTiles - (currentPage > 0 ? 1 : 0);
    const span = currentPage === 0 ? Math.max(0, maxTiles - 1) : maxTiles;
    const visible = new Set(order.slice(start, start + span));

    const worthSeeing = (id: string) => {
      const t = byId.get(id);
      if (!t) return false;
      return t.isPresenting || t.isSpeaking || (t.lastSpokeAt > 0 && now - t.lastSpokeAt < RECENT_SPEECH_MS);
    };

    // Candidates to bring in: worth seeing, currently off this page, best first.
    const incoming = order
      .filter((id) => !visible.has(id) && worthSeeing(id))
      .sort((a, b) => (idealRank.get(a) ?? Infinity) - (idealRank.get(b) ?? Infinity));

    // Candidates to push out: on this page, not presenting, not talking, out of hold,
    // worst first. Anything still inside its hold window is untouchable.
    const outgoing = order
      .filter((id) => {
        if (!visible.has(id)) return false;
        const t = byId.get(id);
        if (!t || t.isPresenting || t.isSpeaking) return false;
        const held = promotedAt.get(id);
        if (held !== undefined && now - held < PROMOTE_HOLD_MS) return false;
        return true;
      })
      .sort((a, b) => (idealRank.get(b) ?? Infinity) - (idealRank.get(a) ?? Infinity));

      const swaps = Math.min(incoming.length, outgoing.length);
    for (let i = 0; i < swaps; i++) {
      const inId = incoming[i];
      const outId = outgoing[i];
      const inIdx = order.indexOf(inId);
      const outIdx = order.indexOf(outId);
      if (inIdx < 0 || outIdx < 0) continue;
      order[inIdx] = outId;
      order[outIdx] = inId;
      promoted.push(inId);
    }
  }

  // ── The local tile ─────────────────────────────────────────────────────────
  // It used to be appended last, which meant that in any call big enough to page,
  // your own tile sat on page 2 and you could not see yourself at all. Both Zoom and
  // Meet guarantee self-view is reachable. Placing it at the END of the first page
  // keeps it visible without changing anything for small calls, where "last" and
  // "last on page 1" are the same slot.
  if (local) {
    const slot = Math.min(order.length, Math.max(0, maxTiles - 1));
    order.splice(slot, 0, local.id);
  }

  return { order, promoted };
}
