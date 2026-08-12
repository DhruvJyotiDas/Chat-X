import React, { useEffect } from 'react';
import { X, MessageSquare, Phone, Video, Mail, Calendar } from 'lucide-react';
import { IBUser } from '../../types';

interface Props {
  user: IBUser;
  onClose: () => void;
  onStartChat?: () => void;
  onStartCall?: () => void;
}

export default function UserProfileModal({ user, onClose, onStartChat, onStartCall }: Props) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);
  const joined = new Date(user.createdAt).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-[#131313] border border-[#424655] rounded-2xl shadow-2xl w-80 overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Header banner */}
        <div className="h-24 bg-gradient-to-br from-[#568dff]/30 to-[#8083ff]/20 relative">
          <button
            onClick={onClose}
            className="absolute top-3 right-3 w-7 h-7 rounded-full bg-[#131313]/60 flex items-center justify-center text-[#8c90a1] hover:text-[#e5e2e1] transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Avatar */}
        <div className="flex justify-center -mt-10 mb-3 relative">
          <div className="relative">
            {user.avatar ? (
              <img
                src={user.avatar}
                alt={user.displayName}
                className="w-20 h-20 rounded-full object-cover border-4 border-[#131313] shadow-xl"
              />
            ) : (
              <div className="w-20 h-20 rounded-full bg-[#568dff]/20 border-4 border-[#131313] flex items-center justify-center shadow-xl">
                <span className="text-2xl font-bold text-[#b0c6ff]">
                  {user.displayName.charAt(0).toUpperCase()}
                </span>
              </div>
            )}
            <div className={`absolute bottom-1 right-1 w-4 h-4 rounded-full border-2 border-[#131313] ${
              user.status === 'online' ? 'bg-[#4dffb1]' : user.status === 'idle' ? 'bg-[#ffd60a]' : 'bg-[#8c90a1]'
            }`} />
          </div>
        </div>

        {/* Info */}
        <div className="px-6 pb-6">
          <div className="text-center mb-4">
            <h2 className="text-lg font-bold text-[#e5e2e1]">{user.displayName}</h2>
            <p className="text-sm text-[#8c90a1]">@{user.username}</p>
            <span className={`inline-block mt-1 text-[10px] font-bold px-2 py-0.5 rounded-full ${
              user.status === 'online' ? 'bg-[#4dffb1]/10 text-[#4dffb1]' :
              user.status === 'idle' ? 'bg-[#ffd60a]/10 text-[#ffd60a]' :
              'bg-[#8c90a1]/10 text-[#8c90a1]'
            }`}>
              {user.status}
            </span>
            {user.bio && <p className="text-xs text-[#c2c6d8] mt-2 leading-relaxed">{user.bio}</p>}
          </div>

          {/* Details */}
          <div className="flex flex-col gap-2 mb-5">
            <div className="flex items-center gap-2 text-xs text-[#8c90a1]">
              <Mail className="w-3.5 h-3.5 text-[#b0c6ff]" />
              <span className="truncate">{user.email}</span>
            </div>
            <div className="flex items-center gap-2 text-xs text-[#8c90a1]">
              <Calendar className="w-3.5 h-3.5 text-[#b0c6ff]" />
              <span>Joined {joined}</span>
            </div>
          </div>

          {/* Action buttons */}
          <div className="flex gap-2">
            {onStartChat && (
              <button
                onClick={() => { onStartChat(); onClose(); }}
                className="flex-1 flex items-center justify-center gap-1.5 bg-[#568dff] text-[#002661] font-bold py-2.5 rounded-xl text-xs hover:bg-[#568dff]/90 transition-colors"
              >
                <MessageSquare className="w-3.5 h-3.5" />
                Message
              </button>
            )}
            {onStartCall && (
              <button
                onClick={() => { onStartCall(); onClose(); }}
                className="flex-1 flex items-center justify-center gap-1.5 bg-[#201f1f] text-[#e5e2e1] border border-[#424655] font-bold py-2.5 rounded-xl text-xs hover:bg-[#2a2a2a] transition-colors"
              >
                <Video className="w-3.5 h-3.5 text-[#b0c6ff]" />
                Call
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
