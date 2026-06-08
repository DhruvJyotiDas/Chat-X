import React, { useState } from 'react';
import { Video, Plus, Link2, Calendar, Clock, Users, AlertCircle, ChevronRight, Bolt, History, VideoOff, Trash2 } from 'lucide-react';
import { useMeeting } from '../../context/MeetingContext';
import { useAuth } from '../../context/AuthContext';
import ScheduleMeetingModal from '../meeting/ScheduleMeetingModal';

interface MeetingRecord { id: string; title?: string; roomCode: string; isHost: boolean; startedAt: string; endedAt?: string; participantCount: number; }
interface Props { onJoinMeeting: () => void; autoJoinCode?: string; onAutoJoinConsumed?: () => void; }

function formatRecordDate(iso: string): string { try { return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch { return iso; } }
function formatScheduledDate(dateStr: string, timeStr: string): string { try { const d = new Date(`${dateStr}T${timeStr}`); return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) + ' · ' + d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }); } catch { return `${dateStr} ${timeStr}`; } }
function getDuration(record: MeetingRecord): string { if (!record.endedAt) return 'In Progress'; const mins = Math.round((new Date(record.endedAt).getTime() - new Date(record.startedAt).getTime()) / 60000); if (mins < 1) return '< 1 min'; if (mins < 60) return `${mins}m`; return `${Math.floor(mins / 60)}h ${mins % 60}m`; }
function isRejoinable(record: MeetingRecord): boolean { if (!record.endedAt) return true; return Date.now() - new Date(record.endedAt).getTime() < 30 * 60 * 1000; }

export default function DebriefView({ onJoinMeeting, autoJoinCode, onAutoJoinConsumed }: Props) {
  const { createMeeting, joinMeeting, meetingError, clearMeetingError, scheduledMeetings, deleteScheduledMeeting } = useMeeting();
  const { currentUser } = useAuth();

  const [meetingCode, setMeetingCode] = useState(autoJoinCode ?? '');
  const [showScheduleModal, setShowScheduleModal] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [isJoining, setIsJoining] = useState(false);

  React.useEffect(() => { if (autoJoinCode) { setMeetingCode(autoJoinCode); onAutoJoinConsumed?.(); } }, [autoJoinCode, onAutoJoinConsumed]);

  const historyKey = `ibconnect_meeting_history_${currentUser?.id ?? 'guest'}`;
  const history: MeetingRecord[] = (() => { try { return JSON.parse(localStorage.getItem(historyKey) || '[]'); } catch { return []; } })();

  const handleCreate = async () => { setIsCreating(true); clearMeetingError(); try { const roomCode = await createMeeting(); window.history.replaceState(null, '', `/${roomCode}`); onJoinMeeting(); } catch {} finally { setIsCreating(false); } };
  const handleJoin = async (code?: string) => { const target = (code ?? meetingCode).trim().toUpperCase(); if (!target) return; setIsJoining(true); clearMeetingError(); try { const roomCode = await joinMeeting(target); window.history.replaceState(null, '', `/${roomCode}`); onJoinMeeting(); } catch {} finally { setIsJoining(false); } };

  return (
    <div className="flex-1 overflow-y-auto p-3 sm:p-6 select-none scrollbar-hide">
      {showScheduleModal && <ScheduleMeetingModal onClose={() => setShowScheduleModal(false)} />}
      <div className="max-w-4xl mx-auto flex flex-col gap-4 sm:gap-6">
        {meetingError && (
          <div className="bg-[#93000a]/20 border border-[#ffb4ab]/30 rounded-xl p-3 sm:p-4 flex items-center gap-3">
            <AlertCircle className="w-4 h-4 text-[#ffb4ab] shrink-0" /><p className="text-xs text-[#ffb4ab] flex-1">{meetingError}</p><button onClick={clearMeetingError} className="text-[#ffb4ab] hover:text-white cursor-pointer text-xs font-bold">✕</button>
          </div>
        )}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
          <button onClick={handleCreate} disabled={isCreating} className="group relative bg-[#1c1b1b] border border-[#424655] hover:border-[#568dff]/60 rounded-2xl p-5 sm:p-6 flex flex-col gap-3 transition-all hover:bg-[#1c1b1b]/80 cursor-pointer disabled:opacity-60 text-left overflow-hidden">
            <div className="absolute inset-0 bg-gradient-to-br from-[#568dff]/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none" />
            <div className="w-10 h-10 sm:w-12 sm:h-12 rounded-xl bg-[#568dff]/10 flex items-center justify-center"><Video className="w-5 h-5 sm:w-6 sm:h-6 text-[#b0c6ff]" /></div>
            <div><h3 className="font-bold text-sm text-[#e5e2e1]">{isCreating ? 'Starting…' : 'Start New Meeting'}</h3><p className="text-xs text-[#8c90a1] mt-1">Create a secure room and share the code with others</p></div>
            <div className="flex items-center gap-1.5 text-xs font-semibold text-[#b0c6ff]"><Bolt className="w-3.5 h-3.5 text-[#70ffba]" /><span>Instant start</span><ChevronRight className="w-3.5 h-3.5 ml-auto" /></div>
          </button>
          <div className="bg-[#1c1b1b] border border-[#424655] rounded-2xl p-5 sm:p-6 flex flex-col gap-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 sm:w-12 sm:h-12 rounded-xl bg-[#c0c1ff]/10 flex items-center justify-center shrink-0"><Link2 className="w-5 h-5 sm:w-6 sm:h-6 text-[#c0c1ff]" /></div>
              <div><h3 className="font-bold text-sm text-[#e5e2e1]">Join a Meeting</h3><p className="text-xs text-[#8c90a1] mt-0.5">Enter a room code to join</p></div>
            </div>
            <div className="flex items-center gap-2 bg-[#131313] rounded-xl border border-[#424655] focus-within:border-[#568dff] transition-all overflow-hidden">
              <input type="text" placeholder="ENTER ROOM CODE…" className="flex-1 pl-3 sm:pl-4 pr-2 py-3 bg-transparent text-xs text-[#e5e2e1] placeholder-[#8c90a1]/60 outline-none uppercase font-mono min-w-0" value={meetingCode} onChange={e => setMeetingCode(e.target.value.toUpperCase())} onKeyDown={e => e.key === 'Enter' && handleJoin()} />
              <button onClick={() => handleJoin()} disabled={isJoining || !meetingCode.trim()} className="mr-1.5 bg-[#568dff] text-[#002661] px-3 sm:px-4 py-1.5 rounded-lg text-xs font-bold hover:bg-[#568dff]/90 disabled:opacity-40 cursor-pointer disabled:cursor-not-allowed transition-colors shrink-0">{isJoining ? '…' : 'Join'}</button>
            </div>
          </div>
        </div>

        <div className="bg-[#1c1b1b] border border-[#424655] rounded-2xl p-4 sm:p-5">
          <div className="flex justify-between items-center mb-4">
            <h3 className="font-semibold text-sm text-[#e5e2e1] flex items-center gap-2"><Calendar className="w-4 h-4 text-[#b0c6ff]" />Scheduled Meetings</h3>
            <button onClick={() => setShowScheduleModal(true)} className="flex items-center gap-1.5 text-[#b0c6ff] hover:text-[#568dff] font-bold text-xs cursor-pointer transition-colors"><Plus className="w-3.5 h-3.5" /><span>Schedule</span></button>
          </div>
          {scheduledMeetings.length === 0 ? (
            <div className="text-center py-6 sm:py-8">
              <Calendar className="w-8 h-8 text-[#424655] mx-auto mb-2" />
              <p className="text-xs text-[#8c90a1]">No scheduled meetings yet</p>
            </div>
          ) : (
            <div className="space-y-2">
              {scheduledMeetings.map(sm => (
                  <div key={sm.id} className="flex items-center justify-between p-3 bg-[#201f1f] border border-[#424655]/60 rounded-xl hover:border-[#b0c6ff]/30 transition-colors gap-2">
                    <div className="flex items-center gap-3 min-w-0 flex-1">
                      <div className="w-8 h-8 rounded-lg bg-[#568dff]/10 flex items-center justify-center shrink-0"><Calendar className="w-4 h-4 text-[#b0c6ff]" /></div>
                      <div className="min-w-0">
                        <p className="text-xs font-semibold text-[#e5e2e1] truncate">{sm.title || 'Untitled Meeting'}</p>
                        <p className="text-[10px] text-[#8c90a1]">{formatScheduledDate(sm.date, sm.time)}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="font-mono text-[10px] text-[#b0c6ff] bg-[#568dff]/10 px-2 py-0.5 rounded hidden xs:block">{sm.code}</span>
                      <button onClick={() => handleJoin(sm.code)} disabled={isJoining} className="text-[10px] text-[#002661] bg-[#568dff] hover:bg-[#568dff]/90 font-bold px-2.5 py-1.5 rounded-lg cursor-pointer transition-colors disabled:opacity-50">
                        {isJoining ? '…' : 'Join'}
                      </button>
                      <button onClick={() => deleteScheduledMeeting(sm.id)} className="w-7 h-7 flex items-center justify-center bg-[#93000a]/20 text-[#ffb4ab] rounded-lg hover:bg-[#93000a]/40 transition-colors" title="Delete Meeting">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
              ))}
            </div>
          )}
        </div>

        <div className="bg-[#1c1b1b] border border-[#424655] rounded-2xl p-4 sm:p-5">
          <div className="flex items-center gap-2 mb-4"><History className="w-4 h-4 text-[#b0c6ff]" /><h3 className="font-semibold text-sm text-[#e5e2e1]">Recent Meetings</h3></div>
          {history.length === 0 ? (
            <div className="text-center py-6 sm:py-8"><VideoOff className="w-8 h-8 text-[#424655] mx-auto mb-2" /><p className="text-xs text-[#8c90a1]">No meetings yet</p></div>
          ) : (
            <div className="space-y-2">
              {[...history].reverse().slice(0, 15).map(record => (
                  <div key={record.id} className="flex items-center gap-3 p-3 bg-[#201f1f] border border-[#424655]/60 rounded-xl hover:border-[#424655] transition-colors">
                    <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${record.isHost ? 'bg-[#568dff]/10' : 'bg-[#c0c1ff]/10'}`}><Video className={`w-4 h-4 ${record.isHost ? 'text-[#b0c6ff]' : 'text-[#c0c1ff]'}`} /></div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-mono text-xs font-bold text-[#e5e2e1]">{record.title || record.roomCode}</span>
                        <span className={`text-[9px] font-black px-1.5 py-0.5 rounded ${record.isHost ? 'bg-[#568dff]/10 text-[#b0c6ff]' : 'bg-[#c0c1ff]/10 text-[#c0c1ff]'}`}>{record.isHost ? 'HOST' : 'JOINED'}</span>
                        {!record.endedAt && <span className="text-[9px] font-black px-1.5 py-0.5 rounded bg-[#4dffb1]/10 text-[#4dffb1]">ACTIVE</span>}
                      </div>
                      <div className="flex items-center gap-2 sm:gap-3 mt-0.5 flex-wrap">
                        <span className="text-[10px] text-[#8c90a1]">{formatRecordDate(record.startedAt)}</span>
                        <span className="text-[10px] text-[#8c90a1] flex items-center gap-1"><Clock className="w-2.5 h-2.5" />{getDuration(record)}</span>
                        <span className="text-[10px] text-[#8c90a1] flex items-center gap-1"><Users className="w-2.5 h-2.5" />{record.participantCount}</span>
                      </div>
                    </div>
                    {isRejoinable(record) && (
                      <button onClick={() => handleJoin(record.roomCode)} disabled={isJoining} className="text-[10px] text-[#8c90a1] hover:text-[#b0c6ff] cursor-pointer shrink-0 font-semibold px-2 py-1 rounded border border-[#424655] hover:border-[#b0c6ff]/40 transition-colors disabled:opacity-50">Rejoin</button>
                    )}
                  </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
