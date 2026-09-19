import React, { useState, useRef, useEffect, useMemo } from 'react';
import {
  X, Camera, User, Lock, Bell, LogOut, Check,
  Loader2, Mail, AtSign, Calendar, ExternalLink,
  ChevronRight, Shield, Palette, Info, Sun, Moon, Monitor,
  MessageSquare, Video, Volume2, Smile, Activity, Sparkles,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { api } from '../../lib/api';
import { useTheme, ThemePreference, DARK_MODE_READY } from '../../hooks/useTheme';
import { loadStatus, saveStatus, loadNotifications, saveNotifications, NotificationPreferences } from '../../lib/preferences';
import { watchDevices, resolveSelection, loadDevicePrefs, EMPTY_SNAPSHOT, type DeviceSnapshot } from '../../lib/devicePrefs';
import { isSpeakerSelectionSupported, setPreferredSpeaker } from '../../lib/audioOutput';
import ConnectionTestPanel from '../meeting/ConnectionTestPanel';
import { config } from '../../config';
import Badge from '../ui/Badge';

type Tab = 'profile' | 'preferences' | 'devices' | 'security' | 'account';

const STATUS_EMOJIS = ['', '💬', '🎯', '📚', '🏫', '🚗', '🍽️', '😴', '🌴', '🤒'];

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={`w-10 h-6 rounded-full transition-colors relative shrink-0 cursor-pointer ${checked ? 'bg-[var(--ib-blue-500)]' : 'bg-[var(--ib-gray-200)]'}`}
    >
      <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow-sm transition-transform ${checked ? 'translate-x-[18px]' : 'translate-x-0.5'}`} />
    </button>
  );
}

interface Props {
  onClose: () => void;
}

// ── Avatar uploader ───────────────────────────────────────────────────────────

function AvatarPicker({ current, name, onChange }: {
  current?: string;
  name: string;
  onChange: (dataUrl: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState(current);

  const handle = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 500 * 1024) { alert('Image must be under 500 KB'); return; }
    const reader = new FileReader();
    reader.onload = (ev) => {
      const url = ev.target?.result as string;
      setPreview(url);
      onChange(url);
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  const initials = name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);

  return (
    <div className="relative group w-20 h-20 mx-auto cursor-pointer" onClick={() => inputRef.current?.click()}>
      <input ref={inputRef} type="file" accept="image/*" className="hidden" onChange={handle} />
      {preview ? (
        <img src={preview} alt="avatar" className="w-20 h-20 rounded-full object-cover border-2 border-[var(--ib-border)]" />
      ) : (
        <div className="w-20 h-20 rounded-full bg-[var(--ib-blue-50)] border-2 border-[var(--ib-border)] flex items-center justify-center">
          <span className="text-2xl font-bold text-[var(--ib-blue-500)]">{initials}</span>
        </div>
      )}
      <div className="absolute inset-0 rounded-full bg-[var(--ib-gray-900)]/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
        <Camera className="w-5 h-5 text-white" />
      </div>
      <div className="absolute -bottom-1 -right-1 w-6 h-6 bg-[var(--ib-blue-500)] rounded-full border-2 border-[var(--ib-surface-raised)] flex items-center justify-center">
        <Camera className="w-3 h-3 text-white" />
      </div>
    </div>
  );
}

// ── Field component ───────────────────────────────────────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-[10px] font-bold uppercase tracking-wider text-[var(--ib-text-muted)]">{label}</label>
      {children}
    </div>
  );
}

function Input({ value, onChange, placeholder, disabled, type = 'text' }: {
  value: string; onChange?: (v: string) => void;
  placeholder?: string; disabled?: boolean; type?: string;
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={e => onChange?.(e.target.value)}
      placeholder={placeholder}
      disabled={disabled}
      className="h-11 px-3 bg-[var(--ib-gray-50)] border border-[var(--ib-border)] rounded-xl text-base md:text-xs text-[var(--ib-text)] placeholder-[var(--ib-text-muted)] focus:border-[var(--ib-blue-500)] focus:shadow-[var(--ib-shadow-focus)] outline-none transition-all disabled:opacity-50 disabled:cursor-not-allowed touch-manipulation"
    />
  );
}

// ── Profile tab ───────────────────────────────────────────────────────────────

function ProfileTab() {
  const { currentUser, updateProfile } = useAuth();
  const [displayName, setDisplayName] = useState(currentUser?.displayName ?? '');
  const [bio, setBio] = useState(currentUser?.bio ?? '');
  const [avatar, setAvatar] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  const dirty = displayName !== currentUser?.displayName || bio !== (currentUser?.bio ?? '') || avatar !== '';

  const save = async () => {
    if (!displayName.trim()) { setError('Display name is required'); return; }
    setSaving(true); setError('');
    try {
      await updateProfile({ displayName: displayName.trim(), bio, ...(avatar ? { avatar } : {}) });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      setAvatar(''); // clear pending avatar after save
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const joined = currentUser?.createdAt
    ? new Date(currentUser.createdAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
    : '';

  return (
    <div className="flex flex-col gap-5">
      {/* Avatar */}
      <div className="flex flex-col items-center gap-2">
        <AvatarPicker
          current={currentUser?.avatar}
          name={currentUser?.displayName ?? 'U'}
          onChange={setAvatar}
        />
        <p className="text-[10px] text-[var(--ib-text-muted)]">Click to change · max 500 KB</p>
      </div>

      {/* Fields */}
      <Field label="Display Name">
        <Input value={displayName} onChange={setDisplayName} placeholder="Your name" />
      </Field>

      <Field label="Bio / Status">
        <textarea
          value={bio}
          onChange={e => setBio(e.target.value)}
          placeholder="What are you up to?"
          rows={2}
          maxLength={160}
          className="px-3 py-2.5 bg-[var(--ib-gray-50)] border border-[var(--ib-border)] rounded-xl text-base md:text-xs text-[var(--ib-text)] placeholder-[var(--ib-text-muted)] focus:border-[var(--ib-blue-500)] outline-none transition-all resize-none touch-manipulation"
        />
        <span className="text-[10px] text-[var(--ib-text-muted)] text-right">{bio.length}/160</span>
      </Field>

      {/* Read-only fields */}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Username">
          <div className="flex items-center gap-2 px-3 py-2.5 bg-[var(--ib-gray-50)] border border-[var(--ib-border)] rounded-xl">
            <AtSign className="w-3 h-3 text-[var(--ib-text-muted)]" />
            <span className="text-xs text-[var(--ib-text-muted)]">{currentUser?.username}</span>
          </div>
        </Field>
        <Field label="Joined">
          <div className="flex items-center gap-2 px-3 py-2.5 bg-[var(--ib-gray-50)] border border-[var(--ib-border)] rounded-xl">
            <Calendar className="w-3 h-3 text-[var(--ib-text-muted)]" />
            <span className="text-xs text-[var(--ib-text-muted)] truncate">{joined}</span>
          </div>
        </Field>
      </div>

      <Field label="Email">
        <div className="flex items-center gap-2 px-3 py-2.5 bg-[var(--ib-gray-50)] border border-[var(--ib-border)] rounded-xl">
          <Mail className="w-3 h-3 text-[var(--ib-text-muted)]" />
          <span className="text-xs text-[var(--ib-text-muted)]">{currentUser?.email}</span>
        </div>
      </Field>

      {error && <p className="text-xs text-[var(--ib-bad-text)] bg-[var(--ib-bad-fill)] border border-[var(--ib-bad-dot)]/30 rounded-xl px-3 py-2">{error}</p>}

      <button
        onClick={save}
        disabled={!dirty || saving}
        className="w-full h-11 bg-[var(--ib-blue-500)] text-white font-bold text-xs rounded-xl hover:bg-[var(--ib-blue-600)] disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-all flex items-center justify-center gap-2"
      >
        {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : saved ? <Check className="w-3.5 h-3.5" /> : null}
        {saving ? 'Saving…' : saved ? 'Saved!' : 'Save Changes'}
      </button>
    </div>
  );
}

// ── Preferences tab ───────────────────────────────────────────────────────────

function PreferencesTab() {
  const { currentUser } = useAuth();
  const { theme, setTheme } = useTheme();
  const [status, setStatus] = useState(() => currentUser ? loadStatus(currentUser.id) : { emoji: '', text: '' });
  const [notifs, setNotifs] = useState<NotificationPreferences>(() => currentUser ? loadNotifications(currentUser.id) : { messageAlerts: true, meetingReminders: true, soundEffects: true });
  const [proactive, setProactive] = useState<import('../../lib/api').AIPAProactivePreferences>({
	enabled: true, meetingSuggestions: true, dailyPlanning: true, taskSignals: true,
	replySignals: true, meetingPrep: true, postMeeting: true, quietStart: '21:00',
	quietEnd: '08:00', timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, dailyLimit: 6,
  });
  const [proactiveSaving, setProactiveSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.getAIPAProactivePreferences().then(value => { if (!cancelled) setProactive(value); }).catch(() => {});
    return () => { cancelled = true; };
  }, [currentUser?.id]);

  const updateStatus = (next: typeof status) => {
    setStatus(next);
    if (currentUser) saveStatus(currentUser.id, next);
  };

  const updateNotif = (key: keyof NotificationPreferences, value: boolean) => {
    const next = { ...notifs, [key]: value };
    setNotifs(next);
    if (currentUser) saveNotifications(currentUser.id, next);
    // Browsers only grant Notification permission from a real user gesture —
    // this toggle click is exactly that, and it's the one place in the app
    // that has a genuine reason to ask (meeting_reminder events are otherwise
    // silent OS-notification-wise, falling back to the in-app banner alone;
    // see ChatContext's meeting_reminder handler and TopBar's banner).
    if (key === 'meetingReminders' && value && typeof Notification !== 'undefined' && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {});
    }
  };

  const updateProactive = async <K extends keyof typeof proactive>(key: K, value: (typeof proactive)[K]) => {
    const previous = proactive;
    const next = { ...proactive, [key]: value };
    setProactive(next);
    setProactiveSaving(true);
    try {
      setProactive(await api.updateAIPAProactivePreferences(next));
    } catch {
      setProactive(previous);
    } finally {
      setProactiveSaving(false);
    }
  };

  // 'system' was already a real ThemePreference value and useTheme.ts already
  // resolves it via matchMedia -- no change to useTheme needed to offer it here.
  const THEME_OPTIONS: { id: ThemePreference; label: string; Icon: React.ElementType }[] = [
    { id: 'light', label: 'Light', Icon: Sun },
    { id: 'dark', label: 'Dark', Icon: Moon },
    { id: 'system', label: 'System', Icon: Monitor },
  ];

  return (
    <div className="flex flex-col gap-6">
      {/* Theme -- gated on DARK_MODE_READY (light-theme redesign, sub-unit 0).
          Dark mode isn't coherent yet (see useTheme.ts's own note on the
          mixed CSS cascade), so this picker stays hidden rather than let
          someone select a 'dark' that only half-applies. Retoned onto
          tokens in sub-unit 6; flips visible once sub-unit 9 sets the gate. */}
      {DARK_MODE_READY && (
        <div>
          <div className="flex items-center gap-2 mb-2.5">
            <Palette className="w-3.5 h-3.5 text-[var(--ib-blue-500)]" />
            <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--ib-text-muted)]">Appearance</span>
          </div>
          <div className="grid grid-cols-3 gap-2">
            {THEME_OPTIONS.map(({ id, label, Icon }) => (
              <button
                key={id}
                onClick={() => setTheme(id)}
                className={`flex flex-col items-center gap-1.5 py-3 rounded-xl border text-xs font-semibold transition-all cursor-pointer ${theme === id ? 'border-[var(--ib-blue-500)] bg-[var(--ib-blue-50)] text-[var(--ib-blue-800)]' : 'border-[var(--ib-border)] text-[var(--ib-text-muted)] hover:text-[var(--ib-text)] hover:bg-[var(--ib-gray-50)]'}`}
              >
                <Icon className="w-4 h-4" />
                {label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Custom status */}
      <div>
        <div className="flex items-center gap-2 mb-2.5">
          <Smile className="w-3.5 h-3.5 text-[var(--ib-blue-500)]" />
          <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--ib-text-muted)]">Custom Status</span>
        </div>
        <div className="flex gap-2">
          <select
            value={status.emoji}
            onChange={e => updateStatus({ ...status, emoji: e.target.value })}
            className="h-11 px-2.5 bg-[var(--ib-gray-50)] border border-[var(--ib-border)] rounded-xl text-sm focus:border-[var(--ib-blue-500)] outline-none cursor-pointer"
          >
            {STATUS_EMOJIS.map(em => <option key={em} value={em}>{em || '—'}</option>)}
          </select>
          <input
            type="text"
            value={status.text}
            onChange={e => updateStatus({ ...status, text: e.target.value })}
            placeholder="What's your status?"
            maxLength={40}
            className="flex-1 h-11 px-3 bg-[var(--ib-gray-50)] border border-[var(--ib-border)] rounded-xl text-base md:text-xs text-[var(--ib-text)] placeholder-[var(--ib-text-muted)] focus:border-[var(--ib-blue-500)] outline-none transition-all touch-manipulation"
          />
        </div>
        <p className="text-[10px] text-[var(--ib-text-muted)] mt-1.5">Shown to you only — visible on this device.</p>
      </div>

      {/* Proactive AIPA */}
      <div>
        <div className="flex items-center gap-2 mb-2.5">
          <Sparkles className="w-3.5 h-3.5 text-[var(--ib-blue-500)]" />
          <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--ib-text-muted)]">Proactive AIPA</span>
          {proactiveSaving && <Loader2 className="ml-auto h-3 w-3 animate-spin text-[var(--ib-text-muted)]" />}
        </div>
        <p className="mb-2.5 text-[10px] leading-4 text-[var(--ib-text-muted)]">AIPA can notice timely opportunities, but calendar changes still require your confirmation.</p>
        <div className="flex flex-col divide-y divide-[var(--ib-border)] border border-[var(--ib-border)] rounded-xl overflow-hidden">
          <div className="flex items-center justify-between px-3.5 py-3">
            <div><p className="text-xs text-[var(--ib-text)]">Proactive suggestions</p><p className="mt-0.5 text-[9px] text-[var(--ib-text-muted)]">Master control for AIPA Now</p></div>
            <Toggle checked={proactive.enabled} onChange={v => void updateProactive('enabled', v)} />
          </div>
          <div className="flex items-center justify-between px-3.5 py-3">
            <div><p className="text-xs text-[var(--ib-text)]">Meeting suggestions</p><p className="mt-0.5 text-[9px] text-[var(--ib-text-muted)]">Prepare reviewable actions from chat</p></div>
            <Toggle checked={proactive.enabled && proactive.meetingSuggestions} onChange={v => void updateProactive('meetingSuggestions', v)} />
          </div>
          <div className="flex items-center justify-between px-3.5 py-3">
            <div><p className="text-xs text-[var(--ib-text)]">Daily planning signals</p><p className="mt-0.5 text-[9px] text-[var(--ib-text-muted)]">Upcoming meetings and invitations</p></div>
            <Toggle checked={proactive.enabled && proactive.dailyPlanning} onChange={v => void updateProactive('dailyPlanning', v)} />
          </div>
		  <div className="flex items-center justify-between px-3.5 py-3">
			<div><p className="text-xs text-[var(--ib-text)]">Task and reminder signals</p><p className="mt-0.5 text-[9px] text-[var(--ib-text-muted)]">Due work and reviewable items found in chat</p></div>
			<Toggle checked={proactive.enabled && proactive.taskSignals} onChange={v => void updateProactive('taskSignals', v)} />
		  </div>
		  <div className="flex items-center justify-between px-3.5 py-3">
			<div><p className="text-xs text-[var(--ib-text)]">Reply-needed signals</p><p className="mt-0.5 text-[9px] text-[var(--ib-text-muted)]">Older unread conversations that may need you</p></div>
			<Toggle checked={proactive.enabled && proactive.replySignals} onChange={v => void updateProactive('replySignals', v)} />
		  </div>
		  <div className="flex items-center justify-between px-3.5 py-3">
			<div><p className="text-xs text-[var(--ib-text)]">Pre-meeting preparation</p><p className="mt-0.5 text-[9px] text-[var(--ib-text-muted)]">Surface meetings to prepare within 24 hours</p></div>
			<Toggle checked={proactive.enabled && proactive.meetingPrep} onChange={v => void updateProactive('meetingPrep', v)} />
		  </div>
		  <div className="flex items-center justify-between px-3.5 py-3">
			<div><p className="text-xs text-[var(--ib-text)]">Post-meeting follow-up</p><p className="mt-0.5 text-[9px] text-[var(--ib-text-muted)]">Prompt for minutes and next actions after calls</p></div>
			<Toggle checked={proactive.enabled && proactive.postMeeting} onChange={v => void updateProactive('postMeeting', v)} />
		  </div>
		  <div className="px-3.5 py-3">
			<div className="mb-2 flex items-center justify-between"><div><p className="text-xs text-[var(--ib-text)]">Quiet hours</p><p className="mt-0.5 text-[9px] text-[var(--ib-text-muted)]">Cards stay in AIPA Now; realtime nudges wait</p></div><span className="text-[9px] text-[var(--ib-text-muted)]">{proactive.timeZone}</span></div>
			<div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
			  <input type="time" value={proactive.quietStart} disabled={!proactive.enabled || proactiveSaving} onChange={e => void updateProactive('quietStart', e.target.value)} className="min-w-0 h-11 rounded-lg border border-[var(--ib-border)] bg-[var(--ib-gray-50)] px-2 text-[10px] text-[var(--ib-text)] outline-none focus:border-[var(--ib-blue-500)] disabled:opacity-50" />
			  <span className="text-[9px] text-[var(--ib-text-muted)]">to</span>
			  <input type="time" value={proactive.quietEnd} disabled={!proactive.enabled || proactiveSaving} onChange={e => void updateProactive('quietEnd', e.target.value)} className="min-w-0 h-11 rounded-lg border border-[var(--ib-border)] bg-[var(--ib-gray-50)] px-2 text-[10px] text-[var(--ib-text)] outline-none focus:border-[var(--ib-blue-500)] disabled:opacity-50" />
			</div>
		  </div>
		  <div className="flex items-center justify-between px-3.5 py-3">
			<div><p className="text-xs text-[var(--ib-text)]">Daily nudge limit</p><p className="mt-0.5 text-[9px] text-[var(--ib-text-muted)]">Maximum realtime AIPA interruptions per day</p></div>
			<select value={proactive.dailyLimit} disabled={!proactive.enabled || proactiveSaving} onChange={e => void updateProactive('dailyLimit', Number(e.target.value))} className="h-11 rounded-lg border border-[var(--ib-border)] bg-[var(--ib-gray-50)] px-2 text-[10px] text-[var(--ib-text)] outline-none focus:border-[var(--ib-blue-500)] disabled:opacity-50 cursor-pointer">
			  {[3, 6, 10, 15].map(limit => <option key={limit} value={limit}>{limit} nudges</option>)}
			</select>
		  </div>
        </div>
      </div>

      {/* Notifications */}
      <div>
        <div className="flex items-center gap-2 mb-2.5">
          <Bell className="w-3.5 h-3.5 text-[var(--ib-blue-500)]" />
          <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--ib-text-muted)]">Notifications</span>
        </div>
        <div className="flex flex-col divide-y divide-[var(--ib-border)] border border-[var(--ib-border)] rounded-xl overflow-hidden">
          <div className="flex items-center justify-between px-3.5 py-3">
            <div className="flex items-center gap-2.5"><MessageSquare className="w-4 h-4 text-[var(--ib-text-muted)]" /><span className="text-xs text-[var(--ib-text)]">Message alerts</span></div>
            <Toggle checked={notifs.messageAlerts} onChange={v => updateNotif('messageAlerts', v)} />
          </div>
          <div className="flex items-center justify-between px-3.5 py-3">
            <div className="flex items-center gap-2.5"><Video className="w-4 h-4 text-[var(--ib-text-muted)]" /><span className="text-xs text-[var(--ib-text)]">Meeting reminders</span></div>
            <Toggle checked={notifs.meetingReminders} onChange={v => updateNotif('meetingReminders', v)} />
          </div>
          <div className="flex items-center justify-between px-3.5 py-3">
            <div className="flex items-center gap-2.5"><Volume2 className="w-4 h-4 text-[var(--ib-text-muted)]" /><span className="text-xs text-[var(--ib-text)]">Sound effects</span></div>
            <Toggle checked={notifs.soundEffects} onChange={v => updateNotif('soundEffects', v)} />
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Security tab ──────────────────────────────────────────────────────────────

function SecurityTab() {
  return (
    <div className="flex flex-col gap-5">
      <div className="bg-[var(--ib-blue-50)] border border-[var(--ib-blue-500)]/20 rounded-xl p-4 flex items-start gap-3">
        <Shield className="w-4 h-4 text-[var(--ib-blue-500)] shrink-0 mt-0.5" />
        <div>
          <p className="text-xs font-semibold text-[var(--ib-text)]">Managed by IB Account</p>
          <p className="text-[10px] text-[var(--ib-text-muted)] mt-0.5">
            IB Connect signs you in with Continue with IB and never sees your password. Change your
            password, review sessions, or update security settings from your IB Account.
          </p>
        </div>
      </div>

      <a
        href={config.ibAccount.accountUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="w-full h-11 bg-[var(--ib-blue-500)] text-white font-bold text-xs rounded-xl hover:bg-[var(--ib-blue-600)] cursor-pointer transition-all flex items-center justify-center gap-2"
      >
        <Lock className="w-3.5 h-3.5" />
        Manage password &amp; security
        <ExternalLink className="w-3.5 h-3.5" />
      </a>
    </div>
  );
}

// ── Account tab ───────────────────────────────────────────────────────────────

function AccountTab({ onClose }: { onClose: () => void }) {
  const { currentUser, logout } = useAuth();

  return (
    <div className="flex flex-col gap-4">
      {/* Account info card */}
      <div className="bg-[var(--ib-surface-raised)] border border-[var(--ib-border)] rounded-2xl p-4">
        <div className="flex items-center gap-3 mb-4">
          {currentUser?.avatar ? (
            <img src={currentUser.avatar} alt="" className="w-12 h-12 rounded-full object-cover" />
          ) : (
            <div className="w-12 h-12 rounded-full bg-[var(--ib-blue-50)] flex items-center justify-center">
              <span className="text-lg font-bold text-[var(--ib-blue-500)]">{currentUser?.displayName.charAt(0).toUpperCase()}</span>
            </div>
          )}
          <div>
            <p className="text-sm font-bold text-[var(--ib-text)]">{currentUser?.displayName}</p>
            <p className="text-xs text-[var(--ib-text-muted)]">@{currentUser?.username}</p>
            <p className="text-[10px] text-[var(--ib-text-muted)]">{currentUser?.email}</p>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2 text-center">
          <div className="bg-[var(--ib-gray-50)] rounded-xl py-2.5 px-3">
            <p className="text-[10px] text-[var(--ib-text-muted)] uppercase font-bold tracking-wider">Status</p>
            <div className="flex items-center justify-center mt-1">
              <Badge status="good">Online</Badge>
            </div>
          </div>
          <div className="bg-[var(--ib-gray-50)] rounded-xl py-2.5 px-3">
            <p className="text-[10px] text-[var(--ib-text-muted)] uppercase font-bold tracking-wider">Member since</p>
            <p className="text-xs font-semibold text-[var(--ib-text)] mt-1">
              {currentUser?.createdAt
                ? new Date(currentUser.createdAt).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
                : '—'}
            </p>
          </div>
        </div>
      </div>

      {/* Actions */}
      <button
        onClick={() => { logout(); onClose(); }}
        className="w-full flex items-center justify-between px-4 h-14 bg-[var(--ib-surface-raised)] border border-[var(--ib-border)] hover:border-[var(--ib-bad-dot)]/40 rounded-xl group cursor-pointer transition-all"
      >
        <div className="flex items-center gap-3">
          <LogOut className="w-4 h-4 text-[var(--ib-bad-dot)]" />
          <span className="text-xs font-semibold text-[var(--ib-text)]">Sign Out</span>
        </div>
        <ChevronRight className="w-3.5 h-3.5 text-[var(--ib-text-muted)] group-hover:text-[var(--ib-bad-dot)] transition-colors" />
      </button>

      {/* About */}
      <div className="bg-[var(--ib-surface-raised)] border border-[var(--ib-border)] rounded-xl p-4">
        <div className="flex items-center gap-2 mb-2">
          <Info className="w-3.5 h-3.5 text-[var(--ib-text-muted)]" />
          <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--ib-text-muted)]">About IB Connect</span>
        </div>
        <p className="text-[10px] text-[var(--ib-text-muted)] leading-relaxed">
          Secure enterprise communication platform. End-to-end encrypted messaging, real-time video meetings, and intelligent productivity tools.
        </p>
        <div className="mt-3 flex items-center gap-2">
          <span className="text-[9px] bg-[var(--ib-good-fill)] text-[var(--ib-good-text)] border border-[var(--ib-good-dot)]/30 px-2 py-0.5 rounded font-bold uppercase">v2.0</span>
          <span className="text-[9px] bg-[var(--ib-blue-50)] text-[var(--ib-blue-800)] border border-[var(--ib-blue-500)]/30 px-2 py-0.5 rounded font-bold uppercase">PostgreSQL</span>
          <span className="text-[9px] bg-[var(--ib-blue-50)] text-[var(--ib-blue-800)] border border-[var(--ib-blue-500)]/30 px-2 py-0.5 rounded font-bold uppercase">WebRTC</span>
        </div>
      </div>
    </div>
  );
}

// ── Devices & network ─────────────────────────────────────────────────────────
//
// The connection test used to be reachable only from the guest lobby, which meant the
// people who most need it — signed-in users starting a meeting from the sidebar, who
// never see a lobby at all — could not get to it. This is the entry point for them.

function DevicesTab() {
  const [devices, setDevices] = useState<DeviceSnapshot>(EMPTY_SNAPSHOT);
  const [testOpen, setTestOpen] = useState(false);
  const [prefs] = useState(loadDevicePrefs);

  useEffect(() => watchDevices(setDevices), []);

  const speakerSelectable = useMemo(isSpeakerSelectionSupported, []);
  const [speaker, setSpeaker] = useState(prefs.speakerId);
  const shownSpeaker = resolveSelection(speaker, devices.outputDevices);

  const label = (d: MediaDeviceInfo) => d.label || `Device ${d.deviceId.slice(0, 8)}`;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold text-[var(--ib-text)]">Your devices</h3>
        <p className="text-xs text-[var(--ib-text-muted)] leading-relaxed">
          Detected on this browser. Names appear once you have allowed camera or microphone
          access at least once.
        </p>
        <div className="flex flex-col gap-2 mt-1">
          {([
            ['Cameras', devices.videoDevices],
            ['Microphones', devices.audioDevices],
            ['Speakers', devices.outputDevices],
          ] as const).map(([kind, list]) => (
            <div key={kind} className="flex items-start justify-between gap-4 py-2 border-b border-[var(--ib-border)] last:border-b-0">
              <span className="text-xs font-medium text-[var(--ib-text)] shrink-0">{kind}</span>
              <span className="text-xs text-[var(--ib-text-muted)] text-right">
                {!devices.synced ? 'Checking…' : list.length === 0 ? 'None found' : list.map(label).join(', ')}
              </span>
            </div>
          ))}
        </div>
      </div>

      {speakerSelectable && devices.outputDevices.length > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold text-[var(--ib-text)]">Speaker</h3>
          <p className="text-xs text-[var(--ib-text-muted)] leading-relaxed">
            Where call audio plays. Applies immediately, including to calls already running.
          </p>
          <select
            value={shownSpeaker}
            onChange={(e) => { setSpeaker(e.target.value); void setPreferredSpeaker(e.target.value); }}
            aria-label="Speaker"
            className="w-full h-11 bg-[var(--ib-gray-50)] border border-[var(--ib-border)] rounded-lg px-3 text-xs text-[var(--ib-text)] outline-none cursor-pointer"
          >
            {devices.outputDevices.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>{label(d)}</option>
            ))}
          </select>
        </div>
      )}

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold text-[var(--ib-text)]">Connection test</h3>
        <p className="text-xs text-[var(--ib-text-muted)] leading-relaxed">
          Checks whether this network allows video calls at all, and whether they have to be
          relayed. Run it before an important meeting, or when a call did not work.
        </p>
        <button
          onClick={() => setTestOpen(true)}
          className="self-start flex items-center gap-2 h-11 px-4 rounded-lg bg-[var(--ib-blue-500)] text-white text-xs font-semibold hover:bg-[var(--ib-blue-600)] cursor-pointer transition-colors"
        >
          <Activity className="w-3.5 h-3.5" />
          Test my connection
        </button>
      </div>

      {testOpen && <ConnectionTestPanel onClose={() => setTestOpen(false)} />}
    </div>
  );
}

// ── Main modal ────────────────────────────────────────────────────────────────

const TABS: { id: Tab; label: string; Icon: React.FC<{ className?: string }> }[] = [
  { id: 'profile',     label: 'Profile',     Icon: User },
  { id: 'preferences', label: 'Preferences', Icon: Palette },
  { id: 'devices',     label: 'Devices',     Icon: Activity },
  { id: 'security',    label: 'Security',    Icon: Lock },
  { id: 'account',     label: 'Account',     Icon: Shield },
];

export default function SettingsModal({ onClose }: Props) {
  const [tab, setTab] = useState<Tab>('profile');

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  // z-[90] like the chat modals. At z-50 this rendered under the sidebar rail
  // (z-[70]) and the mobile hamburger (z-[80]), leaving the left edge undimmed and
  // routing taps there to the sidebar instead of the modal backdrop.
  //
  // Sub-unit 6: full-screen below md (edge-to-edge, safe-area-aware, no
  // backdrop/rounding -- a settings screen, not a small dialog, on a phone),
  // the existing centered/rounded/85vh-capped dialog unchanged at md+.
  return (
    <div
      className="fixed inset-0 z-[90] flex md:items-center md:justify-center bg-[var(--ib-gray-900)]/40 backdrop-blur-sm md:p-4"
      onClick={onClose}
    >
      <div
        className="bg-[var(--ib-surface-raised)] md:border md:border-[var(--ib-border)] md:rounded-2xl md:shadow-[var(--ib-shadow-lg)] w-full h-full md:h-auto md:max-w-lg overflow-hidden flex flex-col md:max-h-[85vh]"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 pt-[max(1rem,env(safe-area-inset-top))] md:pt-4 border-b border-[var(--ib-border)] shrink-0">
          <h2 className="font-bold text-sm text-[var(--ib-text)]">Settings</h2>
          <button onClick={onClose} aria-label="Close settings" className="w-11 h-11 md:w-9 md:h-9 shrink-0 rounded-lg bg-[var(--ib-gray-100)] border border-[var(--ib-border)] flex items-center justify-center text-[var(--ib-text-muted)] hover:text-[var(--ib-bad-dot)] hover:border-[var(--ib-bad-dot)]/40 cursor-pointer transition-all">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Tab bar.
            Scrollable below `sm`: adding the Devices tab made five, and five
            `whitespace-nowrap` labels cannot shrink below their min-content width, so
            the last one ("Account") was pushed past the right edge of a 320px screen.
            Buttons keep their natural width and the row swipes on a phone; from `sm` up
            they go back to `flex-1` and fill the width evenly as before. */}
        <div className="flex overflow-x-auto scrollbar-hide border-b border-[var(--ib-border)] shrink-0 px-2 pt-1">
          {TABS.map(({ id, label, Icon }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`shrink-0 sm:flex-1 flex items-center justify-center gap-1.5 px-1.5 sm:px-0 h-11 sm:h-10 text-[11px] sm:text-xs font-semibold border-b-2 transition-colors cursor-pointer whitespace-nowrap ${
                tab === id
                  ? 'border-[var(--ib-blue-500)] text-[var(--ib-blue-500)]'
                  : 'border-transparent text-[var(--ib-text-muted)] hover:text-[var(--ib-text)]'
              }`}
            >
              {/* Icon hidden below `sm`: five labelled tabs do not fit a 320px screen with
                  icons, and the label is the more informative half — Lock vs Shield for
                  Security vs Account is guesswork without one. Without icons all five fit,
                  so nothing hides behind the scroll. */}
              <Icon className="hidden sm:block w-3.5 h-3.5 shrink-0" />
              <span>{label}</span>
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div className="flex-1 overflow-y-auto p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] md:pb-5 scrollbar-hide">
          {tab === 'profile'     && <ProfileTab />}
          {tab === 'preferences' && <PreferencesTab />}
          {tab === 'devices'     && <DevicesTab />}
          {tab === 'security'    && <SecurityTab />}
          {tab === 'account'     && <AccountTab onClose={onClose} />}
        </div>
      </div>
    </div>
  );
}
