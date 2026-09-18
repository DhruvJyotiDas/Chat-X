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
import { pushOverlay } from '../../lib/overlayStack';

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

// Desktop only. On touch, .group:hover never fires at all -- a phone user
// gets pure icon-only nav with zero way to reveal meaning (found in Phase 1
// of the redesign, UI_REDESIGN_PLAN.md section 1). Fixing that is the mobile
// drawer below, which carries a visible label on every row instead -- this
// tooltip's job stays exactly what it already did well: desktop, where hover
// genuinely exists. A dark tooltip on a light page is a deliberate choice,
// not a leftover from the dark theme -- inverted-contrast tooltips are a
// normal, legible pattern regardless of the page's own theme.
function RailTooltip({ children }: { children: React.ReactNode }) {
  return (
    <div className="pointer-events-none absolute left-full ml-3 top-1/2 -translate-y-1/2 scale-95 opacity-0 group-hover:scale-100 group-hover:opacity-100 hidden md:block bg-[var(--ib-gray-900)] text-white text-xs font-medium py-1.5 px-3 rounded-lg shadow-[var(--ib-shadow-lg)] transition-all duration-150 z-50 whitespace-nowrap">
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

  // Registers the mobile drawer with the shared "is any overlay open" signal
  // (sub-unit 2, src/lib/overlayStack.ts) -- it's its own ad hoc overlay, not
  // built on the shared Modal primitive.
  useEffect(() => {
    if (!isMobileMenuOpen) return;
    return pushOverlay();
  }, [isMobileMenuOpen]);

  const initials = currentUser
    ? currentUser.displayName.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2)
    : 'IB';

  const handleNavClick = (id: AppView) => {
    onViewChange(id);
    setIsMobileMenuOpen(false);
  };

  // Desktop: unchanged shape (icon-only, 44px square, tooltip on hover),
  // retheme only.
  const renderRailButton = ({ id, name, Icon }: NavItem) => {
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
            ? 'bg-[var(--ib-blue-50)] text-[var(--ib-blue-500)] ring-1 ring-inset ring-[var(--ib-blue-100)]'
            : 'text-[var(--ib-gray-600)] hover:bg-[var(--ib-gray-50)] hover:text-[var(--ib-gray-900)]'
        }`}
      >
        <Icon className="w-[18px] h-[18px] transition-transform duration-200 group-hover:scale-110" strokeWidth={isActive ? 2.25 : 2} />

        {showBadge && (
          <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-[var(--ib-bad-dot)] ring-2 ring-white" />
        )}
        {id === 'debrief' && isInMeeting && (
          <span className="absolute -top-1 -right-1 text-[7px] font-black bg-[var(--ib-good-dot)] text-white px-1 py-px rounded-full leading-tight tracking-wide">LIVE</span>
        )}

        <RailTooltip>{name}</RailTooltip>
      </button>
    );
  };

  // Mobile drawer: a real labeled row, not the rail shrunk down. This is the
  // actual fix -- see the file header. 48px tall (mobile tap-target floor).
  const renderDrawerRow = ({ id, name, Icon }: NavItem) => {
    const isActive = currentView === id;
    const showBadge = id === 'chats' && unreadCount > 0 && !isActive;
    return (
      <button
        key={id}
        onClick={() => handleNavClick(id)}
        aria-current={isActive ? 'page' : undefined}
        className={`relative flex items-center gap-3 w-full h-12 px-4 rounded-[var(--ib-radius-md)] shrink-0 transition-colors cursor-pointer ${
          isActive
            ? 'bg-[var(--ib-blue-50)] text-[var(--ib-blue-500)]'
            : 'text-[var(--ib-gray-800)] hover:bg-[var(--ib-gray-50)]'
        }`}
      >
        <Icon className="w-5 h-5 shrink-0" strokeWidth={isActive ? 2.25 : 2} />
        <span className="text-[15px] font-medium">{name}</span>
        {showBadge && <span className="ml-auto w-2 h-2 rounded-full bg-[var(--ib-bad-dot)] shrink-0" />}
        {id === 'debrief' && isInMeeting && (
          <span className="ml-auto text-[10px] font-black bg-[var(--ib-good-dot)] text-white px-1.5 py-0.5 rounded-full tracking-wide shrink-0">LIVE</span>
        )}
      </button>
    );
  };

  return (
    <>
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}

      {/* ── Mobile toggle ── */}
      <button
        onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
        aria-label={isMobileMenuOpen ? 'Close menu' : 'Open menu'}
        className={`md:hidden fixed top-3 left-3 z-[80] w-10 h-10 rounded-xl backdrop-blur-md flex items-center justify-center transition-all duration-300 shadow-[var(--ib-shadow-md)] ${
          isMobileMenuOpen
            ? 'bg-[var(--ib-blue-50)] border border-[var(--ib-blue-100)] text-[var(--ib-blue-500)] rotate-90 scale-95'
            : 'bg-white/90 border border-[var(--ib-gray-200)] text-[var(--ib-gray-800)] hover:bg-[var(--ib-gray-50)] rotate-0 scale-100'
        }`}
      >
        {isMobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
      </button>

      {/* ── Mobile overlay ── */}
      {isMobileMenuOpen && (
        <div
          className="md:hidden fixed inset-0 z-[65] bg-[var(--ib-gray-900)]/40 backdrop-blur-sm transition-opacity"
          onClick={() => setIsMobileMenuOpen(false)}
        />
      )}

      {/* ── Desktop rail: icon-only, unchanged shape, always visible ≥md.
           No off-canvas transform needed since it's never hidden -- matches
           ChatsView's own hidden/lg:flex convention (CLAUDE.md's cited
           reference pattern) rather than the old translate-x-full trick that
           had to serve both a hidden mobile drawer AND a visible desktop
           rail from the same element. ── */}
      <nav className="hidden md:flex fixed left-0 top-0 bottom-0 z-[70] flex-col items-center py-4 w-[76px] h-full border-r border-[var(--ib-gray-100)] bg-white shrink-0">
        <button
          onClick={() => handleNavClick('dashboard')}
          className="mt-1 mb-3 w-11 h-11 rounded-2xl bg-[var(--ib-blue-500)] flex items-center justify-center shadow-[0_0_18px_rgba(0,102,255,0.35)] hover:scale-105 active:scale-95 transition-transform shrink-0"
        >
          <BrandMark className="w-6 h-6" />
        </button>

        <div className="flex flex-col items-center gap-1">
          {PRIMARY_NAV.map(renderRailButton)}
        </div>

        <div className="w-7 h-px bg-[var(--ib-gray-100)] my-2 shrink-0" />

        <div className="flex flex-col items-center gap-1">
          {UTILITY_NAV.map(renderRailButton)}
        </div>

        <div className="mt-auto flex flex-col items-center gap-2 pt-3 shrink-0">
          <button
            onClick={() => setShowSettings(true)}
            aria-label="Settings"
            className="relative group w-11 h-11 flex items-center justify-center rounded-2xl text-[var(--ib-gray-600)] hover:bg-[var(--ib-gray-50)] hover:text-[var(--ib-gray-900)] transition-all cursor-pointer"
          >
            <Settings className="w-[17px] h-[17px] group-hover:rotate-45 transition-transform duration-300" />
            <RailTooltip>Settings</RailTooltip>
          </button>

          <div className="relative group">
            <div
              className="w-9 h-9 rounded-full overflow-hidden border-2 border-[var(--ib-gray-200)] hover:border-[var(--ib-blue-500)] transition-colors cursor-pointer"
              role="button"
              tabIndex={0}
              aria-label="Your profile and settings"
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setShowSettings(true); } }}
              onClick={() => setShowSettings(true)}
            >
              {currentUser?.avatar ? (
                <img alt="profile" src={currentUser.avatar} className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full bg-[var(--ib-blue-50)] flex items-center justify-center">
                  <span className="text-xs font-bold text-[var(--ib-blue-800)]">{initials}</span>
                </div>
              )}
            </div>
            <span className="absolute bottom-0 right-0 w-2.5 h-2.5 bg-[var(--ib-good-dot)] rounded-full border-2 border-white" />

            <div className="pointer-events-none absolute left-full ml-3 bottom-0 scale-95 opacity-0 group-hover:scale-100 group-hover:opacity-100 hidden md:block bg-[var(--ib-gray-900)] text-white text-xs rounded-xl shadow-[var(--ib-shadow-lg)] transition-all duration-150 z-50 whitespace-nowrap overflow-hidden">
              <div className="px-3 py-2 border-b border-white/15 font-semibold flex items-center gap-1.5">
                {currentUser?.displayName}
                {status.emoji && <span>{status.emoji}</span>}
              </div>
              {status.text && <div className="px-3 py-1.5 text-white/80 border-b border-white/15">{status.text}</div>}
              <div className="px-3 py-1.5 text-white/70">Click to open settings</div>
            </div>
          </div>
        </div>
      </nav>

      {/* ── Mobile drawer: a real labeled menu, not the rail shown/hidden.
           w-72 (288px) -- enough room for icon+label+badge without feeling
           cramped, well short of forcing horizontal scroll on a 320px
           viewport (CLAUDE.md's own "survive 320px" bar). ── */}
      <nav
        className={`md:hidden fixed left-0 top-0 bottom-0 z-[70] flex flex-col w-72 max-w-[85vw] h-full bg-white shadow-[var(--ib-shadow-lg)] shrink-0
          transition-transform duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)]
          ${isMobileMenuOpen ? 'translate-x-0' : '-translate-x-full'}`}
      >
        <button
          onClick={() => handleNavClick('dashboard')}
          className="flex items-center gap-3 mt-14 mb-4 mx-4 shrink-0"
        >
          <span className="w-10 h-10 rounded-2xl bg-[var(--ib-blue-500)] flex items-center justify-center shadow-[0_0_18px_rgba(0,102,255,0.35)] shrink-0">
            <BrandMark className="w-5 h-5" />
          </span>
          <span className="text-[15px] font-semibold text-[var(--ib-gray-900)]">IB Connect</span>
        </button>

        <div className="flex flex-col gap-1 px-3 overflow-y-auto">
          {PRIMARY_NAV.map(renderDrawerRow)}
        </div>

        <div className="h-px bg-[var(--ib-gray-100)] my-3 mx-4 shrink-0" />

        <div className="flex flex-col gap-1 px-3">
          {UTILITY_NAV.map(renderDrawerRow)}
        </div>

        <div className="mt-auto flex flex-col gap-1 p-3 pt-3 border-t border-[var(--ib-gray-100)] shrink-0">
          <button
            onClick={() => { setShowSettings(true); setIsMobileMenuOpen(false); }}
            className="flex items-center gap-3 w-full h-12 px-4 rounded-[var(--ib-radius-md)] text-[var(--ib-gray-800)] hover:bg-[var(--ib-gray-50)] transition-colors cursor-pointer"
          >
            <Settings className="w-5 h-5 shrink-0" />
            <span className="text-[15px] font-medium">Settings</span>
          </button>

          <button
            onClick={() => { setShowSettings(true); setIsMobileMenuOpen(false); }}
            className="flex items-center gap-3 w-full px-4 py-2.5 rounded-[var(--ib-radius-md)] hover:bg-[var(--ib-gray-50)] transition-colors cursor-pointer text-left"
          >
            <span className="relative shrink-0">
              <span className="block w-9 h-9 rounded-full overflow-hidden border-2 border-[var(--ib-gray-200)]">
                {currentUser?.avatar ? (
                  <img alt="profile" src={currentUser.avatar} className="w-full h-full object-cover" />
                ) : (
                  <span className="w-full h-full bg-[var(--ib-blue-50)] flex items-center justify-center">
                    <span className="text-xs font-bold text-[var(--ib-blue-800)]">{initials}</span>
                  </span>
                )}
              </span>
              <span className="absolute bottom-0 right-0 w-2.5 h-2.5 bg-[var(--ib-good-dot)] rounded-full border-2 border-white" />
            </span>
            <span className="min-w-0">
              <span className="block text-[14px] font-semibold text-[var(--ib-gray-900)] truncate">{currentUser?.displayName}</span>
              <span className="block text-[12px] text-[var(--ib-gray-600)] truncate">
                {status.text || 'Click to open settings'}
              </span>
            </span>
          </button>
        </div>
      </nav>
    </>
  );
}
