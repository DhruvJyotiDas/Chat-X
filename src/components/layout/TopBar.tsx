import React, { useState, useEffect } from 'react';
import { Search, Bell, HelpCircle, Plus, Sparkles, Command, X } from 'lucide-react';
import { AppView } from '../../types';
import { useAuth } from '../../context/AuthContext';
import { useChat } from '../../context/ChatContext';
import { loadNotifications } from '../../lib/preferences';
import Modal from '../ui/Modal';

interface TopBarProps {
  currentView: AppView;
  onViewChange: (view: AppView) => void;
  searchFilter: string;
  onSearchChange: (val: string) => void;
  onNewChatClicked?: () => void;
}

const VIEW_INFO: Record<AppView, { title: string; subtitle: string; badge: string }> = {
  dashboard: { title: 'Home', subtitle: 'Your daily overview', badge: 'DASHBOARD' },
  chats: { title: 'Messages', subtitle: 'Conversations and groups', badge: 'MESSAGING' },
  calls: { title: 'Calls', subtitle: 'Video & Audio Calls', badge: 'WEBRTC' },
  debrief: { title: 'Meeting Debrief', subtitle: 'Recaps and action items', badge: 'MEETING NOTES' },
  active_meeting: { title: 'Active Call', subtitle: 'Live audio and video', badge: 'LIVE MEDIA' },
  calendar: { title: 'Calendar', subtitle: 'Schedule & Events', badge: 'PERSONAL' },
  security: { title: 'Security', subtitle: 'Account and privacy controls', badge: 'SECURITY CENTER' },
  support: { title: 'Help & Support', subtitle: 'Intelligence Knowledge Center', badge: 'DEDICATED' },
  interview: { title: 'Virtual Interview', subtitle: 'AI mock interviews from your CV', badge: 'AI COACH' },
};

function NotificationsBody({ unreadTotal, onOpenChats }: { unreadTotal: number; onOpenChats: () => void }) {
  return (
    <div className="flex flex-col">
      <p className="px-2 pb-2 pt-1 text-[10px] font-bold uppercase tracking-[.16em] text-[var(--ib-text-muted)]">Notifications</p>
      <button onClick={onOpenChats} className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left cursor-pointer hover:bg-[var(--ib-gray-50)]">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-[var(--ib-blue-50)] text-[var(--ib-blue-500)]"><Bell className="h-4 w-4" /></span>
        <span>
          <strong className="block text-xs font-semibold text-[var(--ib-text)]">{unreadTotal || 'No'} unread messages</strong>
          <span className="text-[10px] text-[var(--ib-text-muted)]">{unreadTotal ? 'Open your inbox to catch up' : "You're all caught up"}</span>
        </span>
      </button>
    </div>
  );
}

export default function TopBar({ currentView, onViewChange, searchFilter, onSearchChange, onNewChatClicked }: TopBarProps) {
  const [notifOpen, setNotifOpen] = useState(false);
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);
  const { currentUser } = useAuth();
  const { threads } = useChat();
  const info = VIEW_INFO[currentView] || VIEW_INFO.chats;

  const unreadTotal = threads.reduce((sum, t) => sum + (t.unreadCount ?? 0), 0);
  const notifsEnabled = currentUser ? loadNotifications(currentUser.id).messageAlerts : true;
  const showNotifDot = notifsEnabled && unreadTotal > 0;

  // In-app companion to the OS Notification ChatContext already tries to show
  // for a meeting_reminder ws event — this fires regardless of whether that
  // succeeded (no permission granted, browser doesn't support it, etc.), so
  // there's always at least one visible signal while the app is open.
  const [reminderBanner, setReminderBanner] = useState<{ title: string; time: string; location?: string; kind?: 'meeting' | 'calendar' } | null>(null);
  useEffect(() => {
    let dismissTimer: ReturnType<typeof setTimeout> | null = null;
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { title: string; time: string; location?: string };
      setReminderBanner({ ...detail, kind: e.type === 'ibconnect_calendar_reminder' ? 'calendar' : 'meeting' });
      if (dismissTimer) window.clearTimeout(dismissTimer);
      dismissTimer = setTimeout(() => setReminderBanner(null), 20000);
    };
    window.addEventListener('ibconnect_meeting_reminder', handler);
    window.addEventListener('ibconnect_calendar_reminder', handler);
    return () => {
      window.removeEventListener('ibconnect_meeting_reminder', handler);
      window.removeEventListener('ibconnect_calendar_reminder', handler);
      if (dismissTimer) window.clearTimeout(dismissTimer);
    };
  }, []);

  const actionLabel = currentView === 'calls' ? 'New Call' : currentView === 'calendar' ? 'New Event' : 'New Chat';

  const handleAction = () => {
    if (currentView === 'calls') { onViewChange('calls'); return; }
    if (currentView === 'calendar') { window.dispatchEvent(new CustomEvent('ibconnect_calendar_create')); return; }
    onNewChatClicked?.();
  };

  const openChatsFromNotif = () => { setNotifOpen(false); onViewChange('chats'); };

  return (
    <>
      {/* In-app companion to the OS Notification (which may not have permission,
          or may not be supported at all) — always shown regardless, so a meeting
          reminder is never silently invisible while the app is open. */}
      {reminderBanner && (
        <div className="fixed top-3 left-1/2 -translate-x-1/2 z-[110] flex items-center gap-2.5 bg-[var(--ib-surface-raised)] border border-[var(--ib-blue-500)]/30 shadow-[var(--ib-shadow-lg)] rounded-xl px-4 py-2.5 max-w-[92vw]">
          <Bell className="w-4 h-4 text-[var(--ib-blue-500)] flex-shrink-0" />
          <span className="text-xs text-[var(--ib-text)] truncate">
            <strong className="font-bold">{reminderBanner.title}</strong> starts at {reminderBanner.time}{reminderBanner.location ? ` · ${reminderBanner.location}` : ''}
          </span>
          <button onClick={() => setReminderBanner(null)} className="text-[var(--ib-text-muted)] hover:text-[var(--ib-text)] flex-shrink-0"><X className="w-3.5 h-3.5" /></button>
        </div>
      )}
      <header className="relative h-14 w-full flex justify-between items-center pl-16 pr-5 md:px-5 border-b border-[var(--ib-border)] bg-[var(--ib-surface-raised)]/90 backdrop-blur-xl z-40 sticky top-0 shrink-0 select-none">
      <div className="flex items-center gap-3 min-w-0">
        <h1
          className="font-bold text-base tracking-tight text-[var(--ib-text)] cursor-pointer whitespace-nowrap"
          onClick={() => onViewChange('dashboard')}
        >
          {info.title}
        </h1>
        <div className="h-3.5 w-px bg-[var(--ib-border)] hidden sm:block" />
        <div className="hidden sm:flex items-center gap-1.5 text-xs text-[var(--ib-text-muted)] bg-[var(--ib-gray-50)] px-2.5 py-1 rounded-lg border border-[var(--ib-border)]">
          <Sparkles className="w-3 h-3 text-[var(--ib-blue-500)]" />
          <span className="truncate max-w-[180px]">{info.subtitle}</span>
        </div>
        <span className="hidden lg:inline-block bg-[var(--ib-good-fill)] text-[var(--ib-good-text)] border border-[var(--ib-good-dot)]/30 text-[9px] font-bold tracking-wider px-2 py-0.5 rounded uppercase whitespace-nowrap">
          {info.badge}
        </span>
      </div>

      <div className="flex items-center gap-2 flex-shrink-0">
        {/* Search: full field >=sm, collapses to a 44px icon button below sm
            (theme brief, sub-unit 3) -- tapping it expands an inline field
            below the header rather than navigating anywhere. */}
        <div className="relative hidden sm:flex items-center bg-[var(--ib-gray-50)] rounded-lg border border-[var(--ib-border)] w-44 hover:border-[var(--ib-blue-500)]/40 focus-within:border-[var(--ib-blue-500)] focus-within:shadow-[var(--ib-shadow-focus)] transition-all">
          <Search className="w-3.5 h-3.5 text-[var(--ib-text-muted)] absolute left-2.5" />
          <input
            type="text"
            className="bg-transparent border-none focus:ring-0 text-base md:text-sm text-[var(--ib-text)] pl-8 pr-3 py-2 w-full outline-none placeholder:text-[var(--ib-text-muted)]"
            placeholder={currentView === 'support' ? 'Search FAQs...' : 'Search...'}
            value={searchFilter}
            onChange={e => onSearchChange(e.target.value)}
          />
        </div>
        <button
          onClick={() => setMobileSearchOpen(v => !v)}
          aria-label="Search"
          aria-expanded={mobileSearchOpen}
          className="sm:hidden w-11 h-11 flex items-center justify-center rounded-lg text-[var(--ib-text-muted)] hover:bg-[var(--ib-gray-100)] hover:text-[var(--ib-text)] transition-colors cursor-pointer"
        >
          <Search className="w-4 h-4" />
        </button>

        {/* pointer-coarse:hidden -- a keyboard shortcut hint is meaningless on
            a touch-primary device even at a width where the sm breakpoint
            would otherwise show it (a touchscreen laptop, say). */}
        <button
          onClick={() => window.dispatchEvent(new CustomEvent('ibconnect:cmdk'))}
          title="Command palette (Ctrl/Cmd+K)"
          className="hidden md:flex pointer-coarse:hidden items-center gap-1 bg-[var(--ib-gray-50)] border border-[var(--ib-border)] hover:border-[var(--ib-blue-500)]/40 text-[var(--ib-text-muted)] hover:text-[var(--ib-blue-500)] rounded-lg px-2 py-1.5 text-[10px] font-bold transition-colors cursor-pointer"
        >
          <Command className="w-3 h-3" />K
        </button>

        {currentView !== 'active_meeting' && currentView !== 'dashboard' && (
          <button
            onClick={handleAction}
            className="flex items-center gap-1.5 bg-[var(--ib-blue-500)] text-white font-bold text-xs py-2 px-3 rounded-lg hover:bg-[var(--ib-blue-600)] active:scale-95 transition-all shadow-[var(--ib-shadow-sm)]"
          >
            <Plus className="w-3.5 h-3.5 stroke-[2.5]" />
            <span className="hidden sm:inline">{actionLabel}</span>
          </button>
        )}

        <div className="h-5 w-px bg-[var(--ib-border)]" />

        {/* Notifications: anchored popover >=md, bottom sheet <md (theme brief, sub-unit 3). */}
        <div className="hidden md:block relative">
          <button
            onClick={() => setNotifOpen(v => !v)}
            aria-label="Notifications"
            aria-expanded={notifOpen}
            className="w-8 h-8 flex items-center justify-center rounded-lg text-[var(--ib-text-muted)] hover:bg-[var(--ib-gray-100)] hover:text-[var(--ib-blue-500)] transition-colors relative cursor-pointer"
          >
            <Bell className="w-4 h-4" />
            {showNotifDot && <span className="absolute top-1.5 right-1.5 w-1.5 h-1.5 rounded-full bg-[var(--ib-bad-dot)]" />}
          </button>
          {notifOpen && (
            <>
              <button aria-label="Close notifications" onClick={() => setNotifOpen(false)} className="fixed inset-0 z-40 cursor-default" />
              <div className="absolute right-0 top-11 z-50 w-72 rounded-2xl border border-[var(--ib-border)] bg-[var(--ib-surface-raised)] p-3 shadow-[var(--ib-shadow-lg)]">
                <NotificationsBody unreadTotal={unreadTotal} onOpenChats={openChatsFromNotif} />
              </div>
            </>
          )}
        </div>
        <button
          onClick={() => setNotifOpen(true)}
          aria-label="Notifications"
          className="md:hidden w-11 h-11 flex items-center justify-center rounded-lg text-[var(--ib-text-muted)] hover:bg-[var(--ib-gray-100)] transition-colors relative cursor-pointer"
        >
          <Bell className="w-4 h-4" />
          {showNotifDot && <span className="absolute top-2 right-2 w-1.5 h-1.5 rounded-full bg-[var(--ib-bad-dot)]" />}
        </button>
        <div className="md:hidden">
          <Modal open={notifOpen} onClose={() => setNotifOpen(false)} variant="sheet" aria-label="Notifications">
            <div className="p-3">
              <NotificationsBody unreadTotal={unreadTotal} onOpenChats={openChatsFromNotif} />
            </div>
          </Modal>
        </div>

        <button
          onClick={() => onViewChange('support')}
          className="w-11 h-11 md:w-8 md:h-8 flex items-center justify-center rounded-lg text-[var(--ib-text-muted)] hover:bg-[var(--ib-gray-100)] hover:text-[var(--ib-blue-500)] transition-colors cursor-pointer"
          title="Help"
        >
          <HelpCircle className="w-4 h-4" />
        </button>
      </div>
    </header>
    {mobileSearchOpen && (
      <div className="sm:hidden sticky top-14 z-30 bg-[var(--ib-surface-raised)] border-b border-[var(--ib-border)] px-4 py-2.5">
        <div className="relative flex items-center bg-[var(--ib-gray-50)] rounded-lg border border-[var(--ib-border)] focus-within:border-[var(--ib-blue-500)] focus-within:shadow-[var(--ib-shadow-focus)]">
          <Search className="w-3.5 h-3.5 text-[var(--ib-text-muted)] absolute left-2.5" />
          <input
            autoFocus
            type="text"
            className="bg-transparent border-none focus:ring-0 text-base text-[var(--ib-text)] pl-8 pr-3 py-2.5 w-full outline-none placeholder:text-[var(--ib-text-muted)] touch-manipulation"
            placeholder={currentView === 'support' ? 'Search FAQs...' : 'Search...'}
            value={searchFilter}
            onChange={e => onSearchChange(e.target.value)}
          />
        </div>
      </div>
    )}
    </>
  );
}
