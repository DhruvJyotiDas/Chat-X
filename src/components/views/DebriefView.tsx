import React, { useState } from 'react';
import { Video, Plus, Link2, Calendar, Clock, Users, AlertCircle, ChevronRight, Bolt, History, VideoOff, Trash2, Sparkles } from 'lucide-react';
import { useMeeting } from '../../context/MeetingContext';
import { useAuth } from '../../context/AuthContext';
import ScheduleMeetingModal from '../meeting/ScheduleMeetingModal';
import MeetingNotesDialog from '../meeting/MeetingNotesDialog';

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
  const [notesMeeting, setNotesMeeting] = useState<MeetingRecord | null>(null);

  React.useEffect(() => { if (autoJoinCode) { setMeetingCode(autoJoinCode); onAutoJoinConsumed?.(); } }, [autoJoinCode, onAutoJoinConsumed]);

  const historyKey = `ibconnect_meeting_history_${currentUser?.id ?? 'guest'}`;
  const history: MeetingRecord[] = (() => { try { return JSON.parse(localStorage.getItem(historyKey) || '[]'); } catch { return []; } })();

  React.useEffect(() => {
	const roomCode = sessionStorage.getItem('ibconnect_open_meeting_notes');
	if (!roomCode) return;
	sessionStorage.removeItem('ibconnect_open_meeting_notes');
	const record = history.find(item => item.roomCode === roomCode) ?? {
	  id: `aipa-${roomCode}`, roomCode, title: `Meeting ${roomCode}`, isHost: false,
	  startedAt: new Date().toISOString(), participantCount: 0,
	};
	setNotesMeeting(record);
	// history is a localStorage snapshot; the room-code handoff is consumed once.
	// eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser?.id]);

  const handleCreate = async () => { setIsCreating(true); clearMeetingError(); try { await createMeeting(); onJoinMeeting(); } catch {} finally { setIsCreating(false); } };
  const handleJoin = async (code?: string) => { const target = (code ?? meetingCode).trim().toUpperCase(); if (!target) return; setIsJoining(true); clearMeetingError(); try { await joinMeeting(target); onJoinMeeting(); } catch {} finally { setIsJoining(false); } };

  return (
    <div className="dashboard-surface flex-1 overflow-y-auto p-3 sm:p-6 select-none scrollbar-hide">
      {showScheduleModal && <ScheduleMeetingModal onClose={() => setShowScheduleModal(false)} />}
      {notesMeeting && <MeetingNotesDialog roomId={notesMeeting.roomCode} title={notesMeeting.title || `Meeting ${notesMeeting.roomCode}`} onClose={() => setNotesMeeting(null)} />}
      <div className="relative z-10 max-w-5xl mx-auto flex flex-col gap-4 sm:gap-6">
        <div className="relative overflow-hidden rounded-[28px] border border-[var(--ib-border)] bg-[var(--ib-surface-raised)] p-5 sm:p-7 shadow-[var(--ib-shadow-sm)]">
          <div className="relative flex flex-col justify-between gap-4 sm:flex-row sm:items-end"><div><p className="mb-2 flex items-center gap-2 text-[10px] font-bold uppercase tracking-[.18em] text-[var(--ib-text-muted)]"><Sparkles className="h-3.5 w-3.5 text-[var(--ib-blue-600)]" />Your meeting workspace</p><h1 className="text-2xl font-semibold tracking-tight text-[var(--ib-text)]">Meet, return, and act</h1><p className="mt-1.5 max-w-xl text-xs leading-5 text-[var(--ib-text-muted)]">Start a room, schedule the next conversation, or reopen AIPA notes from a previous meeting.</p></div><div className="flex gap-2"><span className="rounded-xl border border-[var(--ib-border)] bg-[var(--ib-surface)] px-3 py-2 text-[10px] text-[var(--ib-text-muted)]"><strong className="mr-1 text-sm text-[var(--ib-text)]">{scheduledMeetings.length}</strong> scheduled</span><span className="rounded-xl border border-[var(--ib-border)] bg-[var(--ib-surface)] px-3 py-2 text-[10px] text-[var(--ib-text-muted)]"><strong className="mr-1 text-sm text-[var(--ib-text)]">{history.length}</strong> recent</span></div></div>
        </div>
        {meetingError && (
          <div className="bg-[var(--ib-bad-fill)] border border-[var(--ib-bad-text)]/30 rounded-xl p-3 sm:p-4 flex items-center gap-3">
            <AlertCircle className="w-4 h-4 text-[var(--ib-bad-text)] shrink-0" /><p className="text-xs text-[var(--ib-bad-text)] flex-1">{meetingError}</p><button onClick={clearMeetingError} className="min-h-[44px] min-w-[44px] flex items-center justify-center text-[var(--ib-bad-text)] hover:opacity-70 cursor-pointer text-xs font-bold">✕</button>
          </div>
        )}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
          <button onClick={handleCreate} disabled={isCreating} className="group relative bg-[var(--ib-surface-raised)] border border-[var(--ib-border)] hover:border-[var(--ib-blue-300)] rounded-2xl p-5 sm:p-6 flex flex-col gap-3 transition-all hover:shadow-[var(--ib-shadow-sm)] cursor-pointer disabled:opacity-60 text-left overflow-hidden">
            <div className="w-10 h-10 sm:w-12 sm:h-12 rounded-xl bg-[var(--ib-blue-50)] flex items-center justify-center"><Video className="w-5 h-5 sm:w-6 sm:h-6 text-[var(--ib-blue-600)]" /></div>
            <div><h3 className="font-bold text-sm text-[var(--ib-text)]">{isCreating ? 'Starting…' : 'Start New Meeting'}</h3><p className="text-xs text-[var(--ib-text-muted)] mt-1">Create a secure room and share the code with others</p></div>
            <div className="flex items-center gap-1.5 text-xs font-semibold text-[var(--ib-blue-600)]"><Bolt className="w-3.5 h-3.5 text-[var(--ib-good-text)]" /><span>Instant start</span><ChevronRight className="w-3.5 h-3.5 ml-auto" /></div>
          </button>
          <div className="bg-[var(--ib-surface-raised)] border border-[var(--ib-border)] rounded-2xl p-5 sm:p-6 flex flex-col gap-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 sm:w-12 sm:h-12 rounded-xl bg-[var(--ib-blue-50)] flex items-center justify-center shrink-0"><Link2 className="w-5 h-5 sm:w-6 sm:h-6 text-[var(--ib-blue-600)]" /></div>
              <div><h3 className="font-bold text-sm text-[var(--ib-text)]">Join a Meeting</h3><p className="text-xs text-[var(--ib-text-muted)] mt-0.5">Enter a room code to join</p></div>
            </div>
            <div className="flex items-center gap-2 bg-[var(--ib-surface)] rounded-xl border border-[var(--ib-border)] focus-within:border-[var(--ib-blue-500)] transition-all overflow-hidden">
              <input type="text" placeholder="ENTER ROOM CODE…" className="flex-1 pl-3 sm:pl-4 pr-2 py-3 bg-transparent text-base sm:text-xs text-[var(--ib-text)] placeholder-[var(--ib-text-muted)] outline-none uppercase font-mono min-w-0 touch-manipulation" value={meetingCode} onChange={e => setMeetingCode(e.target.value.toUpperCase())} onKeyDown={e => e.key === 'Enter' && handleJoin()} />
              <button onClick={() => handleJoin()} disabled={isJoining || !meetingCode.trim()} className="mr-1.5 bg-[var(--ib-blue-500)] text-white px-3 sm:px-4 py-2.5 sm:py-1.5 min-h-[44px] sm:min-h-0 rounded-lg text-xs font-bold hover:bg-[var(--ib-blue-600)] disabled:opacity-40 cursor-pointer disabled:cursor-not-allowed transition-colors shrink-0">{isJoining ? '…' : 'Join'}</button>
            </div>
          </div>
        </div>

        <div className="bg-[var(--ib-surface-raised)] border border-[var(--ib-border)] rounded-2xl p-4 sm:p-5">
          <div className="flex justify-between items-center mb-4">
            <h3 className="font-semibold text-sm text-[var(--ib-text)] flex items-center gap-2"><Calendar className="w-4 h-4 text-[var(--ib-blue-600)]" />Scheduled Meetings</h3>
            <button onClick={() => setShowScheduleModal(true)} className="flex items-center gap-1.5 text-[var(--ib-blue-600)] hover:text-[var(--ib-blue-500)] font-bold text-xs cursor-pointer transition-colors min-h-[44px] sm:min-h-0 px-1"><Plus className="w-3.5 h-3.5" /><span>Schedule</span></button>
          </div>
          {scheduledMeetings.length === 0 ? (
            <div className="text-center py-6 sm:py-8">
              <Calendar className="w-8 h-8 text-[var(--ib-border)] mx-auto mb-2" />
              <p className="text-xs text-[var(--ib-text-muted)]">No scheduled meetings yet</p>
            </div>
          ) : (
            <div className="space-y-2">
              {scheduledMeetings.map(sm => (
                  <div key={sm.id} className="flex items-center justify-between p-3 bg-[var(--ib-surface)] border border-[var(--ib-border)] rounded-xl hover:border-[var(--ib-blue-300)] transition-colors gap-2">
                    <div className="flex items-center gap-3 min-w-0 flex-1">
                      <div className="w-8 h-8 rounded-lg bg-[var(--ib-blue-50)] flex items-center justify-center shrink-0"><Calendar className="w-4 h-4 text-[var(--ib-blue-600)]" /></div>
                      <div className="min-w-0">
                        <p className="text-xs font-semibold text-[var(--ib-text)] truncate">{sm.title || 'Untitled Meeting'}</p>
                        <p className="text-[10px] text-[var(--ib-text-muted)]">{formatScheduledDate(sm.date, sm.time)}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="font-mono text-[10px] text-[var(--ib-blue-600)] bg-[var(--ib-blue-50)] px-2 py-0.5 rounded hidden xs:block">{sm.code}</span>
                      <button onClick={() => handleJoin(sm.code)} disabled={isJoining} className="text-[10px] text-white bg-[var(--ib-blue-500)] hover:bg-[var(--ib-blue-600)] font-bold px-2.5 min-h-[36px] py-1.5 rounded-lg cursor-pointer transition-colors disabled:opacity-50">
                        {isJoining ? '…' : 'Join'}
                      </button>
                      <button onClick={() => deleteScheduledMeeting(sm.id)} className="w-9 h-9 flex items-center justify-center bg-[var(--ib-bad-fill)] text-[var(--ib-bad-text)] rounded-lg hover:opacity-80 transition-colors" title="Delete Meeting">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
              ))}
            </div>
          )}
        </div>

        <div className="bg-[var(--ib-surface-raised)] border border-[var(--ib-border)] rounded-2xl p-4 sm:p-5">
          <div className="flex items-center gap-2 mb-4"><History className="w-4 h-4 text-[var(--ib-blue-600)]" /><h3 className="font-semibold text-sm text-[var(--ib-text)]">Recent Meetings</h3></div>
          {history.length === 0 ? (
            <div className="text-center py-6 sm:py-8"><VideoOff className="w-8 h-8 text-[var(--ib-border)] mx-auto mb-2" /><p className="text-xs text-[var(--ib-text-muted)]">No meetings yet</p></div>
          ) : (
            <div className="space-y-2">
              {[...history].reverse().slice(0, 15).map(record => (
                  <div key={record.id} className="flex items-center gap-3 p-3 bg-[var(--ib-surface)] border border-[var(--ib-border)] rounded-xl hover:border-[var(--ib-gray-200)] transition-colors">
                    <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${record.isHost ? 'bg-[var(--ib-blue-50)]' : 'bg-[var(--ib-blue-50)]'}`}><Video className="w-4 h-4 text-[var(--ib-blue-600)]" /></div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-mono text-xs font-bold text-[var(--ib-text)]">{record.title || record.roomCode}</span>
                        <span className={`text-[9px] font-black px-1.5 py-0.5 rounded ${record.isHost ? 'bg-[var(--ib-blue-50)] text-[var(--ib-blue-600)]' : 'bg-[var(--ib-surface)] text-[var(--ib-text-muted)]'}`}>{record.isHost ? 'HOST' : 'JOINED'}</span>
                        {!record.endedAt && <span className="text-[9px] font-black px-1.5 py-0.5 rounded bg-[var(--ib-good-fill)] text-[var(--ib-good-text)]">ACTIVE</span>}
                      </div>
                      <div className="flex items-center gap-2 sm:gap-3 mt-0.5 flex-wrap">
                        <span className="text-[10px] text-[var(--ib-text-muted)]">{formatRecordDate(record.startedAt)}</span>
                        <span className="text-[10px] text-[var(--ib-text-muted)] flex items-center gap-1"><Clock className="w-2.5 h-2.5" />{getDuration(record)}</span>
                        <span className="text-[10px] text-[var(--ib-text-muted)] flex items-center gap-1"><Users className="w-2.5 h-2.5" />{record.participantCount}</span>
                      </div>
                    </div>
                    {isRejoinable(record) && (
                      <button onClick={() => handleJoin(record.roomCode)} disabled={isJoining} className="text-[10px] text-[var(--ib-text-muted)] hover:text-[var(--ib-blue-600)] cursor-pointer shrink-0 font-semibold px-2 min-h-[36px] py-1 rounded border border-[var(--ib-border)] hover:border-[var(--ib-blue-300)] transition-colors disabled:opacity-50">Rejoin</button>
                    )}
                    <button onClick={() => setNotesMeeting(record)} className="flex shrink-0 items-center gap-1 rounded-lg border border-[var(--ib-blue-100)] bg-[var(--ib-blue-50)] px-2.5 min-h-[36px] py-1.5 text-[10px] font-semibold text-[var(--ib-blue-600)] transition hover:bg-[var(--ib-blue-100)]" title="Open transcript and AI meeting notes"><Sparkles className="h-3 w-3" /><span className="hidden sm:inline">Notes</span></button>
                  </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
