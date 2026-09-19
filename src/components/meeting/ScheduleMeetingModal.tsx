import React, { useState, useEffect } from 'react';
import { Calendar, Clock, Copy, Check, Users } from 'lucide-react';
import { useMeeting } from '../../context/MeetingContext';
import { useAuth } from '../../context/AuthContext';
import { api } from '../../lib/api';
import Modal from '../ui/Modal';

interface Props { onClose: () => void; }

// Migrated onto the shared Modal (sub-unit 8 gap-catch -- this ad hoc dark
// dialog was missed in sub-unit 7's Phase 4 surfaces pass; it's opened from
// two now-light pages, DebriefView's "Schedule" button and CommandPalette's
// "Schedule Event" action, so leaving it dark-hardcoded would be a jarring
// dark modal on a light page). It has no pinned header/footer of its own --
// a clean 1:1 fit, unlike CalendarView's EventModal or MeetingNotesDialog.
export default function ScheduleMeetingModal({ onClose }: Props) {
  const { scheduleMeeting } = useMeeting();
  const { currentUser }     = useAuth();

  const today = new Date().toISOString().split('T')[0];
  const defaultTime = (() => {
    const d = new Date(); d.setHours(d.getHours() + 1, 0, 0, 0);
    return `${String(d.getHours()).padStart(2, '0')}:00`;
  })();

  const [title, setTitle]                 = useState('');
  const [date, setDate]                   = useState(today);
  const [time, setTime]                   = useState(defaultTime);
  const [generatedCode, setGeneratedCode] = useState<string | null>(null);
  const [copied, setCopied]               = useState(false);
  const [isInviting, setIsInviting]       = useState(false);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [users, setUsers] = useState<any[]>([]);
  const [selectedUsers, setSelectedUsers] = useState<string[]>([]);

  useEffect(() => {
    api.getUsers().then(res => {
      setUsers(res.filter((u: any) => u.id !== currentUser?.id));
    }).catch(() => {});
  }, [currentUser]);

  const toggleUser = (id: string) => {
    setSelectedUsers(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };

  const handleSelectAll = () => {
    if (selectedUsers.length === users.length) {
      setSelectedUsers([]); // Deselect all if already all selected
    } else {
      setSelectedUsers(users.map(u => u.id));
    }
  };

  const formattedDateTime = (() => {
    try {
      const d = new Date(`${date}T${time}`);
      return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }) + ' at ' + d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    } catch { return `${date} at ${time}`; }
  })();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !date || !time) return;

    setIsInviting(true);
    try {
      // THE FIX: Await the database API call before continuing!
      const code = await scheduleMeeting(title.trim(), date, time, selectedUsers);

      // Send automatic DMs
      for (const uid of selectedUsers) {
        try {
          const thread = await api.startDM(uid);
          await api.sendMessage(thread.id, `📅 **Meeting Invite: ${title.trim()}**\n\nDate: ${date}\nTime: ${time}\n\nJoin Code: \`${code}\`\nLink: ${window.location.origin}/${code}`);
        } catch (err) {}
      }

      setGeneratedCode(code);
    } catch (err) {
      console.error("Failed to schedule", err);
    } finally {
      setIsInviting(false);
    }
  };

  const copyCode = () => {
    if (!generatedCode) return;
    navigator.clipboard.writeText(generatedCode).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); });
  };

  const copyLink = () => {
    if (!generatedCode) return;
    navigator.clipboard.writeText(`${window.location.origin}/${generatedCode}`).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); });
  };

  return (
    <Modal open onClose={onClose} variant="sheet" size="sm" aria-label="Schedule meeting">
      <div className="flex items-center gap-3 px-5 pt-1 pb-4 border-b border-[var(--ib-border)]">
        <div className="w-9 h-9 sm:w-10 sm:h-10 rounded-xl bg-[var(--ib-blue-50)] flex items-center justify-center shrink-0">
          <Calendar className="w-4 h-4 sm:w-5 sm:h-5 text-[var(--ib-blue-600)]" />
        </div>
        <h3 className="font-bold text-sm text-[var(--ib-text)]">Schedule Meeting</h3>
      </div>

      {generatedCode ? (
        <div className="flex flex-col items-center gap-4 px-5 py-6">
          <div className="w-14 h-14 rounded-full bg-[var(--ib-good-fill)] flex items-center justify-center"><Check className="w-7 h-7 text-[var(--ib-good-text)]" /></div>
          <div className="text-center">
            <h4 className="font-bold text-sm text-[var(--ib-text)]">Meeting Scheduled & Invites Sent!</h4>
            <p className="text-xs text-[var(--ib-text)] mt-1">{title}</p>
            <p className="text-[11px] text-[var(--ib-text-muted)] mt-0.5">{formattedDateTime}</p>
          </div>
          <div className="w-full bg-[var(--ib-surface)] border border-[var(--ib-border)] rounded-xl p-3.5">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-[9px] text-[var(--ib-text-muted)] uppercase font-bold tracking-wider mb-0.5">Room Code</p>
                <p className="text-sm font-mono font-bold text-[var(--ib-blue-600)]">{generatedCode}</p>
              </div>
              <button onClick={copyCode} className="flex items-center gap-1 bg-[var(--ib-blue-50)] text-[var(--ib-blue-600)] border border-[var(--ib-blue-100)] px-3 min-h-[44px] rounded-lg text-[10px] font-bold hover:bg-[var(--ib-blue-100)] cursor-pointer transition-colors shrink-0">
                {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />} {copied ? 'Copied!' : 'Copy'}
              </button>
            </div>
          </div>
          <button onClick={copyLink} className="w-full min-h-[44px] text-[10px] text-[var(--ib-text-muted)] hover:text-[var(--ib-blue-600)] font-semibold border border-[var(--ib-border)] rounded-xl transition-colors cursor-pointer">Copy join link instead</button>
          <button onClick={onClose} className="w-full min-h-[44px] bg-[var(--ib-blue-500)] text-white rounded-xl text-xs font-bold hover:bg-[var(--ib-blue-600)] cursor-pointer transition-colors">Done</button>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="flex flex-col gap-4 px-5 py-5">
          <div className="flex flex-col gap-1.5">
            <label className="text-[9px] font-bold tracking-wider text-[var(--ib-text-muted)] uppercase">Meeting Title</label>
            <input autoFocus type="text" placeholder="e.g. Q4 Strategy Review" value={title} onChange={e => setTitle(e.target.value)} className="px-3 py-2.5 h-11 bg-[var(--ib-surface)] border border-[var(--ib-border)] rounded-xl text-base md:text-xs text-[var(--ib-text)] placeholder-[var(--ib-text-muted)] focus:border-[var(--ib-blue-500)] outline-none transition-all touch-manipulation" />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <label className="text-[9px] font-bold tracking-wider text-[var(--ib-text-muted)] uppercase">Date</label>
              <div className="relative">
                <Calendar className="w-3.5 h-3.5 text-[var(--ib-text-muted)] absolute left-3 top-1/2 -translate-y-1/2" />
                <input type="date" value={date} min={today} onChange={e => setDate(e.target.value)} className="w-full pl-8 pr-3 h-11 bg-[var(--ib-surface)] border border-[var(--ib-border)] rounded-xl text-xs text-[var(--ib-text)] focus:border-[var(--ib-blue-500)] outline-none transition-all" />
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-[9px] font-bold tracking-wider text-[var(--ib-text-muted)] uppercase">Time</label>
              <div className="relative">
                <Clock className="w-3.5 h-3.5 text-[var(--ib-text-muted)] absolute left-3 top-1/2 -translate-y-1/2" />
                <input type="time" value={time} onChange={e => setTime(e.target.value)} className="w-full pl-8 pr-3 h-11 bg-[var(--ib-surface)] border border-[var(--ib-border)] rounded-xl text-xs text-[var(--ib-text)] focus:border-[var(--ib-blue-500)] outline-none transition-all" />
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            {/* THE FIX: Select All button added */}
            <div className="flex items-center justify-between">
              <label className="text-[9px] font-bold tracking-wider text-[var(--ib-text-muted)] uppercase flex items-center gap-1"><Users className="w-3 h-3" /> Invite Team Members</label>
              <button type="button" onClick={handleSelectAll} className="text-[9px] font-bold text-[var(--ib-blue-600)] hover:text-[var(--ib-blue-500)] uppercase tracking-wider transition-colors cursor-pointer">
                {selectedUsers.length === users.length && users.length > 0 ? 'Deselect All' : 'Select All'}
              </button>
            </div>

            <div className="max-h-32 overflow-y-auto bg-[var(--ib-surface)] border border-[var(--ib-border)] rounded-xl p-2 space-y-1 scrollbar-hide">
              {users.map(u => (
                <label key={u.id} className="flex min-h-[44px] items-center gap-2 cursor-pointer px-1.5 py-2 hover:bg-[var(--ib-gray-100)] rounded-lg transition-colors">
                  <input type="checkbox" checked={selectedUsers.includes(u.id)} onChange={() => toggleUser(u.id)} className="rounded border-[var(--ib-border)] text-[var(--ib-blue-500)] focus:ring-0" />
                  <div className="w-6 h-6 rounded-full bg-[var(--ib-blue-100)] flex items-center justify-center text-[10px] font-bold text-[var(--ib-blue-600)] uppercase">{u.displayName.charAt(0)}</div>
                  <span className="text-xs text-[var(--ib-text)]">{u.displayName}</span>
                </label>
              ))}
              {users.length === 0 && <p className="text-[10px] text-[var(--ib-text-muted)] text-center py-2">Loading users...</p>}
            </div>
          </div>

          <div className="flex gap-3 pt-2">
            <button type="button" onClick={onClose} className="flex-1 min-h-[44px] bg-[var(--ib-surface)] text-[var(--ib-text)] border border-[var(--ib-border)] rounded-xl text-xs font-semibold hover:bg-[var(--ib-gray-100)] cursor-pointer transition-colors">Cancel</button>
            <button type="submit" disabled={!title.trim() || !date || !time || isInviting} className="flex-1 min-h-[44px] bg-[var(--ib-blue-500)] text-white rounded-xl text-xs font-bold hover:bg-[var(--ib-blue-600)] disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-colors">
              {isInviting ? 'Inviting...' : 'Schedule & Invite'}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
