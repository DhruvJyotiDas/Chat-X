// Keyboard shortcuts for the call.
//
// Shaped after livekit-examples/meet's lib/KeyboardShortcuts.tsx, which is a plain
// keydown listener and two bindings — no dependency needed. Extended here with
// push-to-talk, which is the one people reach for by reflex and which nothing in
// either reference app implements.

import { useEffect, useRef } from 'react';

export interface CallShortcutHandlers {
  toggleMic: () => void;
  toggleCamera: () => void;
  toggleHand: () => void;
  /** Temporarily unmute while the key is held; called with the desired mute state. */
  setPushToTalk: (talking: boolean) => void;
}

/**
 * True when the event came from somewhere the user is typing. Without this, the
 * chat composer becomes unusable — every "d" mutes the call.
 */
function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

export function useCallShortcuts(handlers: CallShortcutHandlers, enabled: boolean) {
  // Handlers change identity every render (they close over call state), but the
  // listener must not be torn down and rebuilt each time — a keyup could otherwise
  // land on a listener that was removed while the key was still down, leaving the
  // mic stuck open.
  const ref = useRef(handlers);
  useEffect(() => { ref.current = handlers; }, [handlers]);

  useEffect(() => {
    if (!enabled) return;

    // Tracks whether *we* opened the mic, so releasing space cannot mute someone
    // who was already unmuted and just happened to press it.
    let pushing = false;

    const onKeyDown = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;

      // Cmd/Ctrl-D: mute. Matches Google Meet, which is where the muscle memory
      // most of these users have comes from.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        ref.current.toggleMic();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'e') {
        e.preventDefault();
        ref.current.toggleCamera();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'h') {
        e.preventDefault();
        ref.current.toggleHand();
        return;
      }

      // Push-to-talk. `e.repeat` fires continuously while held, so only the first
      // press counts.
      if (e.code === 'Space' && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        pushing = true;
        ref.current.setPushToTalk(true);
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || !pushing) return;
      pushing = false;
      ref.current.setPushToTalk(false);
    };

    // Losing focus mid-hold (alt-tab, clicking another window) never delivers the
    // keyup, which would leave the microphone live after the user thought they had
    // let go — the worst possible failure for this feature.
    const onBlur = () => {
      if (!pushing) return;
      pushing = false;
      ref.current.setPushToTalk(false);
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      if (pushing) ref.current.setPushToTalk(false);
    };
  }, [enabled]);
}

/** Rendered in the settings sheet so the shortcuts are discoverable. */
export const SHORTCUT_HINTS: { keys: string; action: string }[] = [
  { keys: 'Ctrl/⌘ + D', action: 'Mute or unmute' },
  { keys: 'Ctrl/⌘ + E', action: 'Camera on or off' },
  { keys: 'Ctrl/⌘ + H', action: 'Raise or lower hand' },
  { keys: 'Hold Space', action: 'Talk while held' },
];
