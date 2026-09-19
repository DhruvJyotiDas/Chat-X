import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlignLeft, CalendarDays, CalendarRange, ChevronLeft, ChevronRight, Clock,
  Columns3, ExternalLink, Grid3x3, List, MapPin, Plus, Search, Settings2,
  Trash2, Users, Video, X, Check,
} from 'lucide-react';
import { CalendarEvent } from '../../types';
import { useAuth } from '../../context/AuthContext';
import { useMeeting } from '../../context/MeetingContext';
import { loadCalendarEvents } from '../../lib/calendarLocal';
import { api, type ApiCalendar, type ApiCalendarEventInput, type ApiWorkingHours, type CalendarResponse } from '../../lib/api';
import Input from '../ui/Input';

const EVENT_TYPES = [
  { name: 'Personal', value: '#6ea8ff' },
  { name: 'Focus', value: '#70e1a1' },
  { name: 'Academic', value: '#c5a7ff' },
  { name: 'Admin', value: '#ff9f8f' },
  { name: 'Meeting', value: '#7dd3fc' },
  { name: 'Important', value: '#ffd166' },
];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
const HOUR_HEIGHT = 64;

type ViewMode = 'month' | 'week' | 'day' | 'agenda';
type ModalState = { date: string; event: CalendarEvent | null; startTime?: string };

function formatDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function parseDate(value: string): Date {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day);
}

function addDays(date: Date, amount: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + amount);
  return next;
}

function startOfWeek(date: Date): Date {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  start.setDate(start.getDate() - start.getDay());
  return start;
}

function timeToMinutes(value?: string): number {
  if (!value) return 0;
  const [hours, minutes] = value.split(':').map(Number);
  return (Number.isFinite(hours) ? hours : 0) * 60 + (Number.isFinite(minutes) ? minutes : 0);
}

function minutesToTime(value: number): string {
  const safe = Math.max(0, Math.min(23 * 60 + 30, value));
  return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`;
}

function addMinutes(value: string, amount: number): string {
  return minutesToTime(timeToMinutes(value) + amount);
}

function formatTime(value?: string): string {
  if (!value) return '';
  const [hours, minutes] = value.split(':').map(Number);
  return new Date(2000, 0, 1, hours, minutes).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function formatLongDate(date: Date): string {
  return date.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
}

function getMeetingCode(event: CalendarEvent): string | null {
  const match = event.description?.match(/Meeting code:\s*(\S+)/i);
  return match?.[1] ?? null;
}

function eventDuration(event: CalendarEvent): number {
  const start = timeToMinutes(event.startTime);
  const end = timeToMinutes(event.endTime);
  return Math.max(30, end > start ? end - start : 60);
}

// EventModal already implements a hand-rolled responsive shape equivalent to
// the shared Modal primitive's own sheet variant (items-end + rounded-t on
// mobile, items-center + fully rounded on desktop) -- kept as its own
// implementation rather than migrated onto <Modal> (sub-unit 5's "event form
// on Modal/Input"), since its Save/Cancel/Delete footer must stay pinned
// below a long scrollable form, and Modal currently only exposes one
// scrollable body region with no separate footer slot. Adding that slot is
// primitive-API work, not something to fold silently into one screen's
// retheme pass. Single-line fields (title, location, date, start/end time)
// use the shared Input primitive directly, satisfying the "...and Input"
// half concretely.
function EventModal({ initialDate, initialTime, event, readOnly, calendars, users, onClose, onSave, onDelete, onRespond }: {
  initialDate: string;
  initialTime?: string;
  event: CalendarEvent | null;
  readOnly?: boolean;
  calendars: ApiCalendar[];
  users: { id: string; displayName: string; email: string }[];
  onClose: () => void;
  onSave: (event: CalendarEvent) => Promise<void>;
  onDelete?: (id: string) => Promise<void>;
  onRespond?: (response: CalendarResponse) => Promise<void>;
}) {
  const defaultStart = initialTime ?? '09:00';
  const [title, setTitle] = useState(event?.title ?? '');
  const [date, setDate] = useState(event?.date ?? initialDate);
  const [allDay, setAllDay] = useState(event?.allDay ?? false);
  const [startTime, setStartTime] = useState(event?.startTime ?? defaultStart);
  const [endTime, setEndTime] = useState(event?.endTime ?? addMinutes(defaultStart, 60));
  const [description, setDescription] = useState(event?.description ?? '');
  const [location, setLocation] = useState(event?.location ?? '');
  const [color, setColor] = useState(event?.color ?? EVENT_TYPES[0].value);
  const [calendarId, setCalendarId] = useState(event?.calendarId ?? calendars.find(calendar => calendar.role !== 'viewer')?.id ?? '');
  const [recurrence, setRecurrence] = useState<NonNullable<CalendarEvent['recurrence']>>(event?.recurrence ?? '');
  const [attendeeIds, setAttendeeIds] = useState<string[]>(event?.attendees?.map(attendee => attendee.userId) ?? []);
  const [reminderMinutes, setReminderMinutes] = useState(event?.reminderMinutes ?? 10);
  const [conflicts, setConflicts] = useState(0);
  const [suggestions, setSuggestions] = useState<{ start: string; end: string }[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState('');
  const meetingCode = event?.meetingCode || (event ? getMeetingCode(event) : null);
  const canSave = title.trim().length > 0 && date && (allDay || endTime > startTime);

  useEffect(() => {
    if (readOnly || allDay || !date || !startTime || !endTime || endTime <= startTime) return;
    const timer = window.setTimeout(async () => {
      try {
        const start = new Date(`${date}T${startTime}:00`).toISOString();
        const end = new Date(`${date}T${endTime}:00`).toISOString();
        const result = await api.getCalendarConflicts(attendeeIds, start, end, event?.seriesId ?? event?.id ?? '');
        setConflicts(result.conflicts.length);
        setSuggestions(result.suggestions);
      } catch { setConflicts(0); setSuggestions([]); }
    }, 400);
    return () => window.clearTimeout(timer);
  }, [attendeeIds, date, startTime, endTime, allDay, readOnly, event?.id, event?.seriesId]);

  const save = async () => {
    if (!canSave || readOnly) return;
    setIsSaving(true);
    setError('');
    try { await onSave({
      id: event?.id ?? `evt-${Date.now()}`,
      creatorId: event?.creatorId ?? '',
      title: title.trim(),
      date,
      startTime: allDay ? '00:00' : startTime,
      endTime: allDay ? '23:59' : endTime,
      allDay,
      description: description.trim(),
      location: location.trim(),
      color,
      calendarId,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      recurrence,
      attendeeIds,
      attendees: event?.attendees,
      reminderMinutes,
      meetingCode: event?.meetingCode,
      version: event?.version,
    }); } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not save the event.');
    } finally { setIsSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-[90] flex items-end justify-center bg-[var(--ib-gray-900)]/40 backdrop-blur-sm p-0 sm:items-center sm:p-4" onMouseDown={event => event.target === event.currentTarget && onClose()}>
      <section className="w-full overflow-hidden rounded-t-[28px] border border-[var(--ib-border)] bg-[var(--ib-surface-raised)] shadow-[var(--ib-shadow-lg)] sm:max-w-lg sm:rounded-[28px]">
        <header className="flex items-center justify-between border-b border-[var(--ib-border)] px-5 py-4">
          <div>
            <p className="text-[9px] font-bold uppercase tracking-[.16em] text-[var(--ib-text-muted)]">{readOnly ? 'IB Connect meeting' : event ? 'Edit calendar event' : 'Create calendar event'}</p>
            <h2 className="mt-1 text-base font-semibold text-[var(--ib-text)]">{readOnly ? event?.title : event ? 'Update event' : 'Add to your calendar'}</h2>
          </div>
          <button onClick={onClose} className="grid h-11 w-11 place-items-center rounded-xl text-[var(--ib-text-muted)] hover:bg-[var(--ib-gray-100)] hover:text-[var(--ib-text)] cursor-pointer" aria-label="Close"><X className="h-4 w-4" /></button>
        </header>

        {readOnly ? (
          <div className="space-y-4 p-5">
            <div className="rounded-2xl border border-[var(--ib-border)] bg-[var(--ib-gray-50)] p-4">
              <div className="flex items-center gap-3 text-sm text-[var(--ib-text)]"><CalendarDays className="h-4 w-4 text-[var(--ib-blue-500)]" />{formatLongDate(parseDate(event!.date))}</div>
              <div className="mt-3 flex items-center gap-3 text-sm text-[var(--ib-text-muted)]"><Clock className="h-4 w-4 text-[var(--ib-blue-500)]" />{formatTime(event!.startTime)}</div>
              {event?.location && <div className="mt-3 flex items-center gap-3 text-sm text-[var(--ib-text-muted)]"><MapPin className="h-4 w-4 text-[var(--ib-blue-500)]" />{event.location}</div>}
              {event?.description && <p className="mt-4 border-t border-[var(--ib-border)] pt-4 text-xs leading-5 text-[var(--ib-text-muted)]">{event.description}</p>}
              {!!event?.attendees?.length && <div className="mt-4 border-t border-[var(--ib-border)] pt-4"><p className="mb-2 text-[9px] font-bold uppercase tracking-[.12em] text-[var(--ib-text-muted)]">Attendees</p><div className="space-y-1.5">{event.attendees.map(attendee => <div key={attendee.userId} className="flex items-center justify-between text-xs"><span className="text-[var(--ib-text)]">{attendee.displayName}</span><span className="capitalize text-[var(--ib-text-muted)]">{attendee.response.replace('_', ' ')}</span></div>)}</div></div>}
            </div>
            {event?.responseStatus === 'needs_action' && onRespond && <div><p className="mb-2 text-[10px] font-semibold text-[var(--ib-text-muted)]">Your response</p><div className="grid grid-cols-3 gap-2">{(['accepted', 'tentative', 'declined'] as CalendarResponse[]).map(response => <button key={response} onClick={() => onRespond(response)} className="h-11 rounded-xl border border-[var(--ib-border)] px-2 text-[10px] font-semibold capitalize text-[var(--ib-text)] hover:border-[var(--ib-blue-500)]/40 hover:bg-[var(--ib-blue-50)] cursor-pointer">{response}</button>)}</div></div>}
            {meetingCode && <a href={`/${meetingCode}`} className="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-[var(--ib-blue-500)] px-4 text-sm font-semibold text-white hover:bg-[var(--ib-blue-600)]"><Video className="h-4 w-4" />Join meeting<ExternalLink className="h-3.5 w-3.5" /></a>}
          </div>
        ) : (
          <div className="max-h-[78vh] space-y-4 overflow-y-auto p-5">
            <input autoFocus value={title} onChange={e => setTitle(e.target.value)} placeholder="Add title" className="w-full min-h-11 border-0 border-b border-[var(--ib-border)] bg-transparent px-1 pb-3 text-xl font-medium text-[var(--ib-text)] outline-none placeholder:text-[var(--ib-text-muted)] focus:border-[var(--ib-blue-500)] touch-manipulation" />

            <div className="flex items-center justify-between rounded-xl border border-[var(--ib-border)] bg-[var(--ib-gray-50)] px-3 py-2.5">
              <div className="flex items-center gap-2 text-xs text-[var(--ib-text)]"><CalendarRange className="h-4 w-4 text-[var(--ib-blue-500)]" />All-day event</div>
              <button type="button" onClick={() => setAllDay(value => !value)} className={`relative h-6 w-11 rounded-full transition cursor-pointer ${allDay ? 'bg-[var(--ib-blue-500)]' : 'bg-[var(--ib-gray-200)]'}`} aria-pressed={allDay}><span className={`absolute top-1 h-4 w-4 rounded-full bg-white transition ${allDay ? 'left-6' : 'left-1'}`} /></button>
            </div>

            <div className={`grid gap-3 ${allDay ? 'grid-cols-1' : 'grid-cols-3'}`}>
              <Input label="Date" type="date" value={date} onChange={e => setDate(e.target.value)} />
              {!allDay && <Input label="Starts" type="time" value={startTime} onChange={e => { setStartTime(e.target.value); if (endTime <= e.target.value) setEndTime(addMinutes(e.target.value, 60)); }} />}
              {!allDay && <Input label="Ends" type="time" value={endTime} min={startTime} onChange={e => setEndTime(e.target.value)} />}
            </div>
            {!allDay && endTime <= startTime && <p className="text-[10px] text-[var(--ib-warn-text)]">End time must be after the start time.</p>}

            <Input value={location} onChange={e => setLocation(e.target.value)} placeholder="Add location or meeting link" />
            <label className="flex items-start gap-3 rounded-xl border border-[var(--ib-border)] bg-[var(--ib-gray-50)] px-3 py-2.5 focus-within:border-[var(--ib-blue-500)] focus-within:shadow-[var(--ib-shadow-focus)]"><AlignLeft className="mt-0.5 h-4 w-4 shrink-0 text-[var(--ib-text-muted)]" /><textarea value={description} onChange={e => setDescription(e.target.value)} rows={3} placeholder="Add notes, agenda, or preparation details" className="min-w-0 flex-1 resize-none bg-transparent text-base sm:text-xs leading-5 text-[var(--ib-text)] outline-none placeholder:text-[var(--ib-text-muted)] touch-manipulation" /></label>

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="space-y-1.5"><span className="text-[9px] font-bold uppercase tracking-[.12em] text-[var(--ib-text-muted)]">Repeats</span><select value={recurrence} onChange={e => setRecurrence(e.target.value as NonNullable<CalendarEvent['recurrence']>)} className="w-full h-11 rounded-xl border border-[var(--ib-border)] bg-[var(--ib-gray-50)] px-3 text-xs text-[var(--ib-text)] outline-none cursor-pointer"><option value="">Does not repeat</option><option value="DAILY">Daily</option><option value="WEEKDAYS">Every weekday</option><option value="WEEKLY">Weekly</option><option value="MONTHLY">Monthly</option></select></label>
              <label className="space-y-1.5"><span className="text-[9px] font-bold uppercase tracking-[.12em] text-[var(--ib-text-muted)]">Reminder</span><select value={reminderMinutes} onChange={e => setReminderMinutes(Number(e.target.value))} className="w-full h-11 rounded-xl border border-[var(--ib-border)] bg-[var(--ib-gray-50)] px-3 text-xs text-[var(--ib-text)] outline-none cursor-pointer"><option value={0}>At event time</option><option value={5}>5 minutes before</option><option value={10}>10 minutes before</option><option value={30}>30 minutes before</option><option value={60}>1 hour before</option><option value={1440}>1 day before</option></select></label>
            </div>

            <div>
              <p className="mb-2 flex items-center gap-2 text-[9px] font-bold uppercase tracking-[.12em] text-[var(--ib-text-muted)]"><Users className="h-3.5 w-3.5" />Attendees and invitations</p>
              <div className="max-h-32 space-y-1 overflow-y-auto rounded-xl border border-[var(--ib-border)] bg-[var(--ib-gray-50)] p-2">{users.length ? users.map(user => { const selected = attendeeIds.includes(user.id); return <button type="button" key={user.id} onClick={() => setAttendeeIds(current => selected ? current.filter(id => id !== user.id) : [...current, user.id])} className={`flex w-full min-h-11 items-center gap-2 rounded-lg px-2 py-2 text-left text-[10px] cursor-pointer ${selected ? 'bg-[var(--ib-blue-50)] text-[var(--ib-text)]' : 'text-[var(--ib-text-muted)] hover:bg-[var(--ib-gray-100)]'}`}><span className={`grid h-4 w-4 place-items-center rounded border ${selected ? 'border-[var(--ib-blue-500)] bg-[var(--ib-blue-500)]' : 'border-[var(--ib-gray-200)]'}`}>{selected && <Check className="h-3 w-3 text-white" />}</span><span className="min-w-0 flex-1 truncate">{user.displayName}</span><span className="hidden truncate text-[8px] text-[var(--ib-text-muted)] sm:block">{user.email}</span></button>; }) : <p className="p-2 text-[10px] text-[var(--ib-text-muted)]">Start conversations with teammates to invite them.</p>}</div>
            </div>

            {conflicts > 0 && <div className="rounded-xl border border-[var(--ib-warn-dot)]/25 bg-[var(--ib-warn-fill)] p-3"><p className="text-[10px] font-semibold text-[var(--ib-warn-text)]">{conflicts} availability conflict{conflicts === 1 ? '' : 's'} detected</p>{suggestions.length > 0 && <div className="mt-2 flex flex-wrap gap-1.5">{suggestions.slice(0, 3).map(suggestion => { const start = new Date(suggestion.start); return <button type="button" key={suggestion.start} onClick={() => { setDate(formatDate(start)); setStartTime(`${String(start.getHours()).padStart(2, '0')}:${String(start.getMinutes()).padStart(2, '0')}`); setEndTime(addMinutes(`${String(start.getHours()).padStart(2, '0')}:${String(start.getMinutes()).padStart(2, '0')}`, Math.max(30, timeToMinutes(endTime) - timeToMinutes(startTime)))); }} className="rounded-lg border border-[var(--ib-warn-dot)]/30 px-2 py-1 text-[9px] text-[var(--ib-warn-text)] hover:bg-[var(--ib-warn-fill)] cursor-pointer">{start.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} · {start.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</button>; })}</div>}</div>}

            <div>
              <p className="mb-2 text-[9px] font-bold uppercase tracking-[.12em] text-[var(--ib-text-muted)]">Calendar</p>
              <div className="flex flex-wrap gap-2">{calendars.filter(calendar => calendar.role !== 'viewer').map(calendar => <button type="button" key={calendar.id} onClick={() => { setCalendarId(calendar.id); setColor(calendar.color); }} className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-[10px] font-semibold transition cursor-pointer ${calendarId === calendar.id ? 'border-[var(--ib-blue-500)]/40 bg-[var(--ib-blue-50)] text-[var(--ib-text)]' : 'border-[var(--ib-border)] text-[var(--ib-text-muted)] hover:bg-[var(--ib-gray-50)]'}`}><span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: calendar.color }} />{calendar.name}</button>)}</div>
            </div>

            {error && <p className="rounded-xl border border-[var(--ib-bad-dot)]/25 bg-[var(--ib-bad-fill)] px-3 py-2 text-[10px] text-[var(--ib-bad-text)]">{error}</p>}

            <footer className="flex items-center gap-2 border-t border-[var(--ib-border)] pt-4">
              {event && onDelete && <button onClick={() => onDelete(event.id)} className="grid h-11 w-11 place-items-center rounded-xl border border-[var(--ib-bad-dot)]/25 bg-[var(--ib-bad-fill)] text-[var(--ib-bad-text)] hover:bg-[var(--ib-bad-fill)]/70 cursor-pointer" title="Delete event"><Trash2 className="h-4 w-4" /></button>}
              <div className="flex-1" />
              <button onClick={onClose} className="h-11 rounded-xl px-4 text-xs font-semibold text-[var(--ib-text-muted)] hover:bg-[var(--ib-gray-100)] cursor-pointer">Cancel</button>
              <button onClick={save} disabled={!canSave || isSaving} className="h-11 rounded-xl bg-[var(--ib-blue-500)] px-5 text-xs font-semibold text-white shadow-[var(--ib-shadow-sm)] hover:bg-[var(--ib-blue-600)] disabled:cursor-not-allowed disabled:opacity-35 cursor-pointer">{isSaving ? 'Saving…' : event ? 'Save changes' : 'Create event'}</button>
            </footer>
          </div>
        )}
      </section>
    </div>
  );
}

function EventChip({ event, compact = false, onOpen }: { event: CalendarEvent; compact?: boolean; onOpen: () => void }) {
  return (
    <button onClick={e => { e.stopPropagation(); onOpen(); }} className="group flex w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-left transition hover:brightness-95 cursor-pointer" style={{ backgroundColor: `${event.color}25`, color: event.color }} title={`${event.title} · ${event.allDay ? 'All day' : formatTime(event.startTime)}`}>
      <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: event.color }} />
      {!compact && <span className="shrink-0 text-[9px] font-medium opacity-80">{event.allDay ? 'All day' : formatTime(event.startTime)}</span>}
      <span className="truncate text-[10px] font-semibold">{event.title}</span>
      {(event.id.startsWith('sched-') || event.meetingCode) && <Video className="ml-auto h-2.5 w-2.5 shrink-0" />}
    </button>
  );
}

function MonthView({ date, today, events, isEditable, onCreate, onOpen, onOpenDay, onMove }: {
  date: Date;
  today: string;
  events: CalendarEvent[];
  isEditable: (event: CalendarEvent) => boolean;
  onCreate: (date: string) => void;
  onOpen: (event: CalendarEvent) => void;
  onOpenDay: (date: Date) => void;
  onMove: (eventId: string, date: string) => void;
}) {
  const [dragOver, setDragOver] = useState<string | null>(null);
  const monthStart = new Date(date.getFullYear(), date.getMonth(), 1);
  const gridStart = addDays(monthStart, -monthStart.getDay());
  const cells = Array.from({ length: 42 }, (_, index) => addDays(gridStart, index));

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-[var(--ib-border)] bg-[var(--ib-surface-raised)]">
      <div className="grid shrink-0 grid-cols-7 border-b border-[var(--ib-border)] bg-[var(--ib-gray-50)]">{DAYS.map(day => <div key={day} className="px-1 py-2.5 text-center text-[9px] font-bold uppercase tracking-[.12em] text-[var(--ib-text-muted)] sm:text-[10px]">{day}</div>)}</div>
      <div className="grid min-h-0 flex-1 grid-cols-7 grid-rows-6">
        {cells.map(cell => {
          const dateKey = formatDate(cell);
          const dayEvents = events.filter(event => event.date === dateKey).sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.startTime.localeCompare(b.startTime));
          const currentMonth = cell.getMonth() === date.getMonth();
          const isToday = dateKey === today;
          return (
            <div key={dateKey} onClick={() => onCreate(dateKey)} onDragOver={e => { e.preventDefault(); setDragOver(dateKey); }} onDragLeave={() => setDragOver(value => value === dateKey ? null : value)} onDrop={e => { e.preventDefault(); const id = e.dataTransfer.getData('text/calendar-event'); if (id) onMove(id, dateKey); setDragOver(null); }} className={`group min-h-[72px] overflow-hidden border-b border-r border-[var(--ib-border)] p-1 transition sm:min-h-[104px] sm:p-1.5 cursor-pointer ${currentMonth ? 'bg-[var(--ib-surface-raised)]' : 'bg-[var(--ib-gray-50)]'} ${dragOver === dateKey ? 'bg-[var(--ib-blue-50)] ring-1 ring-inset ring-[var(--ib-blue-500)]/60' : 'hover:bg-[var(--ib-gray-50)]'}`}>
              <div className="mb-1 flex items-center justify-between">
                <button onClick={e => { e.stopPropagation(); onOpenDay(cell); }} className={`grid h-6 w-6 place-items-center rounded-full text-[10px] font-semibold sm:h-7 sm:w-7 sm:text-xs cursor-pointer ${isToday ? 'bg-[var(--ib-blue-500)] text-white shadow-[var(--ib-shadow-sm)]' : currentMonth ? 'text-[var(--ib-text)] hover:bg-[var(--ib-gray-100)]' : 'text-[var(--ib-gray-400)] hover:bg-[var(--ib-gray-100)]'}`}>{cell.getDate()}</button>
                <button onClick={e => { e.stopPropagation(); onCreate(dateKey); }} className="hidden h-6 w-6 place-items-center rounded-lg text-[var(--ib-text-muted)] opacity-0 transition hover:bg-[var(--ib-gray-100)] hover:text-[var(--ib-text)] group-hover:grid group-hover:opacity-100 sm:grid cursor-pointer"><Plus className="h-3 w-3" /></button>
              </div>
              <div className="space-y-0.5">
                {dayEvents.slice(0, 3).map(event => <div key={event.id} draggable={isEditable(event)} onDragStart={e => { e.stopPropagation(); e.dataTransfer.setData('text/calendar-event', event.id); }}><EventChip event={event} compact={false} onOpen={() => onOpen(event)} /></div>)}
                {dayEvents.length > 3 && <button onClick={e => { e.stopPropagation(); onOpenDay(cell); }} className="px-1.5 text-[9px] font-semibold text-[var(--ib-text-muted)] hover:text-[var(--ib-text)] cursor-pointer">+{dayEvents.length - 3} more</button>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TimelineView({ days, today, events, onCreate, onOpen }: {
  days: Date[];
  today: string;
  events: CalendarEvent[];
  onCreate: (date: string, time: string) => void;
  onOpen: (event: CalendarEvent) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const now = new Date();

  useEffect(() => {
    const target = Math.max(0, (now.getHours() - 1) * HOUR_HEIGHT);
    requestAnimationFrame(() => scrollRef.current?.scrollTo({ top: target }));
  }, [days.length]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-[var(--ib-border)] bg-[var(--ib-surface-raised)]">
      <div className="flex shrink-0 border-b border-[var(--ib-border)] bg-[var(--ib-gray-50)]">
        <div className="w-16 shrink-0 border-r border-[var(--ib-border)] px-2 py-3 text-center text-[8px] font-semibold text-[var(--ib-text-muted)]">{timezone.split('/').pop()?.replace('_', ' ')}</div>
        {days.map(day => { const key = formatDate(day); const active = key === today; return <button key={key} onClick={() => onCreate(key, '09:00')} className="min-w-[118px] flex-1 border-r border-[var(--ib-border)] py-2 text-center hover:bg-[var(--ib-gray-100)] cursor-pointer"><span className={`block text-[9px] font-bold uppercase tracking-[.1em] ${active ? 'text-[var(--ib-blue-500)]' : 'text-[var(--ib-text-muted)]'}`}>{day.toLocaleDateString([], { weekday: 'short' })}</span><span className={`mx-auto mt-1 grid h-8 w-8 place-items-center rounded-full text-sm font-semibold ${active ? 'bg-[var(--ib-blue-500)] text-white' : 'text-[var(--ib-text)]'}`}>{day.getDate()}</span></button>; })}
      </div>

      <div className="flex shrink-0 border-b border-[var(--ib-border)] bg-[var(--ib-surface-raised)]">
        <div className="w-16 shrink-0 border-r border-[var(--ib-border)] px-2 py-2 text-right text-[8px] uppercase tracking-wider text-[var(--ib-text-muted)]">All day</div>
        {days.map(day => { const key = formatDate(day); const allDay = events.filter(event => event.date === key && event.allDay); return <div key={key} className="min-h-10 min-w-[118px] flex-1 space-y-1 border-r border-[var(--ib-border)] p-1">{allDay.map(event => <div key={event.id}><EventChip event={event} onOpen={() => onOpen(event)} /></div>)}</div>; })}
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
        <div className="flex" style={{ minWidth: days.length > 1 ? 64 + days.length * 118 : undefined }}>
          <div className="relative w-16 shrink-0 border-r border-[var(--ib-border)]" style={{ height: HOURS.length * HOUR_HEIGHT }}>
            {HOURS.map(hour => <span key={hour} className="absolute right-2 -translate-y-1/2 text-[9px] text-[var(--ib-text-muted)]" style={{ top: hour * HOUR_HEIGHT }}>{hour === 0 ? '' : formatTime(`${String(hour).padStart(2, '0')}:00`)}</span>)}
          </div>
          {days.map(day => {
            const key = formatDate(day);
            const dayEvents = events.filter(event => event.date === key && !event.allDay).sort((a, b) => a.startTime.localeCompare(b.startTime));
            const isToday = key === today;
            const currentMinute = now.getHours() * 60 + now.getMinutes();
            return (
              <div key={key} className="relative min-w-[118px] flex-1 border-r border-[var(--ib-border)]" style={{ height: HOURS.length * HOUR_HEIGHT, backgroundImage: 'repeating-linear-gradient(to bottom, transparent 0, transparent 63px, rgba(18,22,29,.06) 63px, rgba(18,22,29,.06) 64px)' }}>
                {HOURS.map(hour => <button key={hour} onClick={() => onCreate(key, `${String(hour).padStart(2, '0')}:00`)} className="absolute left-0 right-0 z-0 hover:bg-[var(--ib-blue-50)] cursor-pointer" style={{ top: hour * HOUR_HEIGHT, height: HOUR_HEIGHT }} aria-label={`Create event ${key} ${hour}:00`} />)}
                {isToday && <div className="pointer-events-none absolute left-0 right-0 z-20 border-t border-[var(--ib-bad-dot)]" style={{ top: currentMinute / 60 * HOUR_HEIGHT }}><span className="absolute -left-1.5 -top-1.5 h-3 w-3 rounded-full bg-[var(--ib-bad-dot)]" /></div>}
                {dayEvents.map((event, index) => {
                  const start = timeToMinutes(event.startTime);
                  const top = start / 60 * HOUR_HEIGHT;
                  const height = Math.max(28, eventDuration(event) / 60 * HOUR_HEIGHT - 2);
                  const stagger = (index % 3) * 6;
                  return <button key={event.id} onClick={e => { e.stopPropagation(); onOpen(event); }} className="absolute z-10 overflow-hidden rounded-lg border-l-2 px-2 py-1 text-left shadow-[var(--ib-shadow-sm)] transition hover:z-30 hover:brightness-95 cursor-pointer" style={{ top, height, left: 4 + stagger, right: 4, borderColor: event.color, backgroundColor: `${event.color}25`, color: event.color }}><span className="block truncate text-[10px] font-semibold">{event.title}</span>{height > 38 && <span className="block truncate text-[8px] opacity-80">{formatTime(event.startTime)}–{formatTime(event.endTime)}</span>}{event.location && height > 54 && <span className="mt-0.5 block truncate text-[8px] opacity-70">{event.location}</span>}</button>;
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function AgendaView({ events, today, onOpen }: { events: CalendarEvent[]; today: string; onOpen: (event: CalendarEvent) => void }) {
  const upcoming = events.filter(event => event.date >= today).sort((a, b) => a.date.localeCompare(b.date) || Number(b.allDay) - Number(a.allDay) || a.startTime.localeCompare(b.startTime));
  const groups = upcoming.reduce<Record<string, CalendarEvent[]>>((result, event) => { (result[event.date] ??= []).push(event); return result; }, {});
  if (!upcoming.length) return <div className="grid flex-1 place-items-center rounded-2xl border border-dashed border-[var(--ib-border)] bg-[var(--ib-gray-50)] text-center"><div><CalendarDays className="mx-auto h-9 w-9 text-[var(--ib-gray-400)]" /><p className="mt-3 text-sm font-semibold text-[var(--ib-text)]">Your schedule is open</p><p className="mt-1 text-xs text-[var(--ib-text-muted)]">Create an event to start planning your time.</p></div></div>;
  return <div className="min-h-0 flex-1 overflow-y-auto rounded-2xl border border-[var(--ib-border)] bg-[var(--ib-surface-raised)] p-3 sm:p-5"><div className="mx-auto max-w-4xl space-y-6">{Object.entries(groups).map(([date, items]) => { const parsed = parseDate(date); return <section key={date}><header className="mb-2 flex items-baseline gap-3 border-b border-[var(--ib-border)] pb-2"><span className={`grid h-9 w-9 place-items-center rounded-xl text-sm font-bold ${date === today ? 'bg-[var(--ib-blue-500)] text-white' : 'bg-[var(--ib-gray-100)] text-[var(--ib-text)]'}`}>{parsed.getDate()}</span><div><p className="text-xs font-semibold text-[var(--ib-text)]">{parsed.toLocaleDateString([], { weekday: 'long' })}</p><p className="text-[9px] uppercase tracking-[.1em] text-[var(--ib-text-muted)]">{parsed.toLocaleDateString([], { month: 'long', year: 'numeric' })}</p></div></header><div className="space-y-2">{items.map(event => <button key={event.id} onClick={() => onOpen(event)} className="flex w-full items-center gap-3 rounded-xl border border-[var(--ib-border)] bg-[var(--ib-gray-50)] p-3 text-left transition hover:border-[var(--ib-blue-500)]/30 hover:bg-[var(--ib-blue-50)] cursor-pointer"><span className="h-10 w-1 rounded-full" style={{ backgroundColor: event.color }} /><div className="w-24 shrink-0 text-[10px] font-medium text-[var(--ib-text-muted)]">{event.allDay ? 'All day' : <>{formatTime(event.startTime)}<br /><span className="text-[var(--ib-text-muted)]">{formatTime(event.endTime)}</span></>}</div><div className="min-w-0 flex-1"><p className="truncate text-xs font-semibold text-[var(--ib-text)]">{event.title}</p>{event.location && <p className="mt-0.5 flex items-center gap-1 truncate text-[9px] text-[var(--ib-text-muted)]"><MapPin className="h-2.5 w-2.5" />{event.location}</p>}</div>{(event.id.startsWith('sched-') || event.meetingCode) && <Video className="h-4 w-4 text-[var(--ib-blue-500)]" />}</button>)}</div></section>; })}</div></div>;
}

function CalendarSettingsModal({ calendars, users, onClose, onChanged }: {
  calendars: ApiCalendar[];
  users: { id: string; displayName: string; email: string }[];
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [name, setName] = useState('');
  const [color, setColor] = useState('#70e1a1');
  const [calendarId, setCalendarId] = useState(calendars.find(calendar => calendar.role === 'owner')?.id ?? '');
  const [memberId, setMemberId] = useState(users[0]?.id ?? '');
  const [memberRole, setMemberRole] = useState<'viewer' | 'editor' | 'remove'>('viewer');
  const [hours, setHours] = useState<ApiWorkingHours>({ timeZone: timezone, days: [1, 2, 3, 4, 5], startTime: '09:00', endTime: '18:00' });
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { api.getWorkingHours().then(setHours).catch(() => {}); }, []);
  const run = async (action: () => Promise<unknown>, message: string) => {
    setBusy(true); setStatus('');
    try { await action(); await onChanged(); setStatus(message); } catch (error) { setStatus(error instanceof Error ? error.message : 'Could not save changes.'); }
    finally { setBusy(false); }
  };

  return <div className="fixed inset-0 z-[95] flex items-end justify-center bg-[var(--ib-gray-900)]/40 backdrop-blur-sm sm:items-center sm:p-4" onMouseDown={event => event.target === event.currentTarget && onClose()}><section className="max-h-[90vh] w-full overflow-y-auto rounded-t-[28px] border border-[var(--ib-border)] bg-[var(--ib-surface-raised)] p-5 shadow-[var(--ib-shadow-lg)] sm:max-w-xl sm:rounded-[28px]">
    <header className="mb-5 flex items-center justify-between"><div><p className="text-[9px] font-bold uppercase tracking-[.16em] text-[var(--ib-text-muted)]">Calendar settings</p><h2 className="mt-1 text-lg font-semibold text-[var(--ib-text)]">Calendars and availability</h2></div><button onClick={onClose} aria-label="Close" className="grid h-11 w-11 place-items-center rounded-xl text-[var(--ib-text-muted)] hover:bg-[var(--ib-gray-100)] hover:text-[var(--ib-text)] cursor-pointer"><X className="h-4 w-4" /></button></header>

    <div className="space-y-5">
      <section className="rounded-2xl border border-[var(--ib-border)] bg-[var(--ib-gray-50)] p-4"><h3 className="text-xs font-semibold text-[var(--ib-text)]">Create a team calendar</h3><div className="mt-3 flex gap-2"><input value={name} onChange={e => setName(e.target.value)} placeholder="Calendar name" className="min-w-0 flex-1 h-11 rounded-xl border border-[var(--ib-border)] bg-[var(--ib-surface-raised)] px-3 text-xs text-[var(--ib-text)] outline-none focus:border-[var(--ib-blue-500)] touch-manipulation" /><input type="color" value={color} onChange={e => setColor(e.target.value)} className="h-11 w-12 rounded-xl border border-[var(--ib-border)] bg-transparent p-1 cursor-pointer" /><button disabled={!name.trim() || busy} onClick={() => run(() => api.createCalendar({ name: name.trim(), color, timeZone: timezone }), 'Calendar created.').then(() => setName(''))} className="h-11 rounded-xl bg-[var(--ib-blue-500)] px-3 text-[10px] font-semibold text-white disabled:opacity-40 cursor-pointer">Create</button></div></section>

      <section className="rounded-2xl border border-[var(--ib-border)] bg-[var(--ib-gray-50)] p-4"><h3 className="text-xs font-semibold text-[var(--ib-text)]">Share a calendar</h3><p className="mt-1 text-[10px] text-[var(--ib-text-muted)]">Editors can create and change events. Viewers only see the schedule.</p><div className="mt-3 grid gap-2 sm:grid-cols-3"><select value={calendarId} onChange={e => setCalendarId(e.target.value)} className="h-11 rounded-xl border border-[var(--ib-border)] bg-[var(--ib-surface-raised)] px-3 text-xs text-[var(--ib-text)] cursor-pointer">{calendars.filter(calendar => calendar.role === 'owner').map(calendar => <option key={calendar.id} value={calendar.id}>{calendar.name}</option>)}</select><select value={memberId} onChange={e => setMemberId(e.target.value)} className="h-11 rounded-xl border border-[var(--ib-border)] bg-[var(--ib-surface-raised)] px-3 text-xs text-[var(--ib-text)] cursor-pointer">{users.map(user => <option key={user.id} value={user.id}>{user.displayName}</option>)}</select><select value={memberRole} onChange={e => setMemberRole(e.target.value as 'viewer' | 'editor' | 'remove')} className="h-11 rounded-xl border border-[var(--ib-border)] bg-[var(--ib-surface-raised)] px-3 text-xs text-[var(--ib-text)] cursor-pointer"><option value="viewer">Viewer</option><option value="editor">Editor</option><option value="remove">Remove access</option></select></div><button disabled={!calendarId || !memberId || busy} onClick={() => run(() => api.shareCalendar(calendarId, memberId, memberRole), memberRole === 'remove' ? 'Calendar access removed.' : 'Calendar shared.')} className="mt-3 h-11 rounded-xl border border-[var(--ib-blue-500)]/30 bg-[var(--ib-blue-50)] px-4 text-[10px] font-semibold text-[var(--ib-blue-800)] disabled:opacity-40 cursor-pointer"><Users className="mr-1.5 inline h-3.5 w-3.5" />Update access</button></section>

      <section className="rounded-2xl border border-[var(--ib-border)] bg-[var(--ib-gray-50)] p-4"><h3 className="text-xs font-semibold text-[var(--ib-text)]">Working hours</h3><p className="mt-1 text-[10px] text-[var(--ib-text-muted)]">Availability suggestions respect these hours in {hours.timeZone}.</p><div className="mt-3 flex flex-wrap gap-1.5">{['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map((day, index) => { const active = hours.days.includes(index); return <button key={day} onClick={() => setHours(current => ({ ...current, days: active ? current.days.filter(value => value !== index) : [...current.days, index].sort() }))} className={`rounded-lg border px-2 py-1.5 text-[9px] cursor-pointer ${active ? 'border-[var(--ib-blue-500)]/40 bg-[var(--ib-blue-50)] text-[var(--ib-text)]' : 'border-[var(--ib-border)] text-[var(--ib-text-muted)]'}`}>{day}</button>; })}</div><div className="mt-3 grid grid-cols-2 gap-2"><input type="time" value={hours.startTime} onChange={e => setHours(current => ({ ...current, startTime: e.target.value }))} className="h-11 rounded-xl border border-[var(--ib-border)] bg-[var(--ib-surface-raised)] px-3 text-xs text-[var(--ib-text)]" /><input type="time" value={hours.endTime} onChange={e => setHours(current => ({ ...current, endTime: e.target.value }))} className="h-11 rounded-xl border border-[var(--ib-border)] bg-[var(--ib-surface-raised)] px-3 text-xs text-[var(--ib-text)]" /></div><button disabled={busy || !hours.days.length} onClick={() => run(() => api.updateWorkingHours(hours), 'Working hours saved.')} className="mt-3 h-11 rounded-xl bg-[var(--ib-blue-500)] px-4 text-[10px] font-semibold text-white disabled:opacity-40 cursor-pointer">Save working hours</button></section>
      {status && <p className="rounded-xl border border-[var(--ib-border)] bg-[var(--ib-gray-50)] px-3 py-2 text-[10px] text-[var(--ib-text)]">{status}</p>}
    </div>
  </section></div>;
}

export default function CalendarView() {
  const { currentUser, allUsers } = useAuth();
  const { scheduledMeetings } = useMeeting();
  const now = new Date();
  const today = formatDate(now);
  const [viewDate, setViewDate] = useState(new Date(now.getFullYear(), now.getMonth(), now.getDate()));
  // Sub-unit 5: <md defaults to agenda instead of month -- a 7-column month
  // grid has no useful cell width on a phone (confirmed by looking at
  // MonthView's own min-h-[72px] cells, sized for a mouse-driven desktop
  // layout, not a thumb). Read once at mount, not tracked live -- a mid-
  // session resize while the calendar is already open shouldn't yank the
  // user out of whatever view they picked.
  const [viewMode, setViewMode] = useState<ViewMode>(() => (typeof window !== 'undefined' && window.innerWidth < 768 ? 'agenda' : 'month'));
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [calendars, setCalendars] = useState<ApiCalendar[]>([]);
  const [modal, setModal] = useState<ModalState | null>(null);
  const [selectedDate, setSelectedDate] = useState(today);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const deferredSearch = React.useDeferredValue(searchQuery);
  const [selectedCalendars, setSelectedCalendars] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const loadCalendars = async () => {
    const next = await api.getCalendars();
    setCalendars(next);
    setSelectedCalendars(current => current.size ? current : new Set(next.map(calendar => calendar.id)));
  };
  const loadEvents = async () => {
    const from = formatDate(new Date(viewDate.getFullYear(), viewDate.getMonth() - 2, 1));
    const to = formatDate(new Date(viewDate.getFullYear(), viewDate.getMonth() + 10, 0));
    const next = await api.getCalendarEvents(from, to, deferredSearch.trim());
    setEvents(next);
  };
  const refresh = async () => {
    if (!currentUser) return;
    setLoading(true); setError('');
    try { await Promise.all([loadCalendars(), loadEvents()]); }
    catch (loadError) { setError(loadError instanceof Error ? loadError.message : 'Could not load the calendar.'); }
    finally { setLoading(false); }
  };

  useEffect(() => { refresh(); }, [currentUser?.id, viewDate.getFullYear(), viewDate.getMonth(), deferredSearch]);
  useEffect(() => {
    const listener = () => refresh();
    window.addEventListener('ibconnect_calendar_changed', listener);
    return () => window.removeEventListener('ibconnect_calendar_changed', listener);
  }, [currentUser?.id, viewDate, deferredSearch]);
  useEffect(() => {
    const listener = () => createEvent(formatDate(viewDate));
    window.addEventListener('ibconnect_calendar_create', listener);
    return () => window.removeEventListener('ibconnect_calendar_create', listener);
  }, [viewDate]);

  // One-time migration of the old browser-only events into the default server
  // calendar. Keeping this here avoids losing calendars created before sync.
  useEffect(() => {
    if (!currentUser || !calendars.length) return;
    const migrationKey = `ibconnect_calendar_server_migrated_${currentUser.id}`;
    if (localStorage.getItem(migrationKey)) return;
    const local = loadCalendarEvents(currentUser.id);
    const target = calendars.find(calendar => calendar.isDefault && calendar.role !== 'viewer') ?? calendars.find(calendar => calendar.role !== 'viewer');
    if (!target || !local.length) { localStorage.setItem(migrationKey, '1'); return; }
    const existing = new Set(events.map(event => `${event.title}|${event.date}|${event.startTime}`));
    const pending = local.filter(event => !existing.has(`${event.title}|${event.date}|${event.startTime}`));
    if (!pending.length) { localStorage.setItem(migrationKey, '1'); return; }
    Promise.allSettled(pending.map(event => api.createCalendarEvent({
      calendarId: target.id, title: event.title, description: event.description ?? '', location: event.location ?? '',
      date: event.date, startTime: event.startTime, endTime: event.endTime ?? addMinutes(event.startTime, 60),
      allDay: !!event.allDay, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, recurrence: '', attendeeIds: [], reminderMinutes: 10,
      meetingCode: getMeetingCode(event) ?? undefined,
    }))).then(results => { if (results.every(result => result.status === 'fulfilled')) localStorage.setItem(migrationKey, '1'); loadEvents().catch(() => {}); });
  }, [currentUser?.id, calendars.length, events.length]);

  const meetingEvents = useMemo<CalendarEvent[]>(() => scheduledMeetings.filter(meeting => !events.some(event => event.meetingCode === meeting.code) && (!searchQuery.trim() || meeting.title.toLowerCase().includes(searchQuery.trim().toLowerCase()))).map(meeting => ({
    id: `sched-${meeting.code}-${meeting.id}`,
    creatorId: meeting.creatorId,
    title: meeting.title || 'IB Connect meeting',
    date: meeting.date,
    startTime: meeting.time,
    endTime: addMinutes(meeting.time, 60),
    description: `Meeting code: ${meeting.code}`,
    location: 'IB Connect',
    color: '#7dd3fc',
  })), [scheduledMeetings, events, searchQuery]);
  const visibleEvents = useMemo(() => events.filter(event => !event.calendarId || selectedCalendars.has(event.calendarId)), [events, selectedCalendars]);
  const allEvents = useMemo(() => [...visibleEvents, ...meetingEvents], [visibleEvents, meetingEvents]);
  const isEditable = (event: CalendarEvent) => events.some(item => item.id === event.id) && !!event.canEdit;

  const saveEvent = async (event: CalendarEvent) => {
    if (!currentUser) return;
    const payload: ApiCalendarEventInput = {
      calendarId: event.calendarId ?? calendars.find(calendar => calendar.role !== 'viewer')?.id ?? '',
      title: event.title, description: event.description ?? '', location: event.location ?? '', date: event.date,
      startTime: event.startTime, endTime: event.endTime ?? addMinutes(event.startTime, 60), allDay: !!event.allDay,
      timeZone: event.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      recurrence: event.recurrence ?? '', attendeeIds: event.attendeeIds ?? [], reminderMinutes: event.reminderMinutes ?? 10,
      meetingCode: event.meetingCode,
    };
    if (events.some(item => item.id === event.id)) await api.updateCalendarEvent(event.seriesId ?? event.id, payload);
    else await api.createCalendarEvent(payload);
    await loadEvents();
    setSelectedDate(event.date);
    setModal(null);
  };
  const removeEvent = async (id: string) => { await api.deleteCalendarEvent(events.find(item => item.id === id)?.seriesId ?? id); await loadEvents(); setModal(null); };
  const moveEvent = async (id: string, date: string) => { const event = events.find(item => item.id === id); if (!event?.canEdit) return; await saveEvent({ ...event, date, attendeeIds: event.attendees?.map(attendee => attendee.userId) ?? [] }); };
  const respondEvent = async (response: CalendarResponse) => { if (!modal?.event) return; await api.respondCalendarEvent(modal.event.seriesId ?? modal.event.id, response); await loadEvents(); setModal(null); };
  const openEvent = (event: CalendarEvent) => { setSelectedDate(event.date); setModal({ date: event.date, event }); };
  const createEvent = (date: string, startTime?: string) => { setSelectedDate(date); setModal({ date, event: null, startTime }); };

  const weekDays = useMemo(() => Array.from({ length: 7 }, (_, index) => addDays(startOfWeek(viewDate), index)), [viewDate]);
  const dayEvents = allEvents.filter(event => event.date === selectedDate).sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.startTime.localeCompare(b.startTime));
  const upcoming = allEvents.filter(event => event.date >= today).sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime));

  const periodLabel = viewMode === 'month'
    ? viewDate.toLocaleDateString([], { month: 'long', year: 'numeric' })
    : viewMode === 'week'
      ? `${weekDays[0].toLocaleDateString([], { month: 'short', day: 'numeric' })} – ${weekDays[6].toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}`
      : viewMode === 'day' ? formatLongDate(viewDate) : 'Upcoming schedule';

  const navigate = (direction: -1 | 1) => {
    if (viewMode === 'month' || viewMode === 'agenda') setViewDate(new Date(viewDate.getFullYear(), viewDate.getMonth() + direction, 1));
    else setViewDate(addDays(viewDate, direction * (viewMode === 'week' ? 7 : 1)));
  };
  const goToday = () => { const current = new Date(); setViewDate(current); setSelectedDate(formatDate(current)); };
  const openDay = (date: Date) => { setViewDate(date); setSelectedDate(formatDate(date)); setViewMode('day'); };

  const viewOptions: { id: ViewMode; label: string; icon: React.ElementType }[] = [
    { id: 'month', label: 'Month', icon: Grid3x3 },
    { id: 'week', label: 'Week', icon: Columns3 },
    { id: 'day', label: 'Day', icon: CalendarRange },
    { id: 'agenda', label: 'Schedule', icon: List },
  ];

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-[var(--ib-surface)]">
      {modal && <EventModal initialDate={modal.date} initialTime={modal.startTime} event={modal.event} readOnly={!!modal.event && !isEditable(modal.event)} calendars={calendars} users={allUsers.filter(user => user.id !== currentUser?.id)} onClose={() => setModal(null)} onSave={saveEvent} onDelete={modal.event && isEditable(modal.event) ? removeEvent : undefined} onRespond={modal.event?.responseStatus === 'needs_action' ? respondEvent : undefined} />}
      {settingsOpen && <CalendarSettingsModal calendars={calendars} users={allUsers.filter(user => user.id !== currentUser?.id)} onClose={() => setSettingsOpen(false)} onChanged={async () => { await loadCalendars(); await loadEvents(); }} />}

      <header className="shrink-0 border-b border-[var(--ib-border)] bg-[var(--ib-surface-raised)]/95 px-3 py-3 backdrop-blur-xl sm:px-5">
        <div className="flex flex-wrap items-center gap-2 sm:gap-3">
          <div className="mr-1 flex items-center gap-2.5">
            <span className="grid h-9 w-9 place-items-center rounded-xl bg-[var(--ib-blue-500)] text-white shadow-[var(--ib-shadow-sm)]"><CalendarDays className="h-4.5 w-4.5" /></span>
            <div className="hidden sm:block"><h1 className="text-sm font-semibold text-[var(--ib-text)]">Calendar</h1><p className="text-[9px] text-[var(--ib-text-muted)]">Plan your time with AIPA</p></div>
          </div>
          <button onClick={goToday} className="h-11 sm:h-auto rounded-xl border border-[var(--ib-border)] px-3 sm:py-2 text-[10px] font-semibold text-[var(--ib-text)] hover:bg-[var(--ib-gray-50)] cursor-pointer">Today</button>
          <div className="flex items-center"><button onClick={() => navigate(-1)} className="grid h-11 w-11 sm:h-9 sm:w-9 place-items-center rounded-xl text-[var(--ib-text-muted)] hover:bg-[var(--ib-gray-50)] hover:text-[var(--ib-text)] cursor-pointer" aria-label="Previous period"><ChevronLeft className="h-4 w-4" /></button><button onClick={() => navigate(1)} className="grid h-11 w-11 sm:h-9 sm:w-9 place-items-center rounded-xl text-[var(--ib-text-muted)] hover:bg-[var(--ib-gray-50)] hover:text-[var(--ib-text)] cursor-pointer" aria-label="Next period"><ChevronRight className="h-4 w-4" /></button></div>
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-[var(--ib-text)] sm:text-base">{periodLabel}</h2>
          <label className="hidden items-center gap-2 rounded-xl border border-[var(--ib-border)] bg-[var(--ib-gray-50)] px-3 py-2 lg:flex"><Search className="h-3.5 w-3.5 text-[var(--ib-text-muted)]" /><input value={searchQuery} onChange={event => setSearchQuery(event.target.value)} placeholder="Search calendar" className="w-28 bg-transparent text-[10px] text-[var(--ib-text)] outline-none placeholder:text-[var(--ib-text-muted)]" /></label>
          <div className="order-last flex w-full items-center gap-1 overflow-x-auto rounded-xl border border-[var(--ib-border)] bg-[var(--ib-gray-50)] p-1 sm:order-none sm:w-auto">{viewOptions.map(option => { const Icon = option.icon; return <button key={option.id} onClick={() => setViewMode(option.id)} className={`flex min-w-fit items-center gap-1.5 rounded-lg px-2.5 h-11 sm:h-9 text-[9px] font-semibold transition sm:text-[10px] cursor-pointer ${viewMode === option.id ? 'bg-[var(--ib-surface-raised)] text-[var(--ib-text)] shadow-[var(--ib-shadow-sm)]' : 'text-[var(--ib-text-muted)] hover:text-[var(--ib-text)]'}`}><Icon className="h-3.5 w-3.5" />{option.label}</button>; })}</div>
          <button onClick={() => setSettingsOpen(true)} className="grid h-11 w-11 sm:h-9 sm:w-9 place-items-center rounded-xl border border-[var(--ib-border)] text-[var(--ib-text-muted)] hover:bg-[var(--ib-gray-50)] hover:text-[var(--ib-text)] cursor-pointer" title="Calendars and working hours"><Settings2 className="h-4 w-4" /></button>
          <button onClick={() => createEvent(formatDate(viewDate))} className="flex items-center gap-1.5 rounded-xl bg-[var(--ib-blue-500)] px-3.5 h-11 sm:h-10 text-[10px] font-semibold text-white shadow-[var(--ib-shadow-sm)] hover:bg-[var(--ib-blue-600)] cursor-pointer"><Plus className="h-3.5 w-3.5" />Create</button>
        </div>
        <div className="mt-2 flex items-center gap-2 overflow-x-auto">
          <label className="flex shrink-0 items-center gap-2 rounded-lg border border-[var(--ib-border)] bg-[var(--ib-gray-50)] h-11 sm:h-auto px-2.5 sm:py-1.5 lg:hidden"><Search className="h-3 w-3 text-[var(--ib-text-muted)]" /><input value={searchQuery} onChange={event => setSearchQuery(event.target.value)} placeholder="Search" className="w-20 bg-transparent text-[9px] text-[var(--ib-text)] outline-none placeholder:text-[var(--ib-text-muted)]" /></label>
          {calendars.map(calendar => { const active = selectedCalendars.has(calendar.id); return <button key={calendar.id} onClick={() => setSelectedCalendars(current => { const next = new Set(current); if (active) next.delete(calendar.id); else next.add(calendar.id); return next; })} className={`flex shrink-0 items-center gap-1.5 rounded-lg border h-11 sm:h-auto px-2.5 sm:py-1.5 text-[9px] font-medium cursor-pointer ${active ? 'border-[var(--ib-border)] bg-[var(--ib-gray-100)] text-[var(--ib-text)]' : 'border-[var(--ib-gray-100)] text-[var(--ib-text-muted)]'}`}><span className="h-2 w-2 rounded-full" style={{ backgroundColor: calendar.color }} />{calendar.name}{calendar.memberCount > 1 && <Users className="h-3 w-3 opacity-60" />}</button>; })}
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <main className="flex min-h-0 min-w-0 flex-1 flex-col p-2 sm:p-4">
          {error && <div className="mb-3 flex items-center justify-between rounded-xl border border-[var(--ib-bad-dot)]/25 bg-[var(--ib-bad-fill)] px-3 py-2 text-[10px] text-[var(--ib-bad-text)]"><span>{error}</span><button onClick={refresh} className="font-semibold cursor-pointer">Retry</button></div>}
          {loading && !allEvents.length && <div className="grid flex-1 place-items-center text-xs text-[var(--ib-text-muted)]">Loading your calendars…</div>}
          {!loading && viewMode === 'month' && <MonthView date={viewDate} today={today} events={allEvents} isEditable={isEditable} onCreate={createEvent} onOpen={openEvent} onOpenDay={openDay} onMove={moveEvent} />}
          {!loading && viewMode === 'week' && <TimelineView days={weekDays} today={today} events={allEvents} onCreate={createEvent} onOpen={openEvent} />}
          {!loading && viewMode === 'day' && <TimelineView days={[viewDate]} today={today} events={allEvents} onCreate={createEvent} onOpen={openEvent} />}
          {!loading && viewMode === 'agenda' && <AgendaView events={allEvents} today={today} onOpen={openEvent} />}
        </main>

        <aside className="hidden w-72 shrink-0 flex-col border-l border-[var(--ib-border)] bg-[var(--ib-surface-raised)] xl:flex">
          <div className="border-b border-[var(--ib-border)] p-4">
            <input type="date" value={selectedDate} onChange={event => { setSelectedDate(event.target.value); setViewDate(parseDate(event.target.value)); }} className="w-full h-11 rounded-xl border border-[var(--ib-border)] bg-[var(--ib-gray-50)] px-3 text-xs font-medium text-[var(--ib-text)] outline-none focus:border-[var(--ib-blue-500)]" />
            <div className="mt-3 flex items-center justify-between"><div><p className="text-sm font-semibold text-[var(--ib-text)]">{formatLongDate(parseDate(selectedDate))}</p><p className="mt-0.5 text-[9px] uppercase tracking-[.12em] text-[var(--ib-text-muted)]">{dayEvents.length} {dayEvents.length === 1 ? 'event' : 'events'}</p></div><button onClick={() => createEvent(selectedDate)} className="grid h-9 w-9 place-items-center rounded-xl bg-[var(--ib-blue-50)] text-[var(--ib-blue-500)] hover:bg-[var(--ib-blue-500)]/20 cursor-pointer"><Plus className="h-4 w-4" /></button></div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {dayEvents.length ? <div className="space-y-2">{dayEvents.map(event => <button key={event.id} onClick={() => openEvent(event)} className="w-full rounded-xl border border-[var(--ib-border)] bg-[var(--ib-gray-50)] p-3 text-left hover:bg-[var(--ib-gray-100)] cursor-pointer" style={{ borderLeft: `3px solid ${event.color}` }}><p className="truncate text-xs font-semibold text-[var(--ib-text)]">{event.title}</p><p className="mt-1 flex items-center gap-1 text-[9px] text-[var(--ib-text-muted)]"><Clock className="h-3 w-3" />{event.allDay ? 'All day' : `${formatTime(event.startTime)} – ${formatTime(event.endTime)}`}</p>{event.location && <p className="mt-1 flex items-center gap-1 truncate text-[9px] text-[var(--ib-text-muted)]"><MapPin className="h-3 w-3" />{event.location}</p>}</button>)}</div> : <button onClick={() => createEvent(selectedDate)} className="w-full rounded-xl border border-dashed border-[var(--ib-border)] px-3 py-6 text-center text-[10px] text-[var(--ib-text-muted)] hover:border-[var(--ib-blue-500)]/30 hover:text-[var(--ib-blue-500)] cursor-pointer"><Plus className="mx-auto mb-2 h-4 w-4" />No events. Add one</button>}
            <div className="my-4 border-t border-[var(--ib-border)]" />
            <p className="mb-2 px-1 text-[9px] font-bold uppercase tracking-[.14em] text-[var(--ib-text-muted)]">Coming up</p>
            <div className="space-y-1.5">{upcoming.slice(0, 8).map(event => <button key={`upcoming-${event.id}`} onClick={() => { setSelectedDate(event.date); setViewDate(parseDate(event.date)); openEvent(event); }} className="flex w-full items-center gap-2.5 rounded-xl px-2 py-2 text-left hover:bg-[var(--ib-gray-50)] cursor-pointer"><span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: event.color }} /><div className="min-w-0 flex-1"><p className="truncate text-[10px] font-medium text-[var(--ib-text)]">{event.title}</p><p className="text-[8px] text-[var(--ib-text-muted)]">{parseDate(event.date).toLocaleDateString([], { month: 'short', day: 'numeric' })} · {event.allDay ? 'All day' : formatTime(event.startTime)}</p></div></button>)}</div>
          </div>
        </aside>
      </div>
    </div>
  );
}
