import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Search, LayoutDashboard, MessageSquare, Phone, Video, CalendarDays,
  ShieldCheck, HelpCircle, PlusCircle, CalendarPlus, Settings as SettingsIcon,
  CornerDownLeft, ArrowUp, ArrowDown, Users,
} from 'lucide-react';
import { AppView } from '../types';
import { useAuth } from '../context/AuthContext';
import { useChat } from '../context/ChatContext';
import { useMeeting } from '../context/MeetingContext';
import ScheduleMeetingModal from './meeting/ScheduleMeetingModal';
import SettingsModal from './settings/SettingsModal';

interface Props {
  onNavigate: (view: AppView) => void;
  onJoinMeeting: () => void;
}

interface PaletteItem {
  id: string;
  section: 'Go to' | 'Actions' | 'Chats' | 'People';
  label: string;
  subtitle?: string;
  Icon: React.ElementType;
  run: () => void;
  keywords?: string;
}

export default function CommandPalette({ onNavigate, onJoinMeeting }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [showSchedule, setShowSchedule] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const { allUsers } = useAuth();
  const { threads, setActiveThreadId, startDM } = useChat();
  const { createMeeting, clearMeetingError } = useMeeting();

  const close = () => { setOpen(false); setQuery(''); setActiveIndex(0); };

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen(v => !v);
        return;
      }
      if (e.key === 'Escape' && open) close();
    };
    const openHandler = () => setOpen(true);
    window.addEventListener('keydown', handler);
    window.addEventListener('ibconnect:cmdk', openHandler);
    return () => {
      window.removeEventListener('keydown', handler);
      window.removeEventListener('ibconnect:cmdk', openHandler);
    };
  }, [open]);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 10);
  }, [open]);

  const handleStartMeeting = async () => {
    close();
    clearMeetingError();
    try { await createMeeting(); onJoinMeeting(); } catch {}
  };

  const items: PaletteItem[] = useMemo(() => {
    const nav: PaletteItem[] = [
      { id: 'nav-dashboard', section: 'Go to', label: 'Home', subtitle: 'Dashboard', Icon: LayoutDashboard, run: () => { onNavigate('dashboard'); close(); } },
      { id: 'nav-chats', section: 'Go to', label: 'Chats', Icon: MessageSquare, run: () => { onNavigate('chats'); close(); } },
      { id: 'nav-calls', section: 'Go to', label: 'Calls', Icon: Phone, run: () => { onNavigate('calls'); close(); } },
      { id: 'nav-debrief', section: 'Go to', label: 'Meetings', Icon: Video, run: () => { onNavigate('debrief'); close(); } },
      { id: 'nav-calendar', section: 'Go to', label: 'Calendar', Icon: CalendarDays, run: () => { onNavigate('calendar'); close(); } },
      { id: 'nav-security', section: 'Go to', label: 'Security', Icon: ShieldCheck, run: () => { onNavigate('security'); close(); } },
      { id: 'nav-support', section: 'Go to', label: 'Help & Support', Icon: HelpCircle, run: () => { onNavigate('support'); close(); } },
    ];
    const actions: PaletteItem[] = [
      { id: 'act-newchat', section: 'Actions', label: 'New Chat', Icon: PlusCircle, run: () => { onNavigate('chats'); close(); } },
      { id: 'act-meeting', section: 'Actions', label: 'Start Instant Meeting', Icon: Video, run: handleStartMeeting },
      { id: 'act-schedule', section: 'Actions', label: 'Schedule Event', Icon: CalendarPlus, run: () => { setShowSchedule(true); setOpen(false); } },
      { id: 'act-settings', section: 'Actions', label: 'Open Settings', Icon: SettingsIcon, run: () => { setShowSettings(true); setOpen(false); } },
    ];
    const chatItems: PaletteItem[] = threads.map(t => ({
      id: `thread-${t.id}`, section: 'Chats', label: t.name, subtitle: t.lastMessage, Icon: MessageSquare,
      run: () => { setActiveThreadId(t.id); onNavigate('chats'); close(); },
    }));
    const peopleItems: PaletteItem[] = allUsers.slice(0, 20).map(u => ({
      id: `user-${u.id}`, section: 'People', label: u.displayName, subtitle: `@${u.username}`, Icon: Users, keywords: u.username,
      run: () => { startDM(u.id).then(id => { setActiveThreadId(id); onNavigate('chats'); }).catch(() => {}); close(); },
    }));
    return [...nav, ...actions, ...chatItems, ...peopleItems];
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threads, allUsers]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items.filter(i => i.section === 'Go to' || i.section === 'Actions');
    return items.filter(i =>
      i.label.toLowerCase().includes(q) ||
      i.subtitle?.toLowerCase().includes(q) ||
      i.keywords?.toLowerCase().includes(q)
    ).slice(0, 30);
  }, [items, query]);

  useEffect(() => { setActiveIndex(0); }, [query]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIndex(i => Math.min(i + 1, filtered.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIndex(i => Math.max(i - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); filtered[activeIndex]?.run(); }
  };

  let lastSection = '';

  return (
    <>
      {showSchedule && <ScheduleMeetingModal onClose={() => setShowSchedule(false)} />}
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
      {open && (
        <div className="fixed inset-0 z-[100] flex items-start justify-center bg-black/70 backdrop-blur-sm pt-[10vh] px-4" onClick={close}>
          <div className="bg-[#1c1b1b] border border-[#424655] rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden flex flex-col" style={{ maxHeight: '70vh' }} onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-2.5 px-4 py-3.5 border-b border-[#424655]/60">
              <Search className="w-4 h-4 text-[#8c90a1] shrink-0" />
              <input
                ref={inputRef}
                value={query}
                onChange={e => setQuery(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Search or jump to…"
                className="flex-1 bg-transparent border-none outline-none text-sm text-[#e5e2e1] placeholder-[#8c90a1]/60"
              />
              <span className="text-[9px] font-bold text-[#8c90a1] bg-[#0e0e0e] border border-[#424655] rounded px-1.5 py-0.5">ESC</span>
            </div>
            <div className="flex-1 overflow-y-auto py-2">
              {filtered.length === 0 ? (
                <p className="text-xs text-[#8c90a1] text-center py-8">No matches for "{query}"</p>
              ) : filtered.map((item, i) => {
                const showHeader = item.section !== lastSection;
                lastSection = item.section;
                return (
                  <React.Fragment key={item.id}>
                    {showHeader && <div className="px-4 pt-2 pb-1 text-[9px] font-bold uppercase tracking-wider text-[#8c90a1]">{item.section}</div>}
                    <button
                      onClick={item.run}
                      onMouseEnter={() => setActiveIndex(i)}
                      className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors cursor-pointer ${i === activeIndex ? 'bg-[#568dff]/15' : 'hover:bg-[#201f1f]'}`}
                    >
                      <div className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${i === activeIndex ? 'bg-[#568dff]/20 text-[#b0c6ff]' : 'bg-[#201f1f] text-[#8c90a1]'}`}>
                        <item.Icon className="w-3.5 h-3.5" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-semibold text-[#e5e2e1] truncate">{item.label}</p>
                        {item.subtitle && <p className="text-[10px] text-[#8c90a1] truncate">{item.subtitle}</p>}
                      </div>
                      {i === activeIndex && <CornerDownLeft className="w-3 h-3 text-[#8c90a1] shrink-0" />}
                    </button>
                  </React.Fragment>
                );
              })}
            </div>
            <div className="flex items-center gap-3 px-4 py-2 border-t border-[#424655]/60 text-[9px] text-[#8c90a1]">
              <span className="flex items-center gap-1"><ArrowUp className="w-2.5 h-2.5" /><ArrowDown className="w-2.5 h-2.5" />Navigate</span>
              <span className="flex items-center gap-1"><CornerDownLeft className="w-2.5 h-2.5" />Select</span>
              <span className="ml-auto">Esc to close</span>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
