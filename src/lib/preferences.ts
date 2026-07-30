// Client-local preferences: no backend field exists for these yet, so they're
// stored per-browser rather than synced to the user's account.

export interface StatusPreference { emoji: string; text: string; }
export interface NotificationPreferences {
  messageAlerts: boolean;
  meetingReminders: boolean;
  soundEffects: boolean;
}

const STATUS_KEY = (userId: string) => `ibconnect_status_${userId}`;
const NOTIF_KEY = (userId: string) => `ibconnect_notifs_${userId}`;

export const DEFAULT_NOTIFS: NotificationPreferences = {
  messageAlerts: true,
  meetingReminders: true,
  soundEffects: true,
};

export function loadStatus(userId: string): StatusPreference {
  try {
    const raw = localStorage.getItem(STATUS_KEY(userId));
    if (raw) return JSON.parse(raw);
  } catch {}
  return { emoji: '', text: '' };
}

export function saveStatus(userId: string, status: StatusPreference) {
  localStorage.setItem(STATUS_KEY(userId), JSON.stringify(status));
}

export function loadNotifications(userId: string): NotificationPreferences {
  try {
    const raw = localStorage.getItem(NOTIF_KEY(userId));
    if (raw) return { ...DEFAULT_NOTIFS, ...JSON.parse(raw) };
  } catch {}
  return DEFAULT_NOTIFS;
}

export function saveNotifications(userId: string, prefs: NotificationPreferences) {
  localStorage.setItem(NOTIF_KEY(userId), JSON.stringify(prefs));
}
