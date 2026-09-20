import React, { useCallback, useEffect, useRef, useState } from 'react';
import { X, UserPlus, Copy, Check, Lock } from 'lucide-react';
import { useMeeting } from '../../context/MeetingContext';
import { useAuth } from '../../context/AuthContext';

interface MeetingInviteDialogProps {
  onClose: () => void;
  /** Opens the app's participant-invite flow. No dedicated "add people" picker
   * exists in the app yet, so callers should wire this to whatever is closest
   * (e.g. opening the People panel) — this component itself stays a clean,
   * unopinionated placeholder and never assumes one exists. */
  onAddPeople?: () => void;
}

export default function MeetingInviteDialog({ onClose, onAddPeople }: MeetingInviteDialogProps) {
  const { roomId, requireApproval, setRequireApproval } = useMeeting();
  const { currentUser } = useAuth();

  const [copied, setCopied] = useState(false);
  const [showToast, setShowToast] = useState(false);
  const copyResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (copyResetTimer.current) clearTimeout(copyResetTimer.current);
    if (toastTimer.current) clearTimeout(toastTimer.current);
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  if (!roomId) return null;

  // Routing here is `/:roomCode` (see App.tsx), not `/meet/:id` — mirrors the
  // existing copyLink logic already used elsewhere in ActiveMeetingView.
  const meetingUrl = `${window.location.origin}/${roomId}`;
  const displayUrl = meetingUrl.replace(/^https?:\/\//, '');
  const hostLabel = currentUser?.email || null;

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(meetingUrl);
    } catch (err) {
      console.error('[MeetingInviteDialog] clipboard write failed', err);
      return;
    }
    // Clear any in-flight timers first so rapid repeat clicks reset the
    // 2s window instead of stacking multiple pending state flips/toasts.
    if (copyResetTimer.current) clearTimeout(copyResetTimer.current);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setCopied(true);
    setShowToast(true);
    copyResetTimer.current = setTimeout(() => setCopied(false), 2000);
    toastTimer.current = setTimeout(() => setShowToast(false), 2000);
  }, [meetingUrl]);

  return (
    <div
      className="absolute inset-0 z-[10000] flex items-center justify-center bg-black/30 p-4"
      onClick={onClose}
    >
      <div className="relative w-full max-w-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="invite-dialog-title"
        onClick={(e) => e.stopPropagation()}
        className="w-full bg-[#202124] border border-[#3c4043] rounded-2xl shadow-2xl p-5 sm:p-6 flex flex-col gap-5"
      >
        <div className="flex items-start justify-between gap-3">
          <h2 id="invite-dialog-title" className="text-base sm:text-lg font-semibold text-[#e8eaed]">
            Your meeting is ready
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 -mt-1 -mr-1 w-11 h-11 md:w-8 md:h-8 flex items-center justify-center rounded-full text-[#9aa0a6] hover:bg-[#3c4043] hover:text-[#e8eaed] transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <button
          onClick={() => onAddPeople?.()}
          className="flex items-center justify-center gap-2 bg-[#8ab4f8] text-[#062e6f] font-semibold text-sm min-h-[44px] md:min-h-0 py-2.5 rounded-xl hover:bg-[#aecbfa] active:scale-[0.98] transition-all cursor-pointer"
        >
          <UserPlus className="w-4 h-4" />
          Add people
        </button>

        <div className="flex flex-col gap-2 min-w-0">
          <p className="text-xs text-[#9aa0a6]">Or share this meeting link with people you want to invite</p>
          <div className="flex items-center gap-2 bg-[#131314] border border-[#3c4043] rounded-xl pl-3 pr-1.5 py-1.5 min-w-0">
            <span className="flex-1 min-w-0 truncate text-xs sm:text-[13px] font-mono text-[#c7c9cc]" title={meetingUrl}>
              {displayUrl}
            </span>
            <button
              onClick={handleCopy}
              className={`shrink-0 flex items-center gap-1.5 px-2.5 min-h-[44px] md:min-h-0 py-1.5 rounded-lg text-xs font-semibold transition-colors cursor-pointer ${
                copied ? 'bg-[#0f3d24] text-[#81c995]' : 'bg-[#3c4043] text-[#e8eaed] hover:bg-[#4a4d51]'
              }`}
            >
              {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
              <span className="hidden sm:inline">{copied ? 'Copied' : 'Copy'}</span>
            </button>
          </div>
        </div>

        <label className="flex items-start gap-3 cursor-pointer select-none">
          <button
            type="button"
            role="switch"
            aria-checked={requireApproval}
            aria-label="Require approval to join"
            onClick={() => setRequireApproval(!requireApproval)}
            className={`relative shrink-0 mt-0.5 w-9 h-5 rounded-full transition-colors ${requireApproval ? 'bg-[#8ab4f8]' : 'bg-[#3c4043]'}`}
          >
            <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${requireApproval ? 'translate-x-[18px]' : 'translate-x-0.5'}`} />
          </button>
          <span className="flex items-start gap-2 text-[11px] leading-relaxed text-[#9aa0a6]">
            <Lock className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span>
              {requireApproval
                ? "Someone in the meeting has to let people in — you'll see a prompt when they knock."
                : 'Anyone with this meeting link can join. Turn this on to approve people before they enter.'}
            </span>
          </span>
        </label>

        {hostLabel && (
          <div className="pt-3 border-t border-[#3c4043]/70 text-[11px] text-[#9aa0a6]">
            Joined as <span className="text-[#c7c9cc] font-medium">{hostLabel}</span>
          </div>
        )}
      </div>

      {showToast && (
        <div className="absolute top-full mt-3 left-1/2 -translate-x-1/2 w-max max-w-[90vw] bg-[#3c4043] text-[#e8eaed] text-xs font-medium px-4 py-2.5 rounded-full shadow-xl flex items-center gap-2 pointer-events-none">
          <Check className="w-3.5 h-3.5 text-[#81c995]" />
          Meeting link copied
        </div>
      )}
      </div>
    </div>
  );
}
