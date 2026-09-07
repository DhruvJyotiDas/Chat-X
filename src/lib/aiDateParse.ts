// Best-effort parsing of the free-text date/time phrases the AI model
// returns ("tomorrow", "Friday at 4", "next week") into a real calendar
// date/time. Deliberately NOT real NLP date parsing (see gpu/AI_CONTRACT.md
// and server/ai.go's aiActionItem/aiMeetingSuggestion comments on why real
// date parsing was scoped out) — this is a small, disclosed heuristic for
// the common phrasings the feature's own examples use, not a guarantee.
// Callers must treat the result as a starting point the user can correct,
// never as confirmed — which is why addCalendarEvent's caller always shows
// the raw phrase too, not just the parsed guess.

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

export interface ParsedWhen {
  date: string; // YYYY-MM-DD
  startTime: string; // HH:MM, 24h
}

export function parseWhenPhrase(phrase: string, now: Date = new Date()): ParsedWhen {
  const lower = phrase.toLowerCase();
  const result = new Date(now);
  result.setHours(0, 0, 0, 0);

  if (lower.includes('tomorrow')) {
    result.setDate(result.getDate() + 1);
  } else if (lower.includes('today') || lower.includes('tonight')) {
    // already today
  } else {
    const weekdayIdx = WEEKDAYS.findIndex((d) => lower.includes(d));
    if (weekdayIdx !== -1) {
      const todayIdx = result.getDay();
      // "let's meet Friday" said on a Friday means next Friday, not today —
      // matches the phrase's own intent (proposing a future meeting), not a
      // strict "next occurrence including today" reading.
      let diff = (weekdayIdx - todayIdx + 7) % 7;
      if (diff === 0) diff = 7;
      result.setDate(result.getDate() + diff);
    } else if (lower.includes('next week')) {
      result.setDate(result.getDate() + 7);
    }
    // No recognisable phrase at all -> falls through to "today", the same
    // honest fallback a human skimming an ambiguous phrase would default to;
    // the raw phrase is always shown alongside so this is never silently wrong.
  }

  const timeMatch = lower.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
  let hour = 9;
  let minute = 0;
  if (timeMatch) {
    hour = parseInt(timeMatch[1], 10);
    minute = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;
    const meridiem = timeMatch[3];
    if (meridiem === 'pm' && hour < 12) hour += 12;
    if (meridiem === 'am' && hour === 12) hour = 0;
    if (!meridiem && hour < 8) hour += 12; // "at 4" in a work context reads as 4pm more often than 4am
  }

  const yyyy = result.getFullYear();
  const mm = String(result.getMonth() + 1).padStart(2, '0');
  const dd = String(result.getDate()).padStart(2, '0');
  const hh = String(hour).padStart(2, '0');
  const min = String(minute).padStart(2, '0');
  return { date: `${yyyy}-${mm}-${dd}`, startTime: `${hh}:${min}` };
}
