import React, { useEffect, useMemo, useState } from 'react';
import {
  MessageSquare, Video, CalendarPlus, CalendarDays, Sparkles,
  Phone, Users, ChevronRight, PlusCircle,
} from 'lucide-react';
import { AppView, ExtractedItem } from '../../types';
import { useAuth } from '../../context/AuthContext';
import { useChat } from '../../context/ChatContext';
import { useMeeting } from '../../context/MeetingContext';
import { api } from '../../lib/api';
import { extractIntelligence, ITEM_ICONS, ITEM_COLORS } from '../../lib/intelligence';
import { loadCalendarEvents } from '../../lib/calendarLocal';
import { loadCalls } from '../../lib/callsLocal';
import ScheduleMeetingModal from '../meeting/ScheduleMeetingModal';

interface Props {
  onNavigate: (view: AppView) => void;
  onJoinMeeting: () => void;
}

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return 'Burning the midnight oil';
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

function StatTile({ icon: Icon, label, value, tint }: { icon: React.ElementType; label: string; value: number | string; tint: string }) {
  return (
    <div className="bg-[#1c1b1b] border border-[#424655] rounded-2xl p-4 flex items-center gap-3">
      <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${tint}`}>
        <Icon className="w-5 h-5" />
      </div>
      <div className="min-w-0">
        <p className="text-lg font-bold text-[#e5e2e1] leading-tight">{value}</p>
        <p className="text-[10px] text-[#8c90a1] font-semibold uppercase tracking-wider truncate">{label}</p>
      </div>
    </div>
  );
}

function QuickAction({ icon: Icon, label, onClick, tint }: { icon: React.ElementType; label: string; onClick: () => void; tint: string }) {
  return (
    <button
      onClick={onClick}
      className="flex-1 min-w-[140px] flex items-center gap-3 bg-[#1c1b1b] border border-[#424655] hover:border-[#568dff]/60 rounded-2xl p-4 transition-all hover:bg-[#1c1b1b]/80 text-left cursor-pointer group"
    >
      <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${tint}`}>
        <Icon className="w-5 h-5" />
      </div>
      <span className="text-xs font-bold text-[#e5e2e1]">{label}</span>
      <ChevronRight className="w-4 h-4 text-[#8c90a1] ml-auto group-hover:translate-x-0.5 transition-transform" />
    </button>
  );
}

interface ActivityEntry { id: string; kind: 'chat' | 'meeting'; title: string; subtitle: string; timestamp: number; onClick: () => void; }

export default function DashboardView({ onNavigate, onJoinMeeting }: Props) {
  const { currentUser, allUsers } = useAuth();
  const { threads, setActiveThreadId } = useChat();
  const { scheduledMeetings, createMeeting, meetingError, clearMeetingError } = useMeeting();

  const [isStarting, setIsStarting] = useState(false);
  const [showSchedule, setShowSchedule] = useState(false);
  const [actionItems, setActionItems] = useState<ExtractedItem[]>([]);

  const today = todayStr();

  const unreadCount = useMemo(() => threads.reduce((sum, t) => sum + (t.unreadCount ?? 0), 0), [threads]);

  const upcomingMeetings = useMemo(
    () => [...scheduledMeetings].filter(m => m.date >= today).sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time)),
    [scheduledMeetings, today],
  );

  const callsThisWeek = useMemo(() => {
    if (!currentUser) return 0;
    const weekAgo = Date.now() - 7 * 86400000;
    return loadCalls(currentUser.id).filter(c => c.timestamp >= weekAgo).length;
  }, [currentUser]);

  const calendarEventsToday = useMemo(() => {
    if (!currentUser) return [];
    return loadCalendarEvents(currentUser.id).filter(e => e.date === today);
  }, [currentUser, today]);

  const onlineCount = useMemo(() => allUsers.filter(u => u.status === 'online').length, [allUsers]);

  // Best-effort AI action-item scan across the most recently active threads.
  useEffect(() => {
    let cancelled = false;
    const topThreads = [...threads].sort((a, b) => b.lastTimestamp - a.lastTimestamp).slice(0, 5);
    if (topThreads.length === 0) { setActionItems([]); return; }
    Promise.all(topThreads.map(t => api.getMessages(t.id).catch(() => [])))
      .then(results => {
        if (cancelled) return;
        const all = results.flat().map(m => ({
          id: m.id, threadId: m.threadId, senderId: m.senderId, senderName: m.senderName,
          senderAvatar: m.senderAvatar, text: m.text, time: m.time, timestamp: m.timestamp,
          fileAttachment: m.fileAttachment,
        }));
        setActionItems(extractIntelligence(all));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [threads]);

  const activity: ActivityEntry[] = useMemo(() => {
    const chatEntries: ActivityEntry[] = threads
      .filter(t => t.lastTimestamp)
      .map(t => ({
        id: `chat-${t.id}`, kind: 'chat', title: t.name,
        subtitle: t.lastMessage || 'Started a conversation',
        timestamp: t.lastTimestamp,
        onClick: () => { setActiveThreadId(t.id); onNavigate('chats'); },
      }));
    const meetingEntries: ActivityEntry[] = scheduledMeetings.map(m => ({
      id: `meeting-${m.id}`, kind: 'meeting', title: m.title || m.code,
      subtitle: `Scheduled for ${new Date(`${m.date}T${m.time}`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} · ${m.time}`,
      timestamp: new Date(`${m.date}T${m.time}`).getTime() || 0,
      onClick: () => onNavigate('debrief'),
    }));
    return [...chatEntries, ...meetingEntries].sort((a, b) => b.timestamp - a.timestamp).slice(0, 8);
  }, [threads, scheduledMeetings, onNavigate, setActiveThreadId]);

  const handleStartMeeting = async () => {
    setIsStarting(true);
    clearMeetingError();
    try { await createMeeting(); onJoinMeeting(); } catch {} finally { setIsStarting(false); }
  };

  const initials = currentUser
    ? currentUser.displayName.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2)
    : 'IB';

  return (
    <div className="flex-1 overflow-y-auto p-4 sm:p-6 select-none">
      {showSchedule && <ScheduleMeetingModal onClose={() => setShowSchedule(false)} />}
      <div className="max-w-5xl mx-auto flex flex-col gap-5">
        {/* Header */}
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-full bg-[#568dff]/15 flex items-center justify-center shrink-0 overflow-hidden">
            {currentUser?.avatar ? <img src={currentUser.avatar} className="w-full h-full object-cover" /> : <span className="text-sm font-bold text-[#b0c6ff]">{initials}</span>}
          </div>
          <div>
            <h1 className="text-lg sm:text-xl font-bold text-[#e5e2e1]">{greeting()}, {currentUser?.displayName?.split(' ')[0] ?? 'there'}</h1>
            <p className="text-xs text-[#8c90a1]">{new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</p>
          </div>
        </div>

        {meetingError && <p className="text-xs text-[#ffb4ab] bg-[#93000a]/20 border border-[#ffb4ab]/30 rounded-xl px-3 py-2">{meetingError}</p>}

        {/* Quick actions */}
        <div className="flex flex-wrap gap-3">
          <QuickAction icon={PlusCircle} label="New Chat" tint="bg-[#568dff]/10 text-[#b0c6ff]" onClick={() => onNavigate('chats')} />
          <QuickAction icon={Video} label={isStarting ? 'Starting…' : 'Start Meeting'} tint="bg-[#4dffb1]/10 text-[#4dffb1]" onClick={handleStartMeeting} />
          <QuickAction icon={CalendarPlus} label="Schedule Event" tint="bg-[#c0c1ff]/10 text-[#c0c1ff]" onClick={() => setShowSchedule(true)} />
          <QuickAction icon={CalendarDays} label="Open Calendar" tint="bg-[#ffd60a]/10 text-[#ffd60a]" onClick={() => onNavigate('calendar')} />
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <StatTile icon={MessageSquare} label="Unread Messages" value={unreadCount} tint="bg-[#568dff]/10 text-[#b0c6ff]" />
          <StatTile icon={CalendarDays} label="Upcoming Meetings" value={upcomingMeetings.length} tint="bg-[#c0c1ff]/10 text-[#c0c1ff]" />
          <StatTile icon={Phone} label="Calls This Week" value={callsThisWeek} tint="bg-[#4dffb1]/10 text-[#4dffb1]" />
          <StatTile icon={Sparkles} label="AI Items Detected" value={actionItems.length} tint="bg-[#ffd60a]/10 text-[#ffd60a]" />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Today at a glance */}
          <div className="bg-[#1c1b1b] border border-[#424655] rounded-2xl p-4 sm:p-5">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold text-sm text-[#e5e2e1] flex items-center gap-2"><CalendarDays className="w-4 h-4 text-[#b0c6ff]" />Today at a Glance</h3>
              <span className="text-[10px] bg-[#568dff]/10 text-[#b0c6ff] px-2 py-0.5 rounded-full font-bold">{onlineCount} online</span>
            </div>
            {upcomingMeetings.filter(m => m.date === today).length === 0 && calendarEventsToday.length === 0 ? (
              <div className="text-center py-6">
                <CalendarDays className="w-7 h-7 text-[#424655] mx-auto mb-2" />
                <p className="text-xs text-[#8c90a1]">Nothing scheduled for today</p>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {upcomingMeetings.filter(m => m.date === today).map(m => (
                  <div key={m.id} onClick={() => onNavigate('debrief')} className="flex items-center gap-2.5 p-2.5 rounded-xl bg-[#201f1f] hover:bg-[#2a2a2a] cursor-pointer transition-colors">
                    <div className="w-8 h-8 rounded-lg bg-[#568dff]/10 flex items-center justify-center shrink-0"><Video className="w-4 h-4 text-[#b0c6ff]" /></div>
                    <div className="min-w-0"><p className="text-xs font-semibold text-[#e5e2e1] truncate">{m.title || m.code}</p><p className="text-[10px] text-[#8c90a1]">{m.time}</p></div>
                  </div>
                ))}
                {calendarEventsToday.map(e => (
                  <div key={e.id} onClick={() => onNavigate('calendar')} className="flex items-center gap-2.5 p-2.5 rounded-xl bg-[#201f1f] hover:bg-[#2a2a2a] cursor-pointer transition-colors">
                    <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: e.color }} />
                    <div className="min-w-0"><p className="text-xs font-semibold text-[#e5e2e1] truncate">{e.title}</p><p className="text-[10px] text-[#8c90a1]">{e.startTime}</p></div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* AI highlights */}
          <div className="bg-[#1c1b1b] border border-[#424655] rounded-2xl p-4 sm:p-5">
            <div className="flex items-center gap-2 mb-3">
              <Sparkles className="w-4 h-4 text-[#c0c1ff]" />
              <h3 className="font-semibold text-sm text-[#e5e2e1]">AI Highlights</h3>
            </div>
            {actionItems.length === 0 ? (
              <div className="text-center py-6">
                <Sparkles className="w-7 h-7 text-[#424655] mx-auto mb-2" />
                <p className="text-xs text-[#8c90a1]">No action items detected in recent chats yet</p>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {actionItems.slice(0, 5).map(item => (
                  <div key={item.id} className={`border rounded-xl p-2.5 text-[10px] leading-relaxed ${ITEM_COLORS[item.type]}`}>
                    <div className="flex items-start gap-1.5">
                      <span className="mt-0.5">{ITEM_ICONS[item.type]}</span>
                      <span>{item.text}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Recent activity */}
        <div className="bg-[#1c1b1b] border border-[#424655] rounded-2xl p-4 sm:p-5">
          <h3 className="font-semibold text-sm text-[#e5e2e1] mb-3 flex items-center gap-2"><Users className="w-4 h-4 text-[#b0c6ff]" />Recent Activity</h3>
          {activity.length === 0 ? (
            <div className="text-center py-8">
              <MessageSquare className="w-8 h-8 text-[#424655] mx-auto mb-2" />
              <p className="text-xs text-[#8c90a1]">No activity yet — start a chat or schedule a meeting</p>
            </div>
          ) : (
            <div className="flex flex-col gap-1">
              {activity.map(entry => (
                <div key={entry.id} onClick={entry.onClick} className="flex items-center gap-3 p-2.5 rounded-xl hover:bg-[#201f1f] cursor-pointer transition-colors">
                  <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${entry.kind === 'chat' ? 'bg-[#568dff]/10 text-[#b0c6ff]' : 'bg-[#c0c1ff]/10 text-[#c0c1ff]'}`}>
                    {entry.kind === 'chat' ? <MessageSquare className="w-4 h-4" /> : <Video className="w-4 h-4" />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-semibold text-[#e5e2e1] truncate">{entry.title}</p>
                    <p className="text-[10px] text-[#8c90a1] truncate">{entry.subtitle}</p>
                  </div>
                  <ChevronRight className="w-3.5 h-3.5 text-[#8c90a1] shrink-0" />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
