/**
 * Avatar — not explicitly spec'd in DESIGN_SYSTEM.md §8 (only Button/Badge/
 * Card/Modal/Input were), built from the one real pattern already in use
 * (Sidebar.tsx's profile avatar: image-or-initials, optional presence dot)
 * rather than invented from nothing, so it matches what "avatar" already
 * means in this app instead of introducing a second visual language for it.
 */

export type AvatarSize = 'sm' | 'md' | 'lg';
export type PresenceStatus = 'good' | 'warn' | 'bad' | 'neutral' | 'none';

const SIZE_PX: Record<AvatarSize, string> = { sm: 'w-7 h-7 text-[11px]', md: 'w-9 h-9 text-[13px]', lg: 'w-14 h-14 text-[18px]' };
const DOT_COLOR: Record<Exclude<PresenceStatus, 'none'>, string> = {
  good: 'bg-[var(--ib-good-dot)]', warn: 'bg-[var(--ib-warn-dot)]',
  bad: 'bg-[var(--ib-bad-dot)]', neutral: 'bg-[var(--ib-gray-400)]',
};

interface AvatarProps {
  src?: string | null;
  /** Fallback shown when there's no src — pass already-computed initials, e.g. "SK". */
  initials: string;
  size?: AvatarSize;
  presence?: PresenceStatus;
  className?: string;
}

export default function Avatar({ src, initials, size = 'md', presence = 'none', className = '' }: AvatarProps) {
  return (
    <div className={`relative shrink-0 ${className}`}>
      <div className={`${SIZE_PX[size]} rounded-full overflow-hidden bg-[var(--ib-blue-50)] flex items-center justify-center font-bold text-[var(--ib-blue-800)]`}>
        {src ? <img src={src} alt="" className="w-full h-full object-cover" /> : initials}
      </div>
      {presence !== 'none' && (
        <span
          className={`absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full border-2 border-white ${DOT_COLOR[presence]}`}
          aria-hidden="true"
        />
      )}
    </div>
  );
}
