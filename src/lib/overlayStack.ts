import { useSyncExternalStore } from 'react';

/**
 * Phase 3, sub-unit 2. A minimal shared registry of "is at least one
 * overlay open right now" -- needed so the Ask AIPA launcher/popup can
 * hide itself while a Modal, sheet, or another floating surface is
 * covering the screen, per this batch's visibility rules.
 *
 * Coverage, disclosed rather than silently partial: `Modal.tsx` registers
 * itself automatically (every Modal/sheet usage is covered for free --
 * SettingsModal, GuestNameModal, ConnectionTestPanel today), and
 * CommandPalette and Sidebar's mobile drawer register explicitly since
 * they're still ad hoc overlays, not built on Modal. Older ad hoc
 * `fixed inset-0` surfaces this batch doesn't touch (MeetingInviteDialog,
 * etc.) are NOT wired in -- full coverage lands when Phase 4's sub-unit 7
 * migrates the remaining ones onto Modal.
 */

let count = 0;
const listeners = new Set<() => void>();

function notify() {
  for (const l of listeners) l();
}

export function pushOverlay() {
  count += 1;
  notify();
  return () => {
    count = Math.max(0, count - 1);
    notify();
  };
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot() {
  return count > 0;
}

export function useAnyOverlayOpen(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
