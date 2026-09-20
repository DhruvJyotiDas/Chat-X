import React, { useEffect } from 'react';
import { Phone, PhoneOff, Video } from 'lucide-react';
import { IncomingCall } from '../../context/ChatContext';

interface Props {
  call: IncomingCall;
  onAccept: () => void;
  onDecline: () => void;
}

// Kept as its own fixed-inset-0 wrapper rather than migrated onto the shared
// Modal (sub-unit 9): Modal adds backdrop-click and Escape dismissal, which
// this dialog deliberately doesn't have today (a stray tap declining an
// incoming call would be a real behavior change, not a retheme) -- scope
// guard says a visual fix needing a logic change gets reported, not
// silently made. Retoned onto tokens only.
export default function IncomingCallModal({ call, onAccept, onDecline }: Props) {
  // Auto-decline after 30 seconds
  useEffect(() => {
    const t = setTimeout(onDecline, 30000);
    return () => clearTimeout(t);
  }, [onDecline]);

  return (
    <div className="fixed inset-0 z-[99999] flex items-end sm:items-center justify-center p-4 sm:p-0 bg-[var(--ib-gray-900)]/40 backdrop-blur-sm">
      <div className="w-full max-w-sm bg-[var(--ib-surface-raised)] border border-[var(--ib-border)] rounded-2xl shadow-[var(--ib-shadow-lg)] overflow-hidden animate-in slide-in-from-bottom-4 duration-300">
        <div className="flex flex-col items-center gap-4 p-6 text-center">
          <div className="w-16 h-16 rounded-full bg-[var(--ib-blue-50)] border-2 border-[var(--ib-blue-100)] flex items-center justify-center animate-pulse">
            <span className="text-2xl font-bold text-[var(--ib-blue-600)]">{call.fromName.charAt(0).toUpperCase()}</span>
          </div>
          <div>
            <p className="text-xs font-semibold text-[var(--ib-text-muted)] uppercase tracking-wider mb-1">Incoming {call.callType === 'audio' ? 'Audio' : 'Video'} Call</p>
            <p className="text-lg font-bold text-[var(--ib-text)]">{call.fromName}</p>
          </div>
          <div className="flex gap-4 mt-2">
            <button
              onClick={onDecline}
              className="flex flex-col items-center gap-1.5 cursor-pointer"
            >
              <div className="w-14 h-14 rounded-full bg-[var(--ib-bad-fill)] border border-[var(--ib-bad-text)]/30 flex items-center justify-center hover:opacity-80 transition-colors active:scale-95">
                <PhoneOff className="w-6 h-6 text-[var(--ib-bad-text)]" />
              </div>
              <span className="text-[10px] text-[var(--ib-text-muted)] font-semibold">Decline</span>
            </button>
            <button
              onClick={onAccept}
              className="flex flex-col items-center gap-1.5 cursor-pointer"
            >
              <div className="w-14 h-14 rounded-full bg-[var(--ib-good-fill)] border border-[var(--ib-good-text)]/30 flex items-center justify-center hover:opacity-80 transition-colors active:scale-95 animate-bounce">
                {call.callType === 'audio' ? <Phone className="w-6 h-6 text-[var(--ib-good-text)]" /> : <Video className="w-6 h-6 text-[var(--ib-good-text)]" />}
              </div>
              <span className="text-[10px] text-[var(--ib-good-text)] font-semibold">Accept</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
