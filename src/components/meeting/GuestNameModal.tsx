import React, { useState } from 'react';
import { User, X, Video } from 'lucide-react';
import { useMeeting } from '../../context/MeetingContext';

interface Props {
  onConfirm: (name: string) => void;
  onCancel: () => void;
  action: 'create' | 'join';
  meetingCode?: string | null;
}

export default function GuestNameModal({ onConfirm, onCancel, action, meetingCode }: Props) {
  const [name, setName] = useState('');
  const { user } = useMeeting();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    onConfirm(trimmed);
  };

  return (
    <div className="fixed inset-0 bg-[#0e0e0e]/85 backdrop-blur-md flex items-center justify-center z-50 p-4">
      <div className="bg-[#1c1b1b] border border-[#424655] rounded-2xl max-w-sm w-full p-6 shadow-2xl relative">
        <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-[#568dff] to-[#b0c6ff] rounded-t-2xl" />

        <div className="flex justify-between items-start mb-5">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-[#568dff]/15 flex items-center justify-center">
              <Video className="w-5 h-5 text-[#b0c6ff]" />
            </div>
            <div>
              <h3 className="font-bold text-sm text-[#e5e2e1]">
                {action === 'create' ? 'Create Meeting' : 'Join Meeting'}
              </h3>
              {meetingCode && (
                <p className="text-[10px] text-[#8c90a1] mt-0.5 font-mono">Code: {meetingCode}</p>
              )}
            </div>
          </div>
          <button
            onClick={onCancel}
            className="w-7 h-7 rounded-full bg-[#201f1f] border border-[#424655] flex items-center justify-center hover:border-[#ffb4ab] hover:text-[#ffb4ab] transition-colors cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        <p className="text-xs text-[#c2c6d8] mb-5 leading-relaxed">
          You're joining as a guest. Enter your display name to continue. No account required.
        </p>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="relative">
            <User className="w-4 h-4 text-[#8c90a1] absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              autoFocus
              type="text"
              placeholder="Your display name..."
              value={name}
              maxLength={32}
              onChange={(e) => setName(e.target.value)}
              className="w-full pl-9 pr-4 py-2.5 bg-[#131313] border border-[#424655] rounded-xl text-xs text-[#e5e2e1] placeholder-[#8c90a1]/60 focus:border-[#568dff] focus:ring-1 focus:ring-[#568dff] outline-none transition-all"
            />
          </div>

          <div className="flex gap-3">
            <button
              type="button"
              onClick={onCancel}
              className="flex-1 py-2.5 bg-[#201f1f] text-[#e5e2e1] border border-[#424655] rounded-xl text-xs font-semibold hover:bg-[#2a2a2a] cursor-pointer transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!name.trim()}
              className="flex-1 py-2.5 bg-[#568dff] text-[#002661] rounded-xl text-xs font-bold hover:bg-[#568dff]/90 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-colors"
            >
              {action === 'create' ? 'Create & Join' : 'Join Meeting'}
            </button>
          </div>
        </form>

        <p className="text-[10px] text-[#8c90a1] text-center mt-4">
          Already a member?{' '}
          <button
            onClick={() => onConfirm(user.name)}
            className="text-[#b0c6ff] hover:underline cursor-pointer"
          >
            Join as {user.name}
          </button>
        </p>
      </div>
    </div>
  );
}
