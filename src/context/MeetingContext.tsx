import React, {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
} from 'react';
import { SignalingSocket } from '../lib/signalingSocket';
import { useWebRTC, PeerInfo } from '../hooks/useWebRTC';

// ---- User ----

export interface AppUser {
  id: string;
  name: string;
  isGuest: boolean;
}

function getOrCreateUserId(): string {
  let id = sessionStorage.getItem('ibconnect_user_id');
  if (!id) {
    id = `user-${Math.random().toString(36).slice(2, 10)}`;
    sessionStorage.setItem('ibconnect_user_id', id);
  }
  return id;
}

function getStoredName(): string | null {
  return sessionStorage.getItem('ibconnect_user_name');
}

// ---- Chat ----

export interface LiveChatMessage {
  id: string;
  fromId: string;
  fromName: string;
  text: string;
  time: string;
  isSelf: boolean;
}

// ---- Scheduled Meeting ----

export interface ScheduledMeeting {
  id: string;
  title: string;
  date: string;
  time: string;
  code: string;
}

// ---- Context shape ----

interface MeetingContextType {
  // User
  user: AppUser;
  setUserName: (name: string, isGuest?: boolean) => void;

  // Meeting state
  isInMeeting: boolean;
  roomId: string | null;
  isHost: boolean;

  // Actions
  createMeeting: () => Promise<void>;
  joinMeeting: (code: string) => Promise<void>;
  leaveMeeting: () => void;

  // Scheduling
  scheduledMeetings: ScheduledMeeting[];
  scheduleMeeting: (title: string, date: string, time: string) => string;

  // WebRTC
  localStream: MediaStream | null;
  peers: PeerInfo[];
  isMuted: boolean;
  isVideoOff: boolean;
  isScreenSharing: boolean;
  toggleMic: () => void;
  toggleCamera: () => void;
  toggleScreenShare: () => Promise<void>;

  // In-meeting chat
  chatMessages: LiveChatMessage[];
  sendChatMessage: (text: string) => void;

  // Guest modal
  showGuestModal: boolean;
  pendingJoinCode: string | null;
  setPendingAction: (code: string | null) => void;
  dismissGuestModal: () => void;

  // Error
  meetingError: string | null;
  clearMeetingError: () => void;
}

const MeetingContext = createContext<MeetingContextType | null>(null);

// Use Vite proxy path '/ws' so it works both in dev (proxied) and when deployed
const WS_URL =
  import.meta.env.VITE_WS_URL ??
  (typeof window !== 'undefined'
    ? `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws`
    : 'ws://localhost:3000/ws');

export function MeetingProvider({ children }: { children: React.ReactNode }) {
  const socketRef = useRef<SignalingSocket | null>(null);
  const [socketInstance, setSocketInstance] = useState<SignalingSocket | null>(null);

  const [user, setUser] = useState<AppUser>(() => {
    // Read from the auth system if available
    try {
      const session = JSON.parse(localStorage.getItem('ibconnect_session') || 'null');
      if (session?.userId) {
        const users = JSON.parse(localStorage.getItem('ibconnect_users') || '[]');
        const authUser = users.find((u: { id: string; displayName: string }) => u.id === session.userId);
        if (authUser) return { id: authUser.id, name: authUser.displayName, isGuest: false };
      }
    } catch {}
    const storedName = getStoredName();
    return {
      id: getOrCreateUserId(),
      name: storedName ?? 'Guest',
      isGuest: true,
    };
  });

  const [isInMeeting, setIsInMeeting] = useState(false);
  const [roomId, setRoomId] = useState<string | null>(null);
  const [isHost, setIsHost] = useState(false);
  const [chatMessages, setChatMessages] = useState<LiveChatMessage[]>([]);
  const [scheduledMeetings, setScheduledMeetings] = useState<ScheduledMeeting[]>([]);
  const [showGuestModal, setShowGuestModal] = useState(false);
  const [pendingJoinCode, setPendingJoinCode] = useState<string | null>(null);
  const [meetingError, setMeetingError] = useState<string | null>(null);

  const webrtc = useWebRTC(socketInstance);

  const setUserName = useCallback((name: string, isGuest = true) => {
    const trimmed = name.trim() || 'Guest';
    sessionStorage.setItem('ibconnect_user_name', trimmed);
    setUser((prev) => ({ ...prev, name: trimmed, isGuest }));
  }, []);

  const connectSocket = useCallback(async (): Promise<SignalingSocket> => {
    if (socketRef.current?.isOpen) return socketRef.current;

    const s = new SignalingSocket(WS_URL);

    // Wire chat relay
    s.on('chat_message', (payload) => {
      const p = payload as {
        from_id: string;
        from_name: string;
        text: string;
        time: string;
      };
      setChatMessages((prev) => [
        ...prev,
        {
          id: `chat-${Date.now()}-${Math.random()}`,
          fromId: p.from_id,
          fromName: p.from_name,
          text: p.text,
          time: p.time,
          isSelf: p.from_id === getOrCreateUserId(),
        },
      ]);
    });

    s.on('error', (payload) => {
      const p = payload as { message: string };
      setMeetingError(p.message);
    });

    await s.connect();
    socketRef.current = s;
    setSocketInstance(s);
    return s;
  }, []);

  const createMeeting = useCallback(async () => {
    // If no name is set (fresh guest), show modal first
    if (!getStoredName() && user.name === 'David') {
      // Default user — proceed directly
    }

    try {
      setMeetingError(null);
      await webrtc.initMedia();
      const s = await connectSocket();

      await new Promise<void>((resolve, reject) => {
        const unsub = s.on('room_created', (payload) => {
          const p = payload as { room_id: string };
          unsub();
          setRoomId(p.room_id);
          setIsHost(true);
          setIsInMeeting(true);
          resolve();
        });
        s.on('error', (payload) => {
          const p = payload as { message: string };
          unsub();
          reject(new Error(p.message));
        });
        s.send('create_room', { user_id: user.id, user_name: user.name });
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to create meeting';
      setMeetingError(msg);
      throw err;
    }
  }, [user, webrtc, connectSocket]);

  const joinMeeting = useCallback(
    async (code: string) => {
      const trimmedCode = code.trim().toUpperCase();
      if (!trimmedCode) {
        setMeetingError('Please enter a meeting code.');
        return;
      }

      try {
        setMeetingError(null);
        await webrtc.initMedia();
        const s = await connectSocket();

        await new Promise<void>((resolve, reject) => {
          const unsub = s.on('room_joined', (payload) => {
            const p = payload as {
              room_id: string;
              peers: Array<{ id: string; name: string }>;
            };
            unsub();
            setRoomId(p.room_id);
            setIsHost(false);
            setIsInMeeting(true);

            // Create offers to all existing peers
            p.peers.forEach((peer) => {
              webrtc.createOfferFor(peer.id);
            });
            resolve();
          });

          const errUnsub = s.on('error', (payload) => {
            const ep = payload as { message: string };
            errUnsub();
            unsub();
            reject(new Error(ep.message));
          });

          s.send('join_room', {
            room_id: trimmedCode,
            user_id: user.id,
            user_name: user.name,
          });
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to join meeting';
        setMeetingError(msg);
        throw err;
      }
    },
    [user, webrtc, connectSocket]
  );

  const leaveMeeting = useCallback(() => {
    socketRef.current?.send('leave_room', {});
    socketRef.current?.disconnect();
    socketRef.current = null;
    setSocketInstance(null);
    webrtc.cleanup();
    setIsInMeeting(false);
    setRoomId(null);
    setIsHost(false);
    setChatMessages([]);
  }, [webrtc]);

  const sendChatMessage = useCallback(
    (text: string) => {
      if (!socketRef.current?.isOpen || !text.trim()) return;
      socketRef.current.send('chat_message', { text: text.trim() });
    },
    []
  );

  const scheduleMeeting = useCallback(
    (title: string, date: string, time: string): string => {
      const code = `SCHED-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
      setScheduledMeetings((prev) => [
        ...prev,
        { id: `sm-${Date.now()}`, title, date, time, code },
      ]);
      return code;
    },
    []
  );

  const setPendingAction = useCallback((code: string | null) => {
    setPendingJoinCode(code);
    setShowGuestModal(true);
  }, []);

  const dismissGuestModal = useCallback(() => {
    setShowGuestModal(false);
    setPendingJoinCode(null);
  }, []);

  const clearMeetingError = useCallback(() => setMeetingError(null), []);

  return (
    <MeetingContext.Provider
      value={{
        user,
        setUserName,
        isInMeeting,
        roomId,
        isHost,
        createMeeting,
        joinMeeting,
        leaveMeeting,
        scheduledMeetings,
        scheduleMeeting,
        localStream: webrtc.localStream,
        peers: webrtc.peers,
        isMuted: webrtc.isMuted,
        isVideoOff: webrtc.isVideoOff,
        isScreenSharing: webrtc.isScreenSharing,
        toggleMic: webrtc.toggleMic,
        toggleCamera: webrtc.toggleCamera,
        toggleScreenShare: webrtc.toggleScreenShare,
        chatMessages,
        sendChatMessage,
        showGuestModal,
        pendingJoinCode,
        setPendingAction,
        dismissGuestModal,
        meetingError,
        clearMeetingError,
      }}
    >
      {children}
    </MeetingContext.Provider>
  );
}

export function useMeeting() {
  const ctx = useContext(MeetingContext);
  if (!ctx) throw new Error('useMeeting must be used inside MeetingProvider');
  return ctx;
}
