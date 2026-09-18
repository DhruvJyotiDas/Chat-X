import React, { useEffect, useMemo, useState } from 'react';
import {
  MessageSquare, Video, CalendarPlus, CalendarDays, Sparkles,
  Phone, Users, ChevronRight, PlusCircle, Target, AlertTriangle,
  RefreshCw, ArrowRight, WandSparkles, Check, Clock3, ListTodo,
  BellRing, CalendarCheck2, X, TimerReset,
  ThumbsUp, ThumbsDown,
} from 'lucide-react';
import { AppView, ExtractedItem } from '../../types';
import { useAuth } from '../../context/AuthContext';
import { useChat } from '../../context/ChatContext';
import { useMeeting } from '../../context/MeetingContext';
import { api, type AIDailyBrief, type AITaskItem, type AIReminderItem, type AIPAOpportunity } from '../../lib/api';
import { extractIntelligence, ITEM_ICONS, ITEM_COLORS } from '../../lib/intelligence';
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
    <div className="group flex items-center gap-3 rounded-2xl border border-white/[0.07] bg-white/[0.025] p-4 transition hover:-translate-y-0.5 hover:border-white/[0.12] hover:bg-white/[0.04]">
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
      className="group flex min-w-[140px] flex-1 items-center gap-3 rounded-2xl border border-white/[0.07] bg-white/[0.025] p-4 text-left transition-all hover:-translate-y-0.5 hover:border-[#718cff]/35 hover:bg-[#718cff]/[0.055]"
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
  const [brief, setBrief] = useState<AIDailyBrief | null>(null);
  const [briefLoading, setBriefLoading] = useState(false);
  const [briefError, setBriefError] = useState('');
  const [aiTasks, setAITasks] = useState<AITaskItem[]>([]);
  const [aiReminders, setAIReminders] = useState<AIReminderItem[]>([]);
  const [opportunities, setOpportunities] = useState<AIPAOpportunity[]>([]);
  const [opportunityBusy, setOpportunityBusy] = useState('');
  const [opportunityError, setOpportunityError] = useState('');
  const [calendarEventsToday, setCalendarEventsToday] = useState<import('../../lib/api').ApiCalendarEvent[]>([]);

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

  useEffect(() => {
    if (!currentUser) { setCalendarEventsToday([]); return; }
    const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowISO = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`;
    api.getCalendarEvents(today, tomorrowISO).then(events => setCalendarEventsToday(events.filter(event => event.date === today))).catch(() => setCalendarEventsToday([]));
  }, [currentUser?.id, today]);

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

  // Keep the dashboard useful even when the user has not opened Chats. These
  // are already permissioned AI records; loading them here turns extracted
  // commitments into an actionable surface instead of a hidden feature.
  useEffect(() => {
    if (!currentUser) return;
    let cancelled = false;
    Promise.all([api.getAITasks(), api.getAIReminders()]).then(([taskResult, reminderResult]) => {
      if (cancelled) return;
      setAITasks([...(taskResult.owedByMe ?? []), ...(taskResult.owedToMe ?? [])].slice(0, 8));
      setAIReminders((reminderResult.reminders ?? []).slice(0, 6));
    }).catch(() => {
      if (!cancelled) { setAITasks([]); setAIReminders([]); }
    });
    return () => { cancelled = true; };
  }, [currentUser]);

  useEffect(() => {
    if (!currentUser) { setOpportunities([]); return; }
    let cancelled = false;
    const load = () => api.getAIPAOpportunities(12).then(result => {
      if (!cancelled) setOpportunities(result.opportunities ?? []);
    }).catch(() => { if (!cancelled) setOpportunities([]); });
    void load();
    const refresh = () => { void load(); };
    window.addEventListener('ibconnect_aipa_opportunity', refresh);
    window.addEventListener('ibconnect_calendar_changed', refresh);
    return () => {
      cancelled = true;
      window.removeEventListener('ibconnect_aipa_opportunity', refresh);
      window.removeEventListener('ibconnect_calendar_changed', refresh);
    };
  }, [currentUser?.id]);

  const completeTask = (id: string) => {
    setAITasks(previous => previous.filter(task => task.id !== id));
    void api.completeAITask(id).catch(() => api.getAITasks().then(result => setAITasks([...(result.owedByMe ?? []), ...(result.owedToMe ?? [])].slice(0, 8))).catch(() => {}));
  };

  const completeReminder = (id: string) => {
    setAIReminders(previous => previous.filter(reminder => reminder.id !== id));
    void api.completeAIReminder(id).catch(() => api.getAIReminders().then(result => setAIReminders((result.reminders ?? []).slice(0, 6))).catch(() => {}));
  };

  const dismissOpportunity = async (id: string) => {
    setOpportunityBusy(id);
    setOpportunityError('');
    try {
      await api.dismissAIPAOpportunity(id);
      setOpportunities(items => items.filter(item => item.id !== id));
    } catch (error) {
      setOpportunityError(error instanceof Error ? error.message : 'Could not dismiss that suggestion.');
    } finally {
      setOpportunityBusy('');
    }
  };

  const snoozeOpportunity = async (id: string) => {
    setOpportunityBusy(id);
    setOpportunityError('');
    try {
      await api.snoozeAIPAOpportunity(id, 60);
      setOpportunities(items => items.filter(item => item.id !== id));
    } catch (error) {
      setOpportunityError(error instanceof Error ? error.message : 'Could not snooze that suggestion.');
    } finally {
      setOpportunityBusy('');
    }
  };

  const actOnOpportunity = async (opportunity: AIPAOpportunity) => {
    setOpportunityBusy(opportunity.id);
    setOpportunityError('');
    try {
      if (opportunity.confirmationToken) {
        await api.confirmCalendarAction(opportunity.confirmationToken, true);
		window.dispatchEvent(new CustomEvent('ibconnect_calendar_changed'));
	  } else if (opportunity.kind === 'task_proposal' || opportunity.kind === 'reminder_proposal') {
		await api.acceptAIPAOpportunity(opportunity.id);
		const [taskResult, reminderResult] = await Promise.all([api.getAITasks(), api.getAIReminders()]);
		setAITasks([...(taskResult.owedByMe ?? []), ...(taskResult.owedToMe ?? [])].slice(0, 8));
		setAIReminders((reminderResult.reminders ?? []).slice(0, 6));
      } else {
        await api.completeAIPAOpportunity(opportunity.id);
		if ((opportunity.kind === 'reply_needed' || opportunity.kind === 'task_due' || opportunity.kind === 'reminder_due') && opportunity.sourceId) {
		  setActiveThreadId(opportunity.sourceId);
		  onNavigate('chats');
		} else if (opportunity.kind === 'meeting_followup') {
		  sessionStorage.setItem('ibconnect_open_meeting_notes', opportunity.sourceId);
		  onNavigate('debrief');
		} else {
		  onNavigate('calendar');
		}
      }
      setOpportunities(items => items.filter(item => item.id !== opportunity.id));
    } catch (error) {
      setOpportunityError(error instanceof Error ? error.message : 'AIPA could not complete that action.');
    } finally {
      setOpportunityBusy('');
    }
  };

  const feedbackOpportunity = async (id: string, value: 'helpful' | 'not_relevant') => {
	setOpportunities(items => items.map(item => item.id === id ? { ...item, feedback: value } : item));
	try {
	  await api.feedbackAIPAOpportunity(id, value);
	} catch {
	  setOpportunities(items => items.map(item => item.id === id ? { ...item, feedback: undefined } : item));
	}
  };

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

  const generateBrief = async (force = false) => {
    if (briefLoading) return;
    setBriefLoading(true);
    setBriefError('');
    try {
      setBrief(await api.aiDailyBrief(force));
    } catch (error) {
      setBriefError(error instanceof Error ? error.message : 'AIPA could not create your brief right now.');
    } finally {
      setBriefLoading(false);
    }
  };

  // The server caches one permission-scoped brief per user-local day, so this
  // is instant after the first build and never regenerates on every render.
  useEffect(() => {
	if (!currentUser) { setBrief(null); return; }
	void generateBrief(false);
	// eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser?.id]);

  const initials = currentUser
    ? currentUser.displayName.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2)
    : 'IB';

  return (
    <div className="dashboard-surface flex-1 overflow-y-auto p-4 sm:p-6 select-none">
      {showSchedule && <ScheduleMeetingModal onClose={() => setShowSchedule(false)} />}
      <div className="relative z-10 max-w-6xl mx-auto flex flex-col gap-5">
        {/* Header */}
        <div className="relative overflow-hidden rounded-[28px] border border-white/[0.08] bg-gradient-to-br from-[#151925] via-[#101219] to-[#0d0f14] p-5 sm:p-7 shadow-[0_24px_80px_rgba(0,0,0,.22)]">
          <div className="pointer-events-none absolute -right-24 -top-28 h-72 w-72 rounded-full bg-[#6d7fff]/15 blur-3xl" />
          <div className="pointer-events-none absolute -bottom-24 left-1/3 h-48 w-48 rounded-full bg-[#8b5cf6]/10 blur-3xl" />
          <div className="relative flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 rounded-2xl border border-white/10 bg-[#718cff]/15 flex items-center justify-center shrink-0 overflow-hidden shadow-[0_8px_30px_rgba(96,116,255,.18)]">
                {currentUser?.avatar ? <img src={currentUser.avatar} alt="" className="w-full h-full object-cover" /> : <span className="text-sm font-bold text-[#b9c4ff]">{initials}</span>}
              </div>
              <div>
                <div className="mb-1 flex items-center gap-2 text-[10px] font-bold uppercase tracking-[.18em] text-[#778096]"><span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_10px_#34d399]" /> Your workspace</div>
                <h1 className="text-xl sm:text-2xl font-semibold tracking-tight text-white">{greeting()}, {currentUser?.displayName?.split(' ')[0] ?? 'there'}</h1>
                <p className="mt-1 text-xs text-[#8991a4]">{new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</p>
              </div>
            </div>
            <button onClick={() => void generateBrief(true)} disabled={briefLoading} className="group flex items-center justify-center gap-2 rounded-2xl border border-[#8294ff]/30 bg-[#718cff]/15 px-4 py-3 text-xs font-semibold text-[#c6ceff] transition hover:border-[#8294ff]/55 hover:bg-[#718cff]/25 hover:text-white disabled:opacity-60">
              {briefLoading ? <RefreshCw className="h-4 w-4 animate-spin" /> : <WandSparkles className="h-4 w-4 transition-transform group-hover:rotate-12" />}
              {briefLoading ? 'Building your focus…' : brief ? 'Refresh daily focus' : 'Build my daily focus'}
            </button>
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

        {(brief || briefLoading || briefError) && (
          <section className="overflow-hidden rounded-[24px] border border-[#718cff]/20 bg-gradient-to-br from-[#151827] to-[#101117] shadow-[0_20px_70px_rgba(0,0,0,.2)]">
            <div className="flex items-center justify-between border-b border-white/[0.07] px-5 py-4">
              <div className="flex items-center gap-2.5">
                <span className="grid h-8 w-8 place-items-center rounded-xl bg-[#718cff]/15 text-[#aebaff]"><Sparkles className="h-4 w-4" /></span>
                <div><h2 className="text-sm font-semibold text-white">Daily focus</h2><p className="text-[10px] text-[#747d92]">Grounded in your recent IB Connect activity</p></div>
              </div>
              {brief && <span className="rounded-full border border-white/[0.07] bg-white/[0.035] px-2.5 py-1 text-[9px] font-semibold text-[#7f8799]">{brief.sourceCount} sources</span>}
            </div>
            {briefLoading && !brief && (
              <div className="grid gap-3 p-5 sm:grid-cols-3">
                {[0, 1, 2].map(item => <div key={item} className="h-28 animate-pulse rounded-2xl bg-white/[0.045]" />)}
              </div>
            )}
            {briefError && <div className="m-5 rounded-2xl border border-red-400/20 bg-red-400/[0.07] px-4 py-3 text-xs text-red-200">{briefError}</div>}
            {brief?.notice && <div className="mx-5 mt-4 rounded-2xl border border-amber-300/15 bg-amber-300/[0.06] px-4 py-3 text-[11px] leading-5 text-amber-100/80">{brief.notice}</div>}
            {brief && (
              <div className="p-5">
                <div className="mb-5 max-w-3xl"><h3 className="text-lg font-semibold tracking-tight text-white">{brief.headline}</h3><p className="mt-1.5 text-xs leading-5 text-[#969daf]">{brief.summary}</p></div>
                <div className="grid gap-4 lg:grid-cols-3">
                  <div className="rounded-2xl border border-white/[0.07] bg-white/[0.025] p-4">
                    <h4 className="mb-3 flex items-center gap-2 text-[10px] font-bold uppercase tracking-[.14em] text-[#9eabff]"><Target className="h-3.5 w-3.5" /> Priorities</h4>
                    <div className="space-y-3">{brief.priorities.length ? brief.priorities.map((item, index) => <div key={`${item.sourceRef}-${index}`}><p className="text-xs font-semibold leading-5 text-[#e8eaf0]">{item.title}</p><p className="mt-0.5 text-[10px] leading-4 text-[#777f91]">{item.why}</p><span className="mt-1 inline-block font-mono text-[8px] text-[#5f6880]">{item.sourceRef}</span></div>) : <p className="text-[11px] text-[#70788a]">No urgent priorities found.</p>}</div>
                  </div>
                  <div className="rounded-2xl border border-white/[0.07] bg-white/[0.025] p-4">
                    <h4 className="mb-3 flex items-center gap-2 text-[10px] font-bold uppercase tracking-[.14em] text-emerald-300"><ArrowRight className="h-3.5 w-3.5" /> Follow up</h4>
                    <div className="space-y-3">{brief.followUps.length ? brief.followUps.map((item, index) => <div key={`${item.sourceRef}-${index}`}><p className="text-xs font-semibold leading-5 text-[#e8eaf0]">{item.title}</p><p className="mt-0.5 text-[10px] leading-4 text-[#777f91]">{item.why}</p><span className="mt-1 inline-block font-mono text-[8px] text-[#5f6880]">{item.sourceRef}</span></div>) : <p className="text-[11px] text-[#70788a]">No follow-ups found.</p>}</div>
                  </div>
                  <div className="rounded-2xl border border-white/[0.07] bg-white/[0.025] p-4">
                    <h4 className="mb-3 flex items-center gap-2 text-[10px] font-bold uppercase tracking-[.14em] text-amber-300"><AlertTriangle className="h-3.5 w-3.5" /> Watchouts</h4>
                    <div className="space-y-2">{brief.watchouts.length ? brief.watchouts.map((item, index) => <p key={index} className="text-[11px] leading-4 text-[#a7adba]">• {item}</p>) : <p className="text-[11px] text-[#70788a]">Nothing needs attention right now.</p>}</div>
                  </div>
                </div>
              </div>
            )}
          </section>
        )}

        <section className="overflow-hidden rounded-[24px] border border-[#718cff]/15 bg-[linear-gradient(135deg,rgba(113,140,255,.08),rgba(17,19,24,.96)_45%)] shadow-[0_16px_60px_rgba(0,0,0,.16)]">
          <div className="flex items-center justify-between border-b border-white/[0.07] px-5 py-4">
            <div className="flex items-center gap-2.5">
              <span className="grid h-8 w-8 place-items-center rounded-xl bg-[#718cff]/15 text-[#aebaff]"><BellRing className="h-4 w-4" /></span>
              <div><h2 className="text-sm font-semibold text-white">AIPA now</h2><p className="text-[10px] text-[#7f899d]">Timely suggestions; nothing changes without your confirmation</p></div>
            </div>
            {opportunities.length > 0 && <span className="rounded-full border border-[#718cff]/20 bg-[#718cff]/10 px-2.5 py-1 text-[9px] font-semibold text-[#b9c4ff]">{opportunities.length} ready</span>}
          </div>
          {opportunityError && <p className="mx-4 mt-4 rounded-xl border border-red-300/15 bg-red-300/[0.06] px-3 py-2 text-[10px] text-red-200">{opportunityError}</p>}
          {opportunities.length === 0 ? (
            <div className="flex items-center gap-3 px-5 py-6 text-xs text-[#777f91]"><Check className="h-4 w-4 text-[#91a5ff]" />Nothing needs your attention right now.</div>
          ) : (
            <div className="grid gap-3 p-4 md:grid-cols-2">
              {opportunities.slice(0, 6).map(opportunity => {
                const proposed = opportunity.proposedAction;
                const isBusy = opportunityBusy === opportunity.id;
                return <article key={opportunity.id} className="rounded-2xl border border-white/[0.07] bg-black/15 p-4">
                  <div className="flex items-start gap-3">
                    <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-[#718cff]/10 text-[#aebaff]">{opportunity.kind === 'meeting_prep' || opportunity.kind === 'calendar_invitation' ? <CalendarCheck2 className="h-4 w-4" /> : <Sparkles className="h-4 w-4" />}</span>
                    <div className="min-w-0 flex-1"><h3 className="text-xs font-semibold text-white">{opportunity.title}</h3><p className="mt-1 text-[10px] leading-4 text-[#929bad]">{opportunity.summary}</p></div>
                  </div>
                  {proposed && <div className="mt-3 rounded-xl border border-white/[0.06] bg-white/[0.025] px-3 py-2 text-[9px] text-[#8f99ac]"><span className="font-semibold capitalize text-[#cbd2df]">{proposed.action}</span> · {proposed.date} · {proposed.startTime}–{proposed.endTime}{proposed.warning && <p className="mt-1.5 text-amber-200/75">{proposed.warning}</p>}</div>}
                  <div className="mt-3 flex flex-wrap gap-2">
                    {opportunity.actionLabel && <button disabled={isBusy} onClick={() => void actOnOpportunity(opportunity)} className="rounded-lg bg-[#3978ff] px-3 py-1.5 text-[9px] font-semibold text-white disabled:opacity-50">{isBusy ? 'Working…' : opportunity.actionLabel}</button>}
                    <button disabled={isBusy} onClick={() => void snoozeOpportunity(opportunity.id)} className="flex items-center gap-1 rounded-lg border border-white/[0.08] px-2.5 py-1.5 text-[9px] font-semibold text-[#aab3c3] disabled:opacity-50"><TimerReset className="h-3 w-3" />1 hour</button>
					<button onClick={() => void feedbackOpportunity(opportunity.id, 'helpful')} className={`ml-auto grid h-7 w-7 place-items-center rounded-lg ${opportunity.feedback === 'helpful' ? 'bg-emerald-300/15 text-emerald-200' : 'text-[#657085] hover:bg-white/[0.04] hover:text-white'}`} title="Useful suggestion" aria-label="Mark suggestion useful"><ThumbsUp className="h-3 w-3" /></button>
					<button onClick={() => void feedbackOpportunity(opportunity.id, 'not_relevant')} className={`grid h-7 w-7 place-items-center rounded-lg ${opportunity.feedback === 'not_relevant' ? 'bg-amber-300/15 text-amber-200' : 'text-[#657085] hover:bg-white/[0.04] hover:text-white'}`} title="Not relevant" aria-label="Mark suggestion not relevant"><ThumbsDown className="h-3 w-3" /></button>
                    <button disabled={isBusy} onClick={() => void dismissOpportunity(opportunity.id)} className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-[9px] text-[#737e91] hover:bg-white/[0.04] hover:text-white disabled:opacity-50"><X className="h-3 w-3" />Dismiss</button>
                  </div>
                </article>;
              })}
            </div>
          )}
        </section>

        <section className="overflow-hidden rounded-[24px] border border-white/[0.07] bg-[#111318] shadow-[0_16px_60px_rgba(0,0,0,.16)]">
          <div className="flex items-center justify-between border-b border-white/[0.07] px-5 py-4">
            <div className="flex items-center gap-2.5">
              <span className="grid h-8 w-8 place-items-center rounded-xl bg-emerald-400/10 text-emerald-300"><ListTodo className="h-4 w-4" /></span>
              <div><h2 className="text-sm font-semibold text-white">AI inbox</h2><p className="text-[10px] text-[#747d92]">Commitments and reminders AIPA found in your conversations</p></div>
            </div>
            {(aiTasks.length + aiReminders.length) > 0 && <span className="rounded-full border border-emerald-300/15 bg-emerald-300/[0.06] px-2.5 py-1 text-[9px] font-semibold text-emerald-200">{aiTasks.length + aiReminders.length} open</span>}
          </div>
          {aiTasks.length === 0 && aiReminders.length === 0 ? (
            <div className="flex items-center gap-3 px-5 py-6 text-xs text-[#777f91]"><Check className="h-4 w-4 text-emerald-300" />No open AI tasks or reminders yet. Analyze a conversation to extract them.</div>
          ) : (
            <div className="grid gap-3 p-4 md:grid-cols-2">
              {aiTasks.map(task => <div key={task.id} className="flex items-start gap-3 rounded-2xl border border-white/[0.06] bg-white/[0.025] p-3"><button onClick={() => completeTask(task.id)} className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full border border-[#697593] text-transparent transition hover:border-emerald-300 hover:bg-emerald-300/10 hover:text-emerald-300" title="Complete task" aria-label={`Complete ${task.description}`}><Check className="h-3 w-3" /></button><div className="min-w-0"><p className="text-xs font-medium leading-5 text-[#e6e8ef]">{task.description}</p><p className="mt-1 flex items-center gap-1 text-[9px] text-[#747d92]"><Clock3 className="h-3 w-3" />AI task</p></div></div>)}
              {aiReminders.map(reminder => <div key={reminder.id} className="flex items-start gap-3 rounded-2xl border border-white/[0.06] bg-white/[0.025] p-3"><button onClick={() => completeReminder(reminder.id)} className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full border border-[#697593] text-transparent transition hover:border-emerald-300 hover:bg-emerald-300/10 hover:text-emerald-300" title="Dismiss reminder" aria-label={`Dismiss ${reminder.text}`}><Check className="h-3 w-3" /></button><div className="min-w-0"><p className="text-xs font-medium leading-5 text-[#e6e8ef]">{reminder.text}</p><p className="mt-1 flex items-center gap-1 text-[9px] text-[#747d92]"><Clock3 className="h-3 w-3" />Reminder</p></div></div>)}
            </div>
          )}
        </section>

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
