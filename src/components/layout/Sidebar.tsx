import React, { useState } from 'react';
import {
  MessageSquare,
  Users,
  Phone,
  Calendar,
  ShieldCheck,
  HelpCircle,
  Settings,
  Hexagon,
  LogOut,
  Menu,
  X
} from 'lucide-react';
import { AppView } from '../../types';
import { useAuth } from '../../context/AuthContext';
import SettingsModal from '../settings/SettingsModal';

interface SidebarProps {
  currentView: AppView;
  onViewChange: (view: AppView) => void;
  unreadCount?: number;
  isInMeeting?: boolean;
}

export default function Sidebar({ currentView, onViewChange, unreadCount = 0, isInMeeting = false }: SidebarProps) {
  const { currentUser } = useAuth();
  const [showSettings, setShowSettings] = useState(false);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  const navItems: { id: AppView; name: string; Icon: React.ElementType; badge?: number }[] = [
    { id: 'chats', name: 'Chats', Icon: MessageSquare, badge: unreadCount },
    { id: 'calls', name: 'Calls', Icon: Phone },
    { id: 'debrief', name: 'Meetings', Icon: Users },
    { id: 'calendar', name: 'Calendar', Icon: Calendar },
    { id: 'security', name: 'Security', Icon: ShieldCheck },
    { id: 'support', name: 'Support', Icon: HelpCircle },
  ];

  const initials = currentUser
    ? currentUser.displayName.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2)
    : 'IB';

  const handleNavClick = (id: AppView) => {
    onViewChange(id);
    setIsMobileMenuOpen(false);
  };

  return (
    <>
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}

      {/* ── PRODUCTION GRADE MOBILE TOGGLE ── */}
      <button
        onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
        className={`md:hidden fixed top-3 left-3 z-[80] w-10 h-10 rounded-xl backdrop-blur-md flex items-center justify-center transition-all duration-300 shadow-xl ${
          isMobileMenuOpen 
            ? 'bg-[#568dff]/15 border border-[#568dff]/40 text-[#b0c6ff] rotate-90 scale-95' 
            : 'bg-[#1c1b1b]/90 border border-[#424655] text-[#e5e2e1] hover:bg-[#2a2a2a] rotate-0 scale-100'
        }`}
      >
        {isMobileMenuOpen ? <X className="w-5 h-5 transition-transform" /> : <Menu className="w-5 h-5 transition-transform" />}
      </button>

      {/* ── MOBILE OVERLAY ── */}
      {isMobileMenuOpen && (
        <div
          className="md:hidden fixed inset-0 z-[65] bg-black/60 backdrop-blur-sm transition-opacity"
          onClick={() => setIsMobileMenuOpen(false)}
        />
      )}

      {/* ── SIDEBAR CONTAINER ── */}
      <nav className={`fixed left-0 top-0 bottom-0 z-[70] flex flex-col items-center py-4 w-[72px] h-full border-r border-[#424655] bg-[#1c1b1b] shrink-0 transition-transform duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)] ${isMobileMenuOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}`}>
        
        {/* Brand */}
        <div className="mb-5 mt-10 md:mt-0 flex items-center justify-center">
          <button
            onClick={() => handleNavClick('chats')}
            className="w-10 h-10 rounded-2xl bg-[#0066FF] flex items-center justify-center shadow-[0_0_15px_rgba(0,102,255,0.35)] hover:scale-105 active:scale-95 transition-all"
          >
            <Hexagon className="w-6 h-6 text-white stroke-[2]" />
          </button>
        </div>

        {/* Nav items */}
        <div className="flex-1 flex flex-col gap-1 w-full px-2 overflow-y-auto">
          {navItems.map(({ id, name, Icon, badge }) => {
            const isActive = currentView === id;
            return (
              <button
                key={id}
                onClick={() => handleNavClick(id)}
                aria-label={name}
                className={`w-full flex flex-col items-center justify-center py-2.5 rounded-xl transition-all relative group cursor-pointer ${
                  isActive
                    ? 'bg-[#568dff]/20 text-[#b0c6ff]'
                    : 'text-[#8c90a1] hover:bg-[#2a2a2a] hover:text-[#e5e2e1]'
                }`}
              >
                <Icon className={`w-5 h-5 mb-0.5 ${isActive ? 'text-[#b0c6ff]' : 'text-[#8c90a1]'} group-hover:scale-105 transition-transform`} />
                <span className="text-[9px] font-medium select-none opacity-80 leading-none">{name}</span>
                {isActive && <div className="absolute left-0 top-1/4 bottom-1/4 w-0.5 rounded-r bg-[#b0c6ff]" />}
                {badge && badge > 0 && !isActive && (
                  <span className="absolute top-2 right-2 w-2 h-2 rounded-full bg-[#ffb4ab] ring-1 ring-[#1c1b1b]" />
                )}
                {id === 'debrief' && isInMeeting && (
                  <span className="absolute top-1.5 right-1.5 text-[7px] font-black bg-[#4dffb1] text-[#002661] px-1 rounded leading-tight">LIVE</span>
                )}
                <div className="absolute left-full ml-2 top-1/2 -translate-y-1/2 scale-90 opacity-0 group-hover:scale-100 group-hover:opacity-100 hidden md:block bg-[#353534] text-[#e5e2e1] text-xs py-1.5 px-3 rounded-lg shadow-xl border border-[#424655] pointer-events-none transition-all z-50 whitespace-nowrap">
                  {name}
                </div>
              </button>
            );
          })}
        </div>

        {/* Footer */}
        <div className="mt-auto flex flex-col items-center gap-2 w-full px-2 pt-3 border-t border-[#424655]/50">
          <button
            onClick={() => { setShowSettings(true); setIsMobileMenuOpen(false); }}
            className="w-full flex flex-col items-center justify-center py-2.5 rounded-xl text-[#8c90a1] hover:bg-[#2a2a2a] hover:text-[#e5e2e1] transition-all cursor-pointer group relative"
          >
            <Settings className="w-4.5 h-4.5 group-hover:rotate-45 transition-transform" />
            <div className="absolute left-full ml-2 top-1/2 -translate-y-1/2 scale-90 opacity-0 group-hover:scale-100 group-hover:opacity-100 hidden md:block bg-[#353534] text-[#e5e2e1] text-xs py-1.5 px-3 rounded-lg shadow-xl border border-[#424655] pointer-events-none transition-all z-50 whitespace-nowrap">
              Settings
            </div>
          </button>

          <div className="relative group">
            <div
              className="w-9 h-9 rounded-full overflow-hidden border-2 border-[#353534] hover:border-[#b0c6ff] transition-colors cursor-pointer"
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
            <span className="absolute bottom-0 right-0 w-2.5 h-2.5 bg-[#4dffb1] rounded-full border border-[#1c1b1b]" />
            <div className="absolute left-full ml-2 bottom-0 scale-90 opacity-0 group-hover:scale-100 group-hover:opacity-100 hidden md:block bg-[#353534] text-[#e5e2e1] text-xs rounded-xl shadow-xl border border-[#424655] pointer-events-none transition-all z-50 whitespace-nowrap overflow-hidden">
              <div className="px-3 py-2 border-b border-[#424655] font-semibold">{currentUser?.displayName}</div>
              <div className="px-3 py-1.5 text-[#8c90a1]">Click to open settings</div>
            </div>
          </div>
        </div>
      </nav>
    </>
  );
}
