import React, { useState } from 'react';
import { ChevronLeft, ChevronRight, Plus, X, Clock, AlignLeft, Video, Trash2, List, Grid3x3, GripVertical } from 'lucide-react';
import { CalendarEvent } from '../../types';
import { useAuth } from '../../context/AuthContext';
import { useMeeting } from '../../context/MeetingContext';
import { loadCalendarEvents, addCalendarEvent, updateCalendarEvent, deleteCalendarEvent } from '../../lib/calendarLocal';

const EVENT_TYPES = [
  { name: 'Personal', value: '#568dff' },
  { name: 'Academic', value: '#4dffb1' },
  { name: 'Admin', value: '#ffb4ab' },
  { name: 'Meeting', value: '#c0c1ff' },
  { name: 'Other', value: '#ffd60a' },
];
const DAYS_SHORT = ['S', 'M', 'T', 'W', 'T', 'F', 'S']; const DAYS_FULL = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']; const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function formatDate(date: Date): string { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; }
function fmtScheduledDate(dateStr: string, timeStr: string): string { try { const d = new Date(`${dateStr}T${timeStr}`); return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) + ' · ' + d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }); } catch { return `${dateStr} ${timeStr}`; } }

function EventModal({ initialDate, event, onClose, onSave, onDelete }: {
  initialDate: string;
  event: CalendarEvent | null;
  onClose: () => void;
  onSave: (event: CalendarEvent) => void;
  onDelete?: (id: string) => void;
}) {
  const [title, setTitle] = useState(event?.title ?? '');
  const [date, setDate] = useState(event?.date ?? initialDate);
  const [startTime, setStartTime] = useState(event?.startTime ?? '09:00');
  const [endTime, setEndTime] = useState(event?.endTime ?? '10:00');
  const [description, setDescription] = useState(event?.description ?? '');
  const [color, setColor] = useState(event?.color ?? EVENT_TYPES[0].value);

  const canSave = title.trim().length > 0 && date;

  const handleSave = () => {
    if (!canSave) return;
    onSave({
      id: event?.id ?? `evt-${Date.now()}`,
      creatorId: event?.creatorId ?? '',
      title: title.trim(), date, startTime, endTime, description: description.trim(), color,
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-sm p-0 sm:p-4" onClick={onClose}>
      <div className="bg-[#1c1b1b] border border-[#424655] rounded-t-2xl sm:rounded-2xl w-full sm:max-w-sm shadow-2xl overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#424655]/40">
          <h3 className="font-bold text-sm text-[#e5e2e1]">{event ? 'Edit Event' : 'New Event'}</h3>
          <button onClick={onClose} className="w-7 h-7 rounded-full bg-[#201f1f] border border-[#424655] flex items-center justify-center hover:border-[#ffb4ab] hover:text-[#ffb4ab] transition-colors cursor-pointer"><X className="w-3.5 h-3.5" /></button>
        </div>
        <div className="flex flex-col gap-4 px-5 py-5 max-h-[70vh] overflow-y-auto">
          <div className="flex flex-col gap-1.5">
            <label className="text-[9px] font-bold tracking-wider text-[#8c90a1] uppercase">Title</label>
            <input autoFocus type="text" value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. IB Assessment Review" className="px-3 py-2.5 bg-[#131313] border border-[#424655] rounded-xl text-xs text-[#e5e2e1] placeholder-[#8c90a1]/60 focus:border-[#568dff] outline-none" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <label className="text-[9px] font-bold tracking-wider text-[#8c90a1] uppercase">Date</label>
              <input type="date" value={date} onChange={e => setDate(e.target.value)} className="px-3 py-2.5 bg-[#131313] border border-[#424655] rounded-xl text-xs text-[#e5e2e1] focus:border-[#568dff] outline-none" />
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-[9px] font-bold tracking-wider text-[#8c90a1] uppercase">Start</label>
              <input type="time" value={startTime} onChange={e => setStartTime(e.target.value)} className="px-3 py-2.5 bg-[#131313] border border-[#424655] rounded-xl text-xs text-[#e5e2e1] focus:border-[#568dff] outline-none" />
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-[9px] font-bold tracking-wider text-[#8c90a1] uppercase">End (optional)</label>
            <input type="time" value={endTime} onChange={e => setEndTime(e.target.value)} className="px-3 py-2.5 bg-[#131313] border border-[#424655] rounded-xl text-xs text-[#e5e2e1] focus:border-[#568dff] outline-none w-full" />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-[9px] font-bold tracking-wider text-[#8c90a1] uppercase flex items-center gap-1"><AlignLeft className="w-3 h-3" /> Description</label>
            <textarea value={description} onChange={e => setDescription(e.target.value)} rows={2} placeholder="Optional details…" className="px-3 py-2.5 bg-[#131313] border border-[#424655] rounded-xl text-xs text-[#e5e2e1] placeholder-[#8c90a1]/60 focus:border-[#568dff] outline-none resize-none" />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-[9px] font-bold tracking-wider text-[#8c90a1] uppercase">Type / Color</label>
            <div className="flex gap-2 flex-wrap">
              {EVENT_TYPES.map(t => (
                <button key={t.value} onClick={() => setColor(t.value)} className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-[10px] font-semibold transition-all cursor-pointer ${color === t.value ? 'border-current' : 'border-[#424655] text-[#8c90a1] hover:text-[#e5e2e1]'}`} style={color === t.value ? { color: t.value, backgroundColor: t.value + '15' } : undefined}>
                  <span className="w-2 h-2 rounded-full" style={{ backgroundColor: t.value }} />{t.name}
                </button>
              ))}
            </div>
          </div>
          <div className="flex gap-3 pt-2">
            {event && onDelete && (
              <button onClick={() => onDelete(event.id)} className="w-11 h-11 flex items-center justify-center bg-[#93000a]/15 text-[#ffb4ab] border border-[#ffb4ab]/30 rounded-xl hover:bg-[#93000a]/30 transition-colors cursor-pointer shrink-0" title="Delete event">
                <Trash2 className="w-4 h-4" />
              </button>
            )}
            <button onClick={onClose} className="flex-1 py-2.5 bg-[#201f1f] text-[#e5e2e1] border border-[#424655] rounded-xl text-xs font-semibold hover:bg-[#2a2a2a] cursor-pointer transition-colors">Cancel</button>
            <button onClick={handleSave} disabled={!canSave} className="flex-1 py-2.5 bg-[#568dff] text-[#002661] rounded-xl text-xs font-bold hover:bg-[#568dff]/90 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-colors">Save</button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function CalendarView() {
  const { currentUser } = useAuth();
  const { scheduledMeetings } = useMeeting();
  const today = new Date();
  const todayStr = formatDate(today);

  const [viewDate, setViewDate] = useState(new Date(today.getFullYear(), today.getMonth(), 1));
  const [viewMode, setViewMode] = useState<'month' | 'list'>('month');
  const [events, setEvents] = useState<CalendarEvent[]>(() => currentUser ? loadCalendarEvents(currentUser.id) : []);
  const [modalState, setModalState] = useState<{ date: string; event: CalendarEvent | null } | null>(null);
  const [mobileTab, setMobileTab] = useState<'calendar' | 'upcoming'>('calendar');
  const [dragOverDate, setDragOverDate] = useState<string | null>(null);

  const meetingEvents: CalendarEvent[] = scheduledMeetings.map(sm => ({
    id: `sched-${sm.code}-${sm.id}`, creatorId: currentUser?.id ?? '', title: sm.title || sm.code, date: sm.date, startTime: sm.time, endTime: sm.time, description: `Meeting code: ${sm.code}`, color: '#b0c6ff',
  }));

  const allEvents = [...events, ...meetingEvents];

  const persist = (updated: CalendarEvent[]) => setEvents(updated);

  const handleSaveEvent = (event: CalendarEvent) => {
    if (!currentUser) return;
    const isEdit = events.some(e => e.id === event.id);
    const updated = isEdit ? updateCalendarEvent(currentUser.id, event) : addCalendarEvent(currentUser.id, event);
    persist(updated);
    setModalState(null);
  };

  const handleDeleteEvent = (id: string) => {
    if (!currentUser) return;
    persist(deleteCalendarEvent(currentUser.id, id));
    setModalState(null);
  };

  const handleDropOnDate = (dateStr: string) => (e: React.DragEvent) => {
    e.preventDefault();
    setDragOverDate(null);
    const eventId = e.dataTransfer.getData('text/plain');
    if (!currentUser || !eventId) return;
    const existing = events.find(ev => ev.id === eventId);
    if (!existing || existing.date === dateStr) return;
    persist(updateCalendarEvent(currentUser.id, { ...existing, date: dateStr }));
  };

  const year = viewDate.getFullYear(); const month = viewDate.getMonth(); const firstDay = new Date(year, month, 1).getDay(); const daysInMonth = new Date(year, month + 1, 0).getDate(); const prevMonthDays = new Date(year, month, 0).getDate();
  const cells: { date: Date; isCurrentMonth: boolean }[] = [];
  for (let i = firstDay - 1; i >= 0; i--) cells.push({ date: new Date(year, month - 1, prevMonthDays - i), isCurrentMonth: false });
  for (let d = 1; d <= daysInMonth; d++) cells.push({ date: new Date(year, month, d), isCurrentMonth: true });
  while (cells.length < 42) cells.push({ date: new Date(year, month + 1, cells.length - daysInMonth - firstDay + 1), isCurrentMonth: false });

  const getEventsForDate = (date: Date) => allEvents.filter(e => e.date === formatDate(date)).sort((a, b) => a.startTime.localeCompare(b.startTime));
  const upcomingEvents = allEvents.filter(e => e.date >= todayStr).sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime));

  const isEditable = (ev: CalendarEvent) => events.some(e => e.id === ev.id);

  const UpcomingPanel = () => (
    <div className="flex flex-col h-full bg-[#131313]">
      <div className="p-4 border-b border-[#424655] flex items-center justify-between sticky top-0 bg-[#131313] z-10">
        <h3 className="font-bold text-sm text-[#e5e2e1]">Upcoming</h3>
      </div>
      <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-2">
        {scheduledMeetings.length > 0 && (
          <div className="mb-1">
            <p className="text-[9px] font-bold uppercase tracking-wider text-[#8c90a1] mb-2 px-1">Scheduled Meetings</p>
            {scheduledMeetings.map(sm => (
              <div key={sm.id} className="bg-[#0e0e0e] border border-[#b0c6ff]/20 rounded-xl p-3 mb-2" style={{ borderLeftColor: '#b0c6ff', borderLeftWidth: 3 }}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-semibold text-xs text-[#e5e2e1] truncate">{sm.title || 'Untitled'}</p>
                    <p className="text-[10px] text-[#8c90a1] mt-0.5 flex items-center gap-1"><Clock className="w-3 h-3 shrink-0" />{fmtScheduledDate(sm.date, sm.time)}</p>
                  </div>
                  <Video className="w-3.5 h-3.5 text-[#b0c6ff] shrink-0 mt-0.5" />
                </div>
                <div className="mt-2 flex items-center justify-between">
                  <span className="font-mono text-[10px] text-[#b0c6ff] bg-[#568dff]/10 px-2 py-0.5 rounded">{sm.code}</span>
                  <a href={`/${sm.code}`} className="text-[10px] bg-[#568dff] text-[#002661] font-bold px-3 py-1 rounded-md">Join</a>
                </div>
              </div>
            ))}
          </div>
        )}
        {events.length > 0 && (
          <div>
            <p className="text-[9px] font-bold uppercase tracking-wider text-[#8c90a1] mb-2 px-1">Your Events</p>
            {events.filter(e => e.date >= todayStr).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 20).map(ev => (
              <div key={ev.id} onClick={() => setModalState({ date: ev.date, event: ev })} className="bg-[#0e0e0e] border border-[#424655]/40 rounded-xl p-3 mb-2 cursor-pointer hover:border-[#424655] transition-colors" style={{ borderLeftColor: ev.color, borderLeftWidth: 3 }}>
                <p className="font-semibold text-xs text-[#e5e2e1] truncate">{ev.title}</p>
                <p className="text-[10px] text-[#8c90a1] mt-0.5 flex items-center gap-1"><Clock className="w-3 h-3 shrink-0" />{fmtScheduledDate(ev.date, ev.startTime)}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );

  const ListView = () => (
    <div className="flex-1 overflow-y-auto p-3 sm:p-6">
      {upcomingEvents.length === 0 ? (
        <div className="text-center py-16">
          <Grid3x3 className="w-8 h-8 text-[#424655] mx-auto mb-2" />
          <p className="text-xs text-[#8c90a1]">No upcoming events — click "New Event" to add one</p>
        </div>
      ) : (
        <div className="flex flex-col gap-2 max-w-2xl mx-auto">
          {upcomingEvents.map(ev => (
            <div key={ev.id} onClick={() => isEditable(ev) && setModalState({ date: ev.date, event: ev })} className={`flex items-center gap-3 p-3 rounded-xl bg-[#1c1b1b] border border-[#424655]/60 ${isEditable(ev) ? 'cursor-pointer hover:border-[#424655]' : ''} transition-colors`}>
              <div className="w-2 h-10 rounded-full shrink-0" style={{ backgroundColor: ev.color }} />
              <div className="min-w-0 flex-1">
                <p className="text-xs font-semibold text-[#e5e2e1] truncate">{ev.title}</p>
                <p className="text-[10px] text-[#8c90a1]">{fmtScheduledDate(ev.date, ev.startTime)}</p>
              </div>
              {ev.id.startsWith('sched-') && <Video className="w-3.5 h-3.5 text-[#b0c6ff] shrink-0" />}
            </div>
          ))}
        </div>
      )}
    </div>
  );

  return (
    <div className="flex-1 flex flex-col overflow-hidden h-full bg-[#0e0e0e]">
      {modalState && (
        <EventModal
          initialDate={modalState.date}
          event={modalState.event}
          onClose={() => setModalState(null)}
          onSave={handleSaveEvent}
          onDelete={modalState.event ? handleDeleteEvent : undefined}
        />
      )}
      <div className="lg:hidden flex border-b border-[#424655] bg-[#131313] shrink-0">
        {(['calendar', 'upcoming'] as const).map(tab => (
          <button key={tab} onClick={() => setMobileTab(tab)} className={`flex-1 py-3 text-xs font-bold capitalize transition-colors border-b-2 ${mobileTab === tab ? 'border-[#568dff] text-[#b0c6ff]' : 'border-transparent text-[#8c90a1]'}`}>{tab === 'upcoming' ? 'Upcoming & Meetings' : 'Calendar'}</button>
        ))}
      </div>
      <div className="flex-1 flex overflow-hidden min-h-0">
        <div className={`flex-1 flex flex-col min-h-0 min-w-0 ${mobileTab !== 'calendar' ? 'hidden lg:flex' : 'flex'}`}>
          {viewMode === 'month' ? (
            <div className="flex-1 flex flex-col min-h-0 p-3 sm:p-6">
              <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
                <div className="flex items-center gap-2 sm:gap-4"><h1 className="text-base sm:text-xl font-bold text-[#e5e2e1]">{MONTHS[month]} {year}</h1><div className="flex items-center gap-1"><button onClick={() => setViewDate(new Date(year, month - 1, 1))} className="w-7 h-7 sm:w-8 sm:h-8 flex items-center justify-center rounded-lg text-[#8c90a1] hover:bg-[#201f1f] hover:text-[#e5e2e1] transition-colors"><ChevronLeft className="w-3.5 h-3.5 sm:w-4 sm:h-4" /></button><button onClick={() => setViewDate(new Date(year, month + 1, 1))} className="w-7 h-7 sm:w-8 sm:h-8 flex items-center justify-center rounded-lg text-[#8c90a1] hover:bg-[#201f1f] hover:text-[#e5e2e1] transition-colors"><ChevronRight className="w-3.5 h-3.5 sm:w-4 sm:h-4" /></button></div></div>
                <div className="flex items-center gap-2">
                  <div className="flex items-center bg-[#131313] border border-[#424655] rounded-lg p-0.5">
                    <button onClick={() => setViewMode('month')} title="Month view" className={`w-7 h-7 flex items-center justify-center rounded-md transition-colors ${viewMode === 'month' ? 'bg-[#568dff]/20 text-[#b0c6ff]' : 'text-[#8c90a1] hover:text-[#e5e2e1]'}`}><Grid3x3 className="w-3.5 h-3.5" /></button>
                    <button onClick={() => setViewMode('list')} title="List view" className={`w-7 h-7 flex items-center justify-center rounded-md transition-colors ${viewMode === 'list' ? 'bg-[#568dff]/20 text-[#b0c6ff]' : 'text-[#8c90a1] hover:text-[#e5e2e1]'}`}><List className="w-3.5 h-3.5" /></button>
                  </div>
                  <button onClick={() => setViewDate(new Date(today.getFullYear(), today.getMonth(), 1))} className="px-2.5 py-1.5 text-[10px] sm:text-xs font-bold rounded-lg bg-[#201f1f] text-[#b0c6ff] border border-[#424655] hover:bg-[#2a2a2a]">Today</button>
                  <button onClick={() => setModalState({ date: todayStr, event: null })} className="flex items-center gap-1.5 px-2.5 py-1.5 text-[10px] sm:text-xs font-bold rounded-lg bg-[#568dff] text-[#002661] hover:bg-[#568dff]/90"><Plus className="w-3.5 h-3.5" />New Event</button>
                </div>
              </div>
              <div className="grid grid-cols-7 mb-1 sm:mb-2">{(window.innerWidth < 400 ? DAYS_SHORT : DAYS_FULL).map((d, i) => (<div key={i} className="text-center text-[9px] sm:text-[11px] font-bold text-[#8c90a1] uppercase tracking-wider py-1 sm:py-2">{d}</div>))}</div>

              <div className="flex-1 grid grid-cols-7 gap-px bg-[#424655]/20 rounded-xl overflow-y-auto border border-[#424655]/20 content-start sm:content-stretch">
                {cells.map((cell, i) => {
                  const dateStr = formatDate(cell.date); const dayEvts = getEventsForDate(cell.date); const isToday = dateStr === todayStr; const isCurMon = cell.isCurrentMonth;
                  return (
                    <div
                      key={i}
                      onClick={() => setModalState({ date: dateStr, event: null })}
                      onDragOver={(e) => { e.preventDefault(); setDragOverDate(dateStr); }}
                      onDragLeave={() => setDragOverDate(prev => prev === dateStr ? null : prev)}
                      onDrop={handleDropOnDate(dateStr)}
                      className={`bg-[#0e0e0e] aspect-square sm:aspect-auto p-1 sm:p-2 hover:bg-[#131313] transition-colors flex flex-col items-center sm:items-start cursor-pointer ${isToday ? 'ring-1 ring-inset ring-[#568dff]' : ''} ${dragOverDate === dateStr ? 'ring-2 ring-inset ring-[#c0c1ff] bg-[#131313]' : ''}`}
                    >
                      <div className={`text-[10px] sm:text-xs font-bold mb-1 w-5 h-5 flex items-center justify-center rounded-full shrink-0 ${isToday ? 'bg-[#568dff] text-[#002661]' : isCurMon ? 'text-[#e5e2e1]' : 'text-[#424655]'}`}>{cell.date.getDate()}</div>
                      <div className="flex sm:hidden gap-1 flex-wrap justify-center mt-1">
                        {dayEvts.slice(0, 3).map(ev => (<span key={ev.id} className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: ev.color }} />))}
                      </div>
                      <div className="hidden sm:flex flex-col gap-0.5 w-full">
                        {dayEvts.slice(0, 2).map(ev => (
                          <div
                            key={ev.id}
                            draggable={isEditable(ev)}
                            onDragStart={(e) => { e.stopPropagation(); e.dataTransfer.setData('text/plain', ev.id); }}
                            onClick={(e) => { e.stopPropagation(); if (isEditable(ev)) setModalState({ date: ev.date, event: ev }); }}
                            className={`text-[9px] font-semibold px-1.5 py-0.5 rounded truncate flex items-center gap-1 ${isEditable(ev) ? 'cursor-grab active:cursor-grabbing' : ''}`}
                            style={{ backgroundColor: ev.color + '30', color: ev.color, borderLeft: `2px solid ${ev.color}` }}
                          >
                            {isEditable(ev) && <GripVertical className="w-2 h-2 shrink-0 opacity-50" />}
                            {ev.startTime} {ev.title}
                          </div>
                        ))}
                        {dayEvts.length > 2 && <div className="text-[9px] text-[#8c90a1] font-semibold px-1">+{dayEvts.length - 2}</div>}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="flex-1 flex flex-col min-h-0">
              <div className="flex items-center justify-between p-3 sm:p-6 pb-2 sm:pb-3 flex-wrap gap-2">
                <h1 className="text-base sm:text-xl font-bold text-[#e5e2e1]">All Upcoming Events</h1>
                <div className="flex items-center gap-2">
                  <div className="flex items-center bg-[#131313] border border-[#424655] rounded-lg p-0.5">
                    <button onClick={() => setViewMode('month')} title="Month view" className="w-7 h-7 flex items-center justify-center rounded-md text-[#8c90a1] hover:text-[#e5e2e1] transition-colors"><Grid3x3 className="w-3.5 h-3.5" /></button>
                    <button onClick={() => setViewMode('list')} title="List view" className="w-7 h-7 flex items-center justify-center rounded-md bg-[#568dff]/20 text-[#b0c6ff] transition-colors"><List className="w-3.5 h-3.5" /></button>
                  </div>
                  <button onClick={() => setModalState({ date: todayStr, event: null })} className="flex items-center gap-1.5 px-2.5 py-1.5 text-[10px] sm:text-xs font-bold rounded-lg bg-[#568dff] text-[#002661] hover:bg-[#568dff]/90"><Plus className="w-3.5 h-3.5" />New Event</button>
                </div>
              </div>
              <ListView />
            </div>
          )}
        </div>
        <aside className={`lg:w-72 lg:flex-shrink-0 lg:border-l lg:border-[#424655] lg:bg-[#131313] ${mobileTab === 'upcoming' ? 'block' : 'hidden lg:block'}`}>
          <UpcomingPanel />
        </aside>
      </div>
    </div>
  );
}
