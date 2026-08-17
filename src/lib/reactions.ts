// In-call reactions.
//
// The set is fixed and small on purpose. A full emoji picker turns a two-second
// acknowledgement into a menu interaction, and the server allow-lists these exact
// strings (see allowedReactions in server/main.go) so the list cannot drift into
// arbitrary user-controlled content rendered in everyone else's DOM.

export const REACTIONS = ['👍', '👏', '🎉', '❤️', '😂', '😮', '🤔', '👋'] as const;

export type Reaction = (typeof REACTIONS)[number];

export function isReaction(value: string): value is Reaction {
  return (REACTIONS as readonly string[]).includes(value);
}

/** How long a reaction stays on screen before it is dropped. */
export const REACTION_TTL_MS = 4000;

export interface FloatingReaction {
  /** Unique per emission — the same person can send the same emoji twice in a row. */
  id: string;
  peerId: string;
  peerName: string;
  emoji: string;
  /** Horizontal offset (0..1) so simultaneous reactions do not stack exactly. */
  lane: number;
}

let seq = 0;

export function makeFloatingReaction(peerId: string, peerName: string, emoji: string): FloatingReaction {
  seq += 1;
  return { id: `rx-${seq}`, peerId, peerName, emoji, lane: Math.random() };
}
