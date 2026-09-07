// Typed API client — all calls go to the Go backend
import { diag, classifyDisconnect, reportSessionExpired, backoffDelay } from './diagnostics';

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
  // ── Auth (Continue with IB) ─────────────────────────────────────────────
  // Exchanges an IB Account authorization code (+ PKCE verifier) for an IB
  // Connect session — the only way a session is ever created; password
  // login/signup live entirely on the IB Account hosted pages now.
  oidcCallback: (code: string, codeVerifier: string, nonce: string) =>
    request<{ token: string; user: ApiUser }>('POST', '/auth/oidc/callback', { code, code_verifier: codeVerifier, nonce }),

  me: () => request<ApiUser>('GET', '/auth/me'),

  updateProfile: (fields: { displayName?: string; bio?: string; avatar?: string }) =>
    request<ApiUser>('PUT', '/auth/me', fields),

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

  markRead: (threadId: string) =>
    request<{ ok: boolean }>('POST', `/threads/${threadId}/read`),

  // ── Meetings (NEW) ────────────────────────────────────────────────────────
  getScheduledMeetings: () => 
    request<ApiScheduledMeeting[]>('GET', '/meetings/scheduled'),

  scheduleMeeting: (payload: { title: string; date: string; time: string; invitedUsers?: string[] }) =>
    request<ApiScheduledMeeting>('POST', '/meetings/schedule', payload),

  deleteScheduledMeeting: (id: string) =>
    request<{ message: string }>('DELETE', `/meetings/scheduled/${id}`),

  validateRoomCode: (code: string) =>
    request<{ valid: boolean }>('GET', `/meetings/validate/${code}`),

  // ── LiveKit (media transport) ────────────────────────────────────────────
  // Called only AFTER the /ws create_room/join_room round trip has already
  // succeeded — the backend's authorization for this is "is this identity
  // currently a member of this room" (server/livekit.go), not a fresh
  // check of its own. request()'s existing Authorization-header-if-present
  // behavior is exactly the split the backend expects: a signed-in caller's
  // identity comes from that token server-side, a guest's from the body.
  getLiveKitToken: (roomId: string, userId: string, userName: string) =>
    request<{ token: string; url: string }>('POST', '/livekit/token', {
      room_id: roomId, user_id: userId, user_name: userName,
    }),

  // Same coturn credentials connectionTest.ts already independently fetches
  // for the pre-join diagnostic — coturn was never made obsolete by the
  // LiveKit migration (see CLAUDE.md), it's just a second, unrelated
  // consumer now: useWebRTC.ts passes these into LiveKit's room.connect() as
  // an ICE fallback for participants whose network can't reach the SFU's
  // direct UDP path, the same restrictive-NAT case coturn already existed
  // for under mesh.
  getTurnCredentials: () =>
    request<{ iceServers: RTCIceServer[]; ttlSeconds: number }>('GET', '/turn-credentials'),

  // ── AI features (server/ai.go, gpu/AI_CONTRACT.md) ──────────────────────
  getAIStatus: () => request<{ configured: boolean; detail?: string }>('GET', '/ai/status'),
  aiRewrite: (text: string, mode: string) =>
    request<{ result: string }>('POST', '/ai/rewrite', { text, mode }),
  aiReplySuggestions: (threadId: string) =>
    request<{ suggestions: { tone: string; text: string }[] }>('POST', '/ai/reply-suggestions', { threadId }),
  aiAskThread: (threadId: string, question: string) =>
    request<{ result: string }>('POST', '/ai/ask-thread', { threadId, question }),
  aiAnalyzeThread: (threadId: string) =>
    request<AIThreadAnalysis>('POST', '/ai/analyze-thread', { threadId }),
  getAIMemory: (threadId?: string) =>
    request<{ memory: AIMemoryItem[] }>('GET', `/ai/memory${threadId ? `?threadId=${encodeURIComponent(threadId)}` : ''}`),
  deleteAIMemory: (id: string) => request<{ ok: boolean }>('DELETE', `/ai/memory/${id}`),
  getAITasks: () => request<{ owedByMe: AITaskItem[]; owedToMe: AITaskItem[] }>('GET', '/ai/tasks'),
  completeAITask: (id: string) => request<{ ok: boolean }>('POST', `/ai/tasks/${id}/complete`),
  getAIReminders: () => request<{ reminders: AIReminderItem[] }>('GET', '/ai/reminders'),
  completeAIReminder: (id: string) => request<{ ok: boolean }>('POST', `/ai/reminders/${id}/complete`),
  deleteAIReminder: (id: string) => request<{ ok: boolean }>('DELETE', `/ai/reminders/${id}`),
  aiSearch: (query: string, threadId?: string) =>
    request<{ results: AISearchResult[] }>('POST', '/ai/search', { query, threadId }),
  aiTranslate: (text: string, targetLang: string) =>
    request<{ result: string }>('POST', '/ai/translate', { text, targetLang }),
  aiExtractDocument: (messageId: string) =>
    request<{ summary: string; textLength: number }>('POST', '/ai/documents/extract', { messageId }),
  aiAskDocument: (messageId: string, question: string) =>
    request<{ result: string }>('POST', '/ai/documents/ask', { messageId, question }),
  // ── Meeting transcript + MOM (server/meeting_transcripts.go) ─────────────
  getMeetingTranscript: (roomId: string) =>
    request<{ roomId: string; lines: MeetingTranscriptLine[] }>('GET', `/meetings/${encodeURIComponent(roomId)}/transcript`),
  getMeetingSummary: (roomId: string) =>
    request<MeetingSummary>('POST', `/meetings/${encodeURIComponent(roomId)}/summary`),
};

// ── AI feature types (server/ai.go) ─────────────────────────────────────────

export interface AIActionItem { description: string; assignee: string; due: string }
export interface AIReminderSuggestion { text: string; when: string }
export interface AIMeetingSuggestion { title: string; when: string }
export interface AIThreadAnalysis {
  summary: string;
  keyPoints: string[];
  decisions: string[];
  questions: string[];
  actionItems: AIActionItem[];
  reminders: AIReminderSuggestion[];
  meetingSuggestions: AIMeetingSuggestion[];
}
export interface AIMemoryItem { id: string; fact: string; threadId?: string; createdAt: string }
export interface AITaskItem { id: string; threadId: string; description: string; createdAt: string }
export interface AIReminderItem { id: string; threadId?: string; text: string; createdAt: string }
export interface AISearchResult { messageId: string; threadId: string; threadName: string; senderName: string; text: string; createdAt: string }
export interface MeetingTranscriptLine { speakerId: string; speakerName: string; text: string; lang: string; createdAt: string }
export interface MeetingActionItem { description: string; owner: string }
export interface MeetingSummary {
  summary: string;
  attendees: string[];
  keyPoints: string[];
  decisions: string[];
  actionItems: MeetingActionItem[];
}

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
  | { type: 'call_accepted'; payload: { fromId: string } }
  | { type: 'meeting_reminder'; payload: { threadId: string; meetingId: string; title: string; date: string; time: string } };

export function connectChatWS(
  onEvent: (e: ChatWSEvent) => void,
  onWS?: (ws: WebSocket | null) => void,
): () => void {
  const jwt = token();
  if (!jwt) return () => {};

  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  // NOTE: the token travels in the query string, which means it is written in
  // plaintext to nginx's access log on every connection. That is how the 401
  // behind the 2026-08-12 incident was found — and also why anyone with log
  // access holds replayable sessions. Moving this to a subprotocol header or a
  // one-time ticket is tracked in DEFERRED.md.
  const url = `${proto}://${window.location.host}/chat-ws?token=${encodeURIComponent(jwt)}`;
  let ws: WebSocket | null = null;
  let closed = false;
  let attempt = 0;
  let openedAt = 0;

  const connect = () => {
    diag('chat-ws', 'info', 'connecting', { attempt });
    ws = new WebSocket(url);

    ws.onopen = () => {
      openedAt = performance.now();
      attempt = 0;
      diag('chat-ws', 'info', 'connected');
      onWS?.(ws);
    };

    ws.onerror = () => {
      diag('chat-ws', 'warn', 'socket error (no detail available from the WebSocket API)');
    };

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data as string) as ChatWSEvent;
        onEvent(msg);
      } catch (e) {
        diag('chat-ws', 'error', 'message parse failed', { err: String(e) });
      }
    };

    ws.onclose = async (ev) => {
      const heldMs = openedAt ? Math.round(performance.now() - openedAt) : 0;
      openedAt = 0;
      onWS?.(null);
      diag('chat-ws', 'warn', 'disconnected', {
        code: ev.code, reason: ev.reason || '(none)', wasClean: ev.wasClean,
        heldOpenMs: heldMs, intentional: closed,
      });
      if (closed) return;

      // A rejected handshake (401 for a dead token) reaches JS as a bare close
      // with code 1006 and no detail, identical to an unreachable server. Ask
      // over HTTP, where the status IS readable, before retrying forever.
      const cause = await classifyDisconnect();
      diag('chat-ws', cause === 'session-expired' ? 'error' : 'warn', 'disconnect classified', { cause });
      if (cause === 'session-expired') {
        reportSessionExpired('chat-ws');
        return;
      }
      const delay = backoffDelay(attempt);
      attempt += 1;
      diag('chat-ws', 'info', 'reconnect scheduled', { inMs: delay, attempt, cause });
      setTimeout(connect, delay);
    };
  };

  connect();

  return () => {
    closed = true;
    diag('chat-ws', 'info', 'closing (intentional)');
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
