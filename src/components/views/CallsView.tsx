import React, { useState, useEffect } from 'react';
import { Phone, Video, PhoneIncoming, PhoneOutgoing, PhoneMissed, Search, Users, Clock } from 'lucide-react';
import { CallRecord, IBUser } from '../../types';
import { useAuth } from '../../context/AuthContext';
import { useMeeting } from '../../context/MeetingContext';
import UserProfileModal from '../chat/UserProfileModal';
import { useChat } from '../../context/ChatContext';
import { loadCalls, saveCalls } from '../../lib/callsLocal';

function formatCallTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const diffDays = Math.floor((now.getTime() - d.getTime()) / 86400000);
  if (diffDays === 0) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return d.toLocaleDateString('en-US', { weekday: 'long' });
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// Status pill (sub-unit 5) -- was a bare icon with no label or container;
// good/bad/neutral tokens give incoming/missed the same at-a-glance
// severity reading QualityBadge and Badge already use elsewhere.
function CallStatusPill({ type }: { type: CallRecord['type'] }) {
  const cfg = {
    incoming: { Icon: PhoneIncoming, cls: 'bg-[var(--ib-good-fill)] text-[var(--ib-good-text)]', label: 'Incoming' },
    outgoing: { Icon: PhoneOutgoing, cls: 'bg-[var(--ib-blue-50)] text-[var(--ib-blue-800)]', label: 'Outgoing' },
    missed: { Icon: PhoneMissed, cls: 'bg-[var(--ib-bad-fill)] text-[var(--ib-bad-text)]', label: 'Missed' },
  }[type];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[9px] font-semibold ${cfg.cls}`}>
      <cfg.Icon className="w-2.5 h-2.5" />{cfg.label}
    </span>
  );
}

export default function CallsView({ onJoinMeeting }: { onJoinMeeting: () => void }) {
  const { currentUser, allUsers } = useAuth();
  const { createMeeting } = useMeeting();
  const { startDM, notifyCallInvite } = useChat();
  const [calls, setCalls] = useState<CallRecord[]>([]);
  const [search, setSearch] = useState('');
  const [viewingUser, setViewingUser] = useState<IBUser | null>(null);
  const [calling, setCalling] = useState<string | null>(null);
  const [mobilePanel, setMobilePanel] = useState<'history' | 'contacts'>('history');

  useEffect(() => {
    if (currentUser) setCalls(loadCalls(currentUser.id));
  }, [currentUser?.id]);

  const otherUsers = allUsers.filter(u => u.id !== currentUser?.id);
  const filteredUsers = otherUsers.filter(u =>
    u.displayName.toLowerCase().includes(search.toLowerCase()) ||
    u.username.toLowerCase().includes(search.toLowerCase())
  );

  const handleCall = async (user: IBUser, type: 'video' | 'audio') => {
    if (!currentUser) return;
    setCalling(user.id);
    try {
      const roomId = await createMeeting(undefined, undefined, type === 'audio' ? { muted: false, videoOff: true } : undefined);
      notifyCallInvite(user.id, roomId, currentUser.displayName, type);
      // Log call record
      const record: CallRecord = {
        id: `call-${Date.now()}`,
        type: 'outgoing',
        callType: type,
        participantId: user.id,
        participantName: user.displayName,
        participantAvatar: user.avatar,
        timestamp: Date.now(),
      };
      const updated = [record, ...loadCalls(currentUser.id)].slice(0, 50);
      saveCalls(currentUser.id, updated);
      setCalls(updated);
      onJoinMeeting();
    } catch {
      // error handled by meeting context
    } finally {
      setCalling(null);
    }
  };

  // Two panels side by side only once there's room for both. Below `lg` they were
  // still laid out side by side — a fixed 320px history rail plus the contacts
  // pane — which on a 390px phone left the contacts list a ~70px slice pinned to
  // the right edge, and on a 320px phone pushed it off-screen entirely. Same
  // treatment ChatsView already uses: one panel at a time with a switcher.
  const renderHistory = () => (
    <>
      <div className="p-4 border-b border-[var(--ib-border)] sticky top-0 bg-[var(--ib-surface-raised)] z-10">
          <h2 className="font-bold text-sm text-[var(--ib-text)] mb-3">Recent Calls</h2>
          <button
            onClick={async () => {
              if (!currentUser) return;
              try {
                await createMeeting();
                onJoinMeeting();
              } catch {}
            }}
            className="w-full flex items-center justify-center gap-2 bg-[var(--ib-blue-500)] text-white font-bold py-2.5 rounded-xl text-xs hover:bg-[var(--ib-blue-600)] transition-colors cursor-pointer"
          >
            <Video className="w-4 h-4" />
            Start Instant Meeting
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {calls.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center px-4">
              <div className="w-12 h-12 rounded-2xl bg-[var(--ib-blue-50)] flex items-center justify-center mb-3">
                <Phone className="w-6 h-6 text-[var(--ib-blue-500)]" />
              </div>
              <p className="text-sm font-semibold text-[var(--ib-text)]">No recent calls</p>
              <p className="text-xs text-[var(--ib-text-muted)] mt-1">Start a call from the contacts list</p>
            </div>
          ) : (
            <div className="py-2">
              {calls.map(call => (
                <div key={call.id} className="flex items-center gap-3 px-4 py-3 hover:bg-[var(--ib-gray-50)] cursor-pointer transition-colors">
                  <div className="relative flex-shrink-0">
                    {call.participantAvatar ? (
                      <img src={call.participantAvatar} alt={call.participantName} className="w-10 h-10 rounded-full object-cover" />
                    ) : (
                      <div className="w-10 h-10 rounded-full bg-[var(--ib-blue-50)] flex items-center justify-center">
                        <span className="text-sm font-bold text-[var(--ib-blue-500)]">{call.participantName.charAt(0).toUpperCase()}</span>
                      </div>
                    )}
                    <div className="absolute -bottom-0.5 -right-0.5 w-5 h-5 rounded-full bg-[var(--ib-surface-raised)] border border-[var(--ib-border)] flex items-center justify-center">
                      {call.callType === 'video' ? (
                        <Video className="w-3 h-3 text-[var(--ib-blue-500)]" />
                      ) : (
                        <Phone className="w-3 h-3 text-[var(--ib-blue-500)]" />
                      )}
                    </div>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold text-xs text-[var(--ib-text)]">{call.participantName}</div>
                    <div className="flex items-center gap-1.5 mt-1">
                      <CallStatusPill type={call.type} />
                      <span className="text-[10px] text-[var(--ib-text-muted)]">{formatCallTime(call.timestamp)}</span>
                      {call.duration && (
                        <>
                          <span className="text-[var(--ib-border)]">·</span>
                          <Clock className="w-3 h-3 text-[var(--ib-text-muted)]" />
                          <span className="text-[10px] text-[var(--ib-text-muted)]">{call.duration}</span>
                        </>
                      )}
                    </div>
                  </div>
                  <button
                    onClick={() => {
                      const user = allUsers.find(u => u.id === call.participantId);
                      if (user) handleCall(user, call.callType);
                    }}
                    aria-label={`Call ${call.participantName} back`}
                    className="w-11 h-11 rounded-lg bg-[var(--ib-blue-50)] text-[var(--ib-blue-500)] flex items-center justify-center hover:bg-[var(--ib-blue-500)]/20 transition-colors cursor-pointer shrink-0"
                  >
                    {call.callType === 'video' ? <Video className="w-4 h-4" /> : <Phone className="w-4 h-4" />}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
    </>
  );

  const renderContacts = () => (
    <>
      <div className="p-4 border-b border-[var(--ib-border)] sticky top-0 bg-[var(--ib-surface-raised)] z-10">
          <div className="flex items-center gap-2 mb-3">
            <Users className="w-4 h-4 text-[var(--ib-blue-500)]" />
            <h2 className="font-bold text-sm text-[var(--ib-text)]">IB Connect Users</h2>
            <span className="text-[10px] bg-[var(--ib-blue-50)] text-[var(--ib-blue-800)] px-2 py-0.5 rounded-full font-bold">{otherUsers.length}</span>
          </div>
          <div className="relative">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-[var(--ib-text-muted)]" />
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search users..."
              className="w-full h-11 bg-[var(--ib-gray-50)] border border-[var(--ib-border)] rounded-xl pl-9 pr-4 text-base sm:text-xs text-[var(--ib-text)] placeholder-[var(--ib-text-muted)] focus:border-[var(--ib-blue-500)] outline-none touch-manipulation"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {filteredUsers.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <div className="w-12 h-12 rounded-2xl bg-[var(--ib-blue-50)] flex items-center justify-center mb-3">
                <Users className="w-6 h-6 text-[var(--ib-blue-500)]" />
              </div>
              <p className="text-sm font-semibold text-[var(--ib-text)]">
                {otherUsers.length === 0 ? 'No other users yet' : 'No users found'}
              </p>
              <p className="text-xs text-[var(--ib-text-muted)] mt-1">
                {otherUsers.length === 0 ? 'Invite colleagues to IB Connect to call them' : 'Try a different search'}
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {filteredUsers.map(user => (
                <div key={user.id} className="bg-[var(--ib-surface-raised)] border border-[var(--ib-border)] rounded-xl p-4 hover:shadow-[var(--ib-shadow-sm)] transition-all">
                  <div className="flex items-center gap-3 mb-3">
                    <div
                      className="relative cursor-pointer"
                      onClick={() => setViewingUser(user)}
                    >
                      {user.avatar ? (
                        <img src={user.avatar} alt={user.displayName} className="w-12 h-12 rounded-full object-cover" />
                      ) : (
                        <div className="w-12 h-12 rounded-full bg-[var(--ib-blue-50)] flex items-center justify-center">
                          <span className="text-lg font-bold text-[var(--ib-blue-500)]">{user.displayName.charAt(0).toUpperCase()}</span>
                        </div>
                      )}
                      <div className={`absolute bottom-0 right-0 w-3.5 h-3.5 rounded-full border-2 border-[var(--ib-surface-raised)] ${
                        user.status === 'online' ? 'bg-[var(--ib-good-dot)]' : user.status === 'idle' ? 'bg-[var(--ib-warn-dot)]' : 'bg-[var(--ib-gray-400)]'
                      }`} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-bold text-sm text-[var(--ib-text)] truncate">{user.displayName}</p>
                      <p className="text-xs text-[var(--ib-text-muted)]">@{user.username}</p>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => handleCall(user, 'video')}
                      disabled={calling === user.id}
                      className="flex-1 h-11 flex items-center justify-center gap-1.5 bg-[var(--ib-blue-500)] text-white font-bold rounded-lg text-xs hover:bg-[var(--ib-blue-600)] disabled:opacity-50 transition-colors cursor-pointer"
                    >
                      <Video className="w-3.5 h-3.5" />
                      {calling === user.id ? '...' : 'Video'}
                    </button>
                    <button
                      onClick={() => handleCall(user, 'audio')}
                      disabled={calling === user.id}
                      className="flex-1 h-11 flex items-center justify-center gap-1.5 bg-[var(--ib-surface-raised)] text-[var(--ib-text)] border border-[var(--ib-border)] font-bold rounded-lg text-xs hover:bg-[var(--ib-gray-50)] disabled:opacity-50 transition-colors cursor-pointer"
                    >
                      <Phone className="w-3.5 h-3.5 text-[var(--ib-blue-500)]" />
                      Audio
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
    </>
  );

  const tab = (id: 'history' | 'contacts', label: string, count?: number) => (
    <button
      onClick={() => setMobilePanel(id)}
      className={`flex-1 flex items-center justify-center gap-1.5 h-11 rounded-lg text-xs font-bold transition-colors cursor-pointer ${
        mobilePanel === id ? 'bg-[var(--ib-blue-500)] text-white' : 'text-[var(--ib-text-muted)] hover:text-[var(--ib-text)]'
      }`}
    >
      {label}
      {count !== undefined && (
        <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-bold ${
          mobilePanel === id ? 'bg-white/20 text-white' : 'bg-[var(--ib-blue-50)] text-[var(--ib-blue-800)]'
        }`}>{count}</span>
      )}
    </button>
  );

  return (
    <div className="flex-1 flex flex-col lg:flex-row overflow-hidden h-full">
      {viewingUser && (
        <UserProfileModal
          user={viewingUser}
          onClose={() => setViewingUser(null)}
          onStartChat={() => { startDM(viewingUser.id); }}
          onStartCall={() => handleCall(viewingUser, 'video')}
        />
      )}

      {/* Narrow screens: one panel at a time */}
      <div className="lg:hidden flex-1 flex flex-col overflow-hidden bg-[var(--ib-surface-raised)]">
        <div className="flex gap-1 p-2 border-b border-[var(--ib-border)] bg-[var(--ib-surface-raised)]">
          {tab('history', 'Recent')}
          {tab('contacts', 'Contacts', otherUsers.length)}
        </div>
        <div className="flex-1 flex flex-col overflow-hidden">
          {mobilePanel === 'history' ? renderHistory() : renderContacts()}
        </div>
      </div>

      {/* Wide screens: history rail + contacts, as before */}
      <aside className="hidden lg:flex w-80 flex-shrink-0 flex-col border-r border-[var(--ib-border)] bg-[var(--ib-surface-raised)]">
        {renderHistory()}
      </aside>
      <main className="hidden lg:flex flex-1 flex-col bg-[var(--ib-surface)] overflow-hidden">
        {renderContacts()}
      </main>
    </div>
  );
}
