// Reading RTCPeerConnection.getStats().
//
// Until now nothing in the frontend called getStats() at all, which meant the app had
// no idea how any call was actually going: no quality indicator, no way to know a call
// had fallen back to a TURN relay, and no client-side evidence when someone reported
// that video froze. Everything diagnostics.ts records is signalling and lifecycle —
// what we asked the browser to do, never what the transport then did.
//
// This matters more here than it would behind an SFU. With an SFU there is one
// connection and the server can describe it. In a mesh every peer is a separate
// RTCPeerConnection with its own independent outcome, so per-peer stats are the only
// way to tell "the call is bad" apart from "one person's link is bad" — and those two
// have completely different answers.
//
// Technique follows suitenumerique/meet's features/diagnostics/checks/selectedCandidate.ts:
// find the transport's selectedCandidatePairId, then resolve both ends of that pair.

export interface CandidateInfo {
  /** host, srflx, prflx or relay. `relay` means TURN is carrying the media. */
  type?: string;
  /** Transport to the first hop: udp or tcp. */
  protocol?: string;
  /** Transport used by the relay itself (udp, tcp, tls). Local relay candidates only. */
  relayProtocol?: string;
  /** Chrome reports an mDNS `.local` name here for host candidates. */
  address?: string;
  port?: number;
  networkType?: string;
}

export interface PeerStats {
  local: CandidateInfo;
  remote: CandidateInfo;
  /** Round trip time over the selected pair, in milliseconds. */
  rttMs?: number;
  availableOutgoingBitrate?: number;
  /** Inbound video, aggregated across ssrcs. */
  packetsLost?: number;
  packetsReceived?: number;
  jitterMs?: number;
  framesPerSecond?: number;
  frameWidth?: number;
  frameHeight?: number;
  /** True when either end of the selected pair is a TURN relay. */
  relayed: boolean;
}

type StatsLike = Record<string, unknown> & { type?: string; id?: string };

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);

function readCandidate(stats?: StatsLike): CandidateInfo {
  if (!stats) return {};
  return {
    type: str(stats.candidateType),
    protocol: str(stats.protocol),
    relayProtocol: str(stats.relayProtocol),
    address: str(stats.address),
    port: num(stats.port),
    networkType: str(stats.networkType),
  };
}

/**
 * Pull the useful subset out of a peer connection's stats report.
 *
 * Returns null when no candidate pair has been selected yet — during ICE gathering,
 * or after the connection has failed. Callers should treat that as "unknown", not as
 * a quality reading, or every tile flashes a warning for the first second of a call.
 */
export async function readPeerStats(pc: RTCPeerConnection): Promise<PeerStats | null> {
  let report: RTCStatsReport;
  try {
    report = await pc.getStats();
  } catch {
    return null;
  }

  const byId = new Map<string, StatsLike>();
  let selectedPairId: string | undefined;
  let fallbackPair: StatsLike | undefined;

  report.forEach((raw) => {
    const s = raw as StatsLike;
    if (s.id) byId.set(s.id, s);
    // Chrome exposes the winner on the transport. Firefox historically did not, and
    // instead flags the pair itself — hence the fallback below.
    if (s.type === 'transport' && typeof s.selectedCandidatePairId === 'string') {
      selectedPairId = s.selectedCandidatePairId;
    }
    if (s.type === 'candidate-pair' && (s.selected === true || s.nominated === true) && s.state === 'succeeded') {
      fallbackPair = s;
    }
  });

  const pair = (selectedPairId ? byId.get(selectedPairId) : undefined) ?? fallbackPair;
  if (!pair) return null;

  const local = readCandidate(byId.get(str(pair.localCandidateId) ?? ''));
  const remote = readCandidate(byId.get(str(pair.remoteCandidateId) ?? ''));

  let packetsLost: number | undefined;
  let packetsReceived: number | undefined;
  let jitterMs: number | undefined;
  let framesPerSecond: number | undefined;
  let frameWidth: number | undefined;
  let frameHeight: number | undefined;

  report.forEach((raw) => {
    const s = raw as StatsLike;
    if (s.type !== 'inbound-rtp') return;
    const lost = num(s.packetsLost);
    const received = num(s.packetsReceived);
    if (lost !== undefined) packetsLost = (packetsLost ?? 0) + lost;
    if (received !== undefined) packetsReceived = (packetsReceived ?? 0) + received;
    // jitter is reported in seconds by the spec.
    const jitter = num(s.jitter);
    if (jitter !== undefined) jitterMs = Math.max(jitterMs ?? 0, jitter * 1000);
    if (s.kind === 'video') {
      framesPerSecond = num(s.framesPerSecond) ?? framesPerSecond;
      frameWidth = num(s.frameWidth) ?? frameWidth;
      frameHeight = num(s.frameHeight) ?? frameHeight;
    }
  });

  const rttSeconds = num(pair.currentRoundTripTime);

  return {
    local,
    remote,
    rttMs: rttSeconds === undefined ? undefined : Math.round(rttSeconds * 1000),
    availableOutgoingBitrate: num(pair.availableOutgoingBitrate),
    packetsLost,
    packetsReceived,
    jitterMs: jitterMs === undefined ? undefined : Math.round(jitterMs),
    framesPerSecond,
    frameWidth,
    frameHeight,
    relayed: local.type === 'relay' || remote.type === 'relay',
  };
}

export type LinkQuality = 'good' | 'fair' | 'poor' | 'unknown';

/**
 * Grade a link from RTT and loss.
 *
 * Thresholds are deliberately forgiving. A mesh call shares one uplink across n-1
 * encoders, so some loss under load is normal and expected — a warning badge that
 * lights up during ordinary use is a badge people learn to ignore, which is worse
 * than no badge at all.
 */
export function gradeQuality(stats: PeerStats | null): LinkQuality {
  if (!stats) return 'unknown';

  const { rttMs, packetsLost, packetsReceived } = stats;
  const total = (packetsLost ?? 0) + (packetsReceived ?? 0);
  const lossRatio = total > 0 ? (packetsLost ?? 0) / total : 0;

  if ((rttMs !== undefined && rttMs > 400) || lossRatio > 0.08) return 'poor';
  if ((rttMs !== undefined && rttMs > 200) || lossRatio > 0.03) return 'fair';
  if (rttMs === undefined && total === 0) return 'unknown';
  return 'good';
}

/** One-line human summary of the path, for the diagnostics panel and bug reports. */
export function describePath(stats: PeerStats | null): string {
  if (!stats) return 'not connected';
  const via = stats.relayed
    ? `relay${stats.local.relayProtocol ? ` (${stats.local.relayProtocol})` : ''}`
    : `${stats.local.type ?? 'unknown'}/${stats.remote.type ?? 'unknown'}`;
  const rtt = stats.rttMs === undefined ? '' : `, ${stats.rttMs} ms`;
  return `${via} over ${stats.local.protocol ?? '?'}${rtt}`;
}
