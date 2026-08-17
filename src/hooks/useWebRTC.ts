import { useState, useEffect, useRef, useCallback } from 'react';
import { SignalingSocket } from '../lib/signalingSocket';
import { describeMediaError, describeFatalMediaError } from '../lib/mediaErrors';
import { loadDevicePrefs, deviceConstraint, saveCameraId, saveMicId } from '../lib/devicePrefs';

// ─── ICE configuration ───────────────────────────────────────────────────────
//
// The TURN username and password used to be literals in this file, which means
// they shipped in the built JS bundle — an open relay for anyone who opened
// devtools. They now come from GET /api/turn-credentials, which can hand out
// short-lived HMAC credentials (see handleTurnCredentials in server/main.go).
//
// The fallback below is STUN-only ON PURPOSE. If the credential fetch fails we
// would rather lose relayed calls (peers behind symmetric NAT) than re-embed a
// permanent shared secret to guard against a backend outage. Direct P2P still
// works on the fallback, which covers most connections.
const FALLBACK_ICE: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

let iceConfig: RTCConfiguration = FALLBACK_ICE;
let iceExpiresAt = 0;
let icePending: Promise<RTCConfiguration> | null = null;

// Resolves the ICE configuration, refetching when the credentials are near
// expiry. Every site that constructs an RTCPeerConnection awaits this first, so
// a connection is never built with credentials that are about to lapse.
async function ensureIceServers(): Promise<RTCConfiguration> {
  if (Date.now() < iceExpiresAt) return iceConfig;
  if (icePending) return icePending;

  icePending = (async () => {
    try {
      const res = await fetch('/api/turn-credentials');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json() as { iceServers?: RTCIceServer[]; ttlSeconds?: number };
      if (!body.iceServers?.length) throw new Error('no iceServers in response');
      iceConfig = { iceServers: body.iceServers };
      // ttlSeconds of 0 means static credentials that never expire; refresh
      // those hourly anyway so a switch to HMAC is picked up without a reload.
      const ttl = body.ttlSeconds && body.ttlSeconds > 0 ? body.ttlSeconds : 3600;
      // Renew at 80% of the lifetime so a long call never runs to the edge.
      iceExpiresAt = Date.now() + ttl * 800;
    } catch (err) {
      console.warn('[webrtc] TURN credential fetch failed — falling back to STUN only. '
        + 'Calls needing a relay will not connect.', err);
      iceConfig = FALLBACK_ICE;
      iceExpiresAt = Date.now() + 30_000; // retry soon
    } finally {
      icePending = null;
    }
    return iceConfig;
  })();

  return icePending;
}

/** Mic/camera state chosen in the lobby, applied while acquiring rather than after. */
export interface MediaPrefs {
  muted?: boolean;
  videoOff?: boolean;
}

export interface PeerInfo {
  id: string;
  name: string;
  stream: MediaStream | null;
}

const getFallbackName = (id: string) => {
  const cleanId = id.replace('user-', '').replace('tmp-', '');
  return `Guest (${cleanId.slice(0, 4).toUpperCase()})`;
};

// ─── Upstream budget ─────────────────────────────────────────────────────────
//
// Mesh means every participant uploads a SEPARATE encoded copy of their camera to
// every other participant — there is no server fanning one stream out. Chrome will
// happily try to send each of those at its default ~1-2.5 Mbps, so upstream demand
// grows linearly with the room while the uplink does not: 10 peers is already ~15
// Mbps of video, which most connections cannot sustain. When the uplink saturates,
// Opus packets are dropped alongside video frames, which is why the first
// symptom of over-subscription is people becoming inaudible rather than blurry.
//
// So: divide a fixed budget across the peers actually present, and drop encode
// resolution as the room grows (tiles are physically smaller in a big call anyway,
// so there is nothing to gain from sending full resolution to each).
const CAMERA_BUDGET_BPS = 3_000_000;
const CAMERA_MIN_BPS = 60_000;
const CAMERA_MAX_BPS = 1_200_000;
const SCREEN_BUDGET_BPS = 4_000_000;
const SCREEN_MIN_BPS = 150_000;
const SCREEN_MAX_BPS = 2_000_000;

// How many peer connections to negotiate at once when fanning out. Opening 30+
// simultaneously spikes CPU and floods the TURN server with allocation requests at
// exactly the moment existing connections need bandwidth to stay alive.
const FANOUT_CONCURRENCY = 4;

function budgetFor(peerCount: number, total: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(total / Math.max(1, peerCount))));
}

function scaleFor(peerCount: number): number {
  if (peerCount <= 2) return 1;
  if (peerCount <= 6) return 2;
  if (peerCount <= 12) return 3;
  return 4;
}

async function applyVideoBudget(
  pc: RTCPeerConnection, peerCount: number, budget: [number, number, number], scale: boolean,
) {
  const sender = pc.getSenders().find((s) => s.track?.kind === 'video');
  if (!sender) return;
  const params = sender.getParameters();
  if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
  params.encodings[0].maxBitrate = budgetFor(peerCount, budget[0], budget[1], budget[2]);
  if (scale) params.encodings[0].scaleResolutionDownBy = scaleFor(peerCount);
  try {
    await sender.setParameters(params);
  } catch (err) {
    // Non-fatal: an un-capped sender still works, it just uses more uplink.
    console.warn('[webrtc] could not apply bitrate cap:', err);
  }
}

// Runs `task` over `items` with at most `limit` in flight.
async function pooled<T>(items: T[], limit: number, task: (item: T) => Promise<void>) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      await task(next);
    }
  });
  await Promise.all(workers);
}

// Negotiation bookkeeping for one peer, per the WebRTC spec's "perfect negotiation"
// pattern.
//
// A note on what unarbitrated glare actually does, because the intuitive answer is
// wrong: since Chrome 80 / Firefox 75 / Safari 15, `setRemoteDescription(offer)`
// while in `have-local-offer` does NOT throw — it performs an *implicit rollback*.
// So two peers offering simultaneously does not raise InvalidStateError. What
// happens instead is quieter and worse: both sides roll back, both answer, and both
// end up in `stable` holding MISMATCHED descriptions (A has B's offer + A's answer;
// B has A's offer + B's answer). Each then receives the other's answer in `stable`
// and silently discards it. ICE may still connect, so nothing reports a failure and
// no watchdog fires — the connection is simply wrong.
//
// Electing exactly one side to yield is what prevents that divergence. It is not a
// rare race here: `renegotiateCamera` fans an offer out to every peer whenever
// anyone toggles their camera, while joiners are simultaneously offering inward.
interface NegotiationState {
  makingOffer: boolean;
  ignoreOffer: boolean;
  isSettingRemoteAnswerPending: boolean;
}

// Connection failures used to disappear into `catch (err) {}` — seven of them — so a
// call that half-worked produced no evidence at all. These are rare, genuinely
// abnormal events, so logging every one is cheap and is the only way a report like
// "the other side can't hear me" is ever diagnosable from a console log.
function logRTC(scope: string, peerId: string, err: unknown) {
  console.warn(`[webrtc] ${scope} failed for peer ${peerId}:`, err);
}

export function useWebRTC(socket: SignalingSocket | null, selfId = '') {
  const socketRef = useRef<SignalingSocket | null>(null);
  useEffect(() => { socketRef.current = socket; }, [socket]);

  // Kept in a ref so the long-lived signaling callbacks below always compare
  // against the current id rather than one captured at mount.
  const selfIdRef = useRef(selfId);
  useEffect(() => { selfIdRef.current = selfId; }, [selfId]);

  // Per-peer promise chain. Every negotiation step is a multi-await sequence
  // (setRemoteDescription -> drain ICE -> setLocalDescription -> send), and two
  // messages arriving for the same peer during those awaits used to run
  // concurrently and interleave their state transitions. The perfect-negotiation
  // flags alone do not prevent that — they are read and written across awaits —
  // so operations for a given peer are queued and run strictly one at a time.
  const opChainRef = useRef<Map<string, Promise<unknown>>>(new Map());
  const serialize = useCallback(<T,>(peerId: string, fn: () => Promise<T>): Promise<T> => {
    const prev = opChainRef.current.get(peerId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    // Store a settled-swallowing tail so one rejection cannot poison the chain.
    opChainRef.current.set(peerId, next.then(() => {}, () => {}));
    return next;
  }, []);

  // Lets the ICE watchdog trigger a renegotiation without a circular dependency
  // on createOfferFor, which is declared further down.
  const createOfferForRef = useRef<((peerId: string) => Promise<void>) | null>(null);

  const negRef = useRef<Map<string, NegotiationState>>(new Map());
  const negFor = useCallback((peerId: string): NegotiationState => {
    let s = negRef.current.get(peerId);
    if (!s) {
      s = { makingOffer: false, ignoreOffer: false, isSettingRemoteAnswerPending: false };
      negRef.current.set(peerId, s);
    }
    return s;
  }, []);

  // Exactly one side of each pair must yield when offers collide. Comparing the two
  // ids gives both sides the same answer with opposite results and needs no extra
  // signaling round-trip.
  const isPolite = useCallback((peerId: string) => selfIdRef.current < peerId, []);

  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [peers, setPeers] = useState<PeerInfo[]>([]);
  const [isMuted, setIsMuted] = useState(false);
  const [isVideoOff, setIsVideoOff] = useState(false);
  // switchMic replaces the audio track, and a fresh track always arrives enabled.
  // It needs to know the current mute state without being re-created on every toggle.
  const isMutedRef = useRef(isMuted);
  useEffect(() => { isMutedRef.current = isMuted; }, [isMuted]);

  // Non-fatal media problems that the user has to be told about but which do not
  // stop the call: the camera was blocked so we joined with audio only, or
  // turning the camera back on failed. These used to go to console.error only,
  // so the camera button simply appeared dead and the user kept tapping it.
  const [mediaNotice, setMediaNotice] = useState<string | null>(null);
  const dismissMediaNotice = useCallback(() => setMediaNotice(null), []);

  // Screen sharing runs over its own dedicated peer connections, entirely
  // separate from the camera connections below, so starting/stopping a share
  // never touches (or interrupts) the camera track that's already flowing.
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [screenStream, setScreenStream] = useState<MediaStream | null>(null);
  const [screenPeers, setScreenPeers] = useState<PeerInfo[]>([]);

  const pcsRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);

  const peerNamesRef = useRef<Map<string, string>>(new Map());
  const iceQueueRef = useRef<Map<string, RTCIceCandidateInit[]>>(new Map());
  const peersRef = useRef<PeerInfo[]>([]);
  useEffect(() => { peersRef.current = peers; }, [peers]);

  // Re-divide the upstream budget whenever the room size changes. This has to run
  // on *every* existing connection, not just the new one: one more participant
  // means everyone's share shrinks, and the person who joined last is not the one
  // who saturates the link.
  const applyCameraBudgets = useCallback(() => {
    const count = pcsRef.current.size;
    pcsRef.current.forEach((pc) => {
      void applyVideoBudget(pc, count, [CAMERA_BUDGET_BPS, CAMERA_MIN_BPS, CAMERA_MAX_BPS], true);
    });
  }, []);
  useEffect(() => { applyCameraBudgets(); }, [peers.length, applyCameraBudgets]);

  // Watchdog timers keyed the same way as the ICE queues (`cam:id` / `in:id` / `out:id`).
  // A peer that vanishes uncleanly (laptop closed, network dies, browser force-quit) never
  // sends the app-level "I'm leaving"/"I stopped sharing" message, so without this a remote
  // tile just freezes on its last frame forever. ICE itself still notices — connectivity
  // checks fail independently of our signaling socket — so once a connection has been
  // 'failed' for a few seconds with no recovery, we tear it down ourselves.
  const iceCleanupTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const clearIceCleanupTimer = useCallback((key: string) => {
    const t = iceCleanupTimersRef.current.get(key);
    if (t) { clearTimeout(t); iceCleanupTimersRef.current.delete(key); }
  }, []);

  // outgoing (we're sharing our screen to a peer) / incoming (a peer is sharing to us)
  const outScreenPcsRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const inScreenPcsRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const screenIceQueueRef = useRef<Map<string, RTCIceCandidateInit[]>>(new Map());

  // ─── NAME REGISTRY FIX ──────────────────────────────────────────────────
  const registerPeerName = useCallback((peerId: string, peerName: string) => {
    if (!peerName || !peerName.trim()) return;
    peerNamesRef.current.set(peerId, peerName);
    setPeers((prev) => {
      const existing = prev.find((p) => p.id === peerId);
      if (existing && existing.name !== peerName) {
        return prev.map((p) => (p.id === peerId ? { ...p, name: peerName } : p));
      }
      return prev;
    });
  }, []);

  // Seeds tiles for people who were already in the room when we arrived, straight
  // from the server's peer list. registerPeerName deliberately only *renames* an
  // existing tile, so without this a peer stayed completely invisible until their
  // media arrived — and if the connection never came up (or their signaling socket
  // had silently died) they never appeared at all, while we appeared to them. A
  // placeholder tile renders the "Connecting…" state instead, like Meet does.
  const addPeers = useCallback((incoming: { id: string; name?: string }[]) => {
    incoming.forEach(({ id, name }) => {
      if (name?.trim()) peerNamesRef.current.set(id, name);
    });
    setPeers((prev) => {
      const next = [...prev];
      incoming.forEach(({ id, name }) => {
        const resolved = name?.trim() ? name : peerNamesRef.current.get(id) || getFallbackName(id);
        const at = next.findIndex((p) => p.id === id);
        if (at === -1) next.push({ id, name: resolved, stream: null });
        else next[at] = { ...next[at], name: resolved };
      });
      return next;
    });
  }, []);

  // A peer we already hold a connection to has just (re-)entered the room, which
  // means the connection we have is to a socket that no longer exists — their page
  // reloaded, or their signaling socket dropped and came back. Reusing that dead
  // RTCPeerConnection would leave both sides staring at a frozen tile, so drop it
  // and wait for the offer the arriving side always sends.
  const discardPeerConnection = useCallback((peerId: string) => {
    const pc = pcsRef.current.get(peerId);
    if (pc) { pc.close(); pcsRef.current.delete(peerId); }
    iceQueueRef.current.delete(peerId);
    negRef.current.delete(peerId);
    opChainRef.current.delete(peerId);
    clearIceCleanupTimer(`cam:${peerId}`);
    const outPc = outScreenPcsRef.current.get(peerId);
    if (outPc) { outPc.close(); outScreenPcsRef.current.delete(peerId); }
    screenIceQueueRef.current.delete(`out:${peerId}`);
    clearIceCleanupTimer(`out:${peerId}`);
  }, [clearIceCleanupTimer]);

  const initMedia = useCallback(async (prefs: MediaPrefs = {}): Promise<MediaStream | null> => {
    if (cameraStreamRef.current) {
      setLocalStream(cameraStreamRef.current);
      return cameraStreamRef.current;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Camera and microphone access is not available. The site must be opened over HTTPS — use https:// in the address bar.');
    }

    // Joining with the camera already off (the lobby's choice) skips the camera
    // request entirely: no permission prompt for hardware we are not going to
    // use, and no acquire-then-immediately-stop cycle. This used to be done by
    // calling toggleCamera() *after* joining, which grabbed the camera, released
    // it, and then renegotiated with every peer — an avoidable offer round-trip
    // per participant at the exact moment a call is coming up.
    const wantVideo = !prefs.videoOff;

    let stream: MediaStream | null = null;
    let videoFailure: unknown = null;

    // Reuse the devices this browser chose last time. `deviceConstraint` returns an
    // `ideal` constraint rather than `exact` on purpose — a saved id that no longer
    // resolves must degrade to the default device, not reject the whole request and
    // tell the user their camera is unavailable.
    const saved = loadDevicePrefs();
    const videoConstraint = deviceConstraint(saved.cameraId);
    const audioConstraint = deviceConstraint(saved.micId);

    if (wantVideo) {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraint, audio: audioConstraint });
      } catch (err) {
        videoFailure = err;
      }
    }

    if (!stream) {
      // Retry audio-only even when the combined request was DENIED. Browsers let
      // a user block the camera while leaving the microphone allowed, and that
      // combination rejects the combined call with NotAllowedError — so bailing
      // out here (as this used to) locked out everyone who had deliberately
      // blocked their camera but still wanted to join by voice. If the denial
      // really covered both, this retry rejects immediately from the cached
      // decision without showing a second prompt, so it costs nothing.
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraint });
        setIsVideoOff(true);
        if (videoFailure) setMediaNotice(describeMediaError(videoFailure, 'camera'));
      } catch (audioErr) {
        throw new Error(describeFatalMediaError(videoFailure, audioErr));
      }
    }

    // Apply the lobby's mic choice to the real stream. The track stays live and
    // merely disabled, so unmuting later needs no new permission or hardware.
    if (prefs.muted) {
      stream.getAudioTracks().forEach((t) => { t.enabled = false; });
      setIsMuted(true);
    }
    if (!wantVideo) setIsVideoOff(true);

    cameraStreamRef.current = stream;
    setLocalStream(stream);
    return stream;
  }, []);

  const drainIceCandidates = useCallback(async (peerId: string, pc: RTCPeerConnection) => {
    const queue = iceQueueRef.current.get(peerId) ?? [];
    iceQueueRef.current.delete(peerId);
    for (const candidate of queue) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (err) { logRTC('drainIceCandidate', peerId, err); }
    }
  }, []);

  const attachTracksToConnection = useCallback((pc: RTCPeerConnection) => {
    // Always the camera stream — screen sharing lives on its own peer connections
    // (see below) and must never hijack this one.
    const streamToShare = cameraStreamRef.current;
    if (!streamToShare) return;

    streamToShare.getTracks().forEach((track) => {
      const alreadyAttached = pc.getSenders().find((s) => s.track?.id === track.id);
      if (!alreadyAttached) {
        try { pc.addTrack(track, streamToShare); } catch (e) { console.warn('[webrtc] addTrack failed:', e); }
      }
    });
  }, []);

  const getOrCreatePeerConnection = useCallback((peerId: string): RTCPeerConnection => {
    let pc = pcsRef.current.get(peerId);
    if (pc) return pc;

    pc = new RTCPeerConnection(iceConfig);
    pcsRef.current.set(peerId, pc);

    attachTracksToConnection(pc);

    pc.ontrack = (event) => {
      const remoteStream = event.streams[0];
      if (!remoteStream) return;

      remoteStream.getTracks().forEach(t => t.enabled = true);

      const resolvedName = peerNamesRef.current.get(peerId) || getFallbackName(peerId);

      setPeers((prev) => {
        const existing = prev.find((p) => p.id === peerId);
        if (existing) {
          return prev.map((p) => (p.id === peerId ? { ...p, stream: remoteStream, name: resolvedName } : p));
        }
        return [...prev, { id: peerId, name: resolvedName, stream: remoteStream }];
      });
    };

    pc.onicecandidate = (event) => {
      if (event.candidate && socketRef.current) {
        socketRef.current.send('ice_candidate', { to: peerId, candidate: event.candidate });
      }
    };

    pc.oniceconnectionstatechange = () => {
      const state = pc.iceConnectionState;
      if (state === 'connected' || state === 'completed') {
        clearIceCleanupTimer(`cam:${peerId}`);
        return;
      }
      if (state !== 'failed') return;
      // restartIce() only marks the connection as wanting fresh ICE credentials —
      // it does not itself renegotiate. Without a follow-up offer nothing is ever
      // sent, so the call was a no-op and the connection simply waited out the 8s
      // timer and got deleted. Emitting the offer is what actually attempts repair.
      pc.restartIce();
      void createOfferForRef.current?.(peerId);
      if (iceCleanupTimersRef.current.has(`cam:${peerId}`)) return;
      const timer = setTimeout(() => {
        iceCleanupTimersRef.current.delete(`cam:${peerId}`);
        if (pcsRef.current.get(peerId) !== pc) return; // already replaced/torn down elsewhere
        if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') return;
        pc.close();
        pcsRef.current.delete(peerId);
        negRef.current.delete(peerId);
        setPeers((prev) => prev.filter((p) => p.id !== peerId));
      }, 8000);
      iceCleanupTimersRef.current.set(`cam:${peerId}`, timer);
    };

    return pc;
  }, [attachTracksToConnection, clearIceCleanupTimer]);

  const createOfferFor = useCallback((peerId: string) => serialize(peerId, async () => {
    await ensureIceServers();
    if (!cameraStreamRef.current) await initMedia();
    const pc = getOrCreatePeerConnection(peerId);
    attachTracksToConnection(pc);
    const neg = negFor(peerId);
    try {
      neg.makingOffer = true;
      // No-argument setLocalDescription lets the browser pick the right description
      // type for the current signaling state, which is what makes the rollback in
      // handleOffer below safe to interleave with this.
      await pc.setLocalDescription();
      await applyVideoBudget(pc, pcsRef.current.size,
        [CAMERA_BUDGET_BPS, CAMERA_MIN_BPS, CAMERA_MAX_BPS], true);
      socketRef.current?.send('offer', { to: peerId, sdp: pc.localDescription });
    } catch (err) {
      logRTC('createOffer', peerId, err);
    } finally {
      neg.makingOffer = false;
    }
  }), [getOrCreatePeerConnection, initMedia, attachTracksToConnection, negFor, serialize]);

  const handleOffer = useCallback((fromId: string, sdp: RTCSessionDescriptionInit) => serialize(fromId, async () => {
    await ensureIceServers();
    if (!cameraStreamRef.current) await initMedia();
    const pc = getOrCreatePeerConnection(fromId);
    attachTracksToConnection(pc);
    const neg = negFor(fromId);

    // Glare: an offer arrived while we have an offer of our own outstanding. The
    // impolite side ignores it and keeps its own; the polite side rolls its offer
    // back and accepts theirs. Both sides agreeing on who is which is what stops
    // the connection deadlocking half-open.
    const readyForOffer = !neg.makingOffer && (pc.signalingState === 'stable' || neg.isSettingRemoteAnswerPending);
    const offerCollision = !readyForOffer;

    neg.ignoreOffer = !isPolite(fromId) && offerCollision;
    if (neg.ignoreOffer) return;

    try {
      // setRemoteDescription performs the implicit rollback when we're the polite
      // side mid-offer, so no explicit rollback call is needed here.
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      await drainIceCandidates(fromId, pc);
      await pc.setLocalDescription();
      await applyVideoBudget(pc, pcsRef.current.size,
        [CAMERA_BUDGET_BPS, CAMERA_MIN_BPS, CAMERA_MAX_BPS], true);
      socketRef.current?.send('answer', { to: fromId, sdp: pc.localDescription });
    } catch (err) {
      logRTC('handleOffer', fromId, err);
    }
  }), [getOrCreatePeerConnection, initMedia, drainIceCandidates, attachTracksToConnection, negFor, isPolite, serialize]);

  const handleAnswer = useCallback((fromId: string, sdp: RTCSessionDescriptionInit) => serialize(fromId, async () => {
    // Never create a connection here. An answer for a peer we hold nothing for is
    // stale — it belongs to a connection we already tore down — and materialising
    // one leaves a peer that can never connect and never renders anything but the
    // "Connecting…" placeholder.
    const pc = pcsRef.current.get(fromId);
    if (!pc) return;
    const neg = negFor(fromId);
    try {
      neg.isSettingRemoteAnswerPending = true;
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      await drainIceCandidates(fromId, pc);
    } catch (err) {
      logRTC('handleAnswer', fromId, err);
    } finally {
      neg.isSettingRemoteAnswerPending = false;
    }
  }), [drainIceCandidates, negFor, serialize]);

  useEffect(() => { createOfferForRef.current = createOfferFor; }, [createOfferFor]);

  const handleIceCandidate = useCallback(async (fromId: string, candidate: RTCIceCandidateInit) => {
    // Same rule as handleAnswer: a candidate is never a reason to build a peer
    // connection. Candidates keep arriving for a short while after someone leaves,
    // and each one used to spawn a permanent ghost tile.
    const pc = pcsRef.current.get(fromId);
    if (!pc) return;
    if (!pc.remoteDescription) {
      const queue = iceQueueRef.current.get(fromId) ?? [];
      queue.push(candidate);
      iceQueueRef.current.set(fromId, queue);
      return;
    }
    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
      // Candidates for an offer we deliberately ignored are expected to fail.
      if (!negFor(fromId).ignoreOffer) logRTC('addIceCandidate', fromId, err);
    }
  }, [negFor]);

  // ─── Screen-share signaling (separate connections, tagged kind:"screen") ──

  const makeScreenPc = useCallback((peerId: string, direction: 'in' | 'out'): RTCPeerConnection => {
    const pc = new RTCPeerConnection(iceConfig);
    const timerKey = `${direction}:${peerId}`;
    pc.onicecandidate = (event) => {
      if (event.candidate && socketRef.current) {
        socketRef.current.send('ice_candidate', { to: peerId, candidate: event.candidate, kind: 'screen' });
      }
    };
    pc.oniceconnectionstatechange = () => {
      const state = pc.iceConnectionState;
      if (state === 'connected' || state === 'completed') {
        clearIceCleanupTimer(timerKey);
        return;
      }
      if (state !== 'failed') return;
      pc.restartIce();
      if (iceCleanupTimersRef.current.has(timerKey)) return;
      const timer = setTimeout(() => {
        iceCleanupTimersRef.current.delete(timerKey);
        const map = direction === 'in' ? inScreenPcsRef.current : outScreenPcsRef.current;
        if (map.get(peerId) !== pc) return; // already replaced/torn down elsewhere
        if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') return;
        pc.close();
        map.delete(peerId);
        if (direction === 'in') setScreenPeers((prev) => prev.filter((p) => p.id !== peerId));
      }, 8000);
      iceCleanupTimersRef.current.set(timerKey, timer);
    };
    if (direction === 'in') {
      pc.ontrack = (event) => {
        const remoteStream = event.streams[0];
        if (!remoteStream) return;
        const resolvedName = peerNamesRef.current.get(peerId) || getFallbackName(peerId);
        setScreenPeers((prev) => {
          const existing = prev.find((p) => p.id === peerId);
          if (existing) return prev.map((p) => (p.id === peerId ? { ...p, stream: remoteStream, name: resolvedName } : p));
          return [...prev, { id: peerId, name: resolvedName, stream: remoteStream }];
        });
      };
    }
    return pc;
  }, [clearIceCleanupTimer]);

  const drainScreenIce = useCallback(async (key: string, pc: RTCPeerConnection) => {
    const queue = screenIceQueueRef.current.get(key) ?? [];
    screenIceQueueRef.current.delete(key);
    for (const candidate of queue) {
      try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch (err) {
        logRTC('drainScreenIce', key, err);
      }
    }
  }, []);

  const createScreenOfferFor = useCallback(async (peerId: string) => {
    if (!screenStreamRef.current) return;
    await ensureIceServers();
    let pc = outScreenPcsRef.current.get(peerId);
    if (!pc) { pc = makeScreenPc(peerId, 'out'); outScreenPcsRef.current.set(peerId, pc); }
    screenStreamRef.current.getTracks().forEach((track) => {
      if (!pc!.getSenders().find((s) => s.track?.id === track.id)) {
        try { pc!.addTrack(track, screenStreamRef.current!); } catch (e) {
          logRTC('addTrack(screen)', peerId, e);
        }
      }
    });
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      // Screen shares are the single most expensive thing a client sends, and the
      // presenter is paying for one copy per peer. Cap before the offer goes out.
      await applyVideoBudget(pc, peersRef.current.length,
        [SCREEN_BUDGET_BPS, SCREEN_MIN_BPS, SCREEN_MAX_BPS], false);
      socketRef.current?.send('offer', { to: peerId, sdp: pc.localDescription, kind: 'screen' });
    } catch (err) {
      logRTC('createScreenOffer', peerId, err);
    }
  }, [makeScreenPc]);

  const handleScreenOffer = useCallback(async (fromId: string, sdp: RTCSessionDescriptionInit) => {
    await ensureIceServers();
    let pc = inScreenPcsRef.current.get(fromId);
    if (!pc) { pc = makeScreenPc(fromId, 'in'); inScreenPcsRef.current.set(fromId, pc); }
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      await drainScreenIce(`in:${fromId}`, pc);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socketRef.current?.send('answer', { to: fromId, sdp: pc.localDescription, kind: 'screen' });
    } catch (err) { logRTC('handleScreenOffer', fromId, err); }
  }, [makeScreenPc, drainScreenIce]);

  const handleScreenAnswer = useCallback(async (fromId: string, sdp: RTCSessionDescriptionInit) => {
    const pc = outScreenPcsRef.current.get(fromId);
    if (!pc) return;
    try {
      if (pc.signalingState === 'have-local-offer') {
        await pc.setRemoteDescription(new RTCSessionDescription(sdp));
        await drainScreenIce(`out:${fromId}`, pc);
      }
    } catch (err) { logRTC('handleScreenAnswer', fromId, err); }
  }, [drainScreenIce]);

  const handleScreenIce = useCallback(async (fromId: string, candidate: RTCIceCandidateInit) => {
    const targets: [string, RTCPeerConnection | undefined][] = [
      [`in:${fromId}`, inScreenPcsRef.current.get(fromId)],
      [`out:${fromId}`, outScreenPcsRef.current.get(fromId)],
    ];
    for (const [key, pc] of targets) {
      if (!pc) continue;
      if (!pc.remoteDescription) {
        const queue = screenIceQueueRef.current.get(key) ?? [];
        queue.push(candidate);
        screenIceQueueRef.current.set(key, queue);
        continue;
      }
      try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch (err) {
        logRTC('addIceCandidate(screen)', fromId, err);
      }
    }
  }, []);

  const closeInboundScreen = useCallback((peerId: string) => {
    const pc = inScreenPcsRef.current.get(peerId);
    if (pc) { pc.close(); inScreenPcsRef.current.delete(peerId); }
    screenIceQueueRef.current.delete(`in:${peerId}`);
    clearIceCleanupTimer(`in:${peerId}`);
    setScreenPeers((prev) => prev.filter((p) => p.id !== peerId));
  }, [clearIceCleanupTimer]);

  useEffect(() => {
    if (!socket) return;
    const unsubs = [
      socket.on('peer_joined', (payload) => {
        const { peer_id, peer_name } = payload as { peer_id: string; peer_name: string };
        const validName = peer_name?.trim() ? peer_name : getFallbackName(peer_id);
        peerNamesRef.current.set(peer_id, validName);

        // Anything we still hold for this id belongs to their previous socket.
        discardPeerConnection(peer_id);
        closeInboundScreen(peer_id);

        setPeers((prev) => {
          if (prev.find((p) => p.id === peer_id)) {
            return prev.map(p => p.id === peer_id ? { ...p, name: validName, stream: null } : p);
          }
          return [...prev, { id: peer_id, name: validName, stream: null }];
        });

        if (screenStreamRef.current) createScreenOfferFor(peer_id);
      }),
      socket.on('peer_left', (payload) => {
        const { peer_id } = payload as { peer_id: string };
        const pc = pcsRef.current.get(peer_id);
        if (pc) { pc.close(); pcsRef.current.delete(peer_id); }
        iceQueueRef.current.delete(peer_id);
        negRef.current.delete(peer_id);
        peerNamesRef.current.delete(peer_id);
        clearIceCleanupTimer(`cam:${peer_id}`);
        setPeers((prev) => prev.filter((p) => p.id !== peer_id));

        const outPc = outScreenPcsRef.current.get(peer_id);
        if (outPc) { outPc.close(); outScreenPcsRef.current.delete(peer_id); }
        screenIceQueueRef.current.delete(`out:${peer_id}`);
        clearIceCleanupTimer(`out:${peer_id}`);
        closeInboundScreen(peer_id);
      }),
      socket.on('offer', (payload) => {
        const { from, from_name, sdp, kind } = payload as { from: string; from_name?: string; sdp: RTCSessionDescriptionInit; kind?: string };
        const validName = from_name?.trim() ? from_name : peerNamesRef.current.get(from) || getFallbackName(from);
        peerNamesRef.current.set(from, validName);

        if (kind === 'screen') {
          handleScreenOffer(from, sdp);
          return;
        }

        setPeers((prev) => {
          if (prev.find((p) => p.id === from)) {
            return prev.map(p => p.id === from ? { ...p, name: validName } : p);
          }
          return [...prev, { id: from, name: validName, stream: null }];
        });
        handleOffer(from, sdp);
      }),
      socket.on('answer', (payload) => {
        const { from, sdp, kind } = payload as { from: string; sdp: RTCSessionDescriptionInit; kind?: string };
        if (kind === 'screen') { handleScreenAnswer(from, sdp); return; }
        handleAnswer(from, sdp);
      }),
      socket.on('ice_candidate', (payload) => {
        const { from, candidate, kind } = payload as { from: string; candidate: RTCIceCandidateInit; kind?: string };
        if (kind === 'screen') { handleScreenIce(from, candidate); return; }
        handleIceCandidate(from, candidate);
      }),
      socket.on('screen_share_state', (payload) => {
        const { peer_id, sharing } = payload as { peer_id: string; sharing: boolean };
        if (!sharing) closeInboundScreen(peer_id);
      }),
    ];
    return () => unsubs.forEach((u) => u());
  }, [socket, handleOffer, handleAnswer, handleIceCandidate, handleScreenOffer, handleScreenAnswer, handleScreenIce, createScreenOfferFor, closeInboundScreen, clearIceCleanupTimer, discardPeerConnection]);

  const toggleMic = useCallback(() => {
    if (!cameraStreamRef.current) return;
    cameraStreamRef.current.getAudioTracks().forEach((t) => { t.enabled = !t.enabled; });
    setIsMuted((prev) => !prev);
  }, []);

  // Explicit setter rather than a toggle, for push-to-talk. A toggle can desynchronise
  // from the key state if a keyup is missed (alt-tab mid-hold) and leave the mic live;
  // setting the absolute value makes a missed event self-correct on the next one.
  const setMicMuted = useCallback((muted: boolean) => {
    if (!cameraStreamRef.current) return;
    cameraStreamRef.current.getAudioTracks().forEach((t) => { t.enabled = !muted; });
    setIsMuted(muted);
  }, []);

  // Renegotiates every live camera connection so a peer connection actually reflects
  // whether we currently have a video track to send — used any time toggleCamera
  // adds or removes the local video track (renegotiation, not replaceTrack, because
  // switchCamera/switchMic already own the "keep the same track slot alive" case).
  const renegotiateCamera = useCallback(async () => {
    // This is the main source of offer collisions in a large call — one camera
    // toggle fans an offer out to everybody at once, and any of them may be
    // mid-offer themselves. It must go through the same negotiation bookkeeping
    // as createOfferFor or the glare handling in handleOffer sees stale state.
    await Promise.all([...pcsRef.current.entries()].map(async ([peerId, pc]) => {
      const neg = negFor(peerId);
      if (neg.makingOffer || pc.signalingState !== 'stable') return;
      try {
        neg.makingOffer = true;
        await pc.setLocalDescription();
        socketRef.current?.send('offer', { to: peerId, sdp: pc.localDescription });
      } catch (err) {
        logRTC('renegotiateCamera', peerId, err);
      } finally {
        neg.makingOffer = false;
      }
    }));
  }, [negFor]);

  const toggleCamera = useCallback(async () => {
    if (!cameraStreamRef.current) return;

    if (!isVideoOff) {
      // Turning OFF: fully stop the hardware track (not just `enabled = false`) so the
      // OS camera indicator actually turns off, and remove the sender + renegotiate so
      // remote peers' video element cleanly empties instead of freezing mid-stream.
      const tracks = cameraStreamRef.current.getVideoTracks();
      if (tracks.length === 0) return;
      tracks.forEach((track) => {
        pcsRef.current.forEach((pc) => {
          const sender = pc.getSenders().find((s) => s.track === track);
          if (sender) { try { pc.removeTrack(sender); } catch (err) { console.warn('[webrtc] removeTrack failed:', err); } }
        });
        track.stop();
        cameraStreamRef.current!.removeTrack(track);
      });
      setIsVideoOff(true);
      setLocalStream(cameraStreamRef.current);
      await renegotiateCamera();
      return;
    }

    // Turning ON: the previous track was fully released above, so re-acquire fresh
    // hardware access rather than just re-enabling a dead track.
    try {
      const newStream = await navigator.mediaDevices.getUserMedia({ video: true });
      const newTrack = newStream.getVideoTracks()[0];
      if (!newTrack) return;
      cameraStreamRef.current.addTrack(newTrack);
      pcsRef.current.forEach((pc) => { try { pc.addTrack(newTrack, cameraStreamRef.current!); } catch (err) { console.warn('[webrtc] addTrack failed:', err); } });
      setIsVideoOff(false);
      setLocalStream(cameraStreamRef.current);
      await renegotiateCamera();
    } catch (err) {
      // Permission can be revoked mid-call, or another app can take the device
      // between turning the camera off and back on. isVideoOff stays true, which
      // is correct — but the user needs to know why the button did nothing.
      console.error('[toggleCamera] failed to re-acquire camera', err);
      setMediaNotice(describeMediaError(err, 'camera'));
    }
  }, [isVideoOff, renegotiateCamera]);

  const stopScreenShare = useCallback(() => {
    screenStreamRef.current?.getTracks().forEach((t) => t.stop());
    screenStreamRef.current = null;
    setScreenStream(null);
    setIsScreenSharing(false);
    outScreenPcsRef.current.forEach((pc, peerId) => { pc.close(); clearIceCleanupTimer(`out:${peerId}`); });
    outScreenPcsRef.current.clear();
    socketRef.current?.send('screen_share_state', { sharing: false });
  }, [clearIceCleanupTimer]);

  const toggleScreenShare = useCallback(async () => {
    if (isScreenSharing) {
      stopScreenShare();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: false });
      screenStreamRef.current = stream;
      setScreenStream(stream);
      setIsScreenSharing(true);
      socketRef.current?.send('screen_share_state', { sharing: true });
      // Bounded fan-out. This used to be one unbounded Promise.all, so a presenter
      // in a 35-person call opened 34 extra peer connections — each with its own
      // 30fps encoder — in a single tick, on top of the 34 camera connections
      // already running. Their uplink and CPU collapsed, and the first thing to
      // die was their own outgoing audio: the "nobody can hear the presenter" bug.
      await pooled(peersRef.current.map((p) => p.id), FANOUT_CONCURRENCY, createScreenOfferFor);
      const track = stream.getVideoTracks()[0];
      if (track) track.onended = () => stopScreenShare();
    } catch (err) {
      // A user dismissing the picker throws NotAllowedError — not an error worth surfacing.
      if ((err as { name?: string })?.name !== 'NotAllowedError') {
        console.warn('[webrtc] screen share failed to start:', err);
      }
    }
  }, [isScreenSharing, createScreenOfferFor, stopScreenShare]);

  const switchCamera = useCallback(async (deviceId: string) => {
    try {
      const newStream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: deviceId } }, audio: false });
      const newTrack = newStream.getVideoTracks()[0];
      if (!newTrack) return;
      // Replace track in all peer connections
      await Promise.all([...pcsRef.current.values()].map(pc => {
        const sender = pc.getSenders().find(s => s.track?.kind === 'video');
        return sender ? sender.replaceTrack(newTrack) : Promise.resolve();
      }));
      // Swap track in local camera stream
      if (cameraStreamRef.current) {
        cameraStreamRef.current.getVideoTracks().forEach(t => { t.stop(); cameraStreamRef.current!.removeTrack(t); });
        cameraStreamRef.current.addTrack(newTrack);
      } else {
        cameraStreamRef.current = newStream;
      }
      setLocalStream(cameraStreamRef.current);
      // Only persist after the switch has actually succeeded. Saving on selection
      // would remember a device that failed to open and re-fail on every future join.
      saveCameraId(deviceId);
    } catch (err) { console.error('[switchCamera]', err); setMediaNotice(describeMediaError(err, 'camera')); }
  }, []);

  const switchMic = useCallback(async (deviceId: string) => {
    try {
      const newStream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: deviceId } }, video: false });
      const newTrack = newStream.getAudioTracks()[0];
      if (!newTrack) return;
      await Promise.all([...pcsRef.current.values()].map(pc => {
        const sender = pc.getSenders().find(s => s.track?.kind === 'audio');
        return sender ? sender.replaceTrack(newTrack) : Promise.resolve();
      }));
      if (cameraStreamRef.current) {
        cameraStreamRef.current.getAudioTracks().forEach(t => { t.stop(); cameraStreamRef.current!.removeTrack(t); });
        cameraStreamRef.current.addTrack(newTrack);
      }
      // Carry the current mute state onto the replacement track. Without this,
      // switching microphones while muted silently unmutes you — the new track
      // arrives enabled and the button still says "unmute".
      if (isMutedRef.current) newTrack.enabled = false;
      setLocalStream(cameraStreamRef.current);
      saveMicId(deviceId);
    } catch (err) { console.error('[switchMic]', err); setMediaNotice(describeMediaError(err, 'microphone')); }
  }, []);

  // Read-only view of the live camera peer connections, for getStats() polling.
  // Returns the live map rather than a copy: the caller only reads from it, and a
  // copy per poll would allocate a fresh Map every two seconds for the whole call.
  // Screen-share connections are deliberately excluded — they come and go and their
  // quality is not what a participant tile is reporting on.
  const getPeerConnections = useCallback((): ReadonlyMap<string, RTCPeerConnection> => pcsRef.current, []);

  // Tears down every peer connection but leaves the local camera/mic running.
  // Used when moving between rooms on the same tab: without it the previous
  // room's participants stay in `peers` and render as blank, frozen tiles in
  // the new call. cleanup() is the heavier version for actually leaving.
  const resetPeers = useCallback(() => {
    pcsRef.current.forEach((pc) => pc.close());
    pcsRef.current.clear();
    outScreenPcsRef.current.forEach((pc) => pc.close());
    outScreenPcsRef.current.clear();
    inScreenPcsRef.current.forEach((pc) => pc.close());
    inScreenPcsRef.current.clear();
    iceQueueRef.current.clear();
    screenIceQueueRef.current.clear();
    negRef.current.clear();
    opChainRef.current.clear();
    peerNamesRef.current.clear();
    iceCleanupTimersRef.current.forEach((t) => clearTimeout(t));
    iceCleanupTimersRef.current.clear();
    setPeers([]);
    setScreenPeers([]);
  }, []);

  const cleanup = useCallback(() => {
    pcsRef.current.forEach((pc) => pc.close());
    pcsRef.current.clear();
    iceQueueRef.current.clear();
    negRef.current.clear();
    opChainRef.current.clear();
    peerNamesRef.current.clear();
    outScreenPcsRef.current.forEach((pc) => pc.close());
    outScreenPcsRef.current.clear();
    inScreenPcsRef.current.forEach((pc) => pc.close());
    inScreenPcsRef.current.clear();
    screenIceQueueRef.current.clear();
    iceCleanupTimersRef.current.forEach((t) => clearTimeout(t));
    iceCleanupTimersRef.current.clear();
    cameraStreamRef.current?.getTracks().forEach((t) => t.stop());
    screenStreamRef.current?.getTracks().forEach((t) => t.stop());
    cameraStreamRef.current = null;
    screenStreamRef.current = null;
    setLocalStream(null);
    setScreenStream(null);
    setPeers([]);
    setScreenPeers([]);
    setIsMuted(false);
    setIsVideoOff(false);
    setIsScreenSharing(false);
    setMediaNotice(null);
  }, []);

  return {
    localStream,
    peers,
    isMuted,
    isVideoOff,
    mediaNotice,
    dismissMediaNotice,
    isScreenSharing,
    screenStream,
    screenPeers,
    initMedia,
    createOfferFor,
    toggleMic,
    setMicMuted,
    toggleCamera,
    toggleScreenShare,
    switchCamera,
    switchMic,
    getPeerConnections,
    cleanup,
    resetPeers,
    registerPeerName,
    addPeers,
  };
}
