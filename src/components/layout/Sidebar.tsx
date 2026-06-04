import React from 'react';
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
} from 'lucide-react';
import { AppView } from '../../types';
import { useAuth } from '../../context/AuthContext';

interface SidebarProps {
  currentView: AppView;
  onViewChange: (view: AppView) => void;
  unreadCount?: number;
}

export default function Sidebar({ currentView, onViewChange, unreadCount = 0 }: SidebarProps) {
  const { currentUser, logout } = useAuth();

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

  return (
    <nav className="fixed left-0 top-0 bottom-0 z-50 flex flex-col items-center py-4 w-18 h-full border-r border-[#424655] bg-[#1c1b1b] shrink-0">
      {/* Brand */}
      <div className="mb-5 flex items-center justify-center">
        <button
          onClick={() => onViewChange('chats')}
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
              onClick={() => onViewChange(id)}
              aria-label={name}
              className={`w-full flex flex-col items-center justify-center py-2.5 rounded-xl transition-all relative group cursor-pointer ${
                isActive
                  ? 'bg-[#568dff]/20 text-[#b0c6ff]'
                  : 'text-[#8c90a1] hover:bg-[#2a2a2a] hover:text-[#e5e2e1]'
              }`}
            >
              <Icon className={`w-5 h-5 mb-0.5 ${isActive ? 'text-[#b0c6ff]' : 'text-[#8c90a1]'} group-hover:scale-105 transition-transform`} />
              <span className="text-[9px] font-medium select-none opacity-80 leading-none">{name}</span>

              {/* Active indicator */}
              {isActive && <div className="absolute left-0 top-1/4 bottom-1/4 w-0.5 rounded-r bg-[#b0c6ff]" />}

              {/* Unread badge */}
              {badge && badge > 0 && !isActive && (
                <span className="absolute top-2 right-2 w-2 h-2 rounded-full bg-[#ffb4ab] ring-1 ring-[#1c1b1b]" />
              )}

              {/* Tooltip */}
              <div className="absolute left-full ml-2 top-1/2 -translate-y-1/2 scale-90 opacity-0 group-hover:scale-100 group-hover:opacity-100 bg-[#353534] text-[#e5e2e1] text-xs py-1.5 px-3 rounded-lg shadow-xl border border-[#424655] pointer-events-none transition-all z-50 whitespace-nowrap">
                {name}
              </div>
            </button>
          );
        })}
      </div>

      {/* Footer */}
      <div className="mt-auto flex flex-col items-center gap-2 w-full px-2 pt-3 border-t border-[#424655]/50">
        <button
          onClick={() => onViewChange('security')}
          aria-label="Settings"
          className="w-full flex flex-col items-center justify-center py-2.5 rounded-xl text-[#8c90a1] hover:bg-[#2a2a2a] hover:text-[#e5e2e1] transition-all cursor-pointer group relative"
        >
          <Settings className="w-4.5 h-4.5 group-hover:rotate-45 transition-transform" />
          <div className="absolute left-full ml-2 top-1/2 -translate-y-1/2 scale-90 opacity-0 group-hover:scale-100 group-hover:opacity-100 bg-[#353534] text-[#e5e2e1] text-xs py-1.5 px-3 rounded-lg shadow-xl border border-[#424655] pointer-events-none transition-all z-50 whitespace-nowrap">
            Settings
          </div>
        </button>

        {/* User avatar */}
        <div className="relative group">
          <div className="w-9 h-9 rounded-full overflow-hidden border-2 border-[#353534] hover:border-[#b0c6ff] transition-colors cursor-pointer"
            onClick={() => onViewChange('security')}
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

          {/* Logout tooltip */}
          <div className="absolute left-full ml-2 bottom-0 scale-90 opacity-0 group-hover:scale-100 group-hover:opacity-100 bg-[#353534] text-[#e5e2e1] text-xs rounded-xl shadow-xl border border-[#424655] pointer-events-none transition-all z-50 whitespace-nowrap overflow-hidden">
            <div className="px-3 py-2 border-b border-[#424655] font-semibold">{currentUser?.displayName}</div>
            <button
              onClick={(e) => { e.stopPropagation(); logout(); }}
              className="w-full flex items-center gap-2 px-3 py-2 hover:bg-[#2a2a2a] transition-colors pointer-events-auto text-[#ffb4ab]"
            >
              <LogOut className="w-3.5 h-3.5" /> Sign out
            </button>
          </div>
        </div>
      </div>
    </nav>
  );
}
