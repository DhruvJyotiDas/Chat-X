// Per-peer link quality, polled from getStats().
//
// The mesh equivalent of LiveKit's `participant.connectionQuality`, which is computed
// server-side by the SFU. With no SFU there is nobody to compute it, so each client
// grades its own view of every peer independently — which is arguably more honest:
// what you actually want to know is whether *your* link to that person is healthy,
// and in a mesh that is a different question for every pair in the room.

import { useEffect, useRef, useState } from 'react';
import { readPeerStats, gradeQuality, describePath, type LinkQuality, type PeerStats } from '../lib/connectionStats';
import { diag } from '../lib/diagnostics';

export interface PeerLink {
  quality: LinkQuality;
  stats: PeerStats | null;
}

const EMPTY: ReadonlyMap<string, PeerLink> = new Map();

// Two seconds is frequent enough that a link going bad is visible while it matters,
// and infrequent enough that the polling itself is not part of the problem: getStats()
// walks every ssrc on the connection, and in a mesh this runs once per peer.
const POLL_MS = 2000;

/**
 * Grade every live peer connection on a timer.
 *
 * `getConnections` must be a stable function (useWebRTC's `getPeerConnections`) —
 * it is read inside the interval, so a new identity each render would restart the
 * timer and the poll would never fire.
 */
export function useConnectionQuality(
  getConnections: () => ReadonlyMap<string, RTCPeerConnection>,
  enabled: boolean,
): ReadonlyMap<string, PeerLink> {
  const [links, setLinks] = useState<ReadonlyMap<string, PeerLink>>(EMPTY);

  // Log a peer's path once, when it first settles, rather than on every poll — the
  // interesting fact is "this call went over a relay", and repeating it every two
  // seconds for every peer would bury everything else in the ring buffer.
  const loggedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!enabled) {
      setLinks(EMPTY);
      loggedRef.current.clear();
      return;
    }

    let cancelled = false;
    let timer = 0;

    const poll = async () => {
      const connections = getConnections();
      const next = new Map<string, PeerLink>();

      // Sequential, not Promise.all: these are cheap but there is one per peer, and
      // firing 20 getStats() calls in the same tick during a large call adds a
      // measurable hitch to the main thread every poll.
      for (const [peerId, pc] of connections) {
        if (cancelled) return;
        const stats = await readPeerStats(pc);
        next.set(peerId, { quality: gradeQuality(stats), stats });

        if (stats && !loggedRef.current.has(peerId)) {
          loggedRef.current.add(peerId);
          diag('webrtc', 'info', `selected-candidate-pair ${peerId}: ${describePath(stats)}`, {
            relayed: stats.relayed,
            localType: stats.local.type,
            remoteType: stats.remote.type,
            protocol: stats.local.protocol,
          });
        }
      }

      // Forget peers that have left, so a reconnect logs its new path afresh.
      loggedRef.current.forEach((id) => { if (!connections.has(id)) loggedRef.current.delete(id); });

      if (!cancelled) {
        setLinks(next);
        timer = window.setTimeout(poll, POLL_MS);
      }
    };

    void poll();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [getConnections, enabled]);

  return links;
}

/** True when at least one peer is being carried by a TURN relay. */
export function anyRelayed(links: ReadonlyMap<string, PeerLink>): boolean {
  for (const link of links.values()) if (link.stats?.relayed) return true;
  return false;
}
