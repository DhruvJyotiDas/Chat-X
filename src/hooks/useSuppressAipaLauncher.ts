import { useEffect } from 'react';
import { suppressLauncher } from '../lib/launcherSuppress';

/**
 * Fix-batch 2, section 1. Any screen that owns a bottom composer or other
 * bottom-anchored controls calls this with whether that state is currently
 * active -- e.g. `useSuppressAipaLauncher(mobilePanel === 'chat')` in
 * ChatsView. While `active` is true, the Ask AIPA launcher hides itself
 * (see AskAIPA.tsx's `launcherHidden` computation) instead of floating on
 * top of whatever this screen is showing at the bottom of the viewport.
 */
export function useSuppressAipaLauncher(active: boolean) {
  useEffect(() => {
    if (!active) return;
    return suppressLauncher();
  }, [active]);
}
