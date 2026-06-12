import React, { useEffect } from 'react';
import { Phone, PhoneOff, Video } from 'lucide-react';
import { IncomingCall } from '../../context/ChatContext';

interface Props {
  call: IncomingCall;
  onAccept: () => void;
  onDecline: () => void;
}

export default function IncomingCallModal({ call, onAccept, onDecline }: Props) {
  // Auto-decline after 30 seconds
  useEffect(() => {
    const t = setTimeout(onDecline, 30000);
    return () => clearTimeout(t);
  }, [onDecline]);

  return (
    <div className="fixed inset-0 z-[99999] flex items-end sm:items-center justify-center p-4 sm:p-0 bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-sm bg-[#1a1b1e] border border-[#424655] rounded-2xl shadow-2xl overflow-hidden animate-in slide-in-from-bottom-4 duration-300">
        <div className="flex flex-col items-center gap-4 p-6 text-center">
          <div className="w-16 h-16 rounded-full bg-[#568dff]/20 border-2 border-[#568dff]/40 flex items-center justify-center animate-pulse">
            <span className="text-2xl font-bold text-[#b0c6ff]">{call.fromName.charAt(0).toUpperCase()}</span>
          </div>
          <div>
            <p className="text-xs font-semibold text-[#8c90a1] uppercase tracking-wider mb-1">Incoming Video Call</p>
            <p className="text-lg font-bold text-[#e5e2e1]">{call.fromName}</p>
          </div>
          <div className="flex gap-4 mt-2">
            <button
              onClick={onDecline}
              className="flex flex-col items-center gap-1.5"
            >
              <div className="w-14 h-14 rounded-full bg-[#ffb4ab]/10 border border-[#ffb4ab]/30 flex items-center justify-center hover:bg-[#ffb4ab]/20 transition-colors active:scale-95">
                <PhoneOff className="w-6 h-6 text-[#ffb4ab]" />
              </div>
              <span className="text-[10px] text-[#8c90a1] font-semibold">Decline</span>
            </button>
            <button
              onClick={onAccept}
              className="flex flex-col items-center gap-1.5"
            >
              <div className="w-14 h-14 rounded-full bg-[#4dffb1]/10 border border-[#4dffb1]/30 flex items-center justify-center hover:bg-[#4dffb1]/20 transition-colors active:scale-95 animate-bounce">
                <Video className="w-6 h-6 text-[#4dffb1]" />
              </div>
              <span className="text-[10px] text-[#4dffb1] font-semibold">Accept</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
