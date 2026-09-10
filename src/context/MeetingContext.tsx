import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { SignalingSocket } from '../lib/signalingSocket';
import { useAuth } from './AuthContext';
import { useWebRTC, PeerInfo, MediaPrefs } from '../hooks/useWebRTC';
import { api } from '../lib/api';
import { makeFloatingReaction, isReaction, REACTION_TTL_MS, type FloatingReaction } from '../lib/reactions';
import { extractKeyPoints, type CaptionEvent, type KeyPoint, type TranscriptLine } from '../lib/captions';
import type { PeerLink } from '../lib/connectionStats';
import { config } from '../config';

export interface AppUser { id: string; name: string; isGuest: boolean; }
export interface LiveChatMessage { id: string; fromId: string; fromName: string; text: string; time: string; isSelf: boolean; }
export interface ScheduledMeeting { id: string; title: string; date: string; time: string; code: string; }
/** One knock-to-join request, as seen by someone already in the call. */
export interface JoinRequest { requestId: string; userId: string; userName: string; }

interface MeetingContextType {
  user: AppUser;
  setUserName: (name: string, isGuest?: boolean) => void;
  isInMeeting: boolean;
  // Meet/WhatsApp-style picture-in-picture: the call keeps running while the rest of
  // the app is usable. The RTCPeerConnections live here, not in ActiveMeetingView, so
  // minimising only swaps which UI is mounted — nothing about the call is torn down.
  isMinimized: boolean;
  minimizeMeeting: () => void;
  expandMeeting: () => void;
  roomId: string | null;
  isHost: boolean;
  showInviteDialog: boolean;
  dismissInviteDialog: () => void;
  /** Set when this tab has been evicted by the same account connecting elsewhere —
   *  see EVICTED_CODE in signalingSocket.ts. The socket will not reconnect on its own. */
  evictedNotice: string | null;
  dismissEvictedNotice: () => void;
  createMeeting: (customCode?: string, title?: string, prefs?: MediaPrefs) => Promise<string>;
  joinMeeting: (code: string, title?: string, allowRecreate?: boolean, prefs?: MediaPrefs) => Promise<string>;
  /** True from the moment join_room/create_room is sent until either an
   *  existing participant lets this one in (isInMeeting flips true) or
   *  rejects/times it out (joinDeniedReason gets set) — a room that already
   *  has other people in it doesn't admit a new, never-before-seen identity
   *  on the spot any more; see the knock-to-join flow in server/main.go. */
  awaitingApproval: boolean;
  /** Set once a knock is turned down — either an explicit reject or nobody
   *  responding within the server's own timeout. Cleared on the next join
   *  attempt. Distinguishing this from meetingError lets the UI show a
   *  specific "you weren't let in" screen rather than a generic failure. */
  joinDeniedReason: 'denied' | 'timed_out' | null;
  clearJoinDenied: () => void;
  /** Knock requests currently awaiting a decision from THIS participant (or
   *  anyone else already in the call — whoever answers first wins, see
   *  server/main.go's join_response). Rendered as an accept/reject popup. */
  pendingJoinRequests: JoinRequest[];
  respondToJoinRequest: (requestId: string, approve: boolean) => void;
  /** Whether this room currently requires approval to join — off by default
   *  for every room; see server/main.go's Room.requireApproval for why this
   *  is opt-in rather than automatic. Toggleable at any point during the
   *  call, by anyone currently in it, not fixed at creation time. */
  requireApproval: boolean;
  setRequireApproval: (value: boolean) => void;
  /** Non-fatal media problem to show the user (camera blocked, device busy…). */
  mediaNotice: string | null;
  dismissMediaNotice: () => void;
  rejoinMeeting: (code: string) => Promise<void>;
  isRejoining: boolean;
  leaveMeeting: () => void;
  scheduledMeetings: ScheduledMeeting[];
  refreshScheduledMeetings: () => Promise<void>;
  scheduleMeeting: (title: string, date: string, time: string, invitedUsers?: string[]) => Promise<string>;
  deleteScheduledMeeting: (id: string) => Promise<void>;
  localStream: MediaStream | null;
  peers: PeerInfo[];
  isMuted: boolean;
  isVideoOff: boolean;
  isScreenSharing: boolean;
  screenStream: MediaStream | null;
  screenPeers: PeerInfo[];
  toggleMic: () => void;
  /** Absolute mic control, used by push-to-talk. */
  setMicMuted: (muted: boolean) => void;
  toggleCamera: () => Promise<void>;
  toggleScreenShare: () => Promise<void>;
  switchCamera: (deviceId: string) => Promise<void>;
  switchMic: (deviceId: string) => Promise<void>;
  /** Per-peer connection quality, pushed by LiveKit's own SFU-computed
   *  participant.connectionQuality — see useWebRTC.ts. */
  linkQuality: ReadonlyMap<string, PeerLink>;
  /** Ids currently judged to be speaking, local participant included —
   *  server-computed by the SFU (RoomEvent.ActiveSpeakersChanged). */
  activeSpeakerIds: ReadonlySet<string>;
  /** Tells useWebRTC which remote peers currently have a mounted tile, so it
   *  can subscribe/unsubscribe their camera video accordingly — see
   *  useWebRTC.ts's visiblePeerIdsRef for the full reasoning. */
  setVisiblePeerIds: (ids: Iterable<string>, stagePeerId?: string | null, audioIds?: Iterable<string> | null) => void;
  /** Forces fresh ICE + a follow-up offer on one peer's camera connection. Used to
   *  recover a link that is 'connected' but has quietly stopped decoding frames. */
  restartPeerConnection: (peerId: string) => void;
  /** Reactions currently floating on screen; each expires on its own timer. */
  reactions: FloatingReaction[];
  sendReaction: (emoji: string) => void;
  /** Peer ids with a raised hand, including your own when raised. */
  raisedHands: ReadonlySet<string>;
  isHandRaised: boolean;
  toggleHand: () => void;
  chatMessages: LiveChatMessage[];
  sendChatMessage: (text: string) => void;
  /** Latest live-caption event per currently-speaking participant (partial or
   *  final), for the on-screen caption bar. */
  liveCaptions: ReadonlyMap<string, CaptionEvent>;
  /** Finalized captions only, oldest first, for the Transcript side panel. */
  captionLog: TranscriptLine[];
  captionKeyPoints: KeyPoint[];
  /** This viewer's own chosen caption/translation language, or null for
   *  "show the original language, no translation". */
  myCaptionLang: string | null;
  setCaptionLang: (lang: string | null) => void;
  clearCaptionLog: () => void;
  showGuestModal: boolean;
  pendingJoinCode: string | null;
  setPendingAction: (code: string | null) => void;
  dismissGuestModal: () => void;
  meetingError: string | null;
  clearMeetingError: () => void;
}

const MeetingContext = createContext<MeetingContextType | null>(null);

const WS_URL = config.wsUrl;

function getOrCreateUserId(): string {
  let id = sessionStorage.getItem('ibconnect_user_id');
  if (!id) { id = `user-${Math.random().toString(36).slice(2, 10)}`; sessionStorage.setItem('ibconnect_user_id', id); }
  return id;
}

// Reloading the page tears down every RTCPeerConnection and the signaling socket,
// so the only way back into the call is to redial it. We stash just enough to do
// that in sessionStorage — per-tab, and gone when the tab closes, which matches
// what "I'm currently in this meeting" actually means.
const ACTIVE_MEETING_KEY = 'ibconnect_active_meeting';
export interface ActiveMeetingRecord { roomId: string; isHost: boolean; title?: string; }

function persistActiveMeeting(roomId: string, isHost: boolean, title?: string) {
  try { sessionStorage.setItem(ACTIVE_MEETING_KEY, JSON.stringify({ roomId, isHost, title })); } catch {}
}
function clearActiveMeeting() {
  try { sessionStorage.removeItem(ACTIVE_MEETING_KEY); } catch {}
}
export function readActiveMeeting(): ActiveMeetingRecord | null {
  try {
    const raw = sessionStorage.getItem(ACTIVE_MEETING_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed?.roomId ? parsed : null;
  } catch { return null; }
}

export function MeetingProvider({ children }: { children: React.ReactNode }) {
  const socketRef = useRef<SignalingSocket | null>(null);
  const [socketInstance, setSocketInstance] = useState<SignalingSocket | null>(null);

  const [user, setUser] = useState<AppUser>(() => {
    try {
      const me = localStorage.getItem('ibconnect_me');
      if (me) { const parsed = JSON.parse(me); return { id: parsed.id, name: parsed.displayName, isGuest: false }; }
    } catch {}
    return { id: getOrCreateUserId(), name: sessionStorage.getItem('ibconnect_user_name') ?? 'Guest', isGuest: true };
  });

  // Written synchronously by setUserName so a guest who types a name and joins in
  // the same handler doesn't send the stale name captured by the join closure.
  const nameRef = useRef(user.name);
  useEffect(() => { nameRef.current = user.name; }, [user.name]);

  const [isInMeeting, setIsInMeeting] = useState(false);
  const [isMinimized, setIsMinimized] = useState(false);
  const [roomId, setRoomId] = useState<string | null>(null);
  const [isHost, setIsHost] = useState(false);
  const [isRejoining, setIsRejoining] = useState(false);
  const [showInviteDialog, setShowInviteDialog] = useState(false);
  const [evictedNotice, setEvictedNotice] = useState<string | null>(null);
  const [chatMessages, setChatMessages] = useState<LiveChatMessage[]>([]);
  const [reactions, setReactions] = useState<FloatingReaction[]>([]);
  const [raisedHands, setRaisedHands] = useState<ReadonlySet<string>>(() => new Set());
  const [isHandRaised, setIsHandRaised] = useState(false);
  const [liveCaptions, setLiveCaptions] = useState<ReadonlyMap<string, CaptionEvent>>(() => new Map());
  const [captionLog, setCaptionLog] = useState<TranscriptLine[]>([]);
  const [captionKeyPoints, setCaptionKeyPoints] = useState<KeyPoint[]>([]);
  const [myCaptionLang, setMyCaptionLang] = useState<string | null>(null);
  const [scheduledMeetings, setScheduledMeetings] = useState<ScheduledMeeting[]>([]);
  const [meetingError, setMeetingError] = useState<string | null>(null);
  const [awaitingApproval, setAwaitingApproval] = useState(false);
  const [joinDeniedReason, setJoinDeniedReason] = useState<'denied' | 'timed_out' | null>(null);
  const [pendingJoinRequests, setPendingJoinRequests] = useState<JoinRequest[]>([]);
  const [requireApproval, setRequireApprovalState] = useState(false);
  const [showGuestModal, setShowGuestModal] = useState(false);
  const [pendingJoinCode, setPendingJoinCode] = useState<string | null>(null);

  // Single source of truth for keeping the address bar in sync with the active room,
  // no matter how the meeting was entered (Start Meeting, join code, schedule link,
  // or a direct call from a profile/Contacts). Previously each entry point had to
  // remember to call `history.replaceState` itself — CallsView's direct-call flow
  // never did, so the caller's URL stayed on `/` while the callee's (joined via
  // DebriefView, which did remember) updated correctly. Centralizing it here means
  // every future call site gets this for free. Only reacts to actual isInMeeting
  // transitions (via the ref) rather than "reset to / whenever not in a meeting",
  // so it doesn't stomp on a `/:roomCode` URL someone landed on before joining.
  const wasInMeetingRef = useRef(false);
  useEffect(() => {
    if (isInMeeting && roomId) {
      if (window.location.pathname !== `/${roomId}`) {
        window.history.replaceState(null, '', `/${roomId}`);
      }
    } else if (wasInMeetingRef.current && !isInMeeting) {
      if (window.location.pathname !== '/') {
        window.history.replaceState(null, '', '/');
      }
    }
    wasInMeetingRef.current = isInMeeting;
  }, [isInMeeting, roomId]);

  const userIdRef = useRef(user.id);
  useEffect(() => { userIdRef.current = user.id; }, [user.id]);
  const currentRecordIdRef = useRef<string | null>(null);

  // ── Identity must follow the signed-in account ─────────────────────────────
  //
  // The `useState` initialiser above reads `ibconnect_me` from localStorage exactly
  // once, at mount. AuthContext writes that key *after* it resolves — on a fresh sign-in
  // the OIDC callback calls `loginWithToken` well after MeetingProvider has mounted, so
  // the initialiser found nothing and fell through to
  // `{ id: getOrCreateUserId(), name: 'Guest' }` — and nothing ever re-read it.
  //
  // The consequences were all reported as separate bugs:
  //   * `create_room` sent `user_name: "Guest"`, so everyone who joined by link saw the
  //     host as "Guest" instead of their account name;
  //   * it also sent a throwaway `user_id`, so the host occupied the room under an id
  //     unrelated to their account — which breaks the server's same-user eviction on
  //     reconnect and the `selfId < peerId` politeness tie-break;
  //   * `raisedHands` was keyed by `getOrCreateUserId()` while tiles are keyed by
  //     `user.id`, so your own raised hand never appeared on your own tile.
  //
  // Syncing from AuthContext fixes all three at the source. There was already a
  // `getFreshName()` helper written for this and never called; it is gone now.
  const { currentUser } = useAuth();
  useEffect(() => {
    if (!currentUser) return;
    setUser((prev) => {
      if (prev.id === currentUser.id && prev.name === currentUser.displayName && !prev.isGuest) return prev;
      // Refs are written synchronously as well as through state: a user who signs in and
      // immediately creates a room would otherwise send the stale closure-captured value,
      // which is the same race `nameRef` already exists to close for guests.
      nameRef.current = currentUser.displayName;
      userIdRef.current = currentUser.id;
      return { id: currentUser.id, name: currentUser.displayName, isGuest: false };
    });
  }, [currentUser]);

  const refreshScheduledMeetings = useCallback(async () => {
    try {
      if (user.isGuest) return;
      const data = await api.getScheduledMeetings();
      setScheduledMeetings(data);
    } catch (e) { console.error('Failed to load meetings', e); }
  }, [user.isGuest]);

  useEffect(() => { refreshScheduledMeetings(); }, [refreshScheduledMeetings]);

  const scheduleMeeting = useCallback(async (title: string, date: string, time: string, invitedUsers: string[] = []): Promise<string> => {
    try {
      const newMeeting = await api.scheduleMeeting({ title, date, time, invitedUsers });
      setScheduledMeetings(prev => [...prev, newMeeting]);
      return newMeeting.code;
    } catch (err: any) {
      setMeetingError(err.message || 'Failed to schedule meeting');
      throw err;
    }
  }, []);

  const deleteScheduledMeeting = useCallback(async (id: string) => {
    try {
      await api.deleteScheduledMeeting(id);
      setScheduledMeetings(prev => prev.filter(m => m.id !== id));
    } catch (err) { setMeetingError('Failed to delete meeting'); }
  }, []);

  const saveMeetingRecord = useCallback((roomCode: string, isHostVal: boolean, title?: string) => {
    const id = `mr-${Date.now()}`;
    const key = `ibconnect_meeting_history_${userIdRef.current}`;
    try {
      const history = JSON.parse(localStorage.getItem(key) || '[]');
      const record = { id, roomCode, title: title || roomCode, isHost: isHostVal, startedAt: new Date().toISOString(), participantCount: 1 };
      localStorage.setItem(key, JSON.stringify([...history, record].slice(-50)));
    } catch {}
    currentRecordIdRef.current = id;
  }, []);

  const updateMeetingRecord = useCallback((participantCount: number) => {
    if (!currentRecordIdRef.current) return;
    const key = `ibconnect_meeting_history_${userIdRef.current}`;
    try {
      const history = JSON.parse(localStorage.getItem(key) || '[]');
      const updated = history.map((r: any) => r.id === currentRecordIdRef.current ? { ...r, endedAt: new Date().toISOString(), participantCount } : r);
      localStorage.setItem(key, JSON.stringify(updated));
    } catch {}
    currentRecordIdRef.current = null;
  }, []);

  // Media transport is LiveKit now — this hook no longer needs the signaling
  // socket or a perfect-negotiation tie-break id (see useWebRTC.ts's header).
  const webrtc = useWebRTC();

  const setUserName = useCallback((name: string, isGuest = true) => {
    const trimmed = name.trim() || 'Guest';
    sessionStorage.setItem('ibconnect_user_name', trimmed);
    nameRef.current = trimmed;
    setUser((prev) => ({ ...prev, name: trimmed, isGuest }));

    // Auto-update peers in room without duplicating profile
    if (isInMeeting) {
        webrtc.registerPeerName(user.id, trimmed);
    }
  }, [isInMeeting, webrtc, user.id]);

  // Which room this tab believes it is in, readable from callbacks that outlive a
  // render (the socket's reconnect handler, most importantly).
  const activeRoomRef = useRef<{ code: string; isHost: boolean } | null>(null);
  // Indirection so the long-lived socket always calls the *current* re-entry
  // closure rather than the one that existed when it was constructed.
  const reconnectRef = useRef<() => void>(() => {});

  const connectSocket = useCallback(async (): Promise<SignalingSocket> => {
    if (socketRef.current?.isOpen) return socketRef.current;
    const s = new SignalingSocket(WS_URL, () => reconnectRef.current(), () => {
      // This tab lost its seat to another tab/device signed in as the same account —
      // see EVICTED_CODE in signalingSocket.ts. The socket has deliberately stopped
      // reconnecting (doing so would just get evicted again), so this tab's view of
      // the call is now frozen. Surface that plainly rather than leaving a call screen
      // that silently stops updating with no explanation.
      setEvictedNotice("You've joined this meeting from another device or tab — this window is no longer connected.");
    });
    s.on('chat_message', (p: any) => setChatMessages(prev => [...prev, { id: `chat-${Date.now()}-${Math.random()}`, fromId: p.from_id, fromName: p.from_name, text: p.text, time: p.time, isSelf: p.from_id === userIdRef.current }]));
    // Reactions expire on their own timer rather than being cleared by the sender,
    // so a peer who leaves mid-animation does not strand one on screen forever.
    s.on('reaction', (p: any) => {
      if (!isReaction(String(p?.emoji ?? ''))) return;
      const rx = makeFloatingReaction(p.peer_id, p.peer_name ?? 'Someone', p.emoji);
      setReactions((prev) => [...prev, rx]);
      setTimeout(() => setReactions((prev) => prev.filter((r) => r.id !== rx.id)), REACTION_TTL_MS);
    });
    s.on('hand_state', (p: any) => {
      setRaisedHands((prev) => {
        const next = new Set(prev);
        if (p?.raised) next.add(p.peer_id); else next.delete(p.peer_id);
        return next;
      });
    });
    // A hand belongs to a participant, so it has to come down when they leave —
    // otherwise the roster shows a raised hand for someone who is no longer in
    // the room and nobody can lower it.
    s.on('peer_left', (p: any) => {
      setRaisedHands((prev) => {
        if (!prev.has(p?.peer_id)) return prev;
        const next = new Set(prev);
        next.delete(p.peer_id);
        return next;
      });
      setLiveCaptions((prev) => {
        if (!prev.has(p?.peer_id)) return prev;
        const next = new Map(prev);
        next.delete(p.peer_id);
        return next;
      });
    });
    // Sent by the /asr relay via room.broadcastAll (server/transcription_relay.go),
    // which does NOT exclude the sender — a speaker sees their own captions
    // too, in whatever language THEY have selected, through this exact same
    // path as everyone else. No special-casing needed here for "is this me".
    s.on('caption', (p: any) => {
      const evt: CaptionEvent = {
        peerId: p.peer_id, peerName: p.peer_name ?? 'Someone',
        text: p.text ?? '', lang: p.lang ?? 'en', isFinal: !!p.is_final,
        confidence: p.confidence, translations: p.translations ?? undefined,
        capId: p.cap_id, receivedAt: Date.now(),
      };
      setLiveCaptions((prev) => {
        const next = new Map(prev);
        next.set(evt.peerId, evt);
        return next;
      });
      if (evt.isFinal && evt.text) {
        const line: TranscriptLine = {
          id: `cap-${Date.now()}-${Math.random()}`, text: evt.text, isFinal: true,
          timestamp: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
          speaker: evt.peerName, lang: evt.lang, translations: evt.translations, capId: evt.capId,
        };
        setCaptionLog((prev) => [...prev, line].slice(-50));
        const kps = extractKeyPoints(evt.text);
        if (kps.length) setCaptionKeyPoints((prev) => [...prev, ...kps].slice(-20));
      }
    });
    // Arrives separately from — and after — the "caption" final it belongs
    // to, since translation now runs asynchronously server-side rather than
    // blocking the original caption every viewer sees (see
    // handleASREvent's own comment in transcription_relay.go for why that
    // changed: translation moved off the old fast NLLB model onto the much
    // slower Qwen chat model once NLLB was removed from the GPU VM). Matched
    // by cap_id, not peer_id alone — a peer's live caption entry may already
    // have moved on to a NEWER utterance by the time this arrives, and
    // attaching a stale translation to the wrong line would show the wrong
    // text translated. If the peer's current entry has moved on, this is
    // simply dropped for the live bar (too late to matter there) but the
    // matching transcript log line is still updated — that's for the
    // written record, which cares about eventual correctness, not timing.
    s.on('caption_translation', (p: any) => {
      const capId = p?.cap_id;
      const translations = p?.translations;
      if (!capId || !translations) return;
      setLiveCaptions((prev) => {
        const current = prev.get(p.peer_id);
        if (!current || current.capId !== capId) return prev;
        const next = new Map(prev);
        next.set(p.peer_id, { ...current, translations });
        return next;
      });
      setCaptionLog((prev) => {
        const idx = prev.findIndex((line) => line.capId === capId);
        if (idx === -1) return prev;
        const next = [...prev];
        next[idx] = { ...next[idx], translations };
        return next;
      });
    });
    s.on('error', (p: any) => setMeetingError(p.message));

    // ── Knock-to-join (see server/main.go's attemptRoomEntry) ──────────────
    // join_waiting: sent to US when the room we're entering already has other
    // people in it and we haven't been admitted before — createMeeting/
    // joinMeeting's own promises deliberately do NOT resolve/reject on this;
    // it just flips a flag so the UI can show a "waiting to be let in" screen
    // in the meantime. Cleared again by room_joined/join_rejected below.
    s.on('join_waiting', () => { setAwaitingApproval(true); setJoinDeniedReason(null); });
    s.on('join_rejected', (p: any) => {
      setAwaitingApproval(false);
      setJoinDeniedReason(p?.reason === 'timed_out' ? 'timed_out' : 'denied');
    });
    // join_request: sent to everyone ALREADY in the room when someone new
    // knocks. Several people can see the same request; whoever answers it
    // first wins (server/main.go removes it from room.pending on the first
    // join_response and tells everyone else's popup to close via
    // join_request_cancelled below) — so this list can only ever be added to
    // or fully cleared of one entry, never partially "claimed" client-side.
    s.on('join_request', (p: any) => {
      setPendingJoinRequests((prev) => {
        if (prev.some((r) => r.requestId === p.request_id)) return prev;
        return [...prev, { requestId: p.request_id, userId: p.user_id, userName: p.user_name ?? 'Someone' }];
      });
    });
    s.on('join_request_cancelled', (p: any) => {
      setPendingJoinRequests((prev) => prev.filter((r) => r.requestId !== p?.request_id));
    });
    // Broadcast rather than local-only, so this reflects whoever most
    // recently toggled it (including from a different tab/device of the
    // same account) rather than going stale the moment someone else changes it.
    s.on('require_approval', (p: any) => setRequireApprovalState(!!p?.value));

    await s.connect();
    socketRef.current = s; setSocketInstance(s); return s;
  }, []);

  // Sends a room entry message and resolves with the peers already inside.
  const requestRoomEntry = (s: SignalingSocket, type: 'join_room' | 'create_room', payload: any): Promise<any[]> =>
    new Promise((resolve, reject) => {
      const done = () => { clearTimeout(timer); offOk(); offErr(); };
      const offOk = s.on(type === 'create_room' ? 'room_created' : 'room_joined', (p: any) => { done(); resolve(p?.peers ?? []); });
      const offErr = s.on('error', (p: any) => { done(); reject(new Error(p?.message || 'Room entry failed')); });
      const timer = setTimeout(() => { done(); reject(new Error('Timed out re-entering the meeting')); }, 10000);
      s.send(type, payload);
    });

  // The signaling socket reconnects on its own after a drop, but the server has no
  // memory of who it was: the reconnected socket is a brand-new client sitting in
  // no room at all. Without re-entering, the tab is silently orphaned — media
  // already flowing over the existing peer connections keeps the call *looking*
  // fine, while everyone else was told we left, so anyone who joins or reloads
  // afterwards can't see us and we can't see them. A phone locking its screen or
  // hopping wifi→cellular mid-call is all it takes.
  const reenterRoom = useCallback(async () => {
    const active = activeRoomRef.current;
    const s = socketRef.current;
    if (!active || !s?.isOpen) return;

    const payload = { room_id: active.code, user_id: userIdRef.current, user_name: nameRef.current };
    try {
      await requestRoomEntry(s, 'join_room', payload);
    } catch (err) {
      // The room is gone: reaped after emptying, or erased by a backend restart
      // (rooms is an in-memory map, server/main.go). Reopen it under the same
      // code — for ANYONE, not just the host.
      //
      // This used to bail out here unless active.isHost. That made a backend
      // restart asymmetric in the worst possible way: every socket reconnects
      // at once, the host silently recreates the room, and everyone else is
      // told 'Lost connection to the meeting. Rejoin to continue.' while their
      // media is still flowing perfectly — LiveKit's connection is independent
      // of this one and never noticed. So the call looked alive and was not.
      //
      // Letting anyone recreate is safe because 'host' is a purely CLIENT-side
      // notion: the Go backend has no host concept at all (no hostID field
      // anywhere in server/main.go), and create_room reuses an existing room
      // for the code rather than replacing it. When several clients race here
      // after a restart, roomsMu serialises them: the first creates the room,
      // the rest reuse it, and attemptRoomEntry admits them all. Recreating
      // confers no privilege — it just means arriving first.
      try { await requestRoomEntry(s, 'create_room', payload); }
      catch { setMeetingError('Lost connection to the meeting. Rejoin to continue.'); return; }
    }

    // This redial is recovering the /ws SIGNALING socket, which is a
    // completely separate connection from LiveKit's — a /ws drop does not
    // mean the LiveKit room dropped too. Only reconnect it if it's actually
    // not connected (LiveKit's own reconnection gave up, most likely because
    // the access token's short TTL lapsed during a long outage); otherwise
    // leave a still-healthy media connection alone.
    if (!webrtc.isMediaConnected()) {
      try {
        const { token, url } = await api.getLiveKitToken(active.code, userIdRef.current, nameRef.current);
        await webrtc.connect(url, token);
      } catch (err) {
        setMeetingError('Lost connection to the meeting. Rejoin to continue.');
      }
    }
  }, [webrtc]);
  useEffect(() => { reconnectRef.current = reenterRoom; }, [reenterRoom]);

  const createMeeting = useCallback(async (customCode?: string, title?: string, prefs?: MediaPrefs): Promise<string> => {
    try {
      setMeetingError(null);
      setEvictedNotice(null);
      setAwaitingApproval(false);
      setJoinDeniedReason(null);
      // Drop any peers/messages left over from a previous room on this tab —
      // otherwise the last call's participants linger as blank tiles in the new one.
      webrtc.resetPeers();
      setChatMessages([]);
      const s = await connectSocket();
      const roomId = await new Promise<string>((resolve, reject) => {
        const unsub = s.on('room_created', (p: any) => {
          done(); setRoomId(p.room_id); setIsHost(true); setIsInMeeting(true); setIsMinimized(false); setAwaitingApproval(false);
          activeRoomRef.current = { code: p.room_id, isHost: true };
          setShowInviteDialog((p.peers ?? []).length === 0);
          persistActiveMeeting(p.room_id, true, title);
          saveMeetingRecord(p.room_id, true, title); resolve(p.room_id);
        });
        const errUnsub = s.on('error', (p: any) => { done(); reject(new Error(p.message)); });
        // Reaching this rare path at all means create_room resolved into an
        // existing, already-populated room (see attemptRoomEntry's own
        // comment on why create_room is gated the same as join_room) — a
        // brand-new room is always empty, so it never knocks.
        const rejUnsub = s.on('join_rejected', (p: any) => { done(); reject(new Error(p?.reason === 'timed_out' ? 'Nobody let you in in time.' : 'You were not let into this meeting.')); });
        const done = () => { unsub(); errUnsub(); rejUnsub(); };
        s.send('create_room', { room_id: customCode, user_id: userIdRef.current, user_name: nameRef.current, meeting_title: title });
      });
      // Media (LiveKit) is connected AFTER /ws admission, not before — the
      // token endpoint's authorization IS current /ws room membership
      // (server/livekit.go), so there is no confirmed room to ask for a
      // token for until this point.
      const { token, url } = await api.getLiveKitToken(roomId, userIdRef.current, nameRef.current);
      await webrtc.connect(url, token, prefs);
      return roomId;
    } catch (err: any) { setMeetingError(err.message || 'Failed to create meeting'); throw err; }
  }, [user.id, webrtc, connectSocket, saveMeetingRecord]);

  const joinMeeting = useCallback(async (code: string, knownTitle?: string, allowRecreate = false, prefs?: MediaPrefs): Promise<string> => {
    const trimmedCode = code.trim().toUpperCase();
    if (!trimmedCode) throw new Error('No code');
    try {
      setMeetingError(null);
      setEvictedNotice(null);
      setAwaitingApproval(false);
      setJoinDeniedReason(null);
      if (trimmedCode.startsWith('SCHED-') && !user.isGuest) {
        try { await api.validateRoomCode(trimmedCode); }
        catch (e) { throw new Error('Meeting code is invalid, deleted, or has not started yet.'); }
      }
      webrtc.resetPeers();
      setChatMessages([]);
      const s = await connectSocket();
      await new Promise<void>((resolve, reject) => {
        const unsub = s.on('room_joined', (p: any) => {
          done(); setRoomId(p.room_id); setIsHost(false); setIsInMeeting(true); setIsMinimized(false); setAwaitingApproval(false);
          activeRoomRef.current = { code: trimmedCode, isHost: false };
          const resolvedTitle = knownTitle || scheduledMeetings.find(m => m.code === trimmedCode)?.title;
          persistActiveMeeting(trimmedCode, false, resolvedTitle);
          saveMeetingRecord(trimmedCode, false, resolvedTitle);
          resolve();
        });
        const errUnsub = s.on('error', (p: any) => { done(); reject(new Error(p.message)); });
        // The common case for a room with other people already in it: this
        // rejects the promise (so the caller's `await joinMeeting(...)`
        // fails cleanly) while the global join_rejected handler above sets
        // joinDeniedReason for the UI to render a specific screen from.
        const rejUnsub = s.on('join_rejected', (p: any) => { done(); reject(new Error(p?.reason === 'timed_out' ? 'Nobody let you in in time.' : 'You were not let into this meeting.')); });
        const done = () => { unsub(); errUnsub(); rejUnsub(); };
        s.send('join_room', { room_id: trimmedCode, user_id: userIdRef.current, user_name: nameRef.current });
      });
      // Same ordering as createMeeting — see its comment. `prefs` (the
      // lobby's mute/camera-off choice) is applied here, at LiveKit connect
      // time, exactly like the old initMedia(prefs) applied it at
      // getUserMedia time.
      const { token, url } = await api.getLiveKitToken(trimmedCode, userIdRef.current, nameRef.current);
      await webrtc.connect(url, token, prefs);
      return trimmedCode;
    } catch (err: any) {
      const ownedMeeting = scheduledMeetings.find(m => m.code === trimmedCode);
      if (err.message.includes('Room not found') && ownedMeeting) {
        return await createMeeting(trimmedCode, ownedMeeting.title);
      }
      // Reopening a room we were hosting (e.g. the reload landed after the grace
      // window expired) — recreate it under the same code so the link still works.
      if (err.message.includes('Room not found') && allowRecreate) {
        return await createMeeting(trimmedCode, knownTitle);
      }
      setMeetingError(err.message || 'Failed to join meeting'); throw err;
    }
  }, [user.id, user.isGuest, webrtc, connectSocket, saveMeetingRecord, createMeeting, scheduledMeetings]);

  const minimizeMeeting = useCallback(() => setIsMinimized(true), []);
  const expandMeeting = useCallback(() => setIsMinimized(false), []);

  const leaveMeeting = useCallback(() => {
    updateMeetingRecord(webrtc.peers.length + 1);
    clearActiveMeeting();
    activeRoomRef.current = null;
    socketRef.current?.send('leave_room', {}); socketRef.current?.disconnect();
    socketRef.current = null; setSocketInstance(null); webrtc.cleanup();
    setIsInMeeting(false); setIsMinimized(false); setRoomId(null); setIsHost(false); setShowInviteDialog(false); setChatMessages([]);
    // Leftover hands and reactions would reappear on the next call, attributed to
    // peers from the room that just ended.
    setReactions([]); setRaisedHands(new Set()); setIsHandRaised(false);
    setLiveCaptions(new Map()); setCaptionLog([]); setCaptionKeyPoints([]); setMyCaptionLang(null);
    setIsRejoining(false);
    setAwaitingApproval(false); setJoinDeniedReason(null); setPendingJoinRequests([]); setRequireApprovalState(false);
  }, [webrtc, updateMeetingRecord]);

  // Redials the room after a page reload. Kept separate from joinMeeting so the UI
  // can show a "Rejoining…" state rather than the normal join spinner, and so a
  // room that emptied out on reload is recreated under the same code.
  //
  // allowRecreate was `saved?.isHost === true && ...`, which left a non-host who
  // reloaded after a backend restart with no way back in — the same asymmetry
  // reenterRoom above had, on the other recovery path. Same reasoning applies:
  // the backend has no host concept, so recreating grants nothing.
  const rejoinMeeting = useCallback(async (code: string): Promise<void> => {
    const saved = readActiveMeeting();
    setIsRejoining(true);
    try {
      await joinMeeting(code, saved?.title, saved?.roomId === code);
    } finally {
      setIsRejoining(false);
    }
  }, [joinMeeting]);

  // Closing/refreshing the tab while in a call doesn't unmount React in time to run
  // any cleanup through normal state updates. Without this, the local camera/mic
  // hardware can stay held (and peers never learn we left, so their tile of us just
  // freezes) until the browser eventually tears the page down on its own. `pagehide`
  // fires reliably on tab close/navigation across browsers (unlike `beforeunload`,
  // which some mobile browsers skip); both are wired for belt-and-suspenders.
  useEffect(() => {
    if (!isInMeeting) return;
    const handleUnload = () => {
      socketRef.current?.send('leave_room', {});
      webrtc.cleanup();
    };
    window.addEventListener('pagehide', handleUnload);
    window.addEventListener('beforeunload', handleUnload);
    return () => {
      window.removeEventListener('pagehide', handleUnload);
      window.removeEventListener('beforeunload', handleUnload);
    };
  }, [isInMeeting, webrtc.cleanup]);

  const dismissInviteDialog = useCallback(() => setShowInviteDialog(false), []);
  const dismissEvictedNotice = useCallback(() => setEvictedNotice(null), []);

  const sendChatMessage = useCallback((text: string) => { 
    if (socketRef.current?.isOpen && text.trim()) {
      const localMsg: LiveChatMessage = {
        id: `chat-local-${Date.now()}`,
        fromId: userIdRef.current,
        fromName: user.name,
        text: text.trim(),
        time: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
        isSelf: true
      };
      setChatMessages(prev => [...prev, localMsg]);
      socketRef.current.send('chat_message', { text: text.trim() }); 
    }
  }, [user.name]);

  // Your own reaction is rendered locally as well as broadcast: the server relays to
  // everyone *except* the sender, so without this you would be the only person in the
  // room who could not see what you just sent.
  const sendReaction = useCallback((emoji: string) => {
    if (!socketRef.current?.isOpen || !isReaction(emoji)) return;
    socketRef.current.send('reaction', { emoji });
    const rx = makeFloatingReaction(userIdRef.current, user.name, emoji);
    setReactions((prev) => [...prev, rx]);
    setTimeout(() => setReactions((prev) => prev.filter((r) => r.id !== rx.id)), REACTION_TTL_MS);
  }, [user.name]);

  const toggleHand = useCallback(() => {
    setIsHandRaised((wasRaised) => {
      const raised = !wasRaised;
      socketRef.current?.send('hand_state', { raised });
      const selfId = userIdRef.current;
      setRaisedHands((prev) => {
        const next = new Set(prev);
        if (raised) next.add(selfId); else next.delete(selfId);
        return next;
      });
      return raised;
    });
  }, []);

  // Not broadcast to anyone but stored server-side (Room.clients[you].captionLang
  // in server/main.go) — it's what the /asr relay reads to decide which
  // languages a final transcript needs translating into, purely a viewer-side
  // preference with no bearing on what you sound like to others.
  const setCaptionLang = useCallback((lang: string | null) => {
    setMyCaptionLang(lang);
    socketRef.current?.send('caption_lang', { lang: lang ?? '' });
  }, []);
  const clearCaptionLog = useCallback(() => { setCaptionLog([]); setCaptionKeyPoints([]); }, []);

  const setPendingAction = useCallback((code: string | null) => { setPendingJoinCode(code); setShowGuestModal(true); }, []);
  const dismissGuestModal = useCallback(() => { setShowGuestModal(false); setPendingJoinCode(null); }, []);
  const clearMeetingError = useCallback(() => setMeetingError(null), []);
  const clearJoinDenied = useCallback(() => setJoinDeniedReason(null), []);
  // Removes it from OUR OWN popup list immediately, optimistically — don't
  // wait for the server's own join_request_cancelled broadcast to arrive.
  // Harmless if someone else already answered first (see server/main.go's
  // join_response: a request not found in room.pending is silently a no-op).
  const respondToJoinRequest = useCallback((requestId: string, approve: boolean) => {
    setPendingJoinRequests((prev) => prev.filter((r) => r.requestId !== requestId));
    socketRef.current?.send('join_response', { request_id: requestId, approve });
  }, []);
  const setRequireApproval = useCallback((value: boolean) => {
    setRequireApprovalState(value); // optimistic — the broadcast above also confirms it
    socketRef.current?.send('require_approval', { value });
  }, []);

  return (
    <MeetingContext.Provider value={{
      user, setUserName, isInMeeting, isMinimized, minimizeMeeting, expandMeeting, roomId, isHost, showInviteDialog, dismissInviteDialog, evictedNotice, dismissEvictedNotice, createMeeting, joinMeeting, rejoinMeeting, isRejoining, leaveMeeting,
      awaitingApproval, joinDeniedReason, clearJoinDenied, pendingJoinRequests, respondToJoinRequest, requireApproval, setRequireApproval,
      scheduledMeetings, refreshScheduledMeetings, scheduleMeeting, deleteScheduledMeeting,
      localStream: webrtc.localStream, peers: webrtc.peers, isMuted: webrtc.isMuted, isVideoOff: webrtc.isVideoOff, isScreenSharing: webrtc.isScreenSharing,
      mediaNotice: webrtc.mediaNotice, dismissMediaNotice: webrtc.dismissMediaNotice,
      screenStream: webrtc.screenStream, screenPeers: webrtc.screenPeers,
      toggleMic: webrtc.toggleMic, setMicMuted: webrtc.setMicMuted, toggleCamera: webrtc.toggleCamera, toggleScreenShare: webrtc.toggleScreenShare,
      switchCamera: webrtc.switchCamera, switchMic: webrtc.switchMic,
      linkQuality: webrtc.linkQuality,
      activeSpeakerIds: webrtc.activeSpeakerIds,
      setVisiblePeerIds: webrtc.setVisiblePeerIds,
      restartPeerConnection: webrtc.restartPeerConnection,
      reactions, sendReaction, raisedHands, isHandRaised, toggleHand,
      chatMessages, sendChatMessage, showGuestModal, pendingJoinCode, setPendingAction, dismissGuestModal, meetingError, clearMeetingError,
      liveCaptions, captionLog, captionKeyPoints, myCaptionLang, setCaptionLang, clearCaptionLog
    }}>
      {children}
    </MeetingContext.Provider>
  );
}

export function useMeeting() {
  const ctx = useContext(MeetingContext);
  if (!ctx) throw new Error('useMeeting must be used inside MeetingProvider');
  return ctx;
}
