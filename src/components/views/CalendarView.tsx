import React, { useState, useEffect, useCallback } from 'react';
import { ChevronLeft, ChevronRight, Plus, X, Clock, AlignLeft } from 'lucide-react';
import { CalendarEvent } from '../../types';
import { useAuth } from '../../context/AuthContext';

const EVENT_COLORS = [
  { name: 'Blue', value: '#568dff' },
  { name: 'Green', value: '#4dffb1' },
  { name: 'Purple', value: '#c0c1ff' },
  { name: 'Orange', value: '#ffb4ab' },
  { name: 'Yellow', value: '#ffd60a' },
];

const STORAGE_KEY = (userId: string) => `ibconnect_calendar_${userId}`;

function loadEvents(userId: string): CalendarEvent[] {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY(userId)) || '[]'); } catch { return []; }
}
function saveEvents(userId: string, events: CalendarEvent[]) {
  localStorage.setItem(STORAGE_KEY(userId), JSON.stringify(events));
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

function formatDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

interface EventModalProps {
  date: string;
  event?: CalendarEvent;
  onSave: (event: Omit<CalendarEvent, 'id' | 'creatorId'>) => void;
  onDelete?: () => void;
  onClose: () => void;
}

function EventModal({ date, event, onSave, onDelete, onClose }: EventModalProps) {
  const [title, setTitle] = useState(event?.title || '');
  const [startTime, setStartTime] = useState(event?.startTime || '09:00');
  const [endTime, setEndTime] = useState(event?.endTime || '10:00');
  const [description, setDescription] = useState(event?.description || '');
  const [color, setColor] = useState(event?.color || '#568dff');
  const [selectedDate, setSelectedDate] = useState(date);

  const handleSave = () => {
    if (!title.trim()) return;
    onSave({ title: title.trim(), date: selectedDate, startTime, endTime, description, color });
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-[#131313] border border-[#424655] rounded-2xl shadow-2xl w-96 overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between p-5 border-b border-[#424655]">
          <h2 className="font-bold text-[#e5e2e1]">{event ? 'Edit Event' : 'New Event'}</h2>
          <button onClick={onClose} className="text-[#8c90a1] hover:text-[#e5e2e1]"><X className="w-5 h-5" /></button>
        </div>

        <div className="p-5 flex flex-col gap-4">
          <input
            autoFocus
            type="text"
            placeholder="Event title"
            value={title}
            onChange={e => setTitle(e.target.value)}
            className="w-full bg-[#0e0e0e] border border-[#424655] rounded-xl px-4 py-3 text-[#e5e2e1] text-sm placeholder-[#8c90a1]/60 focus:border-[#568dff] outline-none"
          />

          <div className="flex gap-3">
            <div className="flex-1">
              <label className="text-[10px] text-[#8c90a1] font-bold uppercase tracking-wider block mb-1.5">Date</label>
              <input
                type="date"
                value={selectedDate}
                onChange={e => setSelectedDate(e.target.value)}
                className="w-full bg-[#0e0e0e] border border-[#424655] rounded-xl px-3 py-2.5 text-[#e5e2e1] text-xs focus:border-[#568dff] outline-none"
              />
            </div>
          </div>

          <div className="flex gap-3">
            <div className="flex-1">
              <label className="text-[10px] text-[#8c90a1] font-bold uppercase tracking-wider block mb-1.5 flex items-center gap-1">
                <Clock className="w-3 h-3" /> Start
              </label>
              <input
                type="time"
                value={startTime}
                onChange={e => setStartTime(e.target.value)}
                className="w-full bg-[#0e0e0e] border border-[#424655] rounded-xl px-3 py-2.5 text-[#e5e2e1] text-xs focus:border-[#568dff] outline-none"
              />
            </div>
            <div className="flex-1">
              <label className="text-[10px] text-[#8c90a1] font-bold uppercase tracking-wider block mb-1.5 flex items-center gap-1">
                <Clock className="w-3 h-3" /> End
              </label>
              <input
                type="time"
                value={endTime}
                onChange={e => setEndTime(e.target.value)}
                className="w-full bg-[#0e0e0e] border border-[#424655] rounded-xl px-3 py-2.5 text-[#e5e2e1] text-xs focus:border-[#568dff] outline-none"
              />
            </div>
          </div>

          <div>
            <label className="text-[10px] text-[#8c90a1] font-bold uppercase tracking-wider block mb-1.5 flex items-center gap-1">
              <AlignLeft className="w-3 h-3" /> Description
            </label>
            <textarea
              placeholder="Add description (optional)"
              value={description}
              onChange={e => setDescription(e.target.value)}
              rows={2}
              className="w-full bg-[#0e0e0e] border border-[#424655] rounded-xl px-3 py-2.5 text-[#e5e2e1] text-xs placeholder-[#8c90a1]/60 focus:border-[#568dff] outline-none resize-none"
            />
          </div>

          <div>
            <label className="text-[10px] text-[#8c90a1] font-bold uppercase tracking-wider block mb-2">Color</label>
            <div className="flex gap-2">
              {EVENT_COLORS.map(c => (
                <button
                  key={c.value}
                  onClick={() => setColor(c.value)}
                  title={c.name}
                  className={`w-7 h-7 rounded-full transition-all ${color === c.value ? 'ring-2 ring-white ring-offset-2 ring-offset-[#131313] scale-110' : 'hover:scale-105'}`}
                  style={{ backgroundColor: c.value }}
                />
              ))}
            </div>
          </div>
        </div>

        <div className="p-5 border-t border-[#424655] flex gap-2">
          {onDelete && (
            <button onClick={() => { onDelete(); onClose(); }} className="px-4 py-2.5 rounded-xl bg-[#93000a]/20 text-[#ffb4ab] border border-[#ffb4ab]/20 text-xs font-bold hover:bg-[#93000a]/30 transition-colors">
              Delete
            </button>
          )}
          <button onClick={onClose} className="flex-1 py-2.5 rounded-xl bg-[#201f1f] text-[#8c90a1] border border-[#424655] text-xs font-bold hover:bg-[#2a2a2a] transition-colors">
            Cancel
          </button>
          <button onClick={handleSave} disabled={!title.trim()} className="flex-1 py-2.5 rounded-xl bg-[#568dff] text-[#002661] text-xs font-bold hover:bg-[#568dff]/90 disabled:opacity-40 transition-colors">
            {event ? 'Save Changes' : 'Create Event'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function CalendarView() {
  const { currentUser } = useAuth();
  const today = new Date();
  const [viewDate, setViewDate] = useState(new Date(today.getFullYear(), today.getMonth(), 1));
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [modalDate, setModalDate] = useState<string | null>(null);
  const [editingEvent, setEditingEvent] = useState<CalendarEvent | null>(null);

  useEffect(() => {
    if (currentUser) setEvents(loadEvents(currentUser.id));
  }, [currentUser?.id]);

  const saveAndSet = (evts: CalendarEvent[]) => {
    setEvents(evts);
    if (currentUser) saveEvents(currentUser.id, evts);
  };

  const handleCreateEvent = (data: Omit<CalendarEvent, 'id' | 'creatorId'>) => {
    const newEvent: CalendarEvent = {
      ...data,
      id: `ev-${Date.now()}`,
      creatorId: currentUser!.id,
    };
    saveAndSet([...events, newEvent]);
  };

  const handleUpdateEvent = (data: Omit<CalendarEvent, 'id' | 'creatorId'>) => {
    if (!editingEvent) return;
    saveAndSet(events.map(e => e.id === editingEvent.id ? { ...e, ...data } : e));
  };

  const handleDeleteEvent = (id: string) => {
    saveAndSet(events.filter(e => e.id !== id));
  };

  const year = viewDate.getFullYear();
  const month = viewDate.getMonth();
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const prevMonthDays = new Date(year, month, 0).getDate();

  // Build 6-row grid
  const cells: { date: Date; isCurrentMonth: boolean }[] = [];
  for (let i = firstDay - 1; i >= 0; i--) {
    cells.push({ date: new Date(year, month - 1, prevMonthDays - i), isCurrentMonth: false });
  }
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({ date: new Date(year, month, d), isCurrentMonth: true });
  }
  while (cells.length < 42) {
    cells.push({ date: new Date(year, month + 1, cells.length - daysInMonth - firstDay + 1), isCurrentMonth: false });
  }

  const getEventsForDate = (date: Date) => {
    const key = formatDate(date);
    return events.filter(e => e.date === key).sort((a, b) => a.startTime.localeCompare(b.startTime));
  };

  const todayStr = formatDate(today);

  // Upcoming events (next 7 days)
  const upcomingEvents = events
    .filter(e => e.date >= todayStr)
    .sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime))
    .slice(0, 5);

  return (
    <div className="flex-1 flex overflow-hidden h-full bg-[#0e0e0e]">
      {/* Modals */}
      {modalDate && !editingEvent && (
        <EventModal
          date={modalDate}
          onSave={handleCreateEvent}
          onClose={() => setModalDate(null)}
        />
      )}
      {editingEvent && (
        <EventModal
          date={editingEvent.date}
          event={editingEvent}
          onSave={handleUpdateEvent}
          onDelete={() => handleDeleteEvent(editingEvent.id)}
          onClose={() => setEditingEvent(null)}
        />
      )}

      {/* Main calendar */}
      <div className="flex-1 flex flex-col p-6 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-4">
            <h1 className="text-xl font-bold text-[#e5e2e1]">{MONTHS[month]} {year}</h1>
            <div className="flex items-center gap-1">
              <button
                onClick={() => setViewDate(new Date(year, month - 1, 1))}
                className="w-8 h-8 flex items-center justify-center rounded-lg text-[#8c90a1] hover:bg-[#201f1f] hover:text-[#e5e2e1] transition-colors"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <button
                onClick={() => setViewDate(new Date(year, month + 1, 1))}
                className="w-8 h-8 flex items-center justify-center rounded-lg text-[#8c90a1] hover:bg-[#201f1f] hover:text-[#e5e2e1] transition-colors"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setViewDate(new Date(today.getFullYear(), today.getMonth(), 1))}
              className="px-3 py-1.5 text-xs font-bold rounded-lg bg-[#201f1f] text-[#b0c6ff] border border-[#424655] hover:bg-[#2a2a2a] transition-colors"
            >
              Today
            </button>
            <button
              onClick={() => setModalDate(todayStr)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-lg bg-[#568dff] text-[#002661] hover:bg-[#568dff]/90 transition-colors"
            >
              <Plus className="w-3.5 h-3.5" /> New Event
            </button>
          </div>
        </div>

        {/* Day headers */}
        <div className="grid grid-cols-7 mb-2">
          {DAYS.map(d => (
            <div key={d} className="text-center text-[11px] font-bold text-[#8c90a1] uppercase tracking-wider py-2">
              {d}
            </div>
          ))}
        </div>

        {/* Day grid */}
        <div className="flex-1 grid grid-cols-7 grid-rows-6 gap-px bg-[#424655]/20 rounded-xl overflow-hidden border border-[#424655]/20">
          {cells.map((cell, i) => {
            const dateStr = formatDate(cell.date);
            const dayEvents = getEventsForDate(cell.date);
            const isToday = dateStr === todayStr;
            const isCurrentMonth = cell.isCurrentMonth;

            return (
              <div
                key={i}
                onClick={() => setModalDate(dateStr)}
                className={`bg-[#0e0e0e] p-2 cursor-pointer hover:bg-[#131313] transition-colors flex flex-col overflow-hidden min-h-0 ${
                  isToday ? 'ring-1 ring-inset ring-[#568dff]' : ''
                }`}
              >
                <div className={`text-xs font-bold mb-1 w-6 h-6 flex items-center justify-center rounded-full flex-shrink-0 ${
                  isToday ? 'bg-[#568dff] text-[#002661]' :
                  isCurrentMonth ? 'text-[#e5e2e1]' : 'text-[#424655]'
                }`}>
                  {cell.date.getDate()}
                </div>
                <div className="flex flex-col gap-0.5 overflow-hidden">
                  {dayEvents.slice(0, 3).map(ev => (
                    <div
                      key={ev.id}
                      onClick={e => { e.stopPropagation(); setEditingEvent(ev); }}
                      className="text-[9px] font-semibold px-1.5 py-0.5 rounded truncate cursor-pointer hover:opacity-80 transition-opacity"
                      style={{ backgroundColor: ev.color + '30', color: ev.color, borderLeft: `2px solid ${ev.color}` }}
                    >
                      {ev.startTime} {ev.title}
                    </div>
                  ))}
                  {dayEvents.length > 3 && (
                    <div className="text-[9px] text-[#8c90a1] font-semibold px-1">+{dayEvents.length - 3} more</div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Right sidebar: upcoming events */}
      <aside className="w-72 flex-shrink-0 border-l border-[#424655] bg-[#131313] flex flex-col overflow-y-auto">
        <div className="p-4 border-b border-[#424655] sticky top-0 bg-[#131313] z-10">
          <h3 className="font-bold text-sm text-[#e5e2e1]">Upcoming Events</h3>
        </div>

        <div className="p-4 flex flex-col gap-3">
          {upcomingEvents.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <div className="w-12 h-12 rounded-2xl bg-[#568dff]/10 flex items-center justify-center mb-3">
                <Plus className="w-6 h-6 text-[#b0c6ff]" />
              </div>
              <p className="text-sm font-semibold text-[#e5e2e1]">No upcoming events</p>
              <p className="text-xs text-[#8c90a1] mt-1">Click any day to add an event</p>
            </div>
          ) : (
            upcomingEvents.map(ev => {
              const evDate = new Date(ev.date + 'T00:00:00');
              const isEvToday = ev.date === todayStr;
              const dayLabel = isEvToday ? 'Today' : evDate.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
              return (
                <div
                  key={ev.id}
                  onClick={() => setEditingEvent(ev)}
                  className="bg-[#0e0e0e] border border-[#424655]/60 rounded-xl p-3 cursor-pointer hover:border-[#424655] transition-colors"
                  style={{ borderLeftColor: ev.color, borderLeftWidth: 3 }}
                >
                  <div className="flex justify-between items-start mb-1">
                    <span className="font-semibold text-xs text-[#e5e2e1] truncate flex-1">{ev.title}</span>
                  </div>
                  <div className="flex items-center gap-1 text-[10px] text-[#8c90a1]">
                    <Clock className="w-3 h-3" />
                    <span>{dayLabel} · {ev.startTime}{ev.endTime ? ` – ${ev.endTime}` : ''}</span>
                  </div>
                  {ev.description && (
                    <p className="text-[10px] text-[#8c90a1] mt-1 truncate">{ev.description}</p>
                  )}
                </div>
              );
            })
          )}
        </div>

        {/* Mini month navigator */}
        <div className="p-4 border-t border-[#424655] mt-auto">
          <p className="text-[10px] text-[#8c90a1] font-bold uppercase tracking-wider mb-3">This Month</p>
          <div className="grid grid-cols-7 gap-0.5">
            {DAYS.map(d => (
              <div key={d} className="text-center text-[9px] font-bold text-[#424655] py-1">{d[0]}</div>
            ))}
            {cells.filter(c => c.isCurrentMonth || cells.indexOf(c) < 7).slice(0, 35).map((cell, i) => {
              const dateStr = formatDate(cell.date);
              const hasEvents = events.some(e => e.date === dateStr);
              const isToday = dateStr === todayStr;
              return (
                <div
                  key={i}
                  onClick={() => { setViewDate(new Date(cell.date.getFullYear(), cell.date.getMonth(), 1)); setModalDate(dateStr); }}
                  className={`text-center text-[9px] py-1 rounded cursor-pointer relative ${
                    isToday ? 'bg-[#568dff] text-[#002661] font-bold' :
                    cell.isCurrentMonth ? 'text-[#8c90a1] hover:bg-[#201f1f]' : 'text-[#424655]'
                  }`}
                >
                  {cell.date.getDate()}
                  {hasEvents && !isToday && <span className="absolute bottom-0.5 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-[#568dff]" />}
                </div>
              );
            })}
          </div>
        </div>
      </aside>
    </div>
  );
}
