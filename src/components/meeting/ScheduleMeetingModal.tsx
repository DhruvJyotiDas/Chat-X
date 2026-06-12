import React, { useState, useEffect } from 'react';
import { Calendar, Clock, X, Copy, Check, Users } from 'lucide-react';
import { useMeeting } from '../../context/MeetingContext';
import { useAuth } from '../../context/AuthContext';
import { api } from '../../lib/api';

interface Props { onClose: () => void; }

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

      // Add to personal calendar view immediately
      if (currentUser) {
        try {
          const calKey = `ibconnect_calendar_${currentUser.id}`;
          const calEvents = JSON.parse(localStorage.getItem(calKey) || '[]');
          const calEvent = {
            id: `sched-${code}-cal`, creatorId: currentUser.id, title: title.trim(),
            date, startTime: time, endTime: time, description: `Meeting code: ${code}`, color: '#b0c6ff',
          };
          localStorage.setItem(calKey, JSON.stringify([...calEvents, calEvent]));
        } catch {}
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
    <div className="fixed inset-0 bg-[#0e0e0e]/85 backdrop-blur-md flex items-end sm:items-center justify-center z-50 p-0 sm:p-4" onClick={onClose}>
      <div className="bg-[#1c1b1b] border border-[#424655] rounded-t-2xl sm:rounded-2xl w-full sm:max-w-md shadow-2xl relative overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="absolute top-0 left-0 right-0 h-0.5 bg-gradient-to-r from-[#c0c1ff] to-[#568dff]" />
        <div className="flex justify-center pt-3 pb-1 sm:hidden"><div className="w-10 h-1 rounded-full bg-[#424655]" /></div>

        <div className="flex justify-between items-center px-5 py-4 border-b border-[#424655]/40">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 sm:w-10 sm:h-10 rounded-xl bg-[#c0c1ff]/10 flex items-center justify-center">
              <Calendar className="w-4 h-4 sm:w-5 sm:h-5 text-[#c0c1ff]" />
            </div>
            <h3 className="font-bold text-sm text-[#e5e2e1]">Schedule Meeting</h3>
          </div>
          <button onClick={onClose} className="w-7 h-7 rounded-full bg-[#201f1f] border border-[#424655] flex items-center justify-center hover:border-[#ffb4ab] hover:text-[#ffb4ab] transition-colors cursor-pointer"><X className="w-3.5 h-3.5" /></button>
        </div>

        {generatedCode ? (
          <div className="flex flex-col items-center gap-4 px-5 py-6">
            <div className="w-14 h-14 rounded-full bg-[#00e598]/10 flex items-center justify-center"><Check className="w-7 h-7 text-[#70ffba]" /></div>
            <div className="text-center">
              <h4 className="font-bold text-sm text-[#e5e2e1]">Meeting Scheduled & Invites Sent!</h4>
              <p className="text-xs text-[#c2c6d8] mt-1">{title}</p>
              <p className="text-[11px] text-[#8c90a1] mt-0.5">{formattedDateTime}</p>
            </div>
            <div className="w-full bg-[#131313] border border-[#424655] rounded-xl p-3.5">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-[9px] text-[#8c90a1] uppercase font-bold tracking-wider mb-0.5">Room Code</p>
                  <p className="text-sm font-mono font-bold text-[#b0c6ff]">{generatedCode}</p>
                </div>
                <button onClick={copyCode} className="flex items-center gap-1 bg-[#568dff]/10 text-[#b0c6ff] border border-[#568dff]/30 px-3 py-1.5 rounded-lg text-[10px] font-bold hover:bg-[#568dff]/20 cursor-pointer transition-colors shrink-0">
                  {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />} {copied ? 'Copied!' : 'Copy'}
                </button>
              </div>
            </div>
            <button onClick={copyLink} className="w-full py-2 text-[10px] text-[#8c90a1] hover:text-[#b0c6ff] font-semibold border border-[#424655]/60 rounded-xl transition-colors cursor-pointer">Copy join link instead</button>
            <button onClick={onClose} className="w-full py-2.5 bg-[#568dff] text-[#002661] rounded-xl text-xs font-bold hover:bg-[#568dff]/90 cursor-pointer transition-colors">Done</button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="flex flex-col gap-4 px-5 py-5 max-h-[75vh] overflow-y-auto">
            <div className="flex flex-col gap-1.5">
              <label className="text-[9px] font-bold tracking-wider text-[#8c90a1] uppercase">Meeting Title</label>
              <input autoFocus type="text" placeholder="e.g. Q4 Strategy Review" value={title} onChange={e => setTitle(e.target.value)} className="px-3 py-2.5 bg-[#131313] border border-[#424655] rounded-xl text-xs text-[#e5e2e1] placeholder-[#8c90a1]/60 focus:border-[#568dff] outline-none transition-all" />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <label className="text-[9px] font-bold tracking-wider text-[#8c90a1] uppercase">Date</label>
                <div className="relative">
                  <Calendar className="w-3.5 h-3.5 text-[#8c90a1] absolute left-3 top-1/2 -translate-y-1/2" />
                  <input type="date" value={date} min={today} onChange={e => setDate(e.target.value)} className="w-full pl-8 pr-3 py-2.5 bg-[#131313] border border-[#424655] rounded-xl text-xs text-[#e5e2e1] focus:border-[#568dff] outline-none transition-all" />
                </div>
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-[9px] font-bold tracking-wider text-[#8c90a1] uppercase">Time</label>
                <div className="relative">
                  <Clock className="w-3.5 h-3.5 text-[#8c90a1] absolute left-3 top-1/2 -translate-y-1/2" />
                  <input type="time" value={time} onChange={e => setTime(e.target.value)} className="w-full pl-8 pr-3 py-2.5 bg-[#131313] border border-[#424655] rounded-xl text-xs text-[#e5e2e1] focus:border-[#568dff] outline-none transition-all" />
                </div>
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              {/* THE FIX: Select All button added */}
              <div className="flex items-center justify-between">
                <label className="text-[9px] font-bold tracking-wider text-[#8c90a1] uppercase flex items-center gap-1"><Users className="w-3 h-3" /> Invite Team Members</label>
                <button type="button" onClick={handleSelectAll} className="text-[9px] font-bold text-[#568dff] hover:text-[#b0c6ff] uppercase tracking-wider transition-colors cursor-pointer">
                  {selectedUsers.length === users.length && users.length > 0 ? 'Deselect All' : 'Select All'}
                </button>
              </div>

              <div className="max-h-32 overflow-y-auto bg-[#131313] border border-[#424655] rounded-xl p-2 space-y-1 scrollbar-hide">
                {users.map(u => (
                  <label key={u.id} className="flex items-center gap-2 cursor-pointer p-1.5 hover:bg-[#201f1f] rounded-lg transition-colors">
                    <input type="checkbox" checked={selectedUsers.includes(u.id)} onChange={() => toggleUser(u.id)} className="rounded border-[#424655] bg-[#201f1f] text-[#568dff] focus:ring-0" />
                    <div className="w-6 h-6 rounded-full bg-[#568dff]/20 flex items-center justify-center text-[10px] font-bold text-[#b0c6ff] uppercase">{u.displayName.charAt(0)}</div>
                    <span className="text-xs text-[#e5e2e1]">{u.displayName}</span>
                  </label>
                ))}
                {users.length === 0 && <p className="text-[10px] text-[#8c90a1] text-center py-2">Loading users...</p>}
              </div>
            </div>

            <div className="flex gap-3 pt-2">
              <button type="button" onClick={onClose} className="flex-1 py-2.5 bg-[#201f1f] text-[#e5e2e1] border border-[#424655] rounded-xl text-xs font-semibold hover:bg-[#2a2a2a] cursor-pointer transition-colors">Cancel</button>
              <button type="submit" disabled={!title.trim() || !date || !time || isInviting} className="flex-1 py-2.5 bg-[#568dff] text-[#002661] rounded-xl text-xs font-bold hover:bg-[#568dff]/90 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-colors">
                {isInviting ? 'Inviting...' : 'Schedule & Invite'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
