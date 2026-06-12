import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { SignalingSocket } from '../lib/signalingSocket';
import { useWebRTC, PeerInfo } from '../hooks/useWebRTC';
import { api } from '../lib/api';

export interface AppUser { id: string; name: string; isGuest: boolean; }
export interface LiveChatMessage { id: string; fromId: string; fromName: string; text: string; time: string; isSelf: boolean; }
export interface ScheduledMeeting { id: string; title: string; date: string; time: string; code: string; }

interface MeetingContextType {
  user: AppUser;
  setUserName: (name: string, isGuest?: boolean) => void;
  isInMeeting: boolean;
  roomId: string | null;
  isHost: boolean;
  createMeeting: (customCode?: string, title?: string) => Promise<string>;
  joinMeeting: (code: string, title?: string) => Promise<string>;
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
  toggleMic: () => void;
  toggleCamera: () => void;
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

  const [isInMeeting, setIsInMeeting] = useState(false);
  const [roomId, setRoomId] = useState<string | null>(null);
  const [isHost, setIsHost] = useState(false);
  const [chatMessages, setChatMessages] = useState<LiveChatMessage[]>([]);
  const [scheduledMeetings, setScheduledMeetings] = useState<ScheduledMeeting[]>([]);
  const [meetingError, setMeetingError] = useState<string | null>(null);
  const [showGuestModal, setShowGuestModal] = useState(false);
  const [pendingJoinCode, setPendingJoinCode] = useState<string | null>(null);

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

  const webrtc = useWebRTC(socketInstance);

  const setUserName = useCallback((name: string, isGuest = true) => {
    const trimmed = name.trim() || 'Guest';
    sessionStorage.setItem('ibconnect_user_name', trimmed);
    setUser((prev) => ({ ...prev, name: trimmed, isGuest }));
    
    // Auto-update peers in room without duplicating profile
    if (isInMeeting) {
        webrtc.registerPeerName(user.id, trimmed);
    }
  }, [isInMeeting, webrtc, user.id]);

  const connectSocket = useCallback(async (): Promise<SignalingSocket> => {
    if (socketRef.current?.isOpen) return socketRef.current;
    const s = new SignalingSocket(WS_URL);
    s.on('chat_message', (p: any) => setChatMessages(prev => [...prev, { id: `chat-${Date.now()}-${Math.random()}`, fromId: p.from_id, fromName: p.from_name, text: p.text, time: p.time, isSelf: p.from_id === getOrCreateUserId() }]));
    s.on('error', (p: any) => setMeetingError(p.message));
    await s.connect();
    socketRef.current = s; setSocketInstance(s); return s;
  }, []);

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
      await webrtc.initMedia();
      const s = await connectSocket();
      return await new Promise<string>((resolve, reject) => {
        const unsub = s.on('room_created', (p: any) => {
          unsub(); setRoomId(p.room_id); setIsHost(true); setIsInMeeting(true);
          saveMeetingRecord(p.room_id, true, title); resolve(p.room_id);
        });
        const errUnsub = s.on('error', (p: any) => { errUnsub(); unsub(); reject(new Error(p.message)); });
        s.send('create_room', { room_id: customCode, user_id: user.id, user_name: user.name, meeting_title: title });
      });
    } catch (err: any) { setMeetingError(err.message || 'Failed to create meeting'); throw err; }
  }, [user, webrtc, connectSocket, saveMeetingRecord]);

  const joinMeeting = useCallback(async (code: string, knownTitle?: string): Promise<string> => {
    const trimmedCode = code.trim().toUpperCase();
    if (!trimmedCode) throw new Error('No code');
    try {
      setMeetingError(null);
      if (trimmedCode.startsWith('SCHED-') && !user.isGuest) {
        try { await api.validateRoomCode(trimmedCode); }
        catch (e) { throw new Error('Meeting code is invalid, deleted, or has not started yet.'); }
      }
      await webrtc.initMedia();
      const s = await connectSocket();
      return await new Promise<string>((resolve, reject) => {
        const unsub = s.on('room_joined', (p: any) => {
          unsub(); setRoomId(p.room_id); setIsHost(false); setIsInMeeting(true);
          const resolvedTitle = knownTitle || scheduledMeetings.find(m => m.code === trimmedCode)?.title;
          saveMeetingRecord(trimmedCode, false, resolvedTitle);
          p.peers.forEach((peer: any) => { webrtc.registerPeerName(peer.id, peer.name); webrtc.createOfferFor(peer.id); });
          resolve(trimmedCode);
        });
        const errUnsub = s.on('error', (p: any) => { errUnsub(); unsub(); reject(new Error(p.message)); });
        s.send('join_room', { room_id: trimmedCode, user_id: user.id, user_name: user.name });
      });
    } catch (err: any) {
      const ownedMeeting = scheduledMeetings.find(m => m.code === trimmedCode);
      if (err.message.includes('Room not found') && ownedMeeting) {
        return await createMeeting(trimmedCode, ownedMeeting.title);
      }
      setMeetingError(err.message || 'Failed to join meeting'); throw err;
    }
  }, [user, webrtc, connectSocket, saveMeetingRecord, createMeeting, scheduledMeetings]);

  const leaveMeeting = useCallback(() => {
    updateMeetingRecord(webrtc.peers.length + 1);
    socketRef.current?.send('leave_room', {}); socketRef.current?.disconnect();
    socketRef.current = null; setSocketInstance(null); webrtc.cleanup();
    setIsInMeeting(false); setRoomId(null); setIsHost(false); setChatMessages([]);
  }, [webrtc, updateMeetingRecord]);

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
      user, setUserName, isInMeeting, roomId, isHost, createMeeting, joinMeeting, leaveMeeting,
      scheduledMeetings, refreshScheduledMeetings, scheduleMeeting, deleteScheduledMeeting,
      localStream: webrtc.localStream, peers: webrtc.peers, isMuted: webrtc.isMuted, isVideoOff: webrtc.isVideoOff, isScreenSharing: webrtc.isScreenSharing,
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
