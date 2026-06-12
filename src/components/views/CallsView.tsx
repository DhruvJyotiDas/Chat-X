import React, { useState, useEffect } from 'react';
import { Phone, Video, PhoneIncoming, PhoneOutgoing, PhoneMissed, PhoneOff, Search, Users, Clock } from 'lucide-react';
import { CallRecord, IBUser } from '../../types';
import { useAuth } from '../../context/AuthContext';
import { useMeeting } from '../../context/MeetingContext';
import UserProfileModal from '../chat/UserProfileModal';
import { useChat } from '../../context/ChatContext';

const CALLS_KEY = (userId: string) => `ibconnect_calls_${userId}`;

function loadCalls(userId: string): CallRecord[] {
  try { return JSON.parse(localStorage.getItem(CALLS_KEY(userId)) || '[]'); } catch { return []; }
}
function saveCalls(userId: string, calls: CallRecord[]) {
  localStorage.setItem(CALLS_KEY(userId), JSON.stringify(calls));
}

function formatCallTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const diffDays = Math.floor((now.getTime() - d.getTime()) / 86400000);
  if (diffDays === 0) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return d.toLocaleDateString('en-US', { weekday: 'long' });
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export default function CallsView({ onJoinMeeting }: { onJoinMeeting: () => void }) {
  const { currentUser, allUsers } = useAuth();
  const { createMeeting } = useMeeting();
  const { startDM, notifyCallInvite } = useChat();
  const [calls, setCalls] = useState<CallRecord[]>([]);
  const [search, setSearch] = useState('');
  const [viewingUser, setViewingUser] = useState<IBUser | null>(null);
  const [calling, setCalling] = useState<string | null>(null);

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
      const roomId = await createMeeting();
      notifyCallInvite(user.id, roomId, currentUser.displayName);
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

  const CallIcon = ({ type }: { type: CallRecord['type'] }) => {
    if (type === 'incoming') return <PhoneIncoming className="w-4 h-4 text-[#4dffb1]" />;
    if (type === 'outgoing') return <PhoneOutgoing className="w-4 h-4 text-[#b0c6ff]" />;
    return <PhoneMissed className="w-4 h-4 text-[#ffb4ab]" />;
  };

  return (
    <div className="flex-1 flex overflow-hidden h-full">
      {viewingUser && (
        <UserProfileModal
          user={viewingUser}
          onClose={() => setViewingUser(null)}
          onStartChat={() => { startDM(viewingUser.id); }}
          onStartCall={() => handleCall(viewingUser, 'video')}
        />
      )}

      {/* Call history */}
      <aside className="w-80 flex-shrink-0 flex flex-col border-r border-[#424655] bg-[#0e0e0e]">
        <div className="p-4 border-b border-[#424655] sticky top-0 bg-[#0e0e0e] z-10">
          <h2 className="font-bold text-sm text-[#e5e2e1] mb-3">Recent Calls</h2>
          <button
            onClick={async () => {
              if (!currentUser) return;
              try {
                await createMeeting();
                onJoinMeeting();
              } catch {}
            }}
            className="w-full flex items-center justify-center gap-2 bg-[#568dff] text-[#002661] font-bold py-2.5 rounded-xl text-xs hover:bg-[#568dff]/90 transition-colors"
          >
            <Video className="w-4 h-4" />
            Start Instant Meeting
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {calls.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center px-4">
              <div className="w-12 h-12 rounded-2xl bg-[#568dff]/10 flex items-center justify-center mb-3">
                <Phone className="w-6 h-6 text-[#b0c6ff]" />
              </div>
              <p className="text-sm font-semibold text-[#e5e2e1]">No recent calls</p>
              <p className="text-xs text-[#8c90a1] mt-1">Start a call from the contacts list</p>
            </div>
          ) : (
            <div className="py-2">
              {calls.map(call => (
                <div key={call.id} className="flex items-center gap-3 px-4 py-3 hover:bg-[#131313] cursor-pointer transition-colors">
                  <div className="relative flex-shrink-0">
                    {call.participantAvatar ? (
                      <img src={call.participantAvatar} alt={call.participantName} className="w-10 h-10 rounded-full object-cover" />
                    ) : (
                      <div className="w-10 h-10 rounded-full bg-[#568dff]/10 flex items-center justify-center">
                        <span className="text-sm font-bold text-[#b0c6ff]">{call.participantName.charAt(0).toUpperCase()}</span>
                      </div>
                    )}
                    <div className="absolute -bottom-0.5 -right-0.5 w-5 h-5 rounded-full bg-[#0e0e0e] flex items-center justify-center">
                      {call.callType === 'video' ? (
                        <Video className="w-3 h-3 text-[#b0c6ff]" />
                      ) : (
                        <Phone className="w-3 h-3 text-[#b0c6ff]" />
                      )}
                    </div>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold text-xs text-[#e5e2e1]">{call.participantName}</div>
                    <div className="flex items-center gap-1 mt-0.5">
                      <CallIcon type={call.type} />
                      <span className="text-[10px] text-[#8c90a1]">{formatCallTime(call.timestamp)}</span>
                      {call.duration && (
                        <>
                          <span className="text-[#424655]">·</span>
                          <Clock className="w-3 h-3 text-[#8c90a1]" />
                          <span className="text-[10px] text-[#8c90a1]">{call.duration}</span>
                        </>
                      )}
                    </div>
                  </div>
                  <button
                    onClick={() => {
                      const user = allUsers.find(u => u.id === call.participantId);
                      if (user) handleCall(user, call.callType);
                    }}
                    className="w-8 h-8 rounded-lg bg-[#568dff]/10 text-[#b0c6ff] flex items-center justify-center hover:bg-[#568dff]/20 transition-colors"
                  >
                    {call.callType === 'video' ? <Video className="w-3.5 h-3.5" /> : <Phone className="w-3.5 h-3.5" />}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </aside>

      {/* Contacts / New Call */}
      <main className="flex-1 flex flex-col bg-[#0e0e0e] overflow-hidden">
        <div className="p-4 border-b border-[#424655] sticky top-0 bg-[#0e0e0e] z-10">
          <div className="flex items-center gap-2 mb-3">
            <Users className="w-4 h-4 text-[#b0c6ff]" />
            <h2 className="font-bold text-sm text-[#e5e2e1]">IB Connect Users</h2>
            <span className="text-[10px] bg-[#568dff]/15 text-[#b0c6ff] px-2 py-0.5 rounded-full font-bold">{otherUsers.length}</span>
          </div>
          <div className="relative">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-[#8c90a1]" />
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search users..."
              className="w-full bg-[#131313] border border-[#424655] rounded-xl pl-9 pr-4 py-2.5 text-xs text-[#e5e2e1] placeholder-[#8c90a1]/60 focus:border-[#568dff] outline-none"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {filteredUsers.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <div className="w-12 h-12 rounded-2xl bg-[#568dff]/10 flex items-center justify-center mb-3">
                <Users className="w-6 h-6 text-[#b0c6ff]" />
              </div>
              <p className="text-sm font-semibold text-[#e5e2e1]">
                {otherUsers.length === 0 ? 'No other users yet' : 'No users found'}
              </p>
              <p className="text-xs text-[#8c90a1] mt-1">
                {otherUsers.length === 0 ? 'Invite colleagues to IB Connect to call them' : 'Try a different search'}
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {filteredUsers.map(user => (
                <div key={user.id} className="bg-[#131313] border border-[#424655]/60 rounded-xl p-4 hover:border-[#424655] transition-colors">
                  <div className="flex items-center gap-3 mb-3">
                    <div
                      className="relative cursor-pointer"
                      onClick={() => setViewingUser(user)}
                    >
                      {user.avatar ? (
                        <img src={user.avatar} alt={user.displayName} className="w-12 h-12 rounded-full object-cover" />
                      ) : (
                        <div className="w-12 h-12 rounded-full bg-[#568dff]/10 flex items-center justify-center">
                          <span className="text-lg font-bold text-[#b0c6ff]">{user.displayName.charAt(0).toUpperCase()}</span>
                        </div>
                      )}
                      <div className={`absolute bottom-0 right-0 w-3.5 h-3.5 rounded-full border-2 border-[#131313] ${
                        user.status === 'online' ? 'bg-[#4dffb1]' : user.status === 'idle' ? 'bg-[#ffd60a]' : 'bg-[#8c90a1]'
                      }`} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-bold text-sm text-[#e5e2e1] truncate">{user.displayName}</p>
                      <p className="text-xs text-[#8c90a1]">@{user.username}</p>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => handleCall(user, 'video')}
                      disabled={calling === user.id}
                      className="flex-1 flex items-center justify-center gap-1.5 bg-[#568dff] text-[#002661] font-bold py-2 rounded-lg text-xs hover:bg-[#568dff]/90 disabled:opacity-50 transition-colors"
                    >
                      <Video className="w-3.5 h-3.5" />
                      {calling === user.id ? '...' : 'Video'}
                    </button>
                    <button
                      onClick={() => handleCall(user, 'audio')}
                      disabled={calling === user.id}
                      className="flex-1 flex items-center justify-center gap-1.5 bg-[#201f1f] text-[#e5e2e1] border border-[#424655] font-bold py-2 rounded-lg text-xs hover:bg-[#2a2a2a] disabled:opacity-50 transition-colors"
                    >
                      <Phone className="w-3.5 h-3.5 text-[#b0c6ff]" />
                      Audio
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
