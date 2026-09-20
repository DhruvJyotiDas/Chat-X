/**
 * DESIGN_SYSTEM.md §2.3 / §8 — the red/amber/green status pill.
 *
 * Formalizes what already existed informally as six independent, uncoordinated
 * call sites (Sidebar.tsx:89, TopBar.tsx:150, IncomingCallModal.tsx:34/43,
 * ChatsView.tsx:2058, SettingsModal.tsx:452 — see UI_REDESIGN_PLAN.md §1) each
 * hand-typing one of two literal hex values with no shared definition. This
 * is the one component to migrate those six sites onto, not five separate
 * fixes.
 */

export type BadgeStatus = 'good' | 'warn' | 'bad' | 'neutral';

const STATUS_CLASSES: Record<BadgeStatus, { fill: string; text: string; dot: string }> = {
  good:    { fill: 'bg-[var(--ib-good-fill)]', text: 'text-[var(--ib-good-text)]', dot: 'bg-[var(--ib-good-dot)]' },
  warn:    { fill: 'bg-[var(--ib-warn-fill)]', text: 'text-[var(--ib-warn-text)]', dot: 'bg-[var(--ib-warn-dot)]' },
  bad:     { fill: 'bg-[var(--ib-bad-fill)]',  text: 'text-[var(--ib-bad-text)]',  dot: 'bg-[var(--ib-bad-dot)]' },
  neutral: { fill: 'bg-[var(--ib-gray-100)]',  text: 'text-[var(--ib-gray-600)]',  dot: 'bg-[var(--ib-gray-400)]' },
};

// box-shadow color per status for the optional glow — computed inline rather
// than a fifth Tailwind class per status, since arbitrary-value opacity
// suffixes don't compose with var().
const GLOW_COLOR: Record<BadgeStatus, string> = {
  good: '#1FAE6B', warn: '#E8A317', bad: '#E5484D', neutral: '#9AA5B1',
};

interface BadgeProps {
  status: BadgeStatus;
  children: React.ReactNode;
  /** Soft glow around the dot, per the reference pages. Off by default —
   *  see DESIGN_SYSTEM.md §8: a page full of glowing pills reads as noisy,
   *  not premium. Opt in per call site where it earns its place. */
  glow?: boolean;
  className?: string;
}

export default function Badge({ status, children, glow = false, className = '' }: BadgeProps) {
  const c = STATUS_CLASSES[status];
  return (
    <span
      className={`inline-flex items-center gap-1.5 h-6 px-2.5 rounded-[var(--ib-radius-pill)]
        text-[12px] font-medium leading-none ${c.fill} ${c.text} ${className}`}
    >
      <span
        className={`w-2 h-2 rounded-full shrink-0 ${c.dot}`}
        style={glow ? { boxShadow: `0 0 8px ${GLOW_COLOR[status]}66` } : undefined}
      />
      {children}
    </span>
  );
}
