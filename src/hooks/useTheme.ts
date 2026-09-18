import { useCallback, useEffect, useState } from 'react';

export type ThemePreference = 'dark' | 'light' | 'system';

const KEY = 'ibconnect_theme';

// Dark mode gate (light-theme redesign, sub-unit 0). Flip to true only once
// sub-unit 9's dark palette exists and its screenshots pass -- see
// CHANGELOG.md for that sub-unit's own note if this is still false.
// Real mechanism, read from the code rather than assumed:
//   - `data-theme="dark"|"light"` ATTRIBUTE on <html> (not a class).
//   - Storage key above holds the raw preference ('dark'|'light'|'system'),
//     not the resolved value -- resolve() turns 'system' into one of the
//     other two before apply() writes the attribute.
//   - src/index.css is a two-layer cascade, not one clean direction: `body`
//     and `.dashboard-surface` have LIGHT as their unconditional base with a
//     `:root[data-theme="dark"]` override restoring the old dark look (both
//     migrated in this redesign); the older, not-yet-migrated "Bento Grid"
//     utility classes (`.bg-[#131313]` etc.) have the OPPOSITE shape -- DARK
//     is their unconditional base, and a separate `:root[data-theme="light"]`
//     block (60+ rules) overrides them for the new light default. A real
//     'dark' pref today would render CORRECTLY on the not-yet-migrated
//     screens (their dark base needs no override) but WRONG on every screen
//     already migrated onto --ib-* tokens directly (Sidebar, PreJoin,
//     ActiveMeetingView's chrome, etc.) -- those have no dark counterpart
//     yet and would render stuck light. That mismatch, not indecision, is
//     why dark mode stays gated off until sub-unit 9 does that work for real.
export const DARK_MODE_READY = false;

function resolve(pref: ThemePreference): 'dark' | 'light' {
  if (!DARK_MODE_READY) return 'light';
  if (pref === 'system') {
    return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  return pref;
}

function apply(pref: ThemePreference) {
  document.documentElement.setAttribute('data-theme', resolve(pref));
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
