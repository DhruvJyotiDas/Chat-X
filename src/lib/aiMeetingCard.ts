// Parses the persisted meeting-card messages server/ai_meetings.go posts into
// a thread. Calendar synchronization now happens server-side; cards remain a
// durable, human-visible explanation of what AIPA detected in the chat.

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
