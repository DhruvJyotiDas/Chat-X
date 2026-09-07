// Per-chat personalization — theme accent, wallpaper, and message font.
// Purely a per-viewer display preference (like devicePrefs.ts/captions.ts's
// own settings), so localStorage is the right store, not something synced
// between participants — two people in the same DM can each pick their own
// look without coordinating, exactly like real chat apps do this.

export interface ChatPersonalization {
  wallpaper: string; // a key into WALLPAPERS, or 'none'
  accent: string; // a key into ACCENTS
  font: string; // a key into FONTS
}

export const DEFAULT_PERSONALIZATION: ChatPersonalization = { wallpaper: 'none', accent: 'blue', font: 'default' };

export const WALLPAPERS: { key: string; label: string; css: string }[] = [
  { key: 'none', label: 'None', css: '' },
  { key: 'midnight', label: 'Midnight', css: 'linear-gradient(160deg, #0e0e0e 0%, #14203a 100%)' },
  { key: 'forest', label: 'Forest', css: 'linear-gradient(160deg, #0e0e0e 0%, #0f2a1c 100%)' },
  { key: 'sunset', label: 'Sunset', css: 'linear-gradient(160deg, #1a1010 0%, #3a1f14 100%)' },
  { key: 'grape', label: 'Grape', css: 'linear-gradient(160deg, #150e1a 0%, #2a1638 100%)' },
  { key: 'slate', label: 'Slate', css: 'linear-gradient(160deg, #101214 0%, #1c2226 100%)' },
];

export const ACCENTS: { key: string; label: string; hex: string }[] = [
  { key: 'blue', label: 'Blue', hex: '#568dff' },
  { key: 'violet', label: 'Violet', hex: '#8083ff' },
  { key: 'teal', label: 'Teal', hex: '#2dd4bf' },
  { key: 'rose', label: 'Rose', hex: '#fb7185' },
  { key: 'amber', label: 'Amber', hex: '#f5a524' },
];

export const FONTS: { key: string; label: string; css: string }[] = [
  { key: 'default', label: 'Default', css: 'inherit' },
  { key: 'serif', label: 'Serif', css: 'Georgia, "Times New Roman", serif' },
  { key: 'mono', label: 'Monospace', css: '"SF Mono", "Fira Code", ui-monospace, monospace' },
  { key: 'rounded', label: 'Rounded', css: 'Verdana, "Trebuchet MS", sans-serif' },
];

const keyFor = (userId: string, threadId: string) => `ibconnect_chat_personalization_${userId}_${threadId}`;

export function loadChatPersonalization(userId: string, threadId: string): ChatPersonalization {
  try {
    const raw = localStorage.getItem(keyFor(userId, threadId));
    if (raw) return { ...DEFAULT_PERSONALIZATION, ...JSON.parse(raw) };
  } catch { /* corrupt or inaccessible storage — fall through to default */ }
  return DEFAULT_PERSONALIZATION;
}

export function saveChatPersonalization(userId: string, threadId: string, prefs: ChatPersonalization): void {
  try { localStorage.setItem(keyFor(userId, threadId), JSON.stringify(prefs)); } catch { /* storage full/blocked — setting just won't persist */ }
}
