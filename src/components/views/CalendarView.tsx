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
    <div className="fixed inset-0 z-[90] flex items-end justify-center bg-black/70 p-0 backdrop-blur-md sm:items-center sm:p-4" onMouseDown={event => event.target === event.currentTarget && onClose()}>
      <section className="w-full overflow-hidden rounded-t-[28px] border border-white/10 bg-[#11141b] shadow-[0_30px_100px_rgba(0,0,0,.65)] sm:max-w-lg sm:rounded-[28px]">
        <header className="flex items-center justify-between border-b border-white/[0.07] px-5 py-4">
          <div>
            <p className="text-[9px] font-bold uppercase tracking-[.16em] text-[#77839a]">{readOnly ? 'IB Connect meeting' : event ? 'Edit calendar event' : 'Create calendar event'}</p>
            <h2 className="mt-1 text-base font-semibold text-white">{readOnly ? event?.title : event ? 'Update event' : 'Add to your calendar'}</h2>
          </div>
          <button onClick={onClose} className="grid h-9 w-9 place-items-center rounded-xl text-[#8c96aa] hover:bg-white/[0.06] hover:text-white" aria-label="Close"><X className="h-4 w-4" /></button>
        </header>

        {readOnly ? (
          <div className="space-y-4 p-5">
            <div className="rounded-2xl border border-white/[0.07] bg-white/[0.03] p-4">
              <div className="flex items-center gap-3 text-sm text-white"><CalendarDays className="h-4 w-4 text-[#8ab4ff]" />{formatLongDate(parseDate(event!.date))}</div>
              <div className="mt-3 flex items-center gap-3 text-sm text-[#c5ccda]"><Clock className="h-4 w-4 text-[#8ab4ff]" />{formatTime(event!.startTime)}</div>
              {event?.location && <div className="mt-3 flex items-center gap-3 text-sm text-[#c5ccda]"><MapPin className="h-4 w-4 text-[#8ab4ff]" />{event.location}</div>}
              {event?.description && <p className="mt-4 border-t border-white/[0.06] pt-4 text-xs leading-5 text-[#8f99aa]">{event.description}</p>}
              {!!event?.attendees?.length && <div className="mt-4 border-t border-white/[0.06] pt-4"><p className="mb-2 text-[9px] font-bold uppercase tracking-[.12em] text-[#707b90]">Attendees</p><div className="space-y-1.5">{event.attendees.map(attendee => <div key={attendee.userId} className="flex items-center justify-between text-xs"><span className="text-[#c8cfda]">{attendee.displayName}</span><span className="capitalize text-[#7f8a9d]">{attendee.response.replace('_', ' ')}</span></div>)}</div></div>}
            </div>
            {event?.responseStatus === 'needs_action' && onRespond && <div><p className="mb-2 text-[10px] font-semibold text-[#aab3c3]">Your response</p><div className="grid grid-cols-3 gap-2">{(['accepted', 'tentative', 'declined'] as CalendarResponse[]).map(response => <button key={response} onClick={() => onRespond(response)} className="rounded-xl border border-white/[0.08] px-2 py-2 text-[10px] font-semibold capitalize text-[#cbd2df] hover:border-[#718cff]/50 hover:bg-[#718cff]/10">{response}</button>)}</div></div>}
            {meetingCode && <a href={`/${meetingCode}`} className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#3978ff] px-4 py-3 text-sm font-semibold text-white hover:bg-[#4b85ff]"><Video className="h-4 w-4" />Join meeting<ExternalLink className="h-3.5 w-3.5" /></a>}
          </div>
        ) : (
          <div className="max-h-[78vh] space-y-4 overflow-y-auto p-5">
            <input autoFocus value={title} onChange={e => setTitle(e.target.value)} placeholder="Add title" className="w-full border-0 border-b border-white/10 bg-transparent px-1 pb-3 text-xl font-medium text-white outline-none placeholder:text-[#596174] focus:border-[#6f8cff]" />

            <div className="flex items-center justify-between rounded-xl border border-white/[0.07] bg-white/[0.025] px-3 py-2.5">
              <div className="flex items-center gap-2 text-xs text-[#c4cad6]"><CalendarRange className="h-4 w-4 text-[#8da1ff]" />All-day event</div>
              <button type="button" onClick={() => setAllDay(value => !value)} className={`relative h-6 w-11 rounded-full transition ${allDay ? 'bg-[#5877ff]' : 'bg-white/10'}`} aria-pressed={allDay}><span className={`absolute top-1 h-4 w-4 rounded-full bg-white transition ${allDay ? 'left-6' : 'left-1'}`} /></button>
            </div>

            <div className={`grid gap-3 ${allDay ? 'grid-cols-1' : 'grid-cols-3'}`}>
              <label className="space-y-1.5">
                <span className="text-[9px] font-bold uppercase tracking-[.12em] text-[#707b90]">Date</span>
                <input type="date" value={date} onChange={e => setDate(e.target.value)} className="w-full rounded-xl border border-white/[0.08] bg-black/20 px-3 py-2.5 text-xs text-white outline-none focus:border-[#718cff]/60" />
              </label>
              {!allDay && <label className="space-y-1.5"><span className="text-[9px] font-bold uppercase tracking-[.12em] text-[#707b90]">Starts</span><input type="time" value={startTime} onChange={e => { setStartTime(e.target.value); if (endTime <= e.target.value) setEndTime(addMinutes(e.target.value, 60)); }} className="w-full rounded-xl border border-white/[0.08] bg-black/20 px-3 py-2.5 text-xs text-white outline-none focus:border-[#718cff]/60" /></label>}
              {!allDay && <label className="space-y-1.5"><span className="text-[9px] font-bold uppercase tracking-[.12em] text-[#707b90]">Ends</span><input type="time" value={endTime} min={startTime} onChange={e => setEndTime(e.target.value)} className="w-full rounded-xl border border-white/[0.08] bg-black/20 px-3 py-2.5 text-xs text-white outline-none focus:border-[#718cff]/60" /></label>}
            </div>
            {!allDay && endTime <= startTime && <p className="text-[10px] text-amber-200">End time must be after the start time.</p>}

            <label className="flex items-center gap-3 rounded-xl border border-white/[0.07] bg-white/[0.025] px-3 py-2.5 focus-within:border-[#718cff]/50"><MapPin className="h-4 w-4 shrink-0 text-[#78849a]" /><input value={location} onChange={e => setLocation(e.target.value)} placeholder="Add location or meeting link" className="min-w-0 flex-1 bg-transparent text-xs text-white outline-none placeholder:text-[#606a7d]" /></label>
            <label className="flex items-start gap-3 rounded-xl border border-white/[0.07] bg-white/[0.025] px-3 py-2.5 focus-within:border-[#718cff]/50"><AlignLeft className="mt-0.5 h-4 w-4 shrink-0 text-[#78849a]" /><textarea value={description} onChange={e => setDescription(e.target.value)} rows={3} placeholder="Add notes, agenda, or preparation details" className="min-w-0 flex-1 resize-none bg-transparent text-xs leading-5 text-white outline-none placeholder:text-[#606a7d]" /></label>

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="space-y-1.5"><span className="text-[9px] font-bold uppercase tracking-[.12em] text-[#707b90]">Repeats</span><select value={recurrence} onChange={e => setRecurrence(e.target.value as NonNullable<CalendarEvent['recurrence']>)} className="w-full rounded-xl border border-white/[0.08] bg-[#11141b] px-3 py-2.5 text-xs text-white outline-none"><option value="">Does not repeat</option><option value="DAILY">Daily</option><option value="WEEKDAYS">Every weekday</option><option value="WEEKLY">Weekly</option><option value="MONTHLY">Monthly</option></select></label>
              <label className="space-y-1.5"><span className="text-[9px] font-bold uppercase tracking-[.12em] text-[#707b90]">Reminder</span><select value={reminderMinutes} onChange={e => setReminderMinutes(Number(e.target.value))} className="w-full rounded-xl border border-white/[0.08] bg-[#11141b] px-3 py-2.5 text-xs text-white outline-none"><option value={0}>At event time</option><option value={5}>5 minutes before</option><option value={10}>10 minutes before</option><option value={30}>30 minutes before</option><option value={60}>1 hour before</option><option value={1440}>1 day before</option></select></label>
            </div>

            <div>
              <p className="mb-2 flex items-center gap-2 text-[9px] font-bold uppercase tracking-[.12em] text-[#707b90]"><Users className="h-3.5 w-3.5" />Attendees and invitations</p>
              <div className="max-h-32 space-y-1 overflow-y-auto rounded-xl border border-white/[0.07] bg-white/[0.02] p-2">{users.length ? users.map(user => { const selected = attendeeIds.includes(user.id); return <button type="button" key={user.id} onClick={() => setAttendeeIds(current => selected ? current.filter(id => id !== user.id) : [...current, user.id])} className={`flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-[10px] ${selected ? 'bg-[#718cff]/12 text-white' : 'text-[#929cad] hover:bg-white/[0.04]'}`}><span className={`grid h-4 w-4 place-items-center rounded border ${selected ? 'border-[#718cff] bg-[#718cff]' : 'border-white/15'}`}>{selected && <Check className="h-3 w-3" />}</span><span className="min-w-0 flex-1 truncate">{user.displayName}</span><span className="hidden truncate text-[8px] text-[#626d80] sm:block">{user.email}</span></button>; }) : <p className="p-2 text-[10px] text-[#697487]">Start conversations with teammates to invite them.</p>}</div>
            </div>

            {conflicts > 0 && <div className="rounded-xl border border-amber-300/20 bg-amber-300/[0.06] p-3"><p className="text-[10px] font-semibold text-amber-100">{conflicts} availability conflict{conflicts === 1 ? '' : 's'} detected</p>{suggestions.length > 0 && <div className="mt-2 flex flex-wrap gap-1.5">{suggestions.slice(0, 3).map(suggestion => { const start = new Date(suggestion.start); return <button type="button" key={suggestion.start} onClick={() => { setDate(formatDate(start)); setStartTime(`${String(start.getHours()).padStart(2, '0')}:${String(start.getMinutes()).padStart(2, '0')}`); setEndTime(addMinutes(`${String(start.getHours()).padStart(2, '0')}:${String(start.getMinutes()).padStart(2, '0')}`, Math.max(30, timeToMinutes(endTime) - timeToMinutes(startTime)))); }} className="rounded-lg border border-amber-200/15 px-2 py-1 text-[9px] text-amber-100 hover:bg-amber-100/10">{start.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} · {start.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</button>; })}</div>}</div>}

            <div>
              <p className="mb-2 text-[9px] font-bold uppercase tracking-[.12em] text-[#707b90]">Calendar</p>
              <div className="flex flex-wrap gap-2">{calendars.filter(calendar => calendar.role !== 'viewer').map(calendar => <button type="button" key={calendar.id} onClick={() => { setCalendarId(calendar.id); setColor(calendar.color); }} className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-[10px] font-semibold transition ${calendarId === calendar.id ? 'border-white/20 bg-white/[0.07] text-white' : 'border-white/[0.06] text-[#8690a2] hover:bg-white/[0.04]'}`}><span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: calendar.color }} />{calendar.name}</button>)}</div>
            </div>

            {error && <p className="rounded-xl border border-red-300/15 bg-red-300/[0.06] px-3 py-2 text-[10px] text-red-200">{error}</p>}

            <footer className="flex items-center gap-2 border-t border-white/[0.07] pt-4">
              {event && onDelete && <button onClick={() => onDelete(event.id)} className="grid h-10 w-10 place-items-center rounded-xl border border-red-300/15 bg-red-300/[0.06] text-red-200 hover:bg-red-300/[0.1]" title="Delete event"><Trash2 className="h-4 w-4" /></button>}
              <div className="flex-1" />
              <button onClick={onClose} className="rounded-xl px-4 py-2.5 text-xs font-semibold text-[#a3adbe] hover:bg-white/[0.05]">Cancel</button>
              <button onClick={save} disabled={!canSave || isSaving} className="rounded-xl bg-[#3978ff] px-5 py-2.5 text-xs font-semibold text-white shadow-[0_8px_28px_rgba(57,120,255,.24)] hover:bg-[#4b85ff] disabled:cursor-not-allowed disabled:opacity-35">{isSaving ? 'Saving…' : event ? 'Save changes' : 'Create event'}</button>
            </footer>
          </div>
        )}
      </section>
    </div>
  );
}

function EventChip({ event, compact = false, onOpen }: { event: CalendarEvent; compact?: boolean; onOpen: () => void }) {
  return (
    <button onClick={e => { e.stopPropagation(); onOpen(); }} className="group flex w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-left transition hover:brightness-125" style={{ backgroundColor: `${event.color}20`, color: event.color }} title={`${event.title} · ${event.allDay ? 'All day' : formatTime(event.startTime)}`}>
      <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: event.color }} />
      {!compact && <span className="shrink-0 text-[9px] font-medium opacity-75">{event.allDay ? 'All day' : formatTime(event.startTime)}</span>}
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
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-white/[0.07] bg-[#0d1016]">
      <div className="grid shrink-0 grid-cols-7 border-b border-white/[0.07] bg-[#11151d]">{DAYS.map(day => <div key={day} className="px-1 py-2.5 text-center text-[9px] font-bold uppercase tracking-[.12em] text-[#778197] sm:text-[10px]">{day}</div>)}</div>
      <div className="grid min-h-0 flex-1 grid-cols-7 grid-rows-6">
        {cells.map(cell => {
          const dateKey = formatDate(cell);
          const dayEvents = events.filter(event => event.date === dateKey).sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.startTime.localeCompare(b.startTime));
          const currentMonth = cell.getMonth() === date.getMonth();
          const isToday = dateKey === today;
          return (
            <div key={dateKey} onClick={() => onCreate(dateKey)} onDragOver={e => { e.preventDefault(); setDragOver(dateKey); }} onDragLeave={() => setDragOver(value => value === dateKey ? null : value)} onDrop={e => { e.preventDefault(); const id = e.dataTransfer.getData('text/calendar-event'); if (id) onMove(id, dateKey); setDragOver(null); }} className={`group min-h-[72px] overflow-hidden border-b border-r border-white/[0.055] p-1 transition sm:min-h-[104px] sm:p-1.5 ${currentMonth ? 'bg-[#0d1016]' : 'bg-[#090b10]'} ${dragOver === dateKey ? 'bg-[#718cff]/10 ring-1 ring-inset ring-[#718cff]/60' : 'hover:bg-white/[0.025]'}`}>
              <div className="mb-1 flex items-center justify-between">
                <button onClick={e => { e.stopPropagation(); onOpenDay(cell); }} className={`grid h-6 w-6 place-items-center rounded-full text-[10px] font-semibold sm:h-7 sm:w-7 sm:text-xs ${isToday ? 'bg-[#3978ff] text-white shadow-[0_4px_14px_rgba(57,120,255,.35)]' : currentMonth ? 'text-[#d6dbe5] hover:bg-white/[0.06]' : 'text-[#50586a] hover:bg-white/[0.04]'}`}>{cell.getDate()}</button>
                <button onClick={e => { e.stopPropagation(); onCreate(dateKey); }} className="hidden h-6 w-6 place-items-center rounded-lg text-[#697488] opacity-0 transition hover:bg-white/[0.06] hover:text-white group-hover:grid group-hover:opacity-100 sm:grid"><Plus className="h-3 w-3" /></button>
              </div>
              <div className="space-y-0.5">
                {dayEvents.slice(0, 3).map(event => <div key={event.id} draggable={isEditable(event)} onDragStart={e => { e.stopPropagation(); e.dataTransfer.setData('text/calendar-event', event.id); }}><EventChip event={event} compact={false} onOpen={() => onOpen(event)} /></div>)}
                {dayEvents.length > 3 && <button onClick={e => { e.stopPropagation(); onOpenDay(cell); }} className="px-1.5 text-[9px] font-semibold text-[#8994a7] hover:text-white">+{dayEvents.length - 3} more</button>}
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
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-white/[0.07] bg-[#0d1016]">
      <div className="flex shrink-0 border-b border-white/[0.07] bg-[#11151d]">
        <div className="w-16 shrink-0 border-r border-white/[0.06] px-2 py-3 text-center text-[8px] font-semibold text-[#657085]">{timezone.split('/').pop()?.replace('_', ' ')}</div>
        {days.map(day => { const key = formatDate(day); const active = key === today; return <button key={key} onClick={() => onCreate(key, '09:00')} className="min-w-[118px] flex-1 border-r border-white/[0.055] py-2 text-center hover:bg-white/[0.025]"><span className={`block text-[9px] font-bold uppercase tracking-[.1em] ${active ? 'text-[#8eabff]' : 'text-[#798398]'}`}>{day.toLocaleDateString([], { weekday: 'short' })}</span><span className={`mx-auto mt-1 grid h-8 w-8 place-items-center rounded-full text-sm font-semibold ${active ? 'bg-[#3978ff] text-white' : 'text-[#d6dbe5]'}`}>{day.getDate()}</span></button>; })}
      </div>

      <div className="flex shrink-0 border-b border-white/[0.07] bg-[#0f1218]">
        <div className="w-16 shrink-0 border-r border-white/[0.06] px-2 py-2 text-right text-[8px] uppercase tracking-wider text-[#687286]">All day</div>
        {days.map(day => { const key = formatDate(day); const allDay = events.filter(event => event.date === key && event.allDay); return <div key={key} className="min-h-10 min-w-[118px] flex-1 space-y-1 border-r border-white/[0.055] p-1">{allDay.map(event => <div key={event.id}><EventChip event={event} onOpen={() => onOpen(event)} /></div>)}</div>; })}
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
        <div className="flex" style={{ minWidth: days.length > 1 ? 64 + days.length * 118 : undefined }}>
          <div className="relative w-16 shrink-0 border-r border-white/[0.06]" style={{ height: HOURS.length * HOUR_HEIGHT }}>
            {HOURS.map(hour => <span key={hour} className="absolute right-2 -translate-y-1/2 text-[9px] text-[#687286]" style={{ top: hour * HOUR_HEIGHT }}>{hour === 0 ? '' : formatTime(`${String(hour).padStart(2, '0')}:00`)}</span>)}
          </div>
          {days.map(day => {
            const key = formatDate(day);
            const dayEvents = events.filter(event => event.date === key && !event.allDay).sort((a, b) => a.startTime.localeCompare(b.startTime));
            const isToday = key === today;
            const currentMinute = now.getHours() * 60 + now.getMinutes();
            return (
              <div key={key} className="relative min-w-[118px] flex-1 border-r border-white/[0.055]" style={{ height: HOURS.length * HOUR_HEIGHT, backgroundImage: 'repeating-linear-gradient(to bottom, transparent 0, transparent 63px, rgba(255,255,255,.055) 63px, rgba(255,255,255,.055) 64px)' }}>
                {HOURS.map(hour => <button key={hour} onClick={() => onCreate(key, `${String(hour).padStart(2, '0')}:00`)} className="absolute left-0 right-0 z-0 hover:bg-[#718cff]/[0.035]" style={{ top: hour * HOUR_HEIGHT, height: HOUR_HEIGHT }} aria-label={`Create event ${key} ${hour}:00`} />)}
                {isToday && <div className="pointer-events-none absolute left-0 right-0 z-20 border-t border-red-400" style={{ top: currentMinute / 60 * HOUR_HEIGHT }}><span className="absolute -left-1.5 -top-1.5 h-3 w-3 rounded-full bg-red-400" /></div>}
                {dayEvents.map((event, index) => {
                  const start = timeToMinutes(event.startTime);
                  const top = start / 60 * HOUR_HEIGHT;
                  const height = Math.max(28, eventDuration(event) / 60 * HOUR_HEIGHT - 2);
                  const stagger = (index % 3) * 6;
                  return <button key={event.id} onClick={e => { e.stopPropagation(); onOpen(event); }} className="absolute z-10 overflow-hidden rounded-lg border-l-2 px-2 py-1 text-left shadow-[0_5px_16px_rgba(0,0,0,.16)] transition hover:z-30 hover:brightness-125" style={{ top, height, left: 4 + stagger, right: 4, borderColor: event.color, backgroundColor: `${event.color}22`, color: event.color }}><span className="block truncate text-[10px] font-semibold">{event.title}</span>{height > 38 && <span className="block truncate text-[8px] opacity-75">{formatTime(event.startTime)}–{formatTime(event.endTime)}</span>}{event.location && height > 54 && <span className="mt-0.5 block truncate text-[8px] opacity-65">{event.location}</span>}</button>;
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
  if (!upcoming.length) return <div className="grid flex-1 place-items-center rounded-2xl border border-dashed border-white/10 bg-white/[0.015] text-center"><div><CalendarDays className="mx-auto h-9 w-9 text-[#485267]" /><p className="mt-3 text-sm font-semibold text-white">Your schedule is open</p><p className="mt-1 text-xs text-[#737e91]">Create an event to start planning your time.</p></div></div>;
  return <div className="min-h-0 flex-1 overflow-y-auto rounded-2xl border border-white/[0.07] bg-[#0d1016] p-3 sm:p-5"><div className="mx-auto max-w-4xl space-y-6">{Object.entries(groups).map(([date, items]) => { const parsed = parseDate(date); return <section key={date}><header className="mb-2 flex items-baseline gap-3 border-b border-white/[0.06] pb-2"><span className={`grid h-9 w-9 place-items-center rounded-xl text-sm font-bold ${date === today ? 'bg-[#3978ff] text-white' : 'bg-white/[0.05] text-[#d8dde7]'}`}>{parsed.getDate()}</span><div><p className="text-xs font-semibold text-white">{parsed.toLocaleDateString([], { weekday: 'long' })}</p><p className="text-[9px] uppercase tracking-[.1em] text-[#707b8e]">{parsed.toLocaleDateString([], { month: 'long', year: 'numeric' })}</p></div></header><div className="space-y-2">{items.map(event => <button key={event.id} onClick={() => onOpen(event)} className="flex w-full items-center gap-3 rounded-xl border border-white/[0.06] bg-white/[0.025] p-3 text-left transition hover:border-white/[0.12] hover:bg-white/[0.04]"><span className="h-10 w-1 rounded-full" style={{ backgroundColor: event.color }} /><div className="w-24 shrink-0 text-[10px] font-medium text-[#8792a5]">{event.allDay ? 'All day' : <>{formatTime(event.startTime)}<br /><span className="text-[#5f6879]">{formatTime(event.endTime)}</span></>}</div><div className="min-w-0 flex-1"><p className="truncate text-xs font-semibold text-white">{event.title}</p>{event.location && <p className="mt-0.5 flex items-center gap-1 truncate text-[9px] text-[#748095]"><MapPin className="h-2.5 w-2.5" />{event.location}</p>}</div>{(event.id.startsWith('sched-') || event.meetingCode) && <Video className="h-4 w-4 text-[#79b7ff]" />}</button>)}</div></section>; })}</div></div>;
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

  return <div className="fixed inset-0 z-[95] flex items-end justify-center bg-black/70 backdrop-blur-md sm:items-center sm:p-4" onMouseDown={event => event.target === event.currentTarget && onClose()}><section className="max-h-[90vh] w-full overflow-y-auto rounded-t-[28px] border border-white/10 bg-[#11141b] p-5 shadow-2xl sm:max-w-xl sm:rounded-[28px]">
    <header className="mb-5 flex items-center justify-between"><div><p className="text-[9px] font-bold uppercase tracking-[.16em] text-[#77839a]">Calendar settings</p><h2 className="mt-1 text-lg font-semibold text-white">Calendars and availability</h2></div><button onClick={onClose} aria-label="Close" className="rounded-xl p-2 text-[#8c96aa] hover:bg-white/[0.06] hover:text-white"><X className="h-4 w-4" /></button></header>

    <div className="space-y-5">
      <section className="rounded-2xl border border-white/[0.07] bg-white/[0.025] p-4"><h3 className="text-xs font-semibold text-white">Create a team calendar</h3><div className="mt-3 flex gap-2"><input value={name} onChange={e => setName(e.target.value)} placeholder="Calendar name" className="min-w-0 flex-1 rounded-xl border border-white/[0.08] bg-black/20 px-3 py-2.5 text-xs text-white outline-none" /><input type="color" value={color} onChange={e => setColor(e.target.value)} className="h-10 w-12 rounded-xl border border-white/[0.08] bg-transparent p-1" /><button disabled={!name.trim() || busy} onClick={() => run(() => api.createCalendar({ name: name.trim(), color, timeZone: timezone }), 'Calendar created.').then(() => setName(''))} className="rounded-xl bg-[#3978ff] px-3 text-[10px] font-semibold text-white disabled:opacity-40">Create</button></div></section>

      <section className="rounded-2xl border border-white/[0.07] bg-white/[0.025] p-4"><h3 className="text-xs font-semibold text-white">Share a calendar</h3><p className="mt-1 text-[10px] text-[#788397]">Editors can create and change events. Viewers only see the schedule.</p><div className="mt-3 grid gap-2 sm:grid-cols-3"><select value={calendarId} onChange={e => setCalendarId(e.target.value)} className="rounded-xl border border-white/[0.08] bg-[#11141b] px-3 py-2.5 text-xs text-white">{calendars.filter(calendar => calendar.role === 'owner').map(calendar => <option key={calendar.id} value={calendar.id}>{calendar.name}</option>)}</select><select value={memberId} onChange={e => setMemberId(e.target.value)} className="rounded-xl border border-white/[0.08] bg-[#11141b] px-3 py-2.5 text-xs text-white">{users.map(user => <option key={user.id} value={user.id}>{user.displayName}</option>)}</select><select value={memberRole} onChange={e => setMemberRole(e.target.value as 'viewer' | 'editor' | 'remove')} className="rounded-xl border border-white/[0.08] bg-[#11141b] px-3 py-2.5 text-xs text-white"><option value="viewer">Viewer</option><option value="editor">Editor</option><option value="remove">Remove access</option></select></div><button disabled={!calendarId || !memberId || busy} onClick={() => run(() => api.shareCalendar(calendarId, memberId, memberRole), memberRole === 'remove' ? 'Calendar access removed.' : 'Calendar shared.')} className="mt-3 rounded-xl border border-[#718cff]/30 bg-[#718cff]/10 px-4 py-2 text-[10px] font-semibold text-[#b9c4ff] disabled:opacity-40"><Users className="mr-1.5 inline h-3.5 w-3.5" />Update access</button></section>

      <section className="rounded-2xl border border-white/[0.07] bg-white/[0.025] p-4"><h3 className="text-xs font-semibold text-white">Working hours</h3><p className="mt-1 text-[10px] text-[#788397]">Availability suggestions respect these hours in {hours.timeZone}.</p><div className="mt-3 flex flex-wrap gap-1.5">{['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map((day, index) => { const active = hours.days.includes(index); return <button key={day} onClick={() => setHours(current => ({ ...current, days: active ? current.days.filter(value => value !== index) : [...current.days, index].sort() }))} className={`rounded-lg border px-2 py-1.5 text-[9px] ${active ? 'border-[#718cff]/40 bg-[#718cff]/15 text-white' : 'border-white/[0.07] text-[#737e91]'}`}>{day}</button>; })}</div><div className="mt-3 grid grid-cols-2 gap-2"><input type="time" value={hours.startTime} onChange={e => setHours(current => ({ ...current, startTime: e.target.value }))} className="rounded-xl border border-white/[0.08] bg-black/20 px-3 py-2.5 text-xs text-white" /><input type="time" value={hours.endTime} onChange={e => setHours(current => ({ ...current, endTime: e.target.value }))} className="rounded-xl border border-white/[0.08] bg-black/20 px-3 py-2.5 text-xs text-white" /></div><button disabled={busy || !hours.days.length} onClick={() => run(() => api.updateWorkingHours(hours), 'Working hours saved.')} className="mt-3 rounded-xl bg-[#3978ff] px-4 py-2 text-[10px] font-semibold text-white disabled:opacity-40">Save working hours</button></section>
      {status && <p className="rounded-xl border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-[10px] text-[#bfc7d5]">{status}</p>}
    </div>
  </section></div>;
}

export default function CalendarView() {
  const { currentUser, allUsers } = useAuth();
  const { scheduledMeetings } = useMeeting();
  const now = new Date();
  const today = formatDate(now);
  const [viewDate, setViewDate] = useState(new Date(now.getFullYear(), now.getMonth(), now.getDate()));
  const [viewMode, setViewMode] = useState<ViewMode>('month');
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
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-[#090b10]">
      {modal && <EventModal initialDate={modal.date} initialTime={modal.startTime} event={modal.event} readOnly={!!modal.event && !isEditable(modal.event)} calendars={calendars} users={allUsers.filter(user => user.id !== currentUser?.id)} onClose={() => setModal(null)} onSave={saveEvent} onDelete={modal.event && isEditable(modal.event) ? removeEvent : undefined} onRespond={modal.event?.responseStatus === 'needs_action' ? respondEvent : undefined} />}
      {settingsOpen && <CalendarSettingsModal calendars={calendars} users={allUsers.filter(user => user.id !== currentUser?.id)} onClose={() => setSettingsOpen(false)} onChanged={async () => { await loadCalendars(); await loadEvents(); }} />}

      <header className="shrink-0 border-b border-white/[0.07] bg-[#0d1016]/95 px-3 py-3 backdrop-blur-xl sm:px-5">
        <div className="flex flex-wrap items-center gap-2 sm:gap-3">
          <div className="mr-1 flex items-center gap-2.5">
            <span className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-[#3978ff] to-[#735cff] text-white shadow-[0_8px_26px_rgba(57,120,255,.22)]"><CalendarDays className="h-4.5 w-4.5" /></span>
            <div className="hidden sm:block"><h1 className="text-sm font-semibold text-white">Calendar</h1><p className="text-[9px] text-[#687387]">Plan your time with AIPA</p></div>
          </div>
          <button onClick={goToday} className="rounded-xl border border-white/[0.09] px-3 py-2 text-[10px] font-semibold text-[#c5ccda] hover:bg-white/[0.05]">Today</button>
          <div className="flex items-center"><button onClick={() => navigate(-1)} className="grid h-9 w-9 place-items-center rounded-xl text-[#8490a4] hover:bg-white/[0.05] hover:text-white" aria-label="Previous period"><ChevronLeft className="h-4 w-4" /></button><button onClick={() => navigate(1)} className="grid h-9 w-9 place-items-center rounded-xl text-[#8490a4] hover:bg-white/[0.05] hover:text-white" aria-label="Next period"><ChevronRight className="h-4 w-4" /></button></div>
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-white sm:text-base">{periodLabel}</h2>
          <label className="hidden items-center gap-2 rounded-xl border border-white/[0.08] bg-black/20 px-3 py-2 lg:flex"><Search className="h-3.5 w-3.5 text-[#697589]" /><input value={searchQuery} onChange={event => setSearchQuery(event.target.value)} placeholder="Search calendar" className="w-28 bg-transparent text-[10px] text-white outline-none placeholder:text-[#5f697b]" /></label>
          <div className="order-last flex w-full items-center gap-1 overflow-x-auto rounded-xl border border-white/[0.07] bg-black/20 p-1 sm:order-none sm:w-auto">{viewOptions.map(option => { const Icon = option.icon; return <button key={option.id} onClick={() => setViewMode(option.id)} className={`flex min-w-fit items-center gap-1.5 rounded-lg px-2.5 py-2 text-[9px] font-semibold transition sm:text-[10px] ${viewMode === option.id ? 'bg-white/[0.09] text-white shadow-sm' : 'text-[#7d889b] hover:text-white'}`}><Icon className="h-3.5 w-3.5" />{option.label}</button>; })}</div>
          <button onClick={() => setSettingsOpen(true)} className="grid h-9 w-9 place-items-center rounded-xl border border-white/[0.08] text-[#8792a5] hover:bg-white/[0.05] hover:text-white" title="Calendars and working hours"><Settings2 className="h-4 w-4" /></button>
          <button onClick={() => createEvent(formatDate(viewDate))} className="flex items-center gap-1.5 rounded-xl bg-[#3978ff] px-3.5 py-2.5 text-[10px] font-semibold text-white shadow-[0_8px_24px_rgba(57,120,255,.2)] hover:bg-[#4b85ff]"><Plus className="h-3.5 w-3.5" />Create</button>
        </div>
        <div className="mt-2 flex items-center gap-2 overflow-x-auto">
          <label className="flex shrink-0 items-center gap-2 rounded-lg border border-white/[0.08] bg-black/20 px-2.5 py-1.5 lg:hidden"><Search className="h-3 w-3 text-[#697589]" /><input value={searchQuery} onChange={event => setSearchQuery(event.target.value)} placeholder="Search" className="w-20 bg-transparent text-[9px] text-white outline-none placeholder:text-[#5f697b]" /></label>
          {calendars.map(calendar => { const active = selectedCalendars.has(calendar.id); return <button key={calendar.id} onClick={() => setSelectedCalendars(current => { const next = new Set(current); if (active) next.delete(calendar.id); else next.add(calendar.id); return next; })} className={`flex shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[9px] font-medium ${active ? 'border-white/[0.12] bg-white/[0.06] text-white' : 'border-white/[0.05] text-[#626d7f]'}`}><span className="h-2 w-2 rounded-full" style={{ backgroundColor: calendar.color }} />{calendar.name}{calendar.memberCount > 1 && <Users className="h-3 w-3 opacity-60" />}</button>; })}
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <main className="flex min-h-0 min-w-0 flex-1 flex-col p-2 sm:p-4">
          {error && <div className="mb-3 flex items-center justify-between rounded-xl border border-red-300/15 bg-red-300/[0.06] px-3 py-2 text-[10px] text-red-200"><span>{error}</span><button onClick={refresh} className="font-semibold">Retry</button></div>}
          {loading && !allEvents.length && <div className="grid flex-1 place-items-center text-xs text-[#768195]">Loading your calendars…</div>}
          {!loading && viewMode === 'month' && <MonthView date={viewDate} today={today} events={allEvents} isEditable={isEditable} onCreate={createEvent} onOpen={openEvent} onOpenDay={openDay} onMove={moveEvent} />}
          {!loading && viewMode === 'week' && <TimelineView days={weekDays} today={today} events={allEvents} onCreate={createEvent} onOpen={openEvent} />}
          {!loading && viewMode === 'day' && <TimelineView days={[viewDate]} today={today} events={allEvents} onCreate={createEvent} onOpen={openEvent} />}
          {!loading && viewMode === 'agenda' && <AgendaView events={allEvents} today={today} onOpen={openEvent} />}
        </main>

        <aside className="hidden w-72 shrink-0 flex-col border-l border-white/[0.07] bg-[#0d1016] xl:flex">
          <div className="border-b border-white/[0.07] p-4">
            <input type="date" value={selectedDate} onChange={event => { setSelectedDate(event.target.value); setViewDate(parseDate(event.target.value)); }} className="w-full rounded-xl border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-xs font-medium text-white outline-none focus:border-[#718cff]/60" />
            <div className="mt-3 flex items-center justify-between"><div><p className="text-sm font-semibold text-white">{formatLongDate(parseDate(selectedDate))}</p><p className="mt-0.5 text-[9px] uppercase tracking-[.12em] text-[#6f7a8d]">{dayEvents.length} {dayEvents.length === 1 ? 'event' : 'events'}</p></div><button onClick={() => createEvent(selectedDate)} className="grid h-8 w-8 place-items-center rounded-xl bg-[#3978ff]/15 text-[#8fabff] hover:bg-[#3978ff]/25"><Plus className="h-4 w-4" /></button></div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {dayEvents.length ? <div className="space-y-2">{dayEvents.map(event => <button key={event.id} onClick={() => openEvent(event)} className="w-full rounded-xl border border-white/[0.06] bg-white/[0.025] p-3 text-left hover:bg-white/[0.045]" style={{ borderLeft: `3px solid ${event.color}` }}><p className="truncate text-xs font-semibold text-white">{event.title}</p><p className="mt-1 flex items-center gap-1 text-[9px] text-[#7d899c]"><Clock className="h-3 w-3" />{event.allDay ? 'All day' : `${formatTime(event.startTime)} – ${formatTime(event.endTime)}`}</p>{event.location && <p className="mt-1 flex items-center gap-1 truncate text-[9px] text-[#657085]"><MapPin className="h-3 w-3" />{event.location}</p>}</button>)}</div> : <button onClick={() => createEvent(selectedDate)} className="w-full rounded-xl border border-dashed border-white/10 px-3 py-6 text-center text-[10px] text-[#707b8e] hover:border-[#718cff]/30 hover:text-[#9caffe]"><Plus className="mx-auto mb-2 h-4 w-4" />No events. Add one</button>}
            <div className="my-4 border-t border-white/[0.06]" />
            <p className="mb-2 px-1 text-[9px] font-bold uppercase tracking-[.14em] text-[#687387]">Coming up</p>
            <div className="space-y-1.5">{upcoming.slice(0, 8).map(event => <button key={`upcoming-${event.id}`} onClick={() => { setSelectedDate(event.date); setViewDate(parseDate(event.date)); openEvent(event); }} className="flex w-full items-center gap-2.5 rounded-xl px-2 py-2 text-left hover:bg-white/[0.035]"><span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: event.color }} /><div className="min-w-0 flex-1"><p className="truncate text-[10px] font-medium text-[#ccd2dd]">{event.title}</p><p className="text-[8px] text-[#667186]">{parseDate(event.date).toLocaleDateString([], { month: 'short', day: 'numeric' })} · {event.allDay ? 'All day' : formatTime(event.startTime)}</p></div></button>)}</div>
          </div>
        </aside>
      </div>
    </div>
  );
}
