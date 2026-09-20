import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { motion, AnimatePresence, useDragControls } from 'motion/react';
import { X } from 'lucide-react';
import { useScrollLock } from '../../hooks/useScrollLock';
import { useKeyboardOpen } from '../../hooks/useKeyboardOpen';
import { useReducedMotion } from '../../hooks/useReducedMotion';
import { pushOverlay } from '../../lib/overlayStack';

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
 *
 * Phase 3, sub-unit 1 (foundations) added the `variant` prop:
 * - 'sheet' (default): bottom sheet on <md (drag handle, top radius, safe-
 *   area bottom padding, height capped by --vv-height so the keyboard or a
 *   collapsing browser chrome bar doesn't push content off-screen), centered
 *   card on >=md. Swipe-down-to-dismiss is bound only to the handle/header
 *   row (via useDragControls + a manual dragControls.start() on pointerdown
 *   there), not the whole sheet — so dragging inside the scrollable content
 *   never gets mistaken for a dismiss gesture.
 * - 'centered': always a centered card, at every width. On <md with the
 *   keyboard open this still needs to move — a dialog vertically centered in
 *   the full (keyboard-inclusive) layout viewport can end up with its lower
 *   half, including its primary action, hidden under the keyboard. The outer
 *   wrapper is pinned to the visual viewport's own top/height
 *   (--vv-top/--vv-height, sub-unit 1's useVisualViewport), and at <md it
 *   aligns content to the top of that box instead of centering within it, so
 *   the dialog rides up with the keyboard rather than staying centered in
 *   space the keyboard has covered.
 */

interface ModalProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  /** Content max-width. 'sm' for a form (~420px), 'lg' for a richer panel like Settings (~640px). */
  size?: 'sm' | 'lg';
  /** 'sheet' (default) = bottom sheet <md / centered card >=md. 'centered' = always a centered card. */
  variant?: 'sheet' | 'centered';
  /** Sheet variant only. Near-full-height sheet (top gap ~48px + safe-area)
   *  instead of the default content-driven, 85vh-capped height — for a
   *  surface with its own internal scroll region that wants the space
   *  (Ask AIPA's mobile popup, sub-unit 2). */
  fullHeight?: boolean;
  /** Suppresses Modal's own built-in close X — for a caller supplying its
   *  own header with a close action (Ask AIPA's popup, sub-unit 2), so
   *  there isn't a second, redundant close button floating on top of it. */
  hideCloseButton?: boolean;
  'aria-label': string;
}

const MAX_WIDTH = { sm: 'max-w-[420px]', lg: 'max-w-[640px]' };

export default function Modal({
  open, onClose, children, size = 'sm', variant = 'sheet', fullHeight = false, hideCloseButton = false, ...rest
}: ModalProps) {
  const reduceMotion = useReducedMotion();
  const dragControls = useDragControls();
  useScrollLock(open);
  const keyboardOpen = useKeyboardOpen();

  // Registers with the shared "is any overlay open" signal (sub-unit 2,
  // src/lib/overlayStack.ts) for the whole time this Modal is open — every
  // Modal-based dialog/sheet gets this for free, no per-caller wiring.
  useEffect(() => {
    if (!open) return;
    return pushOverlay();
  }, [open]);

  // Esc closes, matching every existing ad hoc modal's own convention.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  const isSheet = variant === 'sheet';

  return (
    <AnimatePresence>
      {open && (
        <div
          className={`fixed inset-x-0 z-50 flex p-0 md:p-4 md:items-center md:justify-center ${
            isSheet
              ? 'items-end'
              : keyboardOpen
                ? 'items-start justify-center pt-4 md:items-center md:pt-0'
                : 'items-center justify-center'
          }`}
          style={{ top: 'var(--vv-top, 0px)', height: 'var(--vv-height, 100dvh)' }}
        >
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
            drag={isSheet ? 'y' : false}
            dragControls={dragControls}
            dragListener={false}
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={{ top: 0, bottom: 0.6 }}
            onDragEnd={isSheet ? (_e, info) => {
              if (info.offset.y > 80 || info.velocity.y > 500) onClose();
            } : undefined}
            className={
              isSheet
                ? `relative w-full ${MAX_WIDTH[size]} md:mx-auto flex flex-col
                   overflow-hidden
                   bg-[var(--ib-surface-raised)] rounded-t-[var(--ib-radius-xl)] md:rounded-[var(--ib-radius-xl)]
                   shadow-[var(--ib-shadow-lg)] pb-[env(safe-area-inset-bottom)] md:pb-0`
                : `relative w-full ${MAX_WIDTH[size]} overflow-y-auto
                   bg-[var(--ib-surface-raised)] rounded-[var(--ib-radius-xl)] shadow-[var(--ib-shadow-lg)]`
            }
            style={{
              ...(isSheet
                ? fullHeight
                  ? { height: 'calc(var(--vv-height, 100dvh) - 48px - env(safe-area-inset-top, 0px))' }
                  : { maxHeight: 'min(85vh, var(--vv-height, 100dvh) - 24px)' }
                : { maxHeight: 'min(90vh, var(--vv-height, 100dvh) - 32px)' }),
            }}
            initial={reduceMotion ? { opacity: 0 } : isSheet ? { opacity: 0, y: '100%' } : { opacity: 0, scale: 0.96 }}
            animate={reduceMotion ? { opacity: 1 } : isSheet ? { opacity: 1, y: 0 } : { opacity: 1, scale: 1 }}
            exit={reduceMotion ? { opacity: 0 } : isSheet ? { opacity: 0, y: '100%' } : { opacity: 0, scale: 0.96 }}
            transition={{ duration: reduceMotion ? 0 : 0.25, ease: [0.2, 0.8, 0.2, 1] }}
          >
            {isSheet && (
              <div
                onPointerDown={(e) => dragControls.start(e)}
                className="md:hidden shrink-0 flex justify-center pt-2 pb-1 touch-none cursor-grab active:cursor-grabbing"
              >
                <div className="w-9 h-1 rounded-full bg-[var(--ib-gray-200)]" />
              </div>
            )}
            {!hideCloseButton && (
              <button
                onClick={onClose}
                aria-label="Close"
                // 44px tap target regardless of the visible icon size — mobile tap-target floor, §8.
                className="absolute top-2 right-2 w-11 h-11 flex items-center justify-center
                  rounded-full text-[var(--ib-gray-600)] hover:bg-[var(--ib-gray-50)]
                  active:scale-95 transition-all cursor-pointer z-10"
              >
                <X className="w-5 h-5" />
              </button>
            )}
            <div className={isSheet ? 'flex-1 min-h-0 overflow-y-auto overscroll-contain' : ''}>
              {children}
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
