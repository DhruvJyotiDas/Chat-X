import { useCallback, useEffect, useState } from 'react';

export type ThemePreference = 'dark' | 'light' | 'system';

const KEY = 'ibconnect_theme';

// Dark mode gate (light-theme redesign, sub-unit 0). Flipped true in
// sub-unit 9 once the dark palette (index.css's :root[data-theme="dark"]
// token overrides) existed and its screenshots/axe-core pass logged in
// CHANGELOG.md checked out. If you're reading this while it's false again,
// something regressed it back -- check that CHANGELOG entry for what
// "passing" meant.
// Real mechanism, read from the code rather than assumed:
//   - `data-theme="dark"|"light"` ATTRIBUTE on <html> (not a class).
//   - Storage key above holds the raw preference ('dark'|'light'|'system'),
//     not the resolved value -- resolve() turns 'system' into one of the
//     other two before apply() writes the attribute.
//   - src/index.css's :root[data-theme="dark"] block overrides the --ib-*
//     TOKEN VALUES themselves, not per-component classes -- every screen
//     already built on those tokens (or the numbered gray/blue scale they're
//     built from) gets dark mode automatically. The remaining exceptions are
//     deliberate, not gaps: InterviewView.tsx, ActiveMeetingView's own video
//     chrome (and its floating/minimized window, and dialogs only ever
//     opened from inside it, like MeetingInviteDialog) stay on their own
//     fixed dark call-chrome regardless of theme, by design, matching every
//     other video-call product's convention -- see CHANGELOG.md's sub-unit 9
//     entry for the full list and why.
//   - index.html carries an inline pre-paint script with its OWN literal
//     copy of this constant (it runs before any module loads) -- keep it in
//     sync by hand if this ever changes.
export const DARK_MODE_READY = true;

function resolve(pref: ThemePreference): 'dark' | 'light' {
  if (!DARK_MODE_READY) return 'light';
  if (pref === 'system') {
    return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  return pref;
}

// Dark surface tone (--ib-gray-50 under :root[data-theme="dark"] in
// index.css) -- kept as a literal here rather than reading the CSS variable,
// since the browser-chrome meta tag has to be set before/independently of
// any stylesheet. Update both together if that token's value ever changes.
const THEME_COLOR = { light: '#0066FF', dark: '#0C111B' };

function apply(pref: ThemePreference) {
  const resolved = resolve(pref);
  document.documentElement.setAttribute('data-theme', resolved);
  document.documentElement.style.colorScheme = resolved;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[resolved]);
}

export function useTheme() {
  // Default flipped dark -> light 2026-09-18: the redesign in
  // DESIGN_SYSTEM.md is a full departure from dark, not an opt-in toggle.
  // An existing user's saved localStorage preference is untouched either way.
  //
  // While DARK_MODE_READY is false: never even read the stored preference,
  // so a real saved 'dark' is neither applied nor overwritten -- it is
  // simply left alone in storage, ready to resolve correctly the moment the
  // gate flips true and this file is deployed with it.
  const [theme, setThemeState] = useState<ThemePreference>(() => {
    if (!DARK_MODE_READY) return 'light';
    try { return (localStorage.getItem(KEY) as ThemePreference) ?? 'light'; } catch { return 'light'; }
  });

  useEffect(() => { apply(theme); }, [theme]);

  useEffect(() => {
    if (!DARK_MODE_READY || theme !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const handler = () => apply('system');
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [theme]);

  const setTheme = useCallback((pref: ThemePreference) => {
    setThemeState(pref);
    try { localStorage.setItem(KEY, pref); } catch {}
  }, []);

  return { theme, setTheme };
}
