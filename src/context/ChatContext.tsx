import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { RealChatMessage, RealChatThread } from '../types';
import { useAuth } from './AuthContext';

interface TypingState {
  [threadId: string]: { userId: string; userName: string }[];
}

interface ChatContextType {
  threads: RealChatThread[];
  activeThreadId: string | null;
  setActiveThreadId: (id: string | null) => void;
  getMessages: (threadId: string) => RealChatMessage[];
  sendMessage: (threadId: string, text: string, fileAttachment?: RealChatMessage['fileAttachment']) => void;
  startDM: (otherUserId: string) => string;
  typingUsers: TypingState;
  setTyping: (threadId: string, isTyping: boolean) => void;
  markRead: (threadId: string) => void;
}

const ChatContext = createContext<ChatContextType | null>(null);

const MSGS_PREFIX = 'ibconnect_msgs_';
const THREADS_PREFIX = 'ibconnect_threads_';

function loadMessages(threadId: string): RealChatMessage[] {
  try { return JSON.parse(localStorage.getItem(MSGS_PREFIX + threadId) || '[]'); } catch { return []; }
}
function saveMessages(threadId: string, msgs: RealChatMessage[]) {
  localStorage.setItem(MSGS_PREFIX + threadId, JSON.stringify(msgs));
}
function loadThreads(userId: string): RealChatThread[] {
  try { return JSON.parse(localStorage.getItem(THREADS_PREFIX + userId) || '[]'); } catch { return []; }
}
function saveThreads(userId: string, threads: RealChatThread[]) {
  localStorage.setItem(THREADS_PREFIX + userId, JSON.stringify(threads));
}

export function getDMThreadId(userId1: string, userId2: string): string {
  return 'dm_' + [userId1, userId2].sort().join('_');
}

export function ChatProvider({ children }: { children: React.ReactNode }) {
  const { currentUser, getUserById } = useAuth();
  const [threads, setThreads] = useState<RealChatThread[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [typingUsers, setTypingUsers] = useState<TypingState>({});
  const channelRef = useRef<BroadcastChannel | null>(null);
  const typingTimeouts = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  useEffect(() => {
    if (!currentUser) { setThreads([]); return; }
    setThreads(loadThreads(currentUser.id));
  }, [currentUser?.id]);

  // BroadcastChannel for real-time updates
  useEffect(() => {
    if (!currentUser) return;
    let ch: BroadcastChannel | null = null;
    try {
      ch = new BroadcastChannel('ibconnect_realtime');
      channelRef.current = ch;
      ch.onmessage = (e) => {
        const { type, threadId, message, userId, userName } = e.data || {};

        if (type === 'new_message' && message) {
          // Check if we're a participant
          const allThreads = loadThreads(currentUser.id);
          const thread = allThreads.find(t => t.id === threadId);
          if (!thread) {
            // We might be a participant but don't have the thread yet - reload
            const freshThreads = loadThreads(currentUser.id);
            setThreads([...freshThreads]);
            return;
          }
          // Update thread last message
          const updated = allThreads.map(t =>
            t.id === threadId
              ? { ...t, lastMessage: message.text || (message.fileAttachment ? `📎 ${message.fileAttachment.name}` : ''), lastTimestamp: message.timestamp, unreadCount: (activeThreadId !== threadId) ? (t.unreadCount || 0) + 1 : 0 }
              : t
          );
          saveThreads(currentUser.id, updated);
          setThreads([...updated]);
          // Force re-render of message list
          setActiveThreadId(prev => prev); // no-op but triggers rerender in ChatsView via state
        }

        if (type === 'typing_start' && threadId && userId !== currentUser.id) {
          setTypingUsers(prev => {
            const users = prev[threadId] || [];
            if (users.find(u => u.userId === userId)) return prev;
            return { ...prev, [threadId]: [...users, { userId, userName }] };
          });
        }

        if (type === 'typing_stop' && threadId && userId !== currentUser.id) {
          setTypingUsers(prev => ({
            ...prev,
            [threadId]: (prev[threadId] || []).filter(u => u.userId !== userId),
          }));
        }

        if (type === 'thread_created' && e.data.forUserId === currentUser.id) {
          const freshThreads = loadThreads(currentUser.id);
          setThreads([...freshThreads]);
        }
      };
    } catch {}
    return () => { ch?.close(); channelRef.current = null; };
  }, [currentUser?.id, activeThreadId]);

  const getMessages = useCallback((threadId: string): RealChatMessage[] => {
    return loadMessages(threadId);
  }, []);

  const sendMessage = useCallback((threadId: string, text: string, fileAttachment?: RealChatMessage['fileAttachment']) => {
    if (!currentUser) return;
    const msg: RealChatMessage = {
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      threadId,
      senderId: currentUser.id,
      senderName: currentUser.displayName,
      senderAvatar: currentUser.avatar,
      text,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      timestamp: Date.now(),
      fileAttachment,
    };

    const msgs = loadMessages(threadId);
    saveMessages(threadId, [...msgs, msg]);

    // Update thread for current user
    const myThreads = loadThreads(currentUser.id);
    const displayText = fileAttachment ? `📎 ${fileAttachment.name}` : text;
    const updatedMyThreads = myThreads.map(t =>
      t.id === threadId ? { ...t, lastMessage: displayText, lastTimestamp: msg.timestamp, unreadCount: 0 } : t
    );
    saveThreads(currentUser.id, updatedMyThreads);
    setThreads([...updatedMyThreads]);

    // Broadcast to other tabs
    try {
      channelRef.current?.postMessage({ type: 'new_message', threadId, message: msg });
    } catch {}
  }, [currentUser]);

  const startDM = useCallback((otherUserId: string): string => {
    if (!currentUser) return '';
    const threadId = getDMThreadId(currentUser.id, otherUserId);
    const otherUser = getUserById(otherUserId);
    if (!otherUser) return '';

    // Ensure thread exists for current user
    const myThreads = loadThreads(currentUser.id);
    if (!myThreads.find(t => t.id === threadId)) {
      const newThread: RealChatThread = {
        id: threadId,
        type: 'dm',
        name: otherUser.displayName,
        avatar: otherUser.avatar,
        participants: [currentUser.id, otherUserId],
        lastMessage: '',
        lastTimestamp: Date.now(),
        unreadCount: 0,
      };
      const updated = [newThread, ...myThreads];
      saveThreads(currentUser.id, updated);
      setThreads([...updated]);
    }

    // Ensure thread exists for other user too
    const theirThreads = loadThreads(otherUserId);
    if (!theirThreads.find(t => t.id === threadId)) {
      const theirThread: RealChatThread = {
        id: threadId,
        type: 'dm',
        name: currentUser.displayName,
        avatar: currentUser.avatar,
        participants: [currentUser.id, otherUserId],
        lastMessage: '',
        lastTimestamp: Date.now(),
        unreadCount: 0,
      };
      saveThreads(otherUserId, [theirThread, ...theirThreads]);
      // Notify their tab
      try {
        channelRef.current?.postMessage({ type: 'thread_created', forUserId: otherUserId });
      } catch {}
    }

    return threadId;
  }, [currentUser, getUserById]);

  const setTyping = useCallback((threadId: string, isTyping: boolean) => {
    if (!currentUser) return;
    const key = `${currentUser.id}_${threadId}`;
    if (isTyping) {
      clearTimeout(typingTimeouts.current[key]);
      try {
        channelRef.current?.postMessage({ type: 'typing_start', threadId, userId: currentUser.id, userName: currentUser.displayName });
      } catch {}
      typingTimeouts.current[key] = setTimeout(() => {
        try {
          channelRef.current?.postMessage({ type: 'typing_stop', threadId, userId: currentUser.id });
        } catch {}
      }, 3000);
    } else {
      clearTimeout(typingTimeouts.current[key]);
      try {
        channelRef.current?.postMessage({ type: 'typing_stop', threadId, userId: currentUser.id });
      } catch {}
    }
  }, [currentUser]);

  const markRead = useCallback((threadId: string) => {
    if (!currentUser) return;
    const myThreads = loadThreads(currentUser.id);
    const updated = myThreads.map(t => t.id === threadId ? { ...t, unreadCount: 0 } : t);
    saveThreads(currentUser.id, updated);
    setThreads([...updated]);
  }, [currentUser]);

  return (
    <ChatContext.Provider value={{ threads, activeThreadId, setActiveThreadId, getMessages, sendMessage, startDM, typingUsers, setTyping, markRead }}>
      {children}
    </ChatContext.Provider>
  );
}

export function useChat() {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error('useChat must be inside ChatProvider');
  return ctx;
}
