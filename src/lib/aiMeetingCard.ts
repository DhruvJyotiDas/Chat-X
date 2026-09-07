// AI Calendar Intelligence, live version — parses the meeting-card messages
// server/ai_meetings.go posts into a thread (encodeMeetingCard there is the
// authoritative source of this exact format; keep both in sync) and syncs
// them into THIS viewer's own local calendar (calendarLocal.ts — the
// calendar itself is still per-user localStorage, not server-side; see
// ai_meetings.go's own header for why that's still true and what IS shared).
//
// Both participants' clients independently run this same sync whenever they
// see the card — over the live "new_message" ws event if they're connected
// when it's posted, or when they next load the thread's message history
// otherwise (a card is a normal, persisted chat message, so a GET replay
// reconstructs it exactly the same way a live event would have).

import { addCalendarEvent, updateCalendarEvent, deleteCalendarEvent, loadCalendarEvents } from './calendarLocal';

const MEETING_CARD_PREFIX = '\x01MEETING\x01';

export interface MeetingCardPayload {
  meetingId: string;
  title: string;
  date: string; // YYYY-MM-DD
  time: string; // HH:MM, 24h
  action: 'created' | 'updated' | 'cancelled';
}

export function parseMeetingCard(text: string): MeetingCardPayload | null {
  if (!text || !text.startsWith(MEETING_CARD_PREFIX)) return null;
  try {
    const parsed = JSON.parse(text.slice(MEETING_CARD_PREFIX.length));
    if (parsed && typeof parsed.meetingId === 'string') return parsed as MeetingCardPayload;
  } catch { /* not a real card — a human message could theoretically start with this byte if something went very wrong upstream; fail closed */ }
  return null;
}

// Deterministic id shared by every card for the same meeting (created ->
// updated -> cancelled all carry the same meetingId), so create/update/cancel
// all target the exact same local calendar event rather than accumulating
// duplicates every time a meeting's time is revised.
const localEventId = (meetingId: string) => `ai-meeting-${meetingId}`;

/** Mirrors server/ai_meetings.go's friendlyMessagePreview — the raw card
 *  text is correct for parseMeetingCard above but would show as garbled
 *  control-character JSON in a thread-list "last message" preview. */
export function friendlyMessagePreview(text: string): string {
  const card = parseMeetingCard(text);
  if (!card) return text;
  switch (card.action) {
    case 'cancelled': return '📅 Meeting cancelled';
    case 'updated': return `📅 Meeting updated: ${card.title}`;
    default: return `📅 Meeting scheduled: ${card.title}`;
  }
}

/** Call with every message a viewer sees (a live one, or a page of history)
 *  — idempotent, so re-processing the same card twice (e.g. on every reload)
 *  is harmless. */
export function syncMeetingCardsToCalendar(messages: { text: string }[], userId: string): void {
  if (!userId) return;
  for (const m of messages) {
    const card = parseMeetingCard(m.text);
    if (!card) continue;
    const eventId = localEventId(card.meetingId);
    if (card.action === 'cancelled') {
      deleteCalendarEvent(userId, eventId);
      continue;
    }
    const exists = loadCalendarEvents(userId).some((e) => e.id === eventId);
    const event = {
      id: eventId,
      title: card.title,
      date: card.date,
      startTime: card.time,
      description: 'Automatically scheduled from this conversation by AI — check the chat if the time looks wrong.',
      color: '#b0c6ff',
      creatorId: userId,
    };
    if (exists) updateCalendarEvent(userId, event);
    else addCalendarEvent(userId, event);
  }
}
