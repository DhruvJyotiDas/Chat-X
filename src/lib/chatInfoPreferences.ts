export type DisappearingDuration = 'off' | '24h' | '7d' | '90d';

export interface ChatInfoPreferences {
  muted: boolean;
  disappearing: DisappearingDuration;
}

const defaults: ChatInfoPreferences = { muted: false, disappearing: 'off' };
const keyFor = (userId: string, threadId: string) => `ibconnect_chat_info_${userId}_${threadId}`;

export function loadChatInfoPreferences(userId: string, threadId: string): ChatInfoPreferences {
  try {
    const value = localStorage.getItem(keyFor(userId, threadId));
    return value ? { ...defaults, ...JSON.parse(value) } : defaults;
  } catch {
    return defaults;
  }
}

export function saveChatInfoPreferences(userId: string, threadId: string, value: ChatInfoPreferences): void {
  try { localStorage.setItem(keyFor(userId, threadId), JSON.stringify(value)); } catch {}
}
