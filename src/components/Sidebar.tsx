import React from 'react';
import { 
  MessageSquare, 
  Users, 
  Phone, 
  Contact, 
  Calendar, 
  ShieldCheck, 
  HelpCircle, 
  Settings,
  Hexagon
} from 'lucide-react';
import { AppView } from '../types';

interface SidebarProps {
  currentView: AppView;
  onViewChange: (view: AppView) => void;
  unreadCount?: number;
}

export default function Sidebar({ currentView, onViewChange, unreadCount = 2 }: SidebarProps) {
  const primaryNavItems = [
    { id: 'chats' as AppView, name: 'Chats', icon: MessageSquare, badge: unreadCount },
    { id: 'debrief' as AppView, name: 'Meetings', icon: Users },
    { id: 'security' as AppView, name: 'Security & Compliance', icon: ShieldCheck },
    { id: 'support' as AppView, name: 'Support Help', icon: HelpCircle },
  ];

  const utilityNavItems = [
    { id: 'calls', name: 'Calls', icon: Phone },
    { id: 'contacts', name: 'Contacts', icon: Contact },
    { id: 'calendar', name: 'Calendar', icon: Calendar },
  ];

  return (
    <nav className="fixed left-0 top-0 bottom-0 z-50 flex flex-col items-center py-5 w-18 h-full border-r border-[#424655] bg-[#1c1b1b] shrink-0">
      {/* Brand Launcher Logo */}
      <div className="mb-6 flex flex-col items-center justify-center">
        <button 
          onClick={() => onViewChange('chats')}
          className="w-10 h-10 rounded-2xl bg-[#0066FF] flex items-center justify-center shadow-[0_0_15px_rgba(0,102,255,0.4)] cursor-pointer hover:scale-105 active:scale-95 transition-all"
        >
          <Hexagon className="w-6 h-6 text-white stroke-[2.5]" />
        </button>
      </div>

      {/* Primary Actions Navigation */}
      <div className="flex-1 flex flex-col gap-2 w-full px-2">
        {primaryNavItems.map((item) => {
          const Icon = item.icon;
          const isActive = currentView === item.id;
          return (
            <button
              key={item.id}
              onClick={() => onViewChange(item.id)}
              aria-label={item.name}
              className={`w-full flex flex-col items-center justify-center py-3 rounded-xl transition-all relative group cursor-pointer ${
                isActive 
                  ? 'bg-[#568dff]/20 text-[#b0c6ff] border-r-2 border-[#b0c6ff]' 
                  : 'text-[#c2c6d8] hover:bg-[#2a2a2a] hover:text-[#e5e2e1]'
              }`}
            >
              <Icon className={`w-5 h-5 mb-1 transition-transform group-hover:scale-105 ${isActive ? 'text-[#b0c6ff]' : 'text-[#8c90a1]'}`} />
              <span className="text-[10px] font-medium tracking-tight h-3 opacity-80 select-none">{item.name.split(' ')[0]}</span>
              
              {/* Tooltip */}
              <div className="absolute left-16 top-1/2 -translate-y-1/2 scale-75 opacity-0 group-hover:scale-100 group-hover:opacity-100 bg-[#353534] text-[#e5e2e1] text-xs py-1.5 px-3 rounded-lg shadow-xl border border-[#424655] pointer-events-none transition-all z-50 whitespace-nowrap">
                {item.name}
              </div>

              {/* Chat tab indicator badge */}
              {item.badge && item.badge > 0 && !isActive && (
                <span className="absolute top-2 right-3 w-2 h-2 rounded-full bg-[#ffb4ab] ring-1 ring-[#1c1b1b]"></span>
              )}
            </button>
          );
        })}

        <div className="w-8 h-[1px] bg-[#424655]/50 my-2 mx-auto"></div>

        {/* Quick Utility non-active mock links */}
        {utilityNavItems.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              onClick={() => {
                alert(`The ${item.name} panel is simulated. Navigation routes are prioritized on active core layouts (Chats, Meetings Debrief, Security, Support).`);
              }}
              aria-label={item.name}
              className="w-full flex flex-col items-center justify-center py-3 rounded-xl text-[#8c90a1] hover:bg-[#2a2a2a] hover:text-[#e5e2e1] transition-all relative group cursor-pointer"
            >
              <Icon className="w-5 h-5 mb-1 group-hover:scale-105" />
              <span className="text-[10px] font-medium tracking-tight h-3 opacity-60 select-none">{item.name}</span>
              
              <div className="absolute left-16 top-1/2 -translate-y-1/2 scale-75 opacity-0 group-hover:scale-100 group-hover:opacity-100 bg-[#353534] text-[#e5e2e1] text-xs py-1.5 px-3 rounded-lg shadow-xl border border-[#424655] pointer-events-none transition-all z-50">
                {item.name} (Simulated)
              </div>
            </button>
          );
        })}
      </div>

      {/* Footer Settings & Workspace */}
      <div className="mt-auto flex flex-col items-center gap-2 w-full px-2 pt-4 border-t border-[#424655]/50 shrink-0">
        <button 
          onClick={() => {
            alert("Switching Workspace context enclaves. Security settings initialized for Private Sandbox Node A.");
          }}
          aria-label="Workspace Cloud Node"
          className="w-9 h-9 rounded-full bg-[#201f1f] overflow-hidden border border-[#424655] hover:border-[#b0c6ff] transition-colors flex items-center justify-center cursor-pointer group relative"
        >
          <span className="text-xs font-bold text-[#b0c6ff]">CH</span>
          <div className="absolute left-16 top-1/2 -translate-y-1/2 scale-75 opacity-0 group-hover:scale-100 group-hover:opacity-100 bg-[#353534] text-[#e5e2e1] text-xs py-1.5 px-3 rounded-lg shadow-xl border border-[#424655] pointer-events-none transition-all z-50 whitespace-nowrap">
            Swiss Cloud Enclave
          </div>
        </button>

        <button 
          onClick={() => onViewChange('security')}
          aria-label="System Settings"
          className="w-full flex flex-col items-center justify-center py-3 rounded-xl text-[#8c90a1] hover:bg-[#2a2a2a] hover:text-[#e5e2e1] transition-all cursor-pointer group"
        >
          <Settings className="w-5 h-5 group-hover:rotate-45 transition-transform" />
        </button>

        {/* User avatar profile preview card click triggers Security tab */}
        <div 
          onClick={() => onViewChange('security')}
          className="mt-1 w-9 h-9 rounded-full overflow-hidden border-2 border-[#353534] hover:border-[#b0c6ff] transition-colors cursor-pointer relative shrink-0"
          title="Account Information & Settings"
        >
          <img 
            alt="User profile" 
            className="w-full h-full object-cover" 
            src="https://lh3.googleusercontent.com/aida-public/AB6AXuCcUMX_dQ54gfQTRmp3SUSIETQOfiWW3V_VhICOXeIHGtMiE5O4Fey8jMHh9n6TdBgMyYenZyodac-qufe8YprxScQXNeHkPFnG1lEXVoL9CyPWxEzQB4b4N8IMeKRCCh1kY4S5zUThCEaRN4mGGVvo7hjQQD1ll0V1BJXeqz0XCWfN9NGK7P16Uy9PZZiqQvU1sOv8w4tZz_wGGrPIxV3umkJKB-v-jqe5UVb7AsHnA-D9Q8as0CgOu2AaBUVVI1NRCtt9TjHpE2Re" 
          />
          <span className="absolute bottom-0 right-0 w-2.5 h-2.5 bg-[#4dffb1] rounded-full border border-[#131313]"></span>
        </div>
      </div>
    </nav>
  );
}
