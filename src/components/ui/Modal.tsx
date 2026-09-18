import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X } from 'lucide-react';

// motion's useReducedMotion isn't exported by the installed version of the
// package (checked directly, not assumed) — same matchMedia read useTheme.ts
// already uses for prefers-color-scheme, applied to prefers-reduced-motion.
function useReducedMotion() {
  const [reduced, setReduced] = useState(
    () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
  );
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const handler = () => setReduced(mq.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);
  return reduced;
}

/**
 * DESIGN_SYSTEM.md §8 — Modal / dialog.
 *
 * Base shell only. This does not replace all 15 existing ad hoc `fixed
 * inset-0` implementations in one move (UI_REDESIGN_PLAN.md §1 lists them) —
 * each one migrates onto this as that screen's own redesign pass reaches it,
 * per the Phase 2/3/4 ordering in UI_REDESIGN_PLAN.md §6.
 *
 * `open` is a real prop (not conditional-render-only) so AnimatePresence can
 * play the exit animation — unmounting via `{open && <Modal/>}` from the
 * caller skips the exit transition entirely, a common Framer Motion mistake.
 */

interface ModalProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  /** Content max-width. 'sm' for a form (~420px), 'lg' for a richer panel like Settings (~640px). */
  size?: 'sm' | 'lg';
  'aria-label': string;
}

const MAX_WIDTH = { sm: 'max-w-[420px]', lg: 'max-w-[640px]' };

export default function Modal({ open, onClose, children, size = 'sm', ...rest }: ModalProps) {
  const reduceMotion = useReducedMotion();

  // Esc closes, matching every existing ad hoc modal's own convention.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <motion.div
            className="absolute inset-0 bg-[var(--ib-gray-900)]/40 backdrop-blur-sm"
            onClick={onClose}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reduceMotion ? 0 : 0.2 }}
          />
          <motion.div
            role="dialog"
            aria-modal="true"
            {...rest}
            className={`relative w-full ${MAX_WIDTH[size]} max-h-[90vh] overflow-y-auto
              bg-white rounded-[var(--ib-radius-xl)] shadow-[var(--ib-shadow-lg)]`}
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.96 }}
            animate={reduceMotion ? { opacity: 1 } : { opacity: 1, scale: 1 }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.96 }}
            transition={{ duration: reduceMotion ? 0 : 0.25, ease: [0.2, 0.8, 0.2, 1] }}
          >
            <button
              onClick={onClose}
              aria-label="Close"
              // 44px tap target regardless of the visible icon size — mobile tap-target floor, §8.
              className="absolute top-2 right-2 w-11 h-11 flex items-center justify-center
                rounded-full text-[var(--ib-gray-600)] hover:bg-[var(--ib-gray-50)]
                active:scale-95 transition-all cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>
            {children}
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
