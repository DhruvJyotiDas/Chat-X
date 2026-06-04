import React, { useState } from 'react';
import { Calendar, Clock, X, Copy, Check } from 'lucide-react';
import { useMeeting } from '../../context/MeetingContext';

interface Props {
  onClose: () => void;
}

export default function ScheduleMeetingModal({ onClose }: Props) {
  const { scheduleMeeting } = useMeeting();

  const today = new Date().toISOString().split('T')[0];
  const [title, setTitle] = useState('');
  const [date, setDate] = useState(today);
  const [time, setTime] = useState('10:00');
  const [generatedCode, setGeneratedCode] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !date || !time) return;
    const code = scheduleMeeting(title.trim(), date, time);
    setGeneratedCode(code);
  };

  const copyCode = () => {
    if (!generatedCode) return;
    navigator.clipboard.writeText(generatedCode).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="fixed inset-0 bg-[#0e0e0e]/85 backdrop-blur-md flex items-center justify-center z-50 p-4">
      <div className="bg-[#1c1b1b] border border-[#424655] rounded-2xl max-w-md w-full p-6 shadow-2xl relative">
        <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-[#c0c1ff] to-[#568dff] rounded-t-2xl" />

        <div className="flex justify-between items-center mb-5">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-[#c0c1ff]/10 flex items-center justify-center">
              <Calendar className="w-5 h-5 text-[#c0c1ff]" />
            </div>
            <h3 className="font-bold text-sm text-[#e5e2e1]">Schedule Meeting</h3>
          </div>
          <button
            onClick={onClose}
            className="w-7 h-7 rounded-full bg-[#201f1f] border border-[#424655] flex items-center justify-center hover:border-[#ffb4ab] hover:text-[#ffb4ab] transition-colors cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {generatedCode ? (
          <div className="flex flex-col items-center gap-4 py-4">
            <div className="w-14 h-14 rounded-full bg-[#00e598]/10 flex items-center justify-center">
              <Check className="w-7 h-7 text-[#70ffba]" />
            </div>
            <div className="text-center">
              <h4 className="font-bold text-sm text-[#e5e2e1]">Meeting Scheduled</h4>
              <p className="text-xs text-[#c2c6d8] mt-1">{title} — {date} at {time}</p>
            </div>
            <div className="w-full bg-[#131313] border border-[#424655] rounded-xl p-3 flex items-center justify-between gap-2">
              <div>
                <p className="text-[9px] text-[#8c90a1] uppercase font-bold tracking-wider mb-0.5">Meeting Code</p>
                <p className="text-sm font-mono font-bold text-[#b0c6ff]">{generatedCode}</p>
              </div>
              <button
                onClick={copyCode}
                className="flex items-center gap-1 bg-[#568dff]/10 text-[#b0c6ff] border border-[#568dff]/30 px-3 py-1.5 rounded-lg text-[10px] font-bold hover:bg-[#568dff]/20 cursor-pointer transition-colors"
              >
                {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                {copied ? 'Copied!' : 'Copy'}
              </button>
            </div>
            <button
              onClick={onClose}
              className="w-full py-2.5 bg-[#568dff] text-[#002661] rounded-xl text-xs font-bold hover:bg-[#568dff]/90 cursor-pointer transition-colors"
            >
              Done
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <label className="text-[9px] font-bold tracking-wider text-[#8c90a1] uppercase">Meeting Title</label>
              <input
                autoFocus
                type="text"
                placeholder="e.g. Q4 Strategy Review"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="px-3 py-2.5 bg-[#131313] border border-[#424655] rounded-xl text-xs text-[#e5e2e1] placeholder-[#8c90a1]/60 focus:border-[#568dff] focus:ring-1 focus:ring-[#568dff] outline-none transition-all"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <label className="text-[9px] font-bold tracking-wider text-[#8c90a1] uppercase">Date</label>
                <div className="relative">
                  <Calendar className="w-3.5 h-3.5 text-[#8c90a1] absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="date"
                    value={date}
                    min={today}
                    onChange={(e) => setDate(e.target.value)}
                    className="w-full pl-8 pr-3 py-2.5 bg-[#131313] border border-[#424655] rounded-xl text-xs text-[#e5e2e1] focus:border-[#568dff] outline-none transition-all"
                  />
                </div>
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-[9px] font-bold tracking-wider text-[#8c90a1] uppercase">Time</label>
                <div className="relative">
                  <Clock className="w-3.5 h-3.5 text-[#8c90a1] absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="time"
                    value={time}
                    onChange={(e) => setTime(e.target.value)}
                    className="w-full pl-8 pr-3 py-2.5 bg-[#131313] border border-[#424655] rounded-xl text-xs text-[#e5e2e1] focus:border-[#568dff] outline-none transition-all"
                  />
                </div>
              </div>
            </div>

            <div className="flex gap-3 mt-2">
              <button
                type="button"
                onClick={onClose}
                className="flex-1 py-2.5 bg-[#201f1f] text-[#e5e2e1] border border-[#424655] rounded-xl text-xs font-semibold hover:bg-[#2a2a2a] cursor-pointer transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!title.trim() || !date || !time}
                className="flex-1 py-2.5 bg-[#568dff] text-[#002661] rounded-xl text-xs font-bold hover:bg-[#568dff]/90 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-colors"
              >
                Schedule
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
