import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { SignalingSocket } from '../lib/signalingSocket';
import { useWebRTC, PeerInfo, MediaPrefs } from '../hooks/useWebRTC';
import { api } from '../lib/api';

export interface AppUser { id: string; name: string; isGuest: boolean; }
export interface LiveChatMessage { id: string; fromId: string; fromName: string; text: string; time: string; isSelf: boolean; }
export interface ScheduledMeeting { id: string; title: string; date: string; time: string; code: string; }

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
  createMeeting: (customCode?: string, title?: string) => Promise<string>;
  joinMeeting: (code: string, title?: string, allowRecreate?: boolean, prefs?: MediaPrefs) => Promise<string>;
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
  toggleCamera: () => Promise<void>;
  toggleScreenShare: () => Promise<void>;
  switchCamera: (deviceId: string) => Promise<void>;
  switchMic: (deviceId: string) => Promise<void>;
  chatMessages: LiveChatMessage[];
  sendChatMessage: (text: string) => void;
  showGuestModal: boolean;
  pendingJoinCode: string | null;
  setPendingAction: (code: string | null) => void;
  dismissGuestModal: () => void;
  meetingError: string | null;
  clearMeetingError: () => void;
}

const MeetingContext = createContext<MeetingContextType | null>(null);

const WS_URL = import.meta.env.VITE_WS_URL ?? (typeof window !== 'undefined' ? `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws` : 'ws://localhost:3000/ws');

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
  const [chatMessages, setChatMessages] = useState<LiveChatMessage[]>([]);
  const [scheduledMeetings, setScheduledMeetings] = useState<ScheduledMeeting[]>([]);
  const [meetingError, setMeetingError] = useState<string | null>(null);
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

  // user.id decides which side of each pair yields on an offer collision
  // (perfect negotiation) — both peers must agree, so it has to be the same id
  // the signaling server knows us by.
  const webrtc = useWebRTC(socketInstance, user.id);

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
    const s = new SignalingSocket(WS_URL, () => reconnectRef.current());
    s.on('chat_message', (p: any) => setChatMessages(prev => [...prev, { id: `chat-${Date.now()}-${Math.random()}`, fromId: p.from_id, fromName: p.from_name, text: p.text, time: p.time, isSelf: p.from_id === getOrCreateUserId() }]));
    s.on('error', (p: any) => setMeetingError(p.message));
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

    // Every RTCPeerConnection we hold points at a peer who already tore their side
    // down when the server told them we left, so start clean and redial.
    webrtc.resetPeers();
    const payload = { room_id: active.code, user_id: userIdRef.current, user_name: nameRef.current };
    let peers: any[];
    try {
      peers = await requestRoomEntry(s, 'join_room', payload);
    } catch (err) {
      // Room reaped while we were gone. Reopen it if it's ours, same rule the
      // post-reload redial uses; otherwise say so rather than fake a live call.
      if (!active.isHost) { setMeetingError('Lost connection to the meeting. Rejoin to continue.'); return; }
      try { peers = await requestRoomEntry(s, 'create_room', payload); }
      catch { setMeetingError('Lost connection to the meeting. Rejoin to continue.'); return; }
    }
    webrtc.addPeers(peers.map((p: any) => ({ id: p.id, name: p.name })));
    peers.forEach((p: any) => webrtc.createOfferFor(p.id));
  }, [webrtc]);
  useEffect(() => { reconnectRef.current = reenterRoom; }, [reenterRoom]);

  const getFreshName = () => {
    let freshName = user.name;
    try {
      const meStr = localStorage.getItem('ibconnect_me');
      if (meStr) { const meObj = JSON.parse(meStr); if (meObj.displayName) freshName = meObj.displayName; }
    } catch (e) {}
    return freshName;
  };

  const createMeeting = useCallback(async (customCode?: string, title?: string): Promise<string> => {
    try {
      setMeetingError(null);
      // Drop any peers/messages left over from a previous room on this tab —
      // otherwise the last call's participants linger as blank tiles in the new one.
      webrtc.resetPeers();
      setChatMessages([]);
      await webrtc.initMedia();
      const s = await connectSocket();
      return await new Promise<string>((resolve, reject) => {
        const unsub = s.on('room_created', (p: any) => {
          unsub(); setRoomId(p.room_id); setIsHost(true); setIsInMeeting(true); setIsMinimized(false);
          activeRoomRef.current = { code: p.room_id, isHost: true };
          // The server now reuses an existing room for a known code instead of
          // clobbering it, so a "create" can legitimately land in an occupied room
          // (host reloading into their own grace-period room, mainly).
          webrtc.addPeers((p.peers ?? []).map((peer: any) => ({ id: peer.id, name: peer.name })));
          (p.peers ?? []).forEach((peer: any) => webrtc.createOfferFor(peer.id));
          setShowInviteDialog((p.peers ?? []).length === 0);
          persistActiveMeeting(p.room_id, true, title);
          saveMeetingRecord(p.room_id, true, title); resolve(p.room_id);
        });
        const errUnsub = s.on('error', (p: any) => { errUnsub(); unsub(); reject(new Error(p.message)); });
        s.send('create_room', { room_id: customCode, user_id: user.id, user_name: nameRef.current, meeting_title: title });
      });
    } catch (err: any) { setMeetingError(err.message || 'Failed to create meeting'); throw err; }
  }, [user.id, webrtc, connectSocket, saveMeetingRecord]);

  const joinMeeting = useCallback(async (code: string, knownTitle?: string, allowRecreate = false, prefs?: MediaPrefs): Promise<string> => {
    const trimmedCode = code.trim().toUpperCase();
    if (!trimmedCode) throw new Error('No code');
    try {
      setMeetingError(null);
      if (trimmedCode.startsWith('SCHED-') && !user.isGuest) {
        try { await api.validateRoomCode(trimmedCode); }
        catch (e) { throw new Error('Meeting code is invalid, deleted, or has not started yet.'); }
      }
      webrtc.resetPeers();
      setChatMessages([]);
      await webrtc.initMedia(prefs);
      const s = await connectSocket();
      return await new Promise<string>((resolve, reject) => {
        const unsub = s.on('room_joined', (p: any) => {
          unsub(); setRoomId(p.room_id); setIsHost(false); setIsInMeeting(true); setIsMinimized(false);
          activeRoomRef.current = { code: trimmedCode, isHost: false };
          const resolvedTitle = knownTitle || scheduledMeetings.find(m => m.code === trimmedCode)?.title;
          persistActiveMeeting(trimmedCode, false, resolvedTitle);
          saveMeetingRecord(trimmedCode, false, resolvedTitle);
          webrtc.addPeers((p.peers ?? []).map((peer: any) => ({ id: peer.id, name: peer.name })));
          (p.peers ?? []).forEach((peer: any) => webrtc.createOfferFor(peer.id));
          resolve(trimmedCode);
        });
        const errUnsub = s.on('error', (p: any) => { errUnsub(); unsub(); reject(new Error(p.message)); });
        s.send('join_room', { room_id: trimmedCode, user_id: user.id, user_name: nameRef.current });
      });
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
    setIsRejoining(false);
  }, [webrtc, updateMeetingRecord]);

  // Redials the room after a page reload. Kept separate from joinMeeting so the UI
  // can show a "Rejoining…" state rather than the normal join spinner, and so the
  // host of a room that emptied out on reload recreates it under the same code.
  const rejoinMeeting = useCallback(async (code: string): Promise<void> => {
    const saved = readActiveMeeting();
    setIsRejoining(true);
    try {
      await joinMeeting(code, saved?.title, saved?.isHost === true && saved.roomId === code);
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

  const sendChatMessage = useCallback((text: string) => { 
    if (socketRef.current?.isOpen && text.trim()) {
      const localMsg: LiveChatMessage = {
        id: `chat-local-${Date.now()}`,
        fromId: getOrCreateUserId(),
        fromName: user.name,
        text: text.trim(),
        time: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
        isSelf: true
      };
      setChatMessages(prev => [...prev, localMsg]);
      socketRef.current.send('chat_message', { text: text.trim() }); 
    }
  }, [user.name]);

  const setPendingAction = useCallback((code: string | null) => { setPendingJoinCode(code); setShowGuestModal(true); }, []);
  const dismissGuestModal = useCallback(() => { setShowGuestModal(false); setPendingJoinCode(null); }, []);
  const clearMeetingError = useCallback(() => setMeetingError(null), []);

  return (
    <MeetingContext.Provider value={{
      user, setUserName, isInMeeting, isMinimized, minimizeMeeting, expandMeeting, roomId, isHost, showInviteDialog, dismissInviteDialog, createMeeting, joinMeeting, rejoinMeeting, isRejoining, leaveMeeting,
      scheduledMeetings, refreshScheduledMeetings, scheduleMeeting, deleteScheduledMeeting,
      localStream: webrtc.localStream, peers: webrtc.peers, isMuted: webrtc.isMuted, isVideoOff: webrtc.isVideoOff, isScreenSharing: webrtc.isScreenSharing,
      mediaNotice: webrtc.mediaNotice, dismissMediaNotice: webrtc.dismissMediaNotice,
      screenStream: webrtc.screenStream, screenPeers: webrtc.screenPeers,
      toggleMic: webrtc.toggleMic, toggleCamera: webrtc.toggleCamera, toggleScreenShare: webrtc.toggleScreenShare,
      switchCamera: webrtc.switchCamera, switchMic: webrtc.switchMic,
      chatMessages, sendChatMessage, showGuestModal, pendingJoinCode, setPendingAction, dismissGuestModal, meetingError, clearMeetingError
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
