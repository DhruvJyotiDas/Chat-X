import { useCallback, useEffect, useState } from 'react';

export type ThemePreference = 'dark' | 'light' | 'system';

const KEY = 'ibconnect_theme';

function resolve(pref: ThemePreference): 'dark' | 'light' {
  if (pref === 'system') {
    return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  return pref;
}

function apply(pref: ThemePreference) {
  document.documentElement.setAttribute('data-theme', resolve(pref));
}

export function useTheme() {
  const [theme, setThemeState] = useState<ThemePreference>(() => {
    try { return (localStorage.getItem(KEY) as ThemePreference) ?? 'dark'; } catch { return 'dark'; }
  });

  useEffect(() => { apply(theme); }, [theme]);

  useEffect(() => {
    if (theme !== 'system') return;
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
