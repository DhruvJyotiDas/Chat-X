import React, { useState, useEffect } from 'react';
import {
  LayoutDashboard,
  MessageSquare,
  Users,
  Phone,
  Calendar,
  Sparkles,
  ShieldCheck,
  HelpCircle,
  Settings,
  Menu,
  X
} from 'lucide-react';
import { AppView } from '../../types';
import { useAuth } from '../../context/AuthContext';
import SettingsModal from '../settings/SettingsModal';
import { loadStatus, StatusPreference } from '../../lib/preferences';
import BrandMark from '../BrandMark';

interface SidebarProps {
  currentView: AppView;
  onViewChange: (view: AppView) => void;
  unreadCount?: number;
  isInMeeting?: boolean;
}

type NavItem = { id: AppView; name: string; Icon: React.ElementType };

const PRIMARY_NAV: NavItem[] = [
  { id: 'dashboard', name: 'Home', Icon: LayoutDashboard },
  { id: 'chats', name: 'Chats', Icon: MessageSquare },
  { id: 'calls', name: 'Calls', Icon: Phone },
  { id: 'debrief', name: 'Meetings', Icon: Users },
  { id: 'calendar', name: 'Calendar', Icon: Calendar },
  { id: 'interview', name: 'Interview', Icon: Sparkles },
];

const UTILITY_NAV: NavItem[] = [
  { id: 'security', name: 'Security', Icon: ShieldCheck },
  { id: 'support', name: 'Support', Icon: HelpCircle },
];

function RailTooltip({ children }: { children: React.ReactNode }) {
  return (
    <div className="pointer-events-none absolute left-full ml-3 top-1/2 -translate-y-1/2 scale-95 opacity-0 group-hover:scale-100 group-hover:opacity-100 hidden md:block bg-[#2a2a2a] text-[#e5e2e1] text-xs font-medium py-1.5 px-3 rounded-lg shadow-xl border border-[#424655]/80 transition-all duration-150 z-50 whitespace-nowrap">
      {children}
    </div>
  );
}

export default function Sidebar({ currentView, onViewChange, unreadCount = 0, isInMeeting = false }: SidebarProps) {
  const { currentUser } = useAuth();
  const [showSettings, setShowSettings] = useState(false);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [status, setStatus] = useState<StatusPreference>(() => currentUser ? loadStatus(currentUser.id) : { emoji: '', text: '' });

  useEffect(() => {
    if (!showSettings && currentUser) setStatus(loadStatus(currentUser.id));
  }, [showSettings, currentUser]);

  const initials = currentUser
    ? currentUser.displayName.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2)
    : 'IB';

  const handleNavClick = (id: AppView) => {
    onViewChange(id);
    setIsMobileMenuOpen(false);
  };

  const renderNavButton = ({ id, name, Icon }: NavItem) => {
    const isActive = currentView === id;
    const showBadge = id === 'chats' && unreadCount > 0 && !isActive;
    return (
      <button
        key={id}
        onClick={() => handleNavClick(id)}
        aria-label={name}
        aria-current={isActive ? 'page' : undefined}
        className={`relative group w-11 h-11 flex items-center justify-center rounded-2xl shrink-0 transition-all duration-200 cursor-pointer ${
          isActive
            ? 'bg-[#568dff]/15 text-[#b0c6ff] ring-1 ring-inset ring-[#568dff]/30 shadow-[0_0_14px_rgba(86,141,255,0.18)]'
            : 'text-[#8c90a1] hover:bg-white/[0.06] hover:text-[#e5e2e1]'
        }`}
      >
        <Icon className="w-[18px] h-[18px] transition-transform duration-200 group-hover:scale-110" strokeWidth={isActive ? 2.25 : 2} />

        {showBadge && (
          <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-[#ffb4ab] ring-2 ring-[#1c1b1b]" />
        )}
        {id === 'debrief' && isInMeeting && (
          <span className="absolute -top-1 -right-1 text-[7px] font-black bg-[#4dffb1] text-[#002661] px-1 py-px rounded-full leading-tight tracking-wide">LIVE</span>
        )}

        <RailTooltip>{name}</RailTooltip>
      </button>
    );
  };

  return (
    <>
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}

      {/* ── Mobile toggle ── */}
      <button
        onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
        className={`md:hidden fixed top-3 left-3 z-[80] w-10 h-10 rounded-xl backdrop-blur-md flex items-center justify-center transition-all duration-300 shadow-xl ${
          isMobileMenuOpen
            ? 'bg-[#568dff]/15 border border-[#568dff]/40 text-[#b0c6ff] rotate-90 scale-95'
            : 'bg-[#1c1b1b]/90 border border-[#424655] text-[#e5e2e1] hover:bg-[#2a2a2a] rotate-0 scale-100'
        }`}
      >
        {isMobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
      </button>

      {/* ── Mobile overlay ── */}
      {isMobileMenuOpen && (
        <div
          className="md:hidden fixed inset-0 z-[65] bg-black/60 backdrop-blur-sm transition-opacity"
          onClick={() => setIsMobileMenuOpen(false)}
        />
      )}

      {/* ── Sidebar rail ── */}
      <nav className={`fixed left-0 top-0 bottom-0 z-[70] flex flex-col items-center py-4 w-[76px] h-full border-r border-[#424655] bg-[#1c1b1b] shrink-0 transition-transform duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)] ${isMobileMenuOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}`}>

        {/* Brand */}
        <button
          onClick={() => handleNavClick('dashboard')}
          className="mt-10 md:mt-1 mb-3 w-11 h-11 rounded-2xl bg-[#0066FF] flex items-center justify-center shadow-[0_0_18px_rgba(0,102,255,0.4)] hover:scale-105 active:scale-95 transition-transform shrink-0"
        >
          <BrandMark className="w-6 h-6" />
        </button>

        {/* Primary nav */}
        <div className="flex flex-col items-center gap-1">
          {PRIMARY_NAV.map(renderNavButton)}
        </div>

        <div className="w-7 h-px bg-[#424655]/60 my-2 shrink-0" />

        {/* Utility nav */}
        <div className="flex flex-col items-center gap-1">
          {UTILITY_NAV.map(renderNavButton)}
        </div>

        {/* Footer */}
        <div className="mt-auto flex flex-col items-center gap-2 pt-3 shrink-0">
          <button
            onClick={() => { setShowSettings(true); setIsMobileMenuOpen(false); }}
            aria-label="Settings"
            className="relative group w-11 h-11 flex items-center justify-center rounded-2xl text-[#8c90a1] hover:bg-white/[0.06] hover:text-[#e5e2e1] transition-all cursor-pointer"
          >
            <Settings className="w-[17px] h-[17px] group-hover:rotate-45 transition-transform duration-300" />
            <RailTooltip>Settings</RailTooltip>
          </button>

          <div className="relative group">
            <div
              className="w-9 h-9 rounded-full overflow-hidden border-2 border-[#353534] hover:border-[#568dff] transition-colors cursor-pointer"
              role="button"
              tabIndex={0}
              aria-label="Your profile and settings"
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setShowSettings(true); setIsMobileMenuOpen(false); } }}
              onClick={() => { setShowSettings(true); setIsMobileMenuOpen(false); }}
            >
              {currentUser?.avatar ? (
                <img alt="profile" src={currentUser.avatar} className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full bg-[#568dff]/20 flex items-center justify-center">
                  <span className="text-xs font-bold text-[#b0c6ff]">{initials}</span>
                </div>
              )}
            </div>
            <span className="absolute bottom-0 right-0 w-2.5 h-2.5 bg-[#4dffb1] rounded-full border-2 border-[#1c1b1b]" />

            <div className="pointer-events-none absolute left-full ml-3 bottom-0 scale-95 opacity-0 group-hover:scale-100 group-hover:opacity-100 hidden md:block bg-[#2a2a2a] text-[#e5e2e1] text-xs rounded-xl shadow-xl border border-[#424655]/80 transition-all duration-150 z-50 whitespace-nowrap overflow-hidden">
              <div className="px-3 py-2 border-b border-[#424655] font-semibold flex items-center gap-1.5">
                {currentUser?.displayName}
                {status.emoji && <span>{status.emoji}</span>}
              </div>
              {status.text && <div className="px-3 py-1.5 text-[#c2c6d8] border-b border-[#424655]">{status.text}</div>}
              <div className="px-3 py-1.5 text-[#8c90a1]">Click to open settings</div>
            </div>
          </div>
        </div>
      </nav>
    </>
  );
}
