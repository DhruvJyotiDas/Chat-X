import React, { useState } from 'react';
import { Search, Bell, HelpCircle, Shield, Radio, Sparkles, MessageSquare, Plus } from 'lucide-react';
import { AppView } from '../types';

interface TopBarProps {
  currentView: AppView;
  onViewChange: (view: AppView) => void;
  searchFilter: string;
  onSearchChange: (val: string) => void;
  onNewChatClicked?: () => void;
  isRecording?: boolean;
}

export default function TopBar({
  currentView,
  onViewChange,
  searchFilter,
  onSearchChange,
  onNewChatClicked,
  isRecording = true
}: TopBarProps) {
  const [notificationOpen, setNotificationOpen] = useState(false);

  const getHeaderInfo = () => {
    switch (currentView) {
      case 'chats':
        return {
          title: 'IB Connect',
          subtitle: 'Q3 Product Strategy Sync',
          badge: 'ACTIVE ROOM'
        };
      case 'debrief':
        return {
          title: 'Meeting Debrief',
          subtitle: 'Q3 Product Strategy Sync Recap',
          badge: 'SYNC ARCHIVE'
        };
      case 'active_meeting':
        return {
          title: 'Active Video Sync',
          subtitle: 'Secured Enclave Workspace',
          badge: 'LIVE CALL'
        };
      case 'security':
        return {
          title: 'Compliance & Security Hub',
          subtitle: 'Operational Integrity Console',
          badge: 'AES-256 SECURED'
        };
      case 'support':
        return {
          title: 'Help & Technical Support',
          subtitle: 'Intelligence Knowledge Center',
          badge: 'DEDICATED CHANNEL'
        };
    }
  };

  const headerInfo = getHeaderInfo();

  return (
    <header className="h-16 w-full flex justify-between items-center px-6 border-b border-[#424655] bg-[#131313]/85 backdrop-blur-xl z-40 sticky top-0 shrink-0 select-none">
      {/* Brand Title and Active state indicator */}
      <div className="flex items-center gap-4">
        <h1 
          className="font-bold text-lg tracking-tight text-[#e5e2e1] cursor-pointer"
          onClick={() => onViewChange('chats')}
        >
          {headerInfo.title}
        </h1>
        <div className="h-4 w-[1px] bg-[#424655]"></div>
        <div className="flex items-center gap-2 text-xs text-[#c2c6d8] bg-[#201f1f] px-2.5 py-1 rounded-md border border-[#424655]/40">
          <Sparkles className="w-3.5 h-3.5 text-[#b0c6ff]" />
          <span className="font-medium truncate max-w-[150px] md:max-w-xs">{headerInfo.subtitle}</span>
        </div>
        <span className="hidden sm:inline-block bg-[#00e598]/10 text-[#70ffba] border border-[#00e296]/30 text-[10px] font-bold tracking-wider px-2 py-0.5 rounded uppercase">
          {headerInfo.badge}
        </span>
      </div>

      {/* Pulsing Recording bar shown only in Chats & Active Calls */}
      {(currentView === 'active_meeting' || currentView === 'chats') && isRecording && (
        <div className="hidden md:flex items-center gap-2 bg-[#93000a]/20 px-3 py-1 rounded-full border border-[#ffb4ab]/20 animate-pulse">
          <Radio className="w-4.5 h-4.5 text-[#ffb4ab]" />
          <span className="text-[11px] text-[#ffb4ab] font-bold tracking-tight">Record Active</span>
        </div>
      )}

      {/* Global Actions Bar */}
      <div className="flex items-center gap-3">
        {/* Search tool */}
        <div className="relative flex items-center bg-[#1c1b1b] rounded-lg border border-[#424655]/60 w-44 sm:w-60 hover:border-[#b0c6ff] focus-within:border-[#b0c6ff] focus-within:ring-1 focus-within:ring-[#b0c6ff] transition-all">
          <Search className="w-4 h-4 text-[#8c90a1] absolute left-3" />
          <input
            type="text"
            className="bg-transparent border-none focus:ring-0 text-xs text-[#e5e2e1] pl-9 pr-3 py-2 w-full place-holder:text-[#8c90a1] outline-none"
            placeholder={currentView === 'support' ? "Search guides/FAQs..." : "Search data..."}
            value={searchFilter}
            onChange={(e) => onSearchChange(e.target.value)}
          />
        </div>

        {/* Create message / triggers */}
        <button
          onClick={onNewChatClicked || (() => onViewChange('chats'))}
          className="flex items-center gap-1.5 bg-[#568dff] text-[#002661] font-semibold text-xs py-2 px-3 sm:px-4 rounded-lg cursor-pointer hover:bg-[#568dff]/90 active:scale-95 transition-all shadow-sm shrink-0"
        >
          <Plus className="w-3.5 h-3.5 stroke-[2.5]" />
          <span className="hidden sm:inline">New Chat</span>
        </button>

        <div className="h-6 w-[1px] bg-[#424655] mx-1 shrink-0"></div>

        {/* Global actions: Alerts notifications */}
        <div className="relative shrink-0">
          <button 
            onClick={() => {
              setNotificationOpen(!notificationOpen);
              if (notificationOpen) {
                alert("Clean workspace alert inbox. System logs normal in Zurich and Swiss Sandbox Node.");
              }
            }}
            className="w-9 h-9 flex items-center justify-center rounded-lg text-[#c2c6d8] hover:bg-[#201f1f] hover:text-[#b0c6ff] transition-colors cursor-pointer relative"
          >
            <Bell className="w-4 h-4" />
            <span className="absolute top-2 right-2 w-1.5 h-1.5 rounded-full bg-[#ffb4ab]"></span>
          </button>
        </div>

        <button 
          onClick={() => onViewChange('support')}
          className="w-9 h-9 flex items-center justify-center rounded-lg text-[#c2c6d8] hover:bg-[#201f1f] hover:text-[#b0c6ff] transition-colors cursor-pointer shrink-0"
          title="Help Docs"
        >
          <HelpCircle className="w-4 h-4" />
        </button>
      </div>
    </header>
  );
}
