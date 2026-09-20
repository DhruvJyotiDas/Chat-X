import { useSyncExternalStore } from 'react';

/**
 * Fix-batch 2, section 1. A minimal shared registry -- same
 * counter/notify-set shape as src/lib/overlayStack.ts, deliberately, since
 * that pattern already works -- of "is at least one bottom-anchored
 * composer/control surface open right now", so the Ask AIPA launcher can
 * hide itself instead of covering a send button, a toggle, or a form field
 * it doesn't know exists.
 *
 * Root cause this replaces: sub-unit 2's own doc comment already disclosed
 * "hidden while a chat thread is open (mobile) is NOT wired" -- the reason
 * is that ChatsView's thread-open state (`mobilePanel`, a plain useState)
 * was never lifted or exposed anywhere a SIBLING component (AskAIPA, mounted
 * once at the App shell level, not a parent/child of ChatsView) could read
 * it. This is a separate registry from overlayStack.ts on purpose: that one
 * answers "is a Modal-style overlay open" (for Escape-key handling
 * elsewhere); this one answers a different question ("does something own
 * the bottom-right corner right now") that plain page content -- a chat
 * thread, a settings panel -- can trigger without being an "overlay" at all.
 */

let count = 0;
const listeners = new Set<() => void>();

function notify() {
  for (const l of listeners) l();
}

export function suppressLauncher() {
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

export function useLauncherSuppressed(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
