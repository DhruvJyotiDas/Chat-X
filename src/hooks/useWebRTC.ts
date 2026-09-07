import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Room, RoomEvent, RemoteParticipant, RemoteTrack, RemoteTrackPublication,
  LocalTrackPublication, ConnectionState, ConnectionQuality, Participant, Track,
  RemoteVideoTrack, RemoteAudioTrack,
} from 'livekit-client';
import { describeMediaError } from '../lib/mediaErrors';
import { api } from '../lib/api';
import type { PeerLink, LinkQuality } from '../lib/connectionStats';

// Ceiling on the simulcast layer a GRID tile is allowed to request.
//
// The publish ladder is 320x180 (q, 160 kbps) / 640x360 (h, 450 kbps) /
// 1280x720 (f, 1.7 Mbps), and the SFU forwards the LOWEST layer whose width
// covers what the subscriber asked for. adaptiveStream asks for the video
// element's measured size, so a 4-up grid on a 1080p window (~728 px per
// tile) clears 640 and pulls the f layer — 1.7 Mbps per stream where 450 kbps
// is indistinguishable at 728 px. The jump is discontinuous: a 6-person call
// costs LESS egress than a 4-person one.
//
// This is a CEILING, not an override, despite what setVideoDimensions's own
// docstring says: RemoteTrackPublication.emitTrackUpdate sends
// min(requestedVideoDimensions, adaptiveStream's measured size), so a tile
// smaller than 640 still drops to q on its own and an off-screen tile still
// pauses. All this removes is the top layer, and only for grid tiles — the
// stage tile (focus/pin) is exempt, since that is the one place the extra
// resolution is actually visible.
const GRID_MAX_DIMS = { width: 640, height: 360 } as const;
const STAGE_MAX_DIMS = { width: 1280, height: 720 } as const;

// ─── Mesh -> LiveKit SFU migration, Stage 3 (2026-08-27) ─────────────────────
//
// This file used to build and negotiate one RTCPeerConnection per remote
// participant by hand (perfect-negotiation glare handling, manual ICE queues,
// a second parallel connection scheme for screen share — see git history /
// CLAUDE.md's migration work log if any of that reasoning is ever needed
// again). All of that is deleted outright, not "replaced conceptually" — a
// LiveKit Room object owns exactly one transport to the SFU internally, so
// there is no second party to glare against and nothing here to arbitrate.
//
// Screen sharing (gap #1 from the Stage 3 pass) is fixed as of 2026-08-28:
// it is now a second published track (Track.Source.ScreenShare) on the SAME
// Room/LocalParticipant camera already uses, not a second connection scheme —
// exactly what the Stage 2 plan called for. LiveKit's own SDK already
// unpublishes and fires LocalTrackUnpublished when the browser's native
// "Stop sharing" control ends the capture, so there's no manual
// `track.onended` wiring needed the way the old mesh code required.
//
// Quality badges (gap #2) are also fixed as of 2026-08-28: `linkQuality`
// comes from LiveKit's own participant.connectionQuality (computed
// server-side by the SFU, pushed via RoomEvent.ConnectionQualityChanged) —
// no client-side getStats() polling needed, unlike the deleted
// useConnectionQuality.ts this replaces. One real loss of resolution: no
// per-peer "relayed via TURN" fact survives this, since that was always a
// property of one mesh peer connection and there is no equivalent once every
// participant shares one SFU connection — see PeerLink's own comment.
//
// Stall-recovery (gap #3) is fixed as of 2026-08-28 too: restartPeerConnection
// no longer touches a connection (LiveKit has no per-peer one) — it
// unsubscribes and resubscribes that one participant's video track, the
// per-track equivalent of the old per-connection ICE restart, scoped the
// same way the original did (never touching a link everyone else already
// sees fine, per useStalledVideoRecovery.ts's own header).
//
// All three Stage-3 gaps are closed as of this pass.

export interface MediaPrefs {
  muted?: boolean;
  videoOff?: boolean;
}

export interface PeerInfo {
  id: string;
  name: string;
  stream: MediaStream | null;
  /** The peer's own camera track object, or null/absent if unpublished or
   *  unsubscribed — used by RemoteTile to call track.attach()/detach()
   *  directly instead of assigning a combined MediaStream to srcObject,
   *  which is what lets Room's adaptiveStream option observe the attached
   *  element's visibility and size to decide which simulcast layer (or
   *  none) to request. Optional because refreshScreenPeer below builds a
   *  PeerInfo for a screen-share tile, which has no camera track at all. */
  videoTrack?: RemoteVideoTrack | null;
  /** Same idea for the peer's mic track, attached directly to PeerAudio's
   *  <audio> element rather than via a combined-stream srcObject. */
  audioTrack?: RemoteAudioTrack | null;
}

const getFallbackName = (id: string) => {
  const cleanId = id.replace('user-', '').replace('tmp-', '');
  return `Guest (${cleanId.slice(0, 4).toUpperCase()})`;
};

/** Every subscribed track (audio + video) for one participant, combined into
 *  the same single-MediaStream-per-peer shape most of the UI still expects
 *  (useHasVideo's track-presence watch, tileOrder's hasVideo tiebreak, the
 *  `!peer.stream` "still connecting" gate) — LiveKit gives tracks
 *  individually, this is the seam that keeps that an internal detail for
 *  everything except the actual <video>/<audio> elements, which attach the
 *  individual track objects below directly (see PeerInfo's own comment). */
function buildParticipantStream(participant: RemoteParticipant): MediaStream | null {
  const tracks: MediaStreamTrack[] = [];
  participant.videoTrackPublications.forEach((pub) => {
    // Excludes ScreenShare the same way rebuildLocalStream does for the local
    // side — a remote peer's screen share is its own tile (screenPeers), not
    // part of their camera tile's stream.
    if (pub.track && pub.source !== Track.Source.ScreenShare) tracks.push(pub.track.mediaStreamTrack);
  });
  participant.audioTrackPublications.forEach((pub) => {
    if (pub.track) tracks.push(pub.track.mediaStreamTrack);
  });
  return tracks.length ? new MediaStream(tracks) : null;
}

function cameraVideoTrackFor(participant: RemoteParticipant): RemoteVideoTrack | null {
  let found: RemoteVideoTrack | null = null;
  participant.videoTrackPublications.forEach((pub) => {
    if (pub.source !== Track.Source.ScreenShare && pub.videoTrack) found = pub.videoTrack as RemoteVideoTrack;
  });
  return found;
}

function micAudioTrackFor(participant: RemoteParticipant): RemoteAudioTrack | null {
  let found: RemoteAudioTrack | null = null;
  participant.audioTrackPublications.forEach((pub) => {
    if (pub.audioTrack) found = pub.audioTrack as RemoteAudioTrack;
  });
  return found;
}

function peerInfoFor(participant: RemoteParticipant): PeerInfo {
  return {
    id: participant.identity,
    name: participant.name?.trim() || getFallbackName(participant.identity),
    stream: buildParticipantStream(participant),
    videoTrack: cameraVideoTrackFor(participant),
    audioTrack: micAudioTrackFor(participant),
  };
}

// LiveKit's SFU computes this server-side and pushes it — no client-side
// getStats() polling needed, unlike the mesh-era useConnectionQuality.ts this
// replaces. One real loss of resolution: LiveKit has a single degraded tier
// (Poor) where the old mesh grading had two (fair/poor); Poor is mapped to
// our more severe 'poor' rather than guessing at an intermediate 'fair' that
// the SFU never actually signals. `stats` is always null here — there is no
// clean per-peer "was this one relayed" fact once every participant's media
// goes through one shared SFU connection, so it's left honestly absent
// rather than filled with a guessed value (see PeerLink's own comment).
function mapConnectionQuality(q: ConnectionQuality): LinkQuality {
  switch (q) {
    case ConnectionQuality.Excellent:
    case ConnectionQuality.Good:
      return 'good';
    case ConnectionQuality.Poor:
    case ConnectionQuality.Lost:
      return 'poor';
    default:
      return 'unknown';
  }
}

export function useWebRTC() {
  const roomRef = useRef<Room | null>(null);

  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [peers, setPeers] = useState<PeerInfo[]>([]);
  const [isMuted, setIsMuted] = useState(false);
  const [isVideoOff, setIsVideoOff] = useState(false);
  const [mediaNotice, setMediaNotice] = useState<string | null>(null);
  const dismissMediaNotice = useCallback(() => setMediaNotice(null), []);

  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [screenStream, setScreenStream] = useState<MediaStream | null>(null);
  const [screenPeers, setScreenPeers] = useState<PeerInfo[]>([]);
  const [linkQuality, setLinkQuality] = useState<ReadonlyMap<string, PeerLink>>(new Map());

  // LiveKit's SFU already computes who is currently speaking (server-side audio
  // level detection, pushed to every participant including the speaker) — this
  // replaces the old client-side Web Audio AnalyserNode polling loop
  // (useAudioLevels.ts, deleted) that ran an RMS calculation every 120ms per
  // peer on the main thread purely to reinvent what the SFU already knows.
  const [activeSpeakerIds, setActiveSpeakerIds] = useState<Set<string>>(new Set());

  // Which remote peers currently have a mounted, visible tile — the grid only
  // renders one page at a time (usePagination) and the rest genuinely have no
  // <RemoteTile> in the DOM at all, so their camera video is unsubscribed
  // entirely rather than just hidden (see applyVideoSubscription below).
  // Audio is a separate concern and is never gated by this: PeerAudio mounts
  // one <audio> per peer for the whole call regardless of page, matching this
  // app's existing "hear everyone, see one page" design.
  const visiblePeerIdsRef = useRef<Set<string>>(new Set());

  // The one participant on the main stage (focus or explicit pin), or null in
  // plain grid mode. Exempt from GRID_MAX_DIMS — see its comment at the top.
  const stagePeerIdRef = useRef<string | null>(null);

  // Which peers' audio to subscribe. **null means everyone**, which is the
  // behaviour for every meeting small enough not to need a cap and is what the
  // caller passes below the tier threshold — so nothing about a normal call
  // changes.
  //
  // Above that threshold audio is the dominant cost, not video: each
  // participant subscribes N-1 audio streams, so the total is N*(N-1)*48kbps
  // and grows quadratically. At 76 people that is 295 Mbps — 47% of this
  // host's 625 Mbps link — for audio alone, against 4 Mbps of video per
  // subscriber under the video tier. Capping audio is worth more than capping
  // video, which is why it exists.
  //
  // Safe to cap because LiveKit computes active speakers SERVER-side from the
  // published tracks and reports them to everyone regardless of who is
  // subscribed (RoomEvent.ActiveSpeakersChanged below). So a peer nobody is
  // subscribed to still shows up the moment they talk, and the caller can
  // promote them. The cost is that the first ~1 signalling RTT of their speech
  // is missed, which is why this stays off entirely for small calls.
  const audioPeerIdsRef = useRef<Set<string> | null>(null);

  const applyAudioSubscription = useCallback((participant: RemoteParticipant) => {
    const allowed = audioPeerIdsRef.current;
    const want = allowed === null || allowed.has(participant.identity);
    participant.audioTrackPublications.forEach((pub) => {
      if (pub.isSubscribed !== want) pub.setSubscribed(want);
    });
  }, []);

  const setQualityFor = useCallback((identity: string, quality: ConnectionQuality) => {
    setLinkQuality((prev) => {
      const next = new Map(prev);
      next.set(identity, { quality: mapConnectionQuality(quality), stats: null });
      return next;
    });
  }, []);

  // Camera+mic only — explicitly excludes Track.Source.ScreenShare, which is
  // now a second publication on this same localParticipant. Without this
  // filter, starting a screen share would silently splice its video track
  // into the CAMERA preview's MediaStream (localStream), the exact bug this
  // filter exists to prevent.
  const rebuildLocalStream = useCallback(() => {
    const room = roomRef.current;
    if (!room) { setLocalStream(null); return; }
    const tracks: MediaStreamTrack[] = [];
    room.localParticipant.videoTrackPublications.forEach((pub) => {
      if (pub.track && pub.source !== Track.Source.ScreenShare) tracks.push(pub.track.mediaStreamTrack);
    });
    room.localParticipant.audioTrackPublications.forEach((pub) => {
      if (pub.track) tracks.push(pub.track.mediaStreamTrack);
    });
    setLocalStream(tracks.length ? new MediaStream(tracks) : null);
  }, []);

  // The local screen-share preview — deliberately a separate MediaStream
  // from localStream (camera), same reasoning as the mesh-era implementation:
  // screen share must never share a track slot with the camera.
  const rebuildScreenStream = useCallback(() => {
    const room = roomRef.current;
    if (!room) { setScreenStream(null); return; }
    let track: MediaStreamTrack | null = null;
    room.localParticipant.videoTrackPublications.forEach((pub) => {
      if (pub.track && pub.source === Track.Source.ScreenShare) track = pub.track.mediaStreamTrack;
    });
    setScreenStream(track ? new MediaStream([track]) : null);
  }, []);

  const refreshPeer = useCallback((participant: RemoteParticipant) => {
    setPeers((prev) => {
      const info = peerInfoFor(participant);
      const at = prev.findIndex((p) => p.id === info.id);
      if (at === -1) return [...prev, info];
      const next = [...prev];
      next[at] = info;
      return next;
    });
  }, []);

  // Remote screen shares are tracked entirely separately from `peers` (the
  // camera roster) — the UI treats "someone's screen" as its own tile
  // (ActiveMeetingView.tsx combines local-screen + screenPeers into one
  // presentation list), not a property of their camera tile.
  const refreshScreenPeer = useCallback((participant: RemoteParticipant) => {
    const screenPub = Array.from(participant.videoTrackPublications.values())
      .find((pub) => pub.source === Track.Source.ScreenShare && pub.track);
    setScreenPeers((prev) => {
      const withoutThisPeer = prev.filter((p) => p.id !== participant.identity);
      if (!screenPub?.track) return withoutThisPeer; // they stopped sharing (or never were) — just absent, not an error
      const stream = new MediaStream([screenPub.track.mediaStreamTrack]);
      const name = participant.name?.trim() || getFallbackName(participant.identity);
      return [...withoutThisPeer, { id: participant.identity, name, stream }];
    });
  }, []);

  // Audio always subscribes (see visiblePeerIdsRef's own comment); camera
  // video only subscribes for a participant currently in the visible set.
  // Screen share is a separate concern from the paginated camera grid —
  // `activeScreens` in ActiveMeetingView renders every active share
  // unconditionally, so its video always subscribes too, regardless of the
  // camera-grid visible set.
  const applyVideoSubscription = useCallback((participant: RemoteParticipant) => {
    const visible = visiblePeerIdsRef.current;
    // visiblePeerIds includes the LOCAL tile — ActiveMeetingView builds it from
    // `tiles`, which appends self — so this is the on-screen tile count, which
    // is what decides the tile width, not the remote-participant count.
    const capGridTiles = visible.size >= 3;
    participant.videoTrackPublications.forEach((pub) => {
      if (pub.source === Track.Source.ScreenShare) {
        // Screen share is deliberately NOT capped: it is text, it lives on the
        // main stage, and 960x540 (its own lower layer) is unreadable.
        if (!pub.isSubscribed) pub.setSubscribed(true);
        return;
      }
      const shouldSubscribe = visible.has(participant.identity);
      if (pub.isSubscribed !== shouldSubscribe) pub.setSubscribed(shouldSubscribe);
      if (!shouldSubscribe) return;
      // Must come AFTER setSubscribed: setVideoDimensions logs a warning and
      // no-ops on a publication the client has not asked for. It also early-
      // returns when the dimensions are unchanged, so re-running this on every
      // visible-set change costs nothing.
      const onStage = stagePeerIdRef.current === participant.identity;
      pub.setVideoDimensions(capGridTiles && !onStage ? GRID_MAX_DIMS : STAGE_MAX_DIMS);
    });
  }, []);

  // Called from ActiveMeetingView whenever which peers are actually on-screen
  // changes (pagination, focus/carousel swap, a tileOrder promotion). Applied
  // to every current remote participant, not just ones that changed — cheap
  // (setSubscribed no-ops when already in the requested state, checked above)
  // and avoids tracking a separate diff.
  const setVisiblePeerIds = useCallback((
    ids: Iterable<string>,
    stagePeerId?: string | null,
    audioIds?: Iterable<string> | null,
  ) => {
    visiblePeerIdsRef.current = new Set(ids);
    stagePeerIdRef.current = stagePeerId ?? null;
    // undefined/null means "no cap" — subscribe everyone, today's behaviour.
    audioPeerIdsRef.current = audioIds ? new Set(audioIds) : null;
    const room = roomRef.current;
    if (!room) return;
    room.remoteParticipants.forEach((p) => {
      applyVideoSubscription(p);
      applyAudioSubscription(p);
    });
  }, [applyVideoSubscription, applyAudioSubscription]);

  // Connects to the LiveKit room and publishes camera/mic per the lobby's
  // choice. Called by MeetingContext AFTER the existing /ws create_room/
  // join_room round trip succeeds and a LiveKit token has been minted for
  // that confirmed room_id — the /ws room membership check IS the
  // authorization for the token (see server/livekit.go), so this can't run
  // first the way the old initMedia() did.
  const connect = useCallback(async (livekitUrl: string, token: string, prefs: MediaPrefs = {}) => {
    // Hopping rooms on one tab (createMeeting/joinMeeting can be called again
    // without leaveMeeting in between — e.g. the host starting a fresh
    // meeting) must not leak the previous Room's connection.
    if (roomRef.current) {
      void roomRef.current.disconnect();
      roomRef.current = null;
    }

    // adaptiveStream: watches each subscribed video track's ATTACHED element
    // (see RemoteTile/PeerAudio, which call track.attach() rather than
    // assigning a combined MediaStream to srcObject — attach() is what wires
    // an element into this observation in the first place) and requests a
    // lower simulcast layer, or pauses entirely, for one that's off-screen or
    // small. dynacast stops the local publisher from encoding/sending a
    // simulcast layer nobody in the room currently needs, independent of
    // adaptiveStream. Both are additive — neither changes anything for a
    // track nobody has ever attached to an element.
    const room = new Room({ adaptiveStream: true, dynacast: true });
    roomRef.current = room;

    room.on(RoomEvent.ParticipantConnected, (participant: RemoteParticipant) => {
      refreshPeer(participant);
      setQualityFor(participant.identity, participant.connectionQuality);
      // Audio subscribes independently of tile visibility (see
      // visiblePeerIdsRef's comment) — a publication can already exist on
      // ParticipantConnected (a peer who was mid-publish when we joined), so
      // this can't wait for TrackPublished alone to cover it. Below the tier
      // threshold applyAudioSubscription subscribes unconditionally, exactly
      // as the unconditional call it replaces did.
      applyAudioSubscription(participant);
      applyVideoSubscription(participant);
    });
    room.on(RoomEvent.ParticipantDisconnected, (participant: RemoteParticipant) => {
      setPeers((prev) => prev.filter((p) => p.id !== participant.identity));
      setScreenPeers((prev) => prev.filter((p) => p.id !== participant.identity));
      setLinkQuality((prev) => {
        if (!prev.has(participant.identity)) return prev;
        const next = new Map(prev);
        next.delete(participant.identity);
        return next;
      });
    });
    // Fires for the local participant too (per LiveKit's own docs), harmless
    // here — nothing currently reads a 'local' entry out of this map, the
    // People panel only ever looks up OTHER participants' ids.
    room.on(RoomEvent.ConnectionQualityChanged, (quality: ConnectionQuality, participant: Participant) => {
      setQualityFor(participant.identity, quality);
    });
    // With autoSubscribe:false (below), a freshly published track does not
    // subscribe on its own — this is what applies the same
    // audio-always/video-if-visible rule from applyVideoSubscription to a
    // track that appears mid-call (e.g. someone turning their camera on for
    // the first time), not just to the participant's already-published set.
    room.on(RoomEvent.TrackPublished, (pub: RemoteTrackPublication, participant: RemoteParticipant) => {
      // Audio goes through the same tier gate as everywhere else — a peer who
      // publishes while capped out must NOT be silently subscribed here.
      if (pub.kind === Track.Kind.Audio) { applyAudioSubscription(participant); return; }
      applyVideoSubscription(participant);
    });
    room.on(RoomEvent.TrackSubscribed, (_track: RemoteTrack, pub: RemoteTrackPublication, participant: RemoteParticipant) => {
      if (pub.source === Track.Source.ScreenShare) refreshScreenPeer(participant);
      else refreshPeer(participant);
    });
    room.on(RoomEvent.TrackUnsubscribed, (_track: RemoteTrack, pub: RemoteTrackPublication, participant: RemoteParticipant) => {
      if (pub.source === Track.Source.ScreenShare) refreshScreenPeer(participant);
      else refreshPeer(participant);
    });
    // Found by actually testing stop-sharing, not by inspection: relying on
    // TrackUnsubscribed alone left a dead, disabled 2x2 screen-share track
    // rendered full-size in the guest's spotlight after the host stopped —
    // TrackUnpublished ("a RemoteParticipant has unpublished a track", per
    // LiveKit's own docs) is the semantically correct event for exactly this
    // case, and TrackUnsubscribed evidently isn't reliably redundant with it
    // for a source-side unpublish. Both wired now, same handler either way.
    room.on(RoomEvent.TrackUnpublished, (pub: RemoteTrackPublication, participant: RemoteParticipant) => {
      if (pub.source === Track.Source.ScreenShare) refreshScreenPeer(participant);
      else refreshPeer(participant);
    });
    room.on(RoomEvent.LocalTrackPublished, (pub: LocalTrackPublication) => {
      if (pub.source === Track.Source.ScreenShare) { setIsScreenSharing(true); rebuildScreenStream(); }
      else rebuildLocalStream();
    });
    room.on(RoomEvent.LocalTrackUnpublished, (pub: LocalTrackPublication) => {
      // Covers BOTH toggleScreenShare(false) below AND LiveKit's own handling
      // of the browser's native "Stop sharing" control ending the capture —
      // that path unpublishes on its own, with no app code involved, so this
      // listener (not a manual track.onended, unlike the old mesh code) is
      // what keeps isScreenSharing/screenStream in sync with it either way.
      if (pub.source === Track.Source.ScreenShare) { setIsScreenSharing(false); setScreenStream(null); }
      else rebuildLocalStream();
    });
    room.on(RoomEvent.Disconnected, () => {
      setPeers([]);
      setScreenPeers([]);
      setLocalStream(null);
      setScreenStream(null);
      setIsScreenSharing(false);
      setLinkQuality(new Map());
      setActiveSpeakerIds(new Set());
    });
    // Fires for every participant currently judged to be speaking, local
    // participant included — server-computed, replaces useAudioLevels.ts's
    // client-side AnalyserNode polling entirely (see activeSpeakerIds' own
    // comment above).
    room.on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) => {
      setActiveSpeakerIds(new Set(speakers.map((p) => p.identity)));
    });

    // ICE fallback for participants whose network can't reach the SFU's
    // direct UDP path (symmetric NAT, an outbound-UDP-blocking firewall) —
    // reuses the SAME coturn credentials connectionTest.ts already fetches
    // independently, not a new relay. Best-effort: a failed fetch here must
    // never block the call from connecting via LiveKit's default path, so
    // this only ever adds a fallback, never removes the attempt to connect.
    let iceServers: RTCIceServer[] | undefined;
    try {
      iceServers = (await api.getTurnCredentials()).iceServers;
    } catch (err) {
      console.warn('[LiveKit] TURN credentials unavailable, continuing without ICE fallback', err);
    }

    // autoSubscribe:false — pairs with applyVideoSubscription/TrackPublished/
    // ParticipantConnected above to keep camera video unsubscribed for any
    // peer with no mounted tile, instead of downloading every participant's
    // video regardless of what the grid is actually paginated to. Audio is
    // explicitly subscribed by hand everywhere a publication can appear
    // (ParticipantConnected, TrackPublished, and the existingRemotes seed
    // just below) specifically so this flag does not silently mute anyone.
    try {
      await room.connect(livekitUrl, token, { autoSubscribe: false, ...(iceServers ? { rtcConfig: { iceServers } } : {}) });
    } catch (err) {
      roomRef.current = null;
      throw err;
    }

    // Participants already in the room when we connect do NOT fire
    // ParticipantConnected (that event is only for joins after ours) — seed
    // them from the room's own snapshot instead, same job addPeers() used to
    // do from the /ws room_created/room_joined peer list. Also the third
    // place (besides ParticipantConnected and TrackPublished) that has to
    // apply the audio-always/video-if-visible subscription rule, since none
    // of those events fire for a publication that already existed before we
    // connected.
    const existingRemotes = Array.from(room.remoteParticipants.values());
    existingRemotes.forEach((p) => {
      applyAudioSubscription(p);
      applyVideoSubscription(p);
    });
    setPeers(existingRemotes.map(peerInfoFor));
    setLinkQuality(new Map(existingRemotes.map((p) => [p.identity, { quality: mapConnectionQuality(p.connectionQuality), stats: null }])));

    const wantVideo = !prefs.videoOff;
    const wantAudio = !prefs.muted;
    try {
      await room.localParticipant.setMicrophoneEnabled(wantAudio);
    } catch (err) {
      setMediaNotice(describeMediaError(err, 'microphone'));
    }
    try {
      await room.localParticipant.setCameraEnabled(wantVideo);
    } catch (err) {
      if (wantVideo) setMediaNotice(describeMediaError(err, 'camera'));
    }
    setIsMuted(!wantAudio);
    setIsVideoOff(!wantVideo);
    rebuildLocalStream();
  }, [refreshPeer, refreshScreenPeer, rebuildLocalStream, rebuildScreenStream, applyVideoSubscription, applyAudioSubscription]);

  const toggleMic = useCallback(() => {
    const room = roomRef.current;
    if (!room) return;
    const next = !isMuted;
    void room.localParticipant.setMicrophoneEnabled(!next).finally(() => setIsMuted(next));
  }, [isMuted]);

  const setMicMuted = useCallback((muted: boolean) => {
    const room = roomRef.current;
    if (!room) return;
    void room.localParticipant.setMicrophoneEnabled(!muted).finally(() => setIsMuted(muted));
  }, []);

  const toggleCamera = useCallback(async () => {
    const room = roomRef.current;
    if (!room) return;
    const next = !isVideoOff;
    try {
      await room.localParticipant.setCameraEnabled(!next);
      setIsVideoOff(next);
      rebuildLocalStream();
    } catch (err) {
      console.error('[toggleCamera] failed', err);
      setMediaNotice(describeMediaError(err, 'camera'));
    }
  }, [isVideoOff, rebuildLocalStream]);

  // Gap #1 — see file header. Explicit, visible failure rather than a
  // A second published track on the SAME Room/LocalParticipant camera and
  // mic already use — see the file header. isScreenSharing/screenStream are
  // actually driven by the LocalTrackPublished/LocalTrackUnpublished
  // listeners in connect() above, not set directly here, so that LiveKit's
  // own handling of the browser's native "Stop sharing" control (which
  // unpublishes with no app code involved) keeps this state correct too —
  // this function only ever needs to ask LiveKit to start or stop, not
  // separately track whether it succeeded.
  const toggleScreenShare = useCallback(async () => {
    const room = roomRef.current;
    if (!room) return;
    if (isScreenSharing) {
      try { await room.localParticipant.setScreenShareEnabled(false); }
      catch (err) { console.warn('[toggleScreenShare] stop failed:', err); }
      return;
    }
    try {
      await room.localParticipant.setScreenShareEnabled(true);
    } catch (err) {
      // A user dismissing the picker throws NotAllowedError — not an error
      // worth surfacing, same rule the old mesh implementation used.
      if ((err as { name?: string })?.name !== 'NotAllowedError') {
        console.warn('[toggleScreenShare] start failed:', err);
        setMediaNotice("Couldn't start screen sharing on this device or browser.");
      }
    }
  }, [isScreenSharing]);

  const switchCamera = useCallback(async (deviceId: string) => {
    const room = roomRef.current;
    if (!room) return;
    try {
      await room.switchActiveDevice('videoinput', deviceId);
      rebuildLocalStream();
    } catch (err) {
      console.error('[switchCamera]', err);
      setMediaNotice(describeMediaError(err, 'camera'));
    }
  }, [rebuildLocalStream]);

  const switchMic = useCallback(async (deviceId: string) => {
    const room = roomRef.current;
    if (!room) return;
    try {
      await room.switchActiveDevice('audioinput', deviceId);
      rebuildLocalStream();
    } catch (err) {
      console.error('[switchMic]', err);
      setMediaNotice(describeMediaError(err, 'microphone'));
    }
  }, [rebuildLocalStream]);

  // LiveKit's own connection has its own independent, built-in reconnection
  // (RoomEvent.Reconnecting/Reconnected/SignalReconnecting) — it is a SEPARATE
  // socket to a SEPARATE server from /ws, so a /ws drop (reenterRoom,
  // MeetingContext.tsx) does not imply this connection dropped too, and
  // shouldn't blindly rebuild it and throw that built-in recovery away. This
  // is what lets a caller check first: only reconnect LiveKit if it's
  // actually disconnected (e.g. its own reconnection gave up after the
  // access token's TTL lapsed during a long outage), not on every /ws hiccup.
  const isMediaConnected = useCallback(
    () => !!roomRef.current && roomRef.current.state !== ConnectionState.Disconnected,
    [],
  );

  // The mesh-era fix for "this one peer's decode has quietly stalled" was
  // pc.restartIce() + a follow-up offer, scoped to that one peer's own
  // RTCPeerConnection (see useStalledVideoRecovery.ts's header — deliberately
  // never touching a link everyone else already sees fine). LiveKit has no
  // per-peer connection to restart, but it does have a per-TRACK equivalent:
  // unsubscribing and resubscribing forces the SFU to redeliver that
  // participant's stream fresh (a new keyframe, effectively), without
  // touching the shared transport or any other participant's subscription.
  // Scoped to VIDEO only, not audio — the detector this feeds
  // (useStalledVideoRecovery) watches a <video> element's own currentTime,
  // so it's specifically a video-decode symptom; resubscribing audio too
  // would add an audible hiccup for a problem that was never in the audio.
  // A short gap between unsubscribe and resubscribe, not back-to-back in the
  // same tick, to give the unsubscribe an actual round trip to the SFU
  // before asking it to subscribe again.
  const restartPeerConnection = useCallback((peerId: string) => {
    const room = roomRef.current;
    if (!room) return;
    const participant = room.remoteParticipants.get(peerId);
    if (!participant) return;
    participant.videoTrackPublications.forEach((pub) => {
      if (pub.source === Track.Source.ScreenShare || !pub.isSubscribed) return;
      pub.setSubscribed(false);
      setTimeout(() => pub.setSubscribed(true), 300);
    });
  }, []);

  // Kept as no-ops, not deleted, so MeetingContext's existing call sites
  // (registerPeerName on a mid-call rename, addPeers from the old
  // room_created/room_joined flow) don't need to change in this pass. Real
  // behavior change: peer display names now come from LiveKit's own
  // participant.name (set once, at token-mint time, from the SAME user_name
  // the /ws join already sends) rather than from a hand-maintained registry —
  // simpler, but a mid-call rename will not reach already-connected peers
  // until they reconnect. Flagged, not fixed, in the Stage 2 plan.
  const registerPeerName = useCallback((_peerId: string, _name: string) => {}, []);
  const addPeers = useCallback((_incoming: { id: string; name?: string }[]) => {}, []);

  const resetPeers = useCallback(() => {
    setPeers([]);
  }, []);

  const cleanup = useCallback(() => {
    const room = roomRef.current;
    roomRef.current = null;
    if (room && room.state !== ConnectionState.Disconnected) {
      void room.disconnect();
    }
    setPeers([]);
    setScreenPeers([]);
    setLocalStream(null);
    setScreenStream(null);
    setIsScreenSharing(false);
    setIsMuted(false);
    setIsVideoOff(false);
    setMediaNotice(null);
    setLinkQuality(new Map());
    setActiveSpeakerIds(new Set());
    visiblePeerIdsRef.current = new Set();
    stagePeerIdRef.current = null;
    audioPeerIdsRef.current = null;
  }, []);

  useEffect(() => () => cleanup(), [cleanup]);

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
    linkQuality,
    activeSpeakerIds,
    setVisiblePeerIds,
    connect,
    isMediaConnected,
    toggleMic,
    setMicMuted,
    toggleCamera,
    toggleScreenShare,
    switchCamera,
    switchMic,
    restartPeerConnection,
    cleanup,
    resetPeers,
    registerPeerName,
    addPeers,
  };
}
