import React, { useState } from 'react';
import { Search, Bell, HelpCircle, Plus, Sparkles, Phone, Calendar } from 'lucide-react';
import { AppView } from '../../types';

interface TopBarProps {
  currentView: AppView;
  onViewChange: (view: AppView) => void;
  searchFilter: string;
  onSearchChange: (val: string) => void;
  onNewChatClicked?: () => void;
}

const VIEW_INFO: Record<AppView, { title: string; subtitle: string; badge: string }> = {
  chats: { title: 'IB Connect', subtitle: 'Secure Messaging', badge: 'E2E ENCRYPTED' },
  calls: { title: 'Calls', subtitle: 'Video & Audio Calls', badge: 'WEBRTC' },
  debrief: { title: 'Meeting Debrief', subtitle: 'Sync Recap & Action Items', badge: 'SYNC ARCHIVE' },
  active_meeting: { title: 'Active Call', subtitle: 'Secured Enclave Workspace', badge: 'LIVE CALL' },
  calendar: { title: 'Calendar', subtitle: 'Schedule & Events', badge: 'PERSONAL' },
  security: { title: 'Security & Compliance', subtitle: 'Operational Integrity Console', badge: 'AES-256' },
  support: { title: 'Help & Support', subtitle: 'Intelligence Knowledge Center', badge: 'DEDICATED' },
};

export default function TopBar({ currentView, onViewChange, searchFilter, onSearchChange, onNewChatClicked }: TopBarProps) {
  const [notifOpen, setNotifOpen] = useState(false);
  const info = VIEW_INFO[currentView] || VIEW_INFO.chats;

  const actionLabel = currentView === 'calls' ? 'New Call' : currentView === 'calendar' ? 'New Event' : 'New Chat';

  const handleAction = () => {
    if (currentView === 'calls') { onViewChange('calls'); return; }
    if (currentView === 'calendar') { /* CalendarView handles internally */ return; }
    onNewChatClicked?.();
  };

  return (
    <header className="h-14 w-full flex justify-between items-center px-5 border-b border-[#424655] bg-[#131313]/90 backdrop-blur-xl z-40 sticky top-0 shrink-0 select-none">
      <div className="flex items-center gap-3 min-w-0">
        <h1
          className="font-bold text-base tracking-tight text-[#e5e2e1] cursor-pointer whitespace-nowrap"
          onClick={() => onViewChange('chats')}
        >
          {info.title}
        </h1>
        <div className="h-3.5 w-px bg-[#424655] hidden sm:block" />
        <div className="hidden sm:flex items-center gap-1.5 text-xs text-[#c2c6d8] bg-[#201f1f] px-2.5 py-1 rounded-lg border border-[#424655]/40">
          <Sparkles className="w-3 h-3 text-[#b0c6ff]" />
          <span className="truncate max-w-[180px]">{info.subtitle}</span>
        </div>
        <span className="hidden lg:inline-block bg-[#00e598]/10 text-[#70ffba] border border-[#00e296]/30 text-[9px] font-bold tracking-wider px-2 py-0.5 rounded uppercase whitespace-nowrap">
          {info.badge}
        </span>
      </div>

      <div className="flex items-center gap-2 flex-shrink-0">
        <div className="relative hidden sm:flex items-center bg-[#1c1b1b] rounded-lg border border-[#424655]/60 w-44 hover:border-[#b0c6ff]/60 focus-within:border-[#568dff] focus-within:ring-1 focus-within:ring-[#568dff]/50 transition-all">
          <Search className="w-3.5 h-3.5 text-[#8c90a1] absolute left-2.5" />
          <input
            type="text"
            className="bg-transparent border-none focus:ring-0 text-xs text-[#e5e2e1] pl-8 pr-3 py-2 w-full outline-none placeholder:text-[#8c90a1]/60"
            placeholder={currentView === 'support' ? 'Search FAQs...' : 'Search...'}
            value={searchFilter}
            onChange={e => onSearchChange(e.target.value)}
          />
        </div>

        {currentView !== 'active_meeting' && (
          <button
            onClick={handleAction}
            className="flex items-center gap-1.5 bg-[#568dff] text-[#002661] font-bold text-xs py-2 px-3 rounded-lg hover:bg-[#568dff]/90 active:scale-95 transition-all shadow-sm"
          >
            <Plus className="w-3.5 h-3.5 stroke-[2.5]" />
            <span className="hidden sm:inline">{actionLabel}</span>
          </button>
        )}

        <div className="h-5 w-px bg-[#424655]" />

        <button
          onClick={() => setNotifOpen(v => !v)}
          className="w-8 h-8 flex items-center justify-center rounded-lg text-[#8c90a1] hover:bg-[#201f1f] hover:text-[#b0c6ff] transition-colors relative"
        >
          <Bell className="w-4 h-4" />
          <span className="absolute top-1.5 right-1.5 w-1.5 h-1.5 rounded-full bg-[#ffb4ab]" />
        </button>

        <button
          onClick={() => onViewChange('support')}
          className="w-8 h-8 flex items-center justify-center rounded-lg text-[#8c90a1] hover:bg-[#201f1f] hover:text-[#b0c6ff] transition-colors"
          title="Help"
        >
          <HelpCircle className="w-4 h-4" />
        </button>
      </div>
    </header>
  );
}
