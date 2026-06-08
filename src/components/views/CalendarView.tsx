 import React, { useState, useEffect } from 'react';
import { ChevronLeft, ChevronRight, Plus, X, Clock, AlignLeft, Video } from 'lucide-react';
import { CalendarEvent } from '../../types';
import { useAuth } from '../../context/AuthContext';
import { useMeeting } from '../../context/MeetingContext';

const EVENT_COLORS = [{ name: 'Blue', value: '#568dff' }, { name: 'Green', value: '#4dffb1' }, { name: 'Purple', value: '#c0c1ff' }, { name: 'Orange', value: '#ffb4ab' }, { name: 'Yellow', value: '#ffd60a' }];
const DAYS_SHORT = ['S', 'M', 'T', 'W', 'T', 'F', 'S']; const DAYS_FULL = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']; const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function formatDate(date: Date): string { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; }
function fmtScheduledDate(dateStr: string, timeStr: string): string { try { const d = new Date(`${dateStr}T${timeStr}`); return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) + ' · ' + d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }); } catch { return `${dateStr} ${timeStr}`; } }

export default function CalendarView() {
  const { currentUser } = useAuth();
  const { scheduledMeetings, deleteScheduledMeeting } = useMeeting();
  const today = new Date();
  const todayStr = formatDate(today);

  const [viewDate, setViewDate] = useState(new Date(today.getFullYear(), today.getMonth(), 1));
  const [events, setEvents] = useState<CalendarEvent[]>([]); // Future: replace with api.getEvents()
  const [modalDate, setModalDate] = useState<string | null>(null);
  const [mobileTab, setMobileTab] = useState<'calendar' | 'upcoming'>('calendar');

  const meetingEvents: CalendarEvent[] = scheduledMeetings.map(sm => ({
    id: `sched-${sm.code}-${sm.id}`, creatorId: currentUser?.id ?? '', title: sm.title || sm.code, date: sm.date, startTime: sm.time, endTime: sm.time, description: `Meeting code: ${sm.code}`, color: '#b0c6ff',
  }));

  const allEvents = [...events, ...meetingEvents];

  const year = viewDate.getFullYear(); const month = viewDate.getMonth(); const firstDay = new Date(year, month, 1).getDay(); const daysInMonth = new Date(year, month + 1, 0).getDate(); const prevMonthDays = new Date(year, month, 0).getDate();
  const cells: { date: Date; isCurrentMonth: boolean }[] = [];
  for (let i = firstDay - 1; i >= 0; i--) cells.push({ date: new Date(year, month - 1, prevMonthDays - i), isCurrentMonth: false });
  for (let d = 1; d <= daysInMonth; d++) cells.push({ date: new Date(year, month, d), isCurrentMonth: true });
  while (cells.length < 42) cells.push({ date: new Date(year, month + 1, cells.length - daysInMonth - firstDay + 1), isCurrentMonth: false });

  const getEventsForDate = (date: Date) => allEvents.filter(e => e.date === formatDate(date)).sort((a, b) => a.startTime.localeCompare(b.startTime));
  const upcomingEvents = allEvents.filter(e => e.date >= todayStr).sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime)).slice(0, 10);

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
      </div>
    </div>
  );

  return (
    <div className="flex-1 flex flex-col overflow-hidden h-full bg-[#0e0e0e]">
      <div className="lg:hidden flex border-b border-[#424655] bg-[#131313] shrink-0">
        {(['calendar', 'upcoming'] as const).map(tab => (
          <button key={tab} onClick={() => setMobileTab(tab)} className={`flex-1 py-3 text-xs font-bold capitalize transition-colors border-b-2 ${mobileTab === tab ? 'border-[#568dff] text-[#b0c6ff]' : 'border-transparent text-[#8c90a1]'}`}>{tab === 'upcoming' ? 'Upcoming & Meetings' : 'Calendar'}</button>
        ))}
      </div>
      <div className="flex-1 flex overflow-hidden min-h-0">
        <div className={`flex-1 flex flex-col min-h-0 min-w-0 ${mobileTab !== 'calendar' ? 'hidden lg:flex' : 'flex'}`}>
          <div className="flex-1 flex flex-col min-h-0 p-3 sm:p-6">
            <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
              <div className="flex items-center gap-2 sm:gap-4"><h1 className="text-base sm:text-xl font-bold text-[#e5e2e1]">{MONTHS[month]} {year}</h1><div className="flex items-center gap-1"><button onClick={() => setViewDate(new Date(year, month - 1, 1))} className="w-7 h-7 sm:w-8 sm:h-8 flex items-center justify-center rounded-lg text-[#8c90a1] hover:bg-[#201f1f] hover:text-[#e5e2e1] transition-colors"><ChevronLeft className="w-3.5 h-3.5 sm:w-4 sm:h-4" /></button><button onClick={() => setViewDate(new Date(year, month + 1, 1))} className="w-7 h-7 sm:w-8 sm:h-8 flex items-center justify-center rounded-lg text-[#8c90a1] hover:bg-[#201f1f] hover:text-[#e5e2e1] transition-colors"><ChevronRight className="w-3.5 h-3.5 sm:w-4 sm:h-4" /></button></div></div>
              <button onClick={() => setViewDate(new Date(today.getFullYear(), today.getMonth(), 1))} className="px-2.5 py-1.5 text-[10px] sm:text-xs font-bold rounded-lg bg-[#201f1f] text-[#b0c6ff] border border-[#424655] hover:bg-[#2a2a2a]">Today</button>
            </div>
            <div className="grid grid-cols-7 mb-1 sm:mb-2">{(window.innerWidth < 400 ? DAYS_SHORT : DAYS_FULL).map((d, i) => (<div key={i} className="text-center text-[9px] sm:text-[11px] font-bold text-[#8c90a1] uppercase tracking-wider py-1 sm:py-2">{d}</div>))}</div>
            
            {/* 3. MOBILE FIX: Aspect Square grid keeps cells perfectly uniform instead of vertical rectangles */}
            <div className="flex-1 grid grid-cols-7 gap-px bg-[#424655]/20 rounded-xl overflow-y-auto border border-[#424655]/20 content-start">
              {cells.map((cell, i) => {
                const dateStr = formatDate(cell.date); const dayEvts = getEventsForDate(cell.date); const isToday = dateStr === todayStr; const isCurMon = cell.isCurrentMonth;
                return (
                  <div key={i} className={`bg-[#0e0e0e] aspect-square sm:aspect-auto p-1 sm:p-2 hover:bg-[#131313] transition-colors flex flex-col items-center sm:items-start ${isToday ? 'ring-1 ring-inset ring-[#568dff]' : ''}`}>
                    <div className={`text-[10px] sm:text-xs font-bold mb-1 w-5 h-5 flex items-center justify-center rounded-full shrink-0 ${isToday ? 'bg-[#568dff] text-[#002661]' : isCurMon ? 'text-[#e5e2e1]' : 'text-[#424655]'}`}>{cell.date.getDate()}</div>
                    {/* Mobile: Dots only to save space */}
                    <div className="flex sm:hidden gap-1 flex-wrap justify-center mt-1">
                      {dayEvts.slice(0, 3).map(ev => (<span key={ev.id} className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: ev.color }} />))}
                    </div>
                    {/* Desktop: Full pills */}
                    <div className="hidden sm:flex flex-col gap-0.5 w-full">
                      {dayEvts.slice(0, 2).map(ev => (<div key={ev.id} className="text-[9px] font-semibold px-1.5 py-0.5 rounded truncate" style={{ backgroundColor: ev.color + '30', color: ev.color, borderLeft: `2px solid ${ev.color}` }}>{ev.startTime} {ev.title}</div>))}
                      {dayEvts.length > 2 && <div className="text-[9px] text-[#8c90a1] font-semibold px-1">+{dayEvts.length - 2}</div>}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
        <aside className={`lg:w-72 lg:flex-shrink-0 lg:border-l lg:border-[#424655] lg:bg-[#131313] ${mobileTab === 'upcoming' ? 'block' : 'hidden lg:block'}`}>
          <UpcomingPanel />
        </aside>
      </div>
    </div>
  );
}
