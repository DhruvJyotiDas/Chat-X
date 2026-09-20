import { useCallback, useSyncExternalStore } from 'react';

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

export function resolveTheme(pref: ThemePreference): 'dark' | 'light' {
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
  const resolved = resolveTheme(pref);
  document.documentElement.setAttribute('data-theme', resolved);
  document.documentElement.style.colorScheme = resolved;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[resolved]);
}

// Bug-batch 2026-09-19, section 4: every useTheme() call used to be its own
// independent useState -- the Sidebar toggle added in this same fix wouldn't
// have updated Settings' Appearance picker (or vice versa) without a reload,
// and neither would have noticed a second tab changing the preference. This
// is now real module-level singleton state (one value, everyone subscribes
// to it) via useSyncExternalStore -- the storage key and the values stored
// under it are UNCHANGED, only how components read/write the in-memory copy.
function readStoredTheme(): ThemePreference {
  if (!DARK_MODE_READY) return 'light';
  try { return (localStorage.getItem(KEY) as ThemePreference) ?? 'light'; } catch { return 'light'; }
}

let currentTheme: ThemePreference = readStoredTheme();
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

function setTheme(pref: ThemePreference) {
  currentTheme = pref;
  try { localStorage.setItem(KEY, pref); } catch {}
  apply(pref);
  notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): ThemePreference {
  return currentTheme;
}

if (typeof window !== 'undefined') {
  apply(currentTheme);

  // Cross-tab sync: the `storage` event fires in every OTHER tab (never the
  // one that made the change) when localStorage is written -- this is what
  // makes a second tab follow a theme change without a reload.
  window.addEventListener('storage', (e) => {
    if (e.key !== KEY || !DARK_MODE_READY) return;
    currentTheme = (e.newValue as ThemePreference) ?? 'light';
    apply(currentTheme);
    notify();
  });

  // 'system' re-resolves when the OS preference flips, regardless of which
  // (if any) component instance is mounted right now -- module-level, not
  // per-hook, since this is genuinely singleton state now.
  if (DARK_MODE_READY) {
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    mq.addEventListener('change', () => {
      if (currentTheme !== 'system') return;
      apply(currentTheme);
      notify();
    });
  }
}

export function useTheme() {
  const theme = useSyncExternalStore(subscribe, getSnapshot);
  const set = useCallback((pref: ThemePreference) => setTheme(pref), []);
  return { theme, setTheme: set };
}
