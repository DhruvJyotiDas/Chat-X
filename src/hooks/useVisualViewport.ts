import { useEffect } from 'react';

/**
 * Phase 3 foundation. Writes --vv-top and --vv-height (both px) onto
 * <html> from window.visualViewport, kept current via rAF on its own
 * resize/scroll events -- the two events a virtual keyboard opening/closing
 * or a mobile browser's chrome collapsing actually fire. Layout `vh`/`dvh`
 * don't shrink for an on-screen keyboard on iOS Safari; visualViewport does.
 *
 * Mount once at the app shell (see App.tsx), not per-consumer -- the CSS
 * variables are global state on documentElement, so one writer is enough
 * and avoids redundant rAF loops from multiple mounts.
 *
 * Contract for consumers: `window.visualViewport` doesn't exist on every
 * engine, so this hook simply does not set the properties when it's
 * unavailable, rather than writing a synthetic value. Read both variables
 * with a fallback at the call site -- `var(--vv-height, 100dvh)` and
 * `var(--vv-top, 0px)` -- so a browser without visualViewport support still
 * gets a sane full-height, top-anchored box instead of an unset variable
 * collapsing the layout.
 */
export function useVisualViewport() {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    const root = document.documentElement;
    let raf = 0;

    const write = () => {
      root.style.setProperty('--vv-top', `${vv.offsetTop}px`);
      root.style.setProperty('--vv-height', `${vv.height}px`);
    };

    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(write);
    };

    schedule();
    vv.addEventListener('resize', schedule);
    vv.addEventListener('scroll', schedule);

    return () => {
      cancelAnimationFrame(raf);
      vv.removeEventListener('resize', schedule);
      vv.removeEventListener('scroll', schedule);
      root.style.removeProperty('--vv-top');
      root.style.removeProperty('--vv-height');
    };
  }, []);
}
