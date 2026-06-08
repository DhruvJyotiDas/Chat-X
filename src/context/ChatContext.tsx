import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { RealChatMessage, RealChatThread } from '../types';
import { useAuth } from './AuthContext';
import { api, connectChatWS, ChatWSEvent } from '../lib/api';

interface TypingState {
  [threadId: string]: { userId: string; userName: string }[];
}

interface ChatContextType {
  threads: RealChatThread[];
  activeThreadId: string | null;
  setActiveThreadId: (id: string | null) => void;
  getMessages: (threadId: string) => RealChatMessage[];
  sendMessage: (threadId: string, text: string, fileAttachment?: RealChatMessage['fileAttachment']) => void;
  startDM: (otherUserId: string) => Promise<string>;
  createGroup: (name: string, memberIds: string[]) => Promise<string>;
  typingUsers: TypingState;
  setTyping: (threadId: string, isTyping: boolean) => void;
  markRead: (threadId: string) => void;
  refreshThreads: () => Promise<void>;
}

const ChatContext = createContext<ChatContextType | null>(null);

function toRealThread(t: import('../lib/api').ApiThread): RealChatThread {
  return {
    id: t.id,
    type: t.type,
    name: t.name,
    avatar: t.avatar,
    participants: t.participants ?? [],
    lastMessage: t.lastMessage ?? '',
    lastTimestamp: t.lastTimestamp ?? Date.now(),
    unreadCount: t.unreadCount ?? 0,
  };
}

function toRealMessage(m: import('../lib/api').ApiMessage): RealChatMessage {
  return {
    id: m.id,
    threadId: m.threadId,
    senderId: m.senderId,
    senderName: m.senderName,
    senderAvatar: m.senderAvatar,
    text: m.text,
    time: m.time,
    timestamp: m.timestamp,
    fileAttachment: m.fileAttachment ? {
      name: m.fileAttachment.name,
      size: m.fileAttachment.size,
      type: m.fileAttachment.type,
      dataUrl: m.fileAttachment.dataUrl,
    } : undefined,
  };
}

export function ChatProvider({ children }: { children: React.ReactNode }) {
  const { currentUser, allUsers } = useAuth();
  const [threads, setThreads] = useState<RealChatThread[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [typingUsers, setTypingUsers] = useState<TypingState>({});

  // Message cache: threadId -> RealChatMessage[]
  const msgCache = useRef<Map<string, RealChatMessage[]>>(new Map());

  // WebSocket ref for typing events
  const wsRef = useRef<WebSocket | null>(null);
  const typingTimeouts = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const activeThreadRef = useRef<string | null>(null);
  activeThreadRef.current = activeThreadId;

  // Load threads when user changes
  useEffect(() => {
    if (!currentUser) { setThreads([]); msgCache.current.clear(); return; }
    api.getThreads()
      .then(ts => setThreads(ts.map(toRealThread)))
      .catch(() => {});
  }, [currentUser?.id]);

  // Connect to chat WebSocket for real-time events
  useEffect(() => {
    if (!currentUser) return;

    const disconnect = connectChatWS((event: ChatWSEvent) => {
      switch (event.type) {
        case 'users_list': {
          // AuthContext keeps allUsers — we don't need to manage it here
          break;
        }
        case 'user_status': {
          // Status updates handled by AuthContext listener (via window event)
          window.dispatchEvent(new CustomEvent('ibconnect_user_status', { detail: event.payload }));
          break;
        }
        case 'new_message': {
          const { threadId, message } = event.payload;
          const msg = toRealMessage(message);
          // Update message cache
          const existing = msgCache.current.get(threadId) ?? [];
          if (!existing.find(m => m.id === msg.id)) {
            msgCache.current.set(threadId, [...existing, msg]);
          }
          // Update thread last message
          setThreads(prev => {
            const found = prev.find(t => t.id === threadId);
            if (found) {
              return prev.map(t => t.id === threadId ? {
                ...t,
                lastMessage: msg.text || (msg.fileAttachment ? `📎 ${msg.fileAttachment.name}` : ''),
                lastTimestamp: msg.timestamp,
                unreadCount: activeThreadRef.current === threadId ? 0 : (t.unreadCount ?? 0) + 1,
              } : t).sort((a, b) => b.lastTimestamp - a.lastTimestamp);
            }
            // New thread we don't have yet — refresh
            api.getThreads().then(ts => setThreads(ts.map(toRealThread))).catch(() => {});
            return prev;
          });
          // Force re-render of active thread
          if (activeThreadRef.current === threadId) {
            setActiveThreadId(id => id);
          }
          break;
        }
        case 'thread_created': {
          const newThread = toRealThread(event.payload);
          setThreads(prev => [newThread, ...prev.filter(t => t.id !== newThread.id)]);
          break;
        }
        case 'typing_start': {
          const { threadId, userId, userName } = event.payload;
          if (userId === currentUser.id) break;
          setTypingUsers(prev => {
            const users = prev[threadId] ?? [];
            if (users.find(u => u.userId === userId)) return prev;
            return { ...prev, [threadId]: [...users, { userId, userName }] };
          });
          break;
        }
        case 'typing_stop': {
          const { threadId, userId } = event.payload;
          setTypingUsers(prev => ({
            ...prev,
            [threadId]: (prev[threadId] ?? []).filter(u => u.userId !== userId),
          }));
          break;
        }
      }
    });

    // Grab the WS for typing sends — the WS is internal to connectChatWS
    // We'll send typing via the WS we open separately here
    const jwt = localStorage.getItem('ibconnect_jwt') ?? '';
    if (jwt) {
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${window.location.host}/chat-ws?token=${encodeURIComponent(jwt)}`);
      ws.onopen = () => { wsRef.current = ws; };
      ws.onclose = () => { wsRef.current = null; };
      return () => {
        disconnect();
        ws.close();
        wsRef.current = null;
      };
    }

    return disconnect;
  }, [currentUser?.id]);

  // Listen for status events from WebSocket (forwarded by ChatContext)
  useEffect(() => {
    const handler = (e: Event) => {
      const { id, status } = (e as CustomEvent<{ id: string; status: string }>).detail;
      // Update allUsers in AuthContext
      window.dispatchEvent(new CustomEvent('ibconnect_auth_status', { detail: { id, status } }));
    };
    window.addEventListener('ibconnect_user_status', handler);
    return () => window.removeEventListener('ibconnect_user_status', handler);
  }, []);

  const refreshThreads = useCallback(async () => {
    const ts = await api.getThreads();
    setThreads(ts.map(toRealThread));
  }, []);

  const getMessages = useCallback((threadId: string): RealChatMessage[] => {
    return msgCache.current.get(threadId) ?? [];
  }, []);

  // Load messages from API (called by ChatsView when switching threads)
  const loadMessages = useCallback(async (threadId: string): Promise<RealChatMessage[]> => {
    const msgs = await api.getMessages(threadId);
    const realMsgs = msgs.map(toRealMessage);
    msgCache.current.set(threadId, realMsgs);
    return realMsgs;
  }, []);

  const sendMessage = useCallback(async (
    threadId: string,
    text: string,
    fileAttachment?: RealChatMessage['fileAttachment'],
  ) => {
    if (!currentUser) return;
    const apiFile = fileAttachment ? {
      name: fileAttachment.name,
      size: fileAttachment.size,
      type: fileAttachment.type,
      dataUrl: fileAttachment.dataUrl,
    } : undefined;
    const msg = await api.sendMessage(threadId, text, apiFile);
    const realMsg = toRealMessage(msg);
    // Add to cache optimistically (server push will dedupe)
    const existing = msgCache.current.get(threadId) ?? [];
    if (!existing.find(m => m.id === realMsg.id)) {
      msgCache.current.set(threadId, [...existing, realMsg]);
    }
    setThreads(prev => prev.map(t => t.id === threadId ? {
      ...t,
      lastMessage: text || (fileAttachment ? `📎 ${fileAttachment.name}` : ''),
      lastTimestamp: realMsg.timestamp,
      unreadCount: 0,
    } : t).sort((a, b) => b.lastTimestamp - a.lastTimestamp));
    setActiveThreadId(id => id); // trigger re-render
  }, [currentUser]);

  const startDM = useCallback(async (otherUserId: string): Promise<string> => {
    const thread = await api.startDM(otherUserId);
    const real = toRealThread(thread);
    setThreads(prev => {
      if (prev.find(t => t.id === real.id)) return prev;
      return [real, ...prev];
    });
    return real.id;
  }, []);

  const createGroup = useCallback(async (name: string, memberIds: string[]): Promise<string> => {
    const thread = await api.createGroup(name, memberIds);
    const real = toRealThread(thread);
    setThreads(prev => [real, ...prev.filter(t => t.id !== real.id)]);
    return real.id;
  }, []);

  const setTyping = useCallback((threadId: string, isTyping: boolean) => {
    if (!currentUser || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    const key = `${currentUser.id}_${threadId}`;
    if (isTyping) {
      clearTimeout(typingTimeouts.current[key]);
      wsRef.current.send(JSON.stringify({ type: 'typing_start', threadId, userName: currentUser.displayName }));
      typingTimeouts.current[key] = setTimeout(() => {
        wsRef.current?.send(JSON.stringify({ type: 'typing_stop', threadId }));
      }, 3000);
    } else {
      clearTimeout(typingTimeouts.current[key]);
      wsRef.current.send(JSON.stringify({ type: 'typing_stop', threadId }));
    }
  }, [currentUser]);

  const markRead = useCallback((threadId: string) => {
    setThreads(prev => prev.map(t => t.id === threadId ? { ...t, unreadCount: 0 } : t));
  }, []);

  // Expose loadMessages so ChatsView can call it
  (ChatProvider as unknown as { _loadMessages?: typeof loadMessages })._loadMessages = loadMessages;

  return (
    <ChatContext.Provider value={{
      threads, activeThreadId, setActiveThreadId,
      getMessages, sendMessage, startDM, createGroup,
      typingUsers, setTyping, markRead, refreshThreads,
    }}>
      {children}
    </ChatContext.Provider>
  );
}

export function useChat() {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error('useChat must be inside ChatProvider');
  return ctx;
}
