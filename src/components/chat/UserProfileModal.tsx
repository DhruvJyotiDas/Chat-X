import React from 'react';
import { MessageSquare, Video, Mail, Calendar } from 'lucide-react';
import { IBUser } from '../../types';
import Modal from '../ui/Modal';

interface Props {
  user: IBUser;
  onClose: () => void;
  onStartChat?: () => void;
  onStartCall?: () => void;
}

export default function UserProfileModal({ user, onClose, onStartChat, onStartCall }: Props) {
  const joined = new Date(user.createdAt).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  return (
    <Modal open onClose={onClose} variant="centered" size="sm" aria-label={`${user.displayName}'s profile`}>
      {/* Header banner */}
      <div className="h-24 bg-gradient-to-br from-[var(--ib-blue-100)] to-[var(--ib-blue-50)]" />

      {/* Avatar */}
      <div className="flex justify-center -mt-10 mb-3 relative">
        <div className="relative">
          {user.avatar ? (
            <img
              src={user.avatar}
              alt={user.displayName}
              className="w-20 h-20 rounded-full object-cover border-4 border-[var(--ib-surface-raised)] shadow-xl"
            />
          ) : (
            <div className="w-20 h-20 rounded-full bg-[var(--ib-blue-50)] border-4 border-[var(--ib-surface-raised)] flex items-center justify-center shadow-xl">
              <span className="text-2xl font-bold text-[var(--ib-blue-600)]">
                {user.displayName.charAt(0).toUpperCase()}
              </span>
            </div>
          )}
          <div className={`absolute bottom-1 right-1 w-4 h-4 rounded-full border-2 border-[var(--ib-surface-raised)] ${
            user.status === 'online' ? 'bg-[var(--ib-good-dot)]' : user.status === 'idle' ? 'bg-[var(--ib-warn-dot)]' : 'bg-[var(--ib-gray-400)]'
          }`} />
        </div>
      </div>

      {/* Info */}
      <div className="px-6 pb-6">
        <div className="text-center mb-4">
          <h2 className="text-lg font-bold text-[var(--ib-text)]">{user.displayName}</h2>
          <p className="text-sm text-[var(--ib-text-muted)]">@{user.username}</p>
          <span className={`inline-block mt-1 text-[10px] font-bold px-2 py-0.5 rounded-full ${
            user.status === 'online' ? 'bg-[var(--ib-good-fill)] text-[var(--ib-good-text)]' :
            user.status === 'idle' ? 'bg-[var(--ib-warn-fill)] text-[var(--ib-warn-text)]' :
            'bg-[var(--ib-gray-100)] text-[var(--ib-text-muted)]'
          }`}>
            {user.status}
          </span>
          {user.bio && <p className="text-xs text-[var(--ib-text)] mt-2 leading-relaxed">{user.bio}</p>}
        </div>

        {/* Details */}
        <div className="flex flex-col gap-2 mb-5">
          <div className="flex items-center gap-2 text-xs text-[var(--ib-text-muted)]">
            <Mail className="w-3.5 h-3.5 text-[var(--ib-blue-600)]" />
            <span className="truncate">{user.email}</span>
          </div>
          <div className="flex items-center gap-2 text-xs text-[var(--ib-text-muted)]">
            <Calendar className="w-3.5 h-3.5 text-[var(--ib-blue-600)]" />
            <span>Joined {joined}</span>
          </div>
        </div>

        {/* Action buttons */}
        <div className="flex gap-2">
          {onStartChat && (
            <button
              onClick={() => { onStartChat(); onClose(); }}
              className="flex-1 flex items-center justify-center gap-1.5 bg-[var(--ib-blue-500)] text-white font-bold min-h-[44px] rounded-xl text-xs hover:bg-[var(--ib-blue-600)] transition-colors cursor-pointer"
            >
              <MessageSquare className="w-3.5 h-3.5" />
              Message
            </button>
          )}
          {onStartCall && (
            <button
              onClick={() => { onStartCall(); onClose(); }}
              className="flex-1 flex items-center justify-center gap-1.5 bg-[var(--ib-surface)] text-[var(--ib-text)] border border-[var(--ib-border)] font-bold min-h-[44px] rounded-xl text-xs hover:bg-[var(--ib-gray-100)] transition-colors cursor-pointer"
            >
              <Video className="w-3.5 h-3.5 text-[var(--ib-blue-600)]" />
              Call
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
