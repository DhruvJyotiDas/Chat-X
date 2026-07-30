import { CalendarEvent } from '../types';

const key = (userId: string) => `ibconnect_calendar_${userId}`;

export function loadCalendarEvents(userId: string): CalendarEvent[] {
  try { return JSON.parse(localStorage.getItem(key(userId)) || '[]'); } catch { return []; }
}

export function saveCalendarEvents(userId: string, events: CalendarEvent[]) {
  localStorage.setItem(key(userId), JSON.stringify(events));
}

export function addCalendarEvent(userId: string, event: CalendarEvent): CalendarEvent[] {
  const updated = [...loadCalendarEvents(userId), event];
  saveCalendarEvents(userId, updated);
  return updated;
}

export function updateCalendarEvent(userId: string, event: CalendarEvent): CalendarEvent[] {
  const updated = loadCalendarEvents(userId).map(e => e.id === event.id ? event : e);
  saveCalendarEvents(userId, updated);
  return updated;
}

export function deleteCalendarEvent(userId: string, eventId: string): CalendarEvent[] {
  const updated = loadCalendarEvents(userId).filter(e => e.id !== eventId);
  saveCalendarEvents(userId, updated);
  return updated;
}
