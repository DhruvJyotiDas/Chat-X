// Typed API client — all calls go to the Go backend

const BASE = '/api';

function token(): string {
  return localStorage.getItem('ibconnect_jwt') ?? '';
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token() ? { Authorization: `Bearer ${token()}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  // Read raw text first so we always get useful debug info on failure
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    // Response was not JSON — could be nginx 413 / 502 / HTML error page
    if (res.status === 413) throw new Error('Request too large — try a smaller profile picture (under 500 KB)');
    if (res.status === 502 || res.status === 503) throw new Error('Server temporarily unavailable, please try again');
    throw new Error(`Server error (${res.status}): ${text.slice(0, 120)}`);
  }

  if (!res.ok) throw new Error((json as { error?: string }).error ?? `HTTP ${res.status}`);
  return json as T;
}

export const api = {
  // ── Auth ──────────────────────────────────────────────────────────────────
  signup: (username: string, displayName: string, email: string, password: string, avatar?: string) =>
    request<{ token: string; user: ApiUser }>('POST', '/auth/signup', { username, displayName, email, password, avatar }),

  login: (email: string, password: string) =>
    request<{ token: string; user: ApiUser }>('POST', '/auth/login', { email, password }),

  me: () => request<ApiUser>('GET', '/auth/me'),

  updateProfile: (fields: { displayName?: string; bio?: string; avatar?: string }) =>
    request<ApiUser>('PUT', '/auth/me', fields),

  changePassword: (oldPassword: string, newPassword: string) =>
    request<{ message: string }>('PUT', '/auth/password', { oldPassword, newPassword }),

  // ── Users ─────────────────────────────────────────────────────────────────
  getUsers: () => request<ApiUser[]>('GET', '/users'),

  // ── Threads ───────────────────────────────────────────────────────────────
  getThreads: () => request<ApiThread[]>('GET', '/threads'),

  startDM: (otherUserId: string) =>
    request<ApiThread>('POST', '/threads', { type: 'dm', otherUserId }),

  createGroup: (name: string, memberIds: string[]) =>
    request<ApiThread>('POST', '/threads', { type: 'group', name, memberIds }),

  // ── Messages ──────────────────────────────────────────────────────────────
  getMessages: (threadId: string) =>
    request<ApiMessage[]>('GET', `/threads/${threadId}/messages`),

  sendMessage: (threadId: string, text: string, fileAttachment?: ApiFile) =>
    request<ApiMessage>('POST', `/threads/${threadId}/messages`, { text, fileAttachment }),

  // ── Meetings (NEW) ────────────────────────────────────────────────────────
  getScheduledMeetings: () => 
    request<ApiScheduledMeeting[]>('GET', '/meetings/scheduled'),

  scheduleMeeting: (payload: { title: string; date: string; time: string; invitedUsers?: string[] }) =>
    request<ApiScheduledMeeting>('POST', '/meetings/schedule', payload),

  deleteScheduledMeeting: (id: string) =>
    request<{ message: string }>('DELETE', `/meetings/scheduled/${id}`),

  validateRoomCode: (code: string) =>
    request<{ valid: boolean }>('GET', `/meetings/validate/${code}`),
};

// ── Types ────────────────────────────────────────────────────────────────────

export interface ApiUser {
  id: string;
  username: string;
  displayName: string;
  email: string;
  avatar?: string;
  bio?: string;
  status: 'online' | 'offline' | 'idle';
  createdAt: string;
}

export interface ApiThread {
  id: string;
  type: 'dm' | 'group';
  name: string;
  avatar?: string;
  participants: string[];
  lastMessage: string;
  lastTimestamp: number;
  unreadCount: number;
}

export interface ApiMessage {
  id: string;
  threadId: string;
  senderId: string;
  senderName: string;
  senderAvatar?: string;
  text: string;
  time: string;
  timestamp: number;
  fileAttachment?: ApiFile;
}

export interface ApiFile {
  name: string;
  size: number;
  type: string;
  dataUrl?: string;
}

export interface ApiScheduledMeeting {
  id: string;
  code: string;
  title: string;
  date: string;
  time: string;
  creatorId: string;
}

// ── Chat WebSocket ────────────────────────────────────────────────────────────

export type ChatWSEvent =
  | { type: 'users_list'; payload: ApiUser[] }
  | { type: 'user_status'; payload: { id: string; status: string } }
  | { type: 'new_message'; payload: { threadId: string; message: ApiMessage } }
  | { type: 'thread_created'; payload: ApiThread }
  | { type: 'typing_start'; payload: { threadId: string; userId: string; userName: string } }
  | { type: 'typing_stop'; payload: { threadId: string; userId: string } }
  | { type: 'call_invite'; payload: { fromId: string; fromName: string; roomId: string } }
  | { type: 'call_declined'; payload: { fromId: string } }
  | { type: 'call_accepted'; payload: { fromId: string } };

export function connectChatWS(
  onEvent: (e: ChatWSEvent) => void,
  onWS?: (ws: WebSocket | null) => void,
): () => void {
  const jwt = token();
  if (!jwt) return () => {};

  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${proto}://${window.location.host}/chat-ws?token=${encodeURIComponent(jwt)}`;
  let ws: WebSocket | null = null;
  let closed = false;

  const connect = () => {
    ws = new WebSocket(url);
    ws.onopen = () => { onWS?.(ws); };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data as string) as ChatWSEvent;
        onEvent(msg);
      } catch {}
    };
    ws.onclose = () => {
      onWS?.(null);
      if (!closed) setTimeout(connect, 3000); // auto-reconnect
    };
  };

  connect();

  return () => {
    closed = true;
    ws?.close();
    onWS?.(null);
  };
}

export function sendTyping(ws: WebSocket | null, threadId: string, userName: string, isTyping: boolean) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: isTyping ? 'typing_start' : 'typing_stop', threadId, userName }));
}

export function sendCallInvite(ws: WebSocket | null, toUserId: string, roomId: string, fromName: string) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'call_invite', to: toUserId, roomId, fromName }));
}

export function sendCallDeclined(ws: WebSocket | null, toUserId: string) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'call_declined', to: toUserId }));
}

export function sendCallAccepted(ws: WebSocket | null, toUserId: string) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'call_accepted', to: toUserId }));
}
