// Typed API client — all calls go to the Go backend
import { diag, classifyDisconnect, reportSessionExpired, backoffDelay } from './diagnostics';
import { config } from '../config';

const BASE = config.apiBase.replace(/\/$/, '');

function localDateISO(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

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
    if (res.status === 502 || res.status === 503) throw new Error('AIPA is temporarily unavailable. Please try again in a moment.');
    if (res.status === 504) throw new Error('AIPA is taking longer than expected. Your transcript is safe—please try the summary again.');
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

  updateGroup: (threadId: string, fields: { name: string; description: string; avatar: string; adminsEditInfo: boolean; adminsSend: boolean }) =>
    request<ApiThread>('PUT', `/threads/${threadId}`, fields),

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
    request<ApiScheduledMeeting>('POST', '/meetings/schedule', { ...payload, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }),

  deleteScheduledMeeting: (id: string) =>
    request<{ message: string }>('DELETE', `/meetings/scheduled/${id}`),

  validateRoomCode: (code: string) =>
    request<{ valid: boolean }>('GET', `/meetings/validate/${code}`),

  // ── Calendar ─────────────────────────────────────────────────────────────
  getCalendars: () => request<ApiCalendar[]>('GET', `/calendar/calendars?timeZone=${encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone)}`),
  createCalendar: (payload: Pick<ApiCalendar, 'name' | 'color' | 'timeZone'>) =>
    request<ApiCalendar>('POST', '/calendar/calendars', payload),
  shareCalendar: (calendarId: string, userId: string, role: 'viewer' | 'editor' | 'remove') =>
    request<{ ok: boolean }>('POST', `/calendar/calendars/${encodeURIComponent(calendarId)}/members`, { userId, role }),
  getCalendarEvents: (from: string, to: string, q = '', calendarId = '') => {
    const params = new URLSearchParams({ from, to });
    if (q) params.set('q', q);
    if (calendarId) params.set('calendarId', calendarId);
    return request<ApiCalendarEvent[]>('GET', `/calendar/events?${params}`);
  },
  createCalendarEvent: (payload: ApiCalendarEventInput) => request<ApiCalendarEvent>('POST', '/calendar/events', payload),
  updateCalendarEvent: (id: string, payload: ApiCalendarEventInput) =>
    request<ApiCalendarEvent>('PUT', `/calendar/events/${encodeURIComponent(id)}`, payload),
  deleteCalendarEvent: (id: string) => request<{ ok: boolean }>('DELETE', `/calendar/events/${encodeURIComponent(id)}`),
  respondCalendarEvent: (id: string, response: CalendarResponse) =>
    request<{ response: CalendarResponse }>('POST', `/calendar/events/${encodeURIComponent(id)}/response`, { response }),
  getWorkingHours: () => request<ApiWorkingHours>('GET', '/calendar/working-hours'),
  updateWorkingHours: (payload: ApiWorkingHours) => request<ApiWorkingHours>('PUT', '/calendar/working-hours', payload),
  getAvailability: (userIds: string[], from: string, to: string, duration: number) => {
    const params = new URLSearchParams({ userIds: userIds.join(','), from, to, duration: String(duration), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
    return request<ApiAvailability>('GET', `/calendar/availability?${params}`);
  },
  getCalendarConflicts: (userIds: string[], from: string, to: string, excludeEventId = '') => {
    const params = new URLSearchParams({ userIds: userIds.join(','), from, to });
    if (excludeEventId) params.set('excludeEventId', excludeEventId);
    return request<ApiConflicts>('GET', `/calendar/conflicts?${params}`);
  },
  getCalendarNotifications: () => request<ApiCalendarNotification[]>('GET', '/calendar/notifications'),
  readCalendarNotification: (id: string) => request<{ ok: boolean }>('POST', `/calendar/notifications/${encodeURIComponent(id)}/read`),
  confirmCalendarAction: (confirmationToken: string, approve: boolean) =>
    request<{ ok: boolean; message: string; event?: ApiCalendarEvent }>('POST', '/calendar/actions/confirm', { token: confirmationToken, approve }),

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
  // Sends the user's own local date + personal (client-only) calendar events
  // alongside the message so AIPA can answer "what's on my calendar" and
  // resolve relative dates ("tomorrow") against the user's actual today —
  // see buildAIPAContext/detectScheduleIntent in server/ai_assistant.go.
  // `action` comes back set (e.g. "schedule_meeting") when the message was
  // recognized as a real request and actually carried out server-side,
  // rather than just answered.
  aiChat: (
    text: string,
    messages: AIAssistantMessage[] = [],
    personalEvents: AIPACalendarEvent[] = [],
    recentCalls: AIPACallRecord[] = [],
  ) =>
    request<AIPAChatResponse>('POST', '/ai/chat', {
      text,
      messages,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      localNow: localDateISO(),
      personalEvents,
      recentCalls,
    }),
  aiDailyBrief: (force = false) => request<AIDailyBrief>('POST', '/ai/daily-brief', {
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    localNow: new Date().toString(),
    force,
  }),
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
  getAIPAOpportunities: (limit = 20) =>
    request<{ opportunities: AIPAOpportunity[] }>('GET', `/ai/opportunities?limit=${limit}`),
  dismissAIPAOpportunity: (id: string) =>
    request<{ ok: boolean }>('POST', `/ai/opportunities/${encodeURIComponent(id)}/dismiss`),
  snoozeAIPAOpportunity: (id: string, minutes = 60) =>
    request<{ ok: boolean }>('POST', `/ai/opportunities/${encodeURIComponent(id)}/snooze`, { minutes }),
  completeAIPAOpportunity: (id: string) =>
    request<{ ok: boolean }>('POST', `/ai/opportunities/${encodeURIComponent(id)}/complete`),
  acceptAIPAOpportunity: (id: string) =>
    request<{ ok: boolean }>('POST', `/ai/opportunities/${encodeURIComponent(id)}/accept`),
  feedbackAIPAOpportunity: (id: string, value: 'helpful' | 'not_relevant') =>
    request<{ ok: boolean }>('POST', `/ai/opportunities/${encodeURIComponent(id)}/feedback`, { value }),
  getAIPAProactivePreferences: () => request<AIPAProactivePreferences>('GET', '/ai/proactive-preferences'),
  updateAIPAProactivePreferences: (preferences: AIPAProactivePreferences) =>
    request<AIPAProactivePreferences>('PUT', '/ai/proactive-preferences', preferences),
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
export interface AIAssistantMessage { role: 'user' | 'assistant'; text: string }
export interface AIPACalendarEvent {
  id: string; title: string; date: string; startTime: string; endTime?: string;
  allDay?: boolean; description?: string; location?: string;
}
export interface AIPACallRecord {
  type: 'incoming' | 'outgoing' | 'missed'; callType: 'video' | 'audio';
  participantName: string; duration?: string; occurredAt: string;
}
export interface AIPAContextSource { kind: string; label: string; count: number }
export interface AIPAContextSummary {
  sources: AIPAContextSource[]; unavailable: string[]; webSearchConfigured: boolean;
}
export interface AIPAWebSource { title: string; url: string; snippet: string }
export interface AIPAChatResponse {
  result: string; action?: string; context?: AIPAContextSummary; sources?: AIPAWebSource[];
  confirmationToken?: string;
  proposedAction?: AIPACalendarAction;
}
export interface AIPACalendarAction {
  action: 'create' | 'update' | 'delete'; eventId?: string; title: string; date: string;
  startTime: string; endTime: string; timeZone: string; attendeeNames?: string[]; warning?: string;
}
export interface AIPAOpportunity {
  id: string; kind: string; title: string; summary: string; sourceType: string; sourceId: string;
  confidence: number; priority: number; actionLabel?: string; confirmationToken?: string;
  proposedAction?: AIPACalendarAction; status: 'pending' | 'snoozed' | 'dismissed' | 'completed';
  resultRef?: string; feedback?: 'helpful' | 'not_relevant'; createdAt: string; updatedAt: string;
}
export interface AIPAProactivePreferences {
  enabled: boolean;
  meetingSuggestions: boolean;
  dailyPlanning: boolean;
  taskSignals: boolean;
  replySignals: boolean;
  meetingPrep: boolean;
  postMeeting: boolean;
  quietStart: string;
  quietEnd: string;
  timeZone: string;
  dailyLimit: number;
}
export interface AIBriefItem { title: string; why: string; sourceRef: string }
export interface AIDailyBrief {
  headline: string;
  summary: string;
  priorities: AIBriefItem[];
  followUps: AIBriefItem[];
  watchouts: string[];
  generatedAt: string;
  sourceCount: number;
  generatedBy?: 'ai' | 'grounded_fallback';
  notice?: string;
}
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
  description?: string;
  createdBy?: string;
  adminsEditInfo?: boolean;
  adminsSend?: boolean;
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
  inviteeIds?: string[];
}

export interface ApiCalendar {
  id: string;
  name: string;
  color: string;
  timeZone: string;
  ownerId: string;
  role: 'owner' | 'editor' | 'viewer';
  isDefault: boolean;
  memberCount: number;
}

export type CalendarResponse = 'needs_action' | 'accepted' | 'declined' | 'tentative';

export interface ApiCalendarAttendee {
  userId: string;
  displayName: string;
  email: string;
  response: CalendarResponse;
}

export interface ApiCalendarEvent {
  id: string;
  seriesId?: string;
  calendarId: string;
  calendarName: string;
  title: string;
  description: string;
  location: string;
  date: string;
  startTime: string;
  endTime: string;
  allDay: boolean;
  timeZone: string;
  recurrence?: '' | 'DAILY' | 'WEEKLY' | 'WEEKDAYS' | 'MONTHLY';
  color: string;
  creatorId: string;
  organizerId: string;
  meetingCode?: string;
  reminderMinutes: number;
  responseStatus: CalendarResponse;
  canEdit: boolean;
  version: number;
  attendees: ApiCalendarAttendee[];
}

export interface ApiCalendarEventInput {
  calendarId: string;
  title: string;
  description: string;
  location: string;
  date: string;
  startTime: string;
  endTime: string;
  allDay: boolean;
  timeZone: string;
  recurrence: '' | 'DAILY' | 'WEEKLY' | 'WEEKDAYS' | 'MONTHLY';
  attendeeIds: string[];
  reminderMinutes: number;
  meetingCode?: string;
}

export interface ApiWorkingHours { timeZone: string; days: number[]; startTime: string; endTime: string }
export interface ApiBusyInterval { userId: string; start: string; end: string }
export interface ApiAvailability { busy: ApiBusyInterval[]; suggestions: { start: string; end: string }[]; timeZone: string }
export interface ApiConflicts { hasConflict: boolean; conflicts: ApiBusyInterval[]; suggestions: { start: string; end: string }[] }
export interface ApiCalendarNotification { id: string; eventId: string; title: string; date: string; time: string; location: string }

// ── Chat WebSocket ────────────────────────────────────────────────────────────

export type ChatWSEvent =
  | { type: 'users_list'; payload: ApiUser[] }
  | { type: 'user_status'; payload: { id: string; status: string } }
  | { type: 'new_message'; payload: { threadId: string; message: ApiMessage } }
  | { type: 'thread_created'; payload: ApiThread }
  | { type: 'thread_updated'; payload: ApiThread }
  | { type: 'typing_start'; payload: { threadId: string; userId: string; userName: string } }
  | { type: 'typing_stop'; payload: { threadId: string; userId: string } }
  | { type: 'call_invite'; payload: { fromId: string; fromName: string; roomId: string; callType: 'audio' | 'video' } }
  | { type: 'call_declined'; payload: { fromId: string } }
  | { type: 'call_accepted'; payload: { fromId: string } }
  | { type: 'meeting_reminder'; payload: { threadId: string; meetingId: string; title: string; date: string; time: string } }
  | { type: 'calendar_reminder'; payload: { notificationId: string; eventId: string; title: string; date: string; time: string; location?: string } }
  | { type: 'aipa_opportunity'; payload: { id: string; kind: string; title: string } }
  | { type: 'calendar_invitation' | 'calendar_updated' | 'calendar_cancelled' | 'calendar_shared' | 'calendar_response'; payload: Record<string, unknown> };

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

export function sendCallInvite(ws: WebSocket | null, toUserId: string, roomId: string, fromName: string, callType: 'audio' | 'video' = 'video') {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'call_invite', to: toUserId, roomId, fromName, callType }));
}

export function sendCallDeclined(ws: WebSocket | null, toUserId: string) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'call_declined', to: toUserId }));
}

export function sendCallAccepted(ws: WebSocket | null, toUserId: string) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'call_accepted', to: toUserId }));
}
