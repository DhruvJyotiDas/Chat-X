import React, { useState } from 'react';
import { User, Video } from 'lucide-react';
import { useMeeting } from '../../context/MeetingContext';
import Modal from '../ui/Modal';
import Button from '../ui/Button';
import Input from '../ui/Input';

interface Props {
  onConfirm: (name: string) => void;
  onCancel: () => void;
  action: 'create' | 'join';
  meetingCode?: string | null;
}

// Migrated onto the shared Modal/Button/Input primitives (2026-09-18 redesign)
// -- this was one of 15 ad hoc `fixed inset-0` implementations found in
// Phase 1 (UI_REDESIGN_PLAN.md section 1), and a clean 1:1 fit: a backdrop,
// a white card, a close affordance is exactly what Modal already does.
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
    <Modal open onClose={onCancel} aria-label={action === 'create' ? 'Create meeting' : 'Join meeting'}>
      <div className="p-6">
        <div className="flex items-center gap-3 mb-5">
          <div className="w-10 h-10 rounded-xl bg-[var(--ib-blue-50)] flex items-center justify-center shrink-0">
            <Video className="w-5 h-5 text-[var(--ib-blue-500)]" />
          </div>
          <div className="min-w-0">
            <h3 className="font-bold text-sm text-[var(--ib-gray-900)]">
              {action === 'create' ? 'Create Meeting' : 'Join Meeting'}
            </h3>
            {meetingCode && (
              <p className="text-[10px] text-[var(--ib-gray-600)] mt-0.5 font-mono">Code: {meetingCode}</p>
            )}
          </div>
        </div>

        <p className="text-xs text-[var(--ib-gray-600)] mb-5 leading-relaxed">
          You're joining as a guest. Enter your display name to continue. No account required.
        </p>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="relative">
            <User className="w-4 h-4 text-[var(--ib-gray-400)] absolute left-3 top-1/2 -translate-y-1/2 z-10" />
            <Input
              autoFocus
              type="text"
              placeholder="Your display name..."
              value={name}
              maxLength={32}
              onChange={(e) => setName(e.target.value)}
              className="pl-9"
            />
          </div>

          <div className="flex gap-3">
            <Button type="button" variant="secondary" onClick={onCancel} className="flex-1">
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim()} className="flex-1">
              {action === 'create' ? 'Create & Join' : 'Join Meeting'}
            </Button>
          </div>
        </form>

        <p className="text-[10px] text-[var(--ib-gray-600)] text-center mt-4">
          Already a member?{' '}
          <button
            onClick={() => onConfirm(user.name)}
            className="text-[var(--ib-blue-500)] hover:underline cursor-pointer"
          >
            Join as {user.name}
          </button>
        </p>
      </div>
    </Modal>
  );
}
