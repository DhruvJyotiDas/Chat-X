import React, { useState, useRef, useEffect } from 'react';
import {
  X, Camera, User, Lock, Bell, LogOut, Check,
  Loader2, Mail, AtSign, Calendar, ExternalLink,
  ChevronRight, Shield, Palette, Info, Sun, Moon, Monitor,
  MessageSquare, Video, Volume2, Smile,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { api } from '../../lib/api';
import { useTheme, ThemePreference } from '../../hooks/useTheme';
import { loadStatus, saveStatus, loadNotifications, saveNotifications, NotificationPreferences } from '../../lib/preferences';

type Tab = 'profile' | 'preferences' | 'security' | 'account';

const STATUS_EMOJIS = ['', '💬', '🎯', '📚', '🏫', '🚗', '🍽️', '😴', '🌴', '🤒'];

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={`w-10 h-6 rounded-full transition-colors relative shrink-0 cursor-pointer ${checked ? 'bg-[#568dff]' : 'bg-[#424655]'}`}
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
        <img src={preview} alt="avatar" className="w-20 h-20 rounded-full object-cover border-2 border-[#424655]" />
      ) : (
        <div className="w-20 h-20 rounded-full bg-[#568dff]/20 border-2 border-[#424655] flex items-center justify-center">
          <span className="text-2xl font-bold text-[#b0c6ff]">{initials}</span>
        </div>
      )}
      <div className="absolute inset-0 rounded-full bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
        <Camera className="w-5 h-5 text-white" />
      </div>
      <div className="absolute -bottom-1 -right-1 w-6 h-6 bg-[#568dff] rounded-full border-2 border-[#131313] flex items-center justify-center">
        <Camera className="w-3 h-3 text-white" />
      </div>
    </div>
  );
}

// ── Field component ───────────────────────────────────────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-[10px] font-bold uppercase tracking-wider text-[#8c90a1]">{label}</label>
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
      className="px-3 py-2.5 bg-[#0e0e0e] border border-[#424655] rounded-xl text-xs text-[#e5e2e1] placeholder-[#8c90a1]/60 focus:border-[#568dff] focus:ring-1 focus:ring-[#568dff]/30 outline-none transition-all disabled:opacity-50 disabled:cursor-not-allowed"
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
        <p className="text-[10px] text-[#8c90a1]">Click to change · max 500 KB</p>
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
          className="px-3 py-2.5 bg-[#0e0e0e] border border-[#424655] rounded-xl text-xs text-[#e5e2e1] placeholder-[#8c90a1]/60 focus:border-[#568dff] outline-none transition-all resize-none"
        />
        <span className="text-[10px] text-[#8c90a1] text-right">{bio.length}/160</span>
      </Field>

      {/* Read-only fields */}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Username">
          <div className="flex items-center gap-2 px-3 py-2.5 bg-[#0e0e0e]/50 border border-[#424655]/40 rounded-xl">
            <AtSign className="w-3 h-3 text-[#8c90a1]" />
            <span className="text-xs text-[#8c90a1]">{currentUser?.username}</span>
          </div>
        </Field>
        <Field label="Joined">
          <div className="flex items-center gap-2 px-3 py-2.5 bg-[#0e0e0e]/50 border border-[#424655]/40 rounded-xl">
            <Calendar className="w-3 h-3 text-[#8c90a1]" />
            <span className="text-xs text-[#8c90a1] truncate">{joined}</span>
          </div>
        </Field>
      </div>

      <Field label="Email">
        <div className="flex items-center gap-2 px-3 py-2.5 bg-[#0e0e0e]/50 border border-[#424655]/40 rounded-xl">
          <Mail className="w-3 h-3 text-[#8c90a1]" />
          <span className="text-xs text-[#8c90a1]">{currentUser?.email}</span>
        </div>
      </Field>

      {error && <p className="text-xs text-[#ffb4ab] bg-[#93000a]/20 border border-[#ffb4ab]/30 rounded-xl px-3 py-2">{error}</p>}

      <button
        onClick={save}
        disabled={!dirty || saving}
        className="w-full py-2.5 bg-[#568dff] text-[#002661] font-bold text-xs rounded-xl hover:bg-[#568dff]/90 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-all flex items-center justify-center gap-2"
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

  const updateStatus = (next: typeof status) => {
    setStatus(next);
    if (currentUser) saveStatus(currentUser.id, next);
  };

  const updateNotif = (key: keyof NotificationPreferences, value: boolean) => {
    const next = { ...notifs, [key]: value };
    setNotifs(next);
    if (currentUser) saveNotifications(currentUser.id, next);
  };

  const THEME_OPTIONS: { id: ThemePreference; label: string; Icon: React.ElementType }[] = [
    { id: 'dark', label: 'Dark', Icon: Moon },
    { id: 'light', label: 'Light', Icon: Sun },
    { id: 'system', label: 'System', Icon: Monitor },
  ];

  return (
    <div className="flex flex-col gap-6">
      {/* Theme */}
      <div>
        <div className="flex items-center gap-2 mb-2.5">
          <Palette className="w-3.5 h-3.5 text-[#b0c6ff]" />
          <span className="text-[10px] font-bold uppercase tracking-wider text-[#8c90a1]">Appearance</span>
        </div>
        <div className="grid grid-cols-3 gap-2">
          {THEME_OPTIONS.map(({ id, label, Icon }) => (
            <button
              key={id}
              onClick={() => setTheme(id)}
              className={`flex flex-col items-center gap-1.5 py-3 rounded-xl border text-xs font-semibold transition-all cursor-pointer ${theme === id ? 'border-[#568dff] bg-[#568dff]/10 text-[#b0c6ff]' : 'border-[#424655] text-[#8c90a1] hover:text-[#e5e2e1] hover:border-[#424655]'}`}
            >
              <Icon className="w-4 h-4" />
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Custom status */}
      <div>
        <div className="flex items-center gap-2 mb-2.5">
          <Smile className="w-3.5 h-3.5 text-[#b0c6ff]" />
          <span className="text-[10px] font-bold uppercase tracking-wider text-[#8c90a1]">Custom Status</span>
        </div>
        <div className="flex gap-2">
          <select
            value={status.emoji}
            onChange={e => updateStatus({ ...status, emoji: e.target.value })}
            className="px-2.5 py-2.5 bg-[#0e0e0e] border border-[#424655] rounded-xl text-sm focus:border-[#568dff] outline-none"
          >
            {STATUS_EMOJIS.map(em => <option key={em} value={em}>{em || '—'}</option>)}
          </select>
          <input
            type="text"
            value={status.text}
            onChange={e => updateStatus({ ...status, text: e.target.value })}
            placeholder="What's your status?"
            maxLength={40}
            className="flex-1 px-3 py-2.5 bg-[#0e0e0e] border border-[#424655] rounded-xl text-xs text-[#e5e2e1] placeholder-[#8c90a1]/60 focus:border-[#568dff] outline-none transition-all"
          />
        </div>
        <p className="text-[10px] text-[#8c90a1] mt-1.5">Shown to you only — visible on this device.</p>
      </div>

      {/* Notifications */}
      <div>
        <div className="flex items-center gap-2 mb-2.5">
          <Bell className="w-3.5 h-3.5 text-[#b0c6ff]" />
          <span className="text-[10px] font-bold uppercase tracking-wider text-[#8c90a1]">Notifications</span>
        </div>
        <div className="flex flex-col divide-y divide-[#424655]/40 border border-[#424655] rounded-xl overflow-hidden">
          <div className="flex items-center justify-between px-3.5 py-3">
            <div className="flex items-center gap-2.5"><MessageSquare className="w-4 h-4 text-[#8c90a1]" /><span className="text-xs text-[#e5e2e1]">Message alerts</span></div>
            <Toggle checked={notifs.messageAlerts} onChange={v => updateNotif('messageAlerts', v)} />
          </div>
          <div className="flex items-center justify-between px-3.5 py-3">
            <div className="flex items-center gap-2.5"><Video className="w-4 h-4 text-[#8c90a1]" /><span className="text-xs text-[#e5e2e1]">Meeting reminders</span></div>
            <Toggle checked={notifs.meetingReminders} onChange={v => updateNotif('meetingReminders', v)} />
          </div>
          <div className="flex items-center justify-between px-3.5 py-3">
            <div className="flex items-center gap-2.5"><Volume2 className="w-4 h-4 text-[#8c90a1]" /><span className="text-xs text-[#e5e2e1]">Sound effects</span></div>
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
      <div className="bg-[#568dff]/5 border border-[#568dff]/20 rounded-xl p-4 flex items-start gap-3">
        <Shield className="w-4 h-4 text-[#b0c6ff] shrink-0 mt-0.5" />
        <div>
          <p className="text-xs font-semibold text-[#e5e2e1]">Managed by IB Account</p>
          <p className="text-[10px] text-[#8c90a1] mt-0.5">
            IB Connect signs you in with Continue with IB and never sees your password. Change your
            password, review sessions, or update security settings from your IB Account.
          </p>
        </div>
      </div>

      <a
        href="https://meet.icebrkr.space/auth/account"
        target="_blank"
        rel="noopener noreferrer"
        className="w-full py-2.5 bg-[#568dff] text-[#002661] font-bold text-xs rounded-xl hover:bg-[#568dff]/90 cursor-pointer transition-all flex items-center justify-center gap-2"
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
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="flex flex-col gap-4">
      {/* Account info card */}
      <div className="bg-[#1c1b1b] border border-[#424655] rounded-2xl p-4">
        <div className="flex items-center gap-3 mb-4">
          {currentUser?.avatar ? (
            <img src={currentUser.avatar} alt="" className="w-12 h-12 rounded-full object-cover" />
          ) : (
            <div className="w-12 h-12 rounded-full bg-[#568dff]/20 flex items-center justify-center">
              <span className="text-lg font-bold text-[#b0c6ff]">{currentUser?.displayName.charAt(0).toUpperCase()}</span>
            </div>
          )}
          <div>
            <p className="text-sm font-bold text-[#e5e2e1]">{currentUser?.displayName}</p>
            <p className="text-xs text-[#8c90a1]">@{currentUser?.username}</p>
            <p className="text-[10px] text-[#8c90a1]">{currentUser?.email}</p>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2 text-center">
          <div className="bg-[#131313] rounded-xl py-2.5 px-3">
            <p className="text-[10px] text-[#8c90a1] uppercase font-bold tracking-wider">Status</p>
            <div className="flex items-center justify-center gap-1.5 mt-1">
              <span className="w-2 h-2 rounded-full bg-[#4dffb1]" />
              <span className="text-xs font-semibold text-[#4dffb1]">Online</span>
            </div>
          </div>
          <div className="bg-[#131313] rounded-xl py-2.5 px-3">
            <p className="text-[10px] text-[#8c90a1] uppercase font-bold tracking-wider">Member since</p>
            <p className="text-xs font-semibold text-[#e5e2e1] mt-1">
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
        className="w-full flex items-center justify-between px-4 py-3 bg-[#1c1b1b] border border-[#424655] hover:border-[#ffb4ab]/40 rounded-xl group cursor-pointer transition-all"
      >
        <div className="flex items-center gap-3">
          <LogOut className="w-4 h-4 text-[#ffb4ab]" />
          <span className="text-xs font-semibold text-[#e5e2e1]">Sign Out</span>
        </div>
        <ChevronRight className="w-3.5 h-3.5 text-[#8c90a1] group-hover:text-[#ffb4ab] transition-colors" />
      </button>

      {/* About */}
      <div className="bg-[#1c1b1b] border border-[#424655] rounded-xl p-4">
        <div className="flex items-center gap-2 mb-2">
          <Info className="w-3.5 h-3.5 text-[#8c90a1]" />
          <span className="text-[10px] font-bold uppercase tracking-wider text-[#8c90a1]">About IB Connect</span>
        </div>
        <p className="text-[10px] text-[#8c90a1]/70 leading-relaxed">
          Secure enterprise communication platform. End-to-end encrypted messaging, real-time video meetings, and intelligent productivity tools.
        </p>
        <div className="mt-3 flex items-center gap-2">
          <span className="text-[9px] bg-[#00e598]/10 text-[#70ffba] border border-[#00e296]/30 px-2 py-0.5 rounded font-bold uppercase">v2.0</span>
          <span className="text-[9px] bg-[#568dff]/10 text-[#b0c6ff] border border-[#568dff]/30 px-2 py-0.5 rounded font-bold uppercase">PostgreSQL</span>
          <span className="text-[9px] bg-[#8083ff]/10 text-[#c0c1ff] border border-[#8083ff]/30 px-2 py-0.5 rounded font-bold uppercase">WebRTC</span>
        </div>
      </div>
    </div>
  );
}

// ── Main modal ────────────────────────────────────────────────────────────────

const TABS: { id: Tab; label: string; Icon: React.FC<{ className?: string }> }[] = [
  { id: 'profile',     label: 'Profile',     Icon: User },
  { id: 'preferences', label: 'Preferences', Icon: Palette },
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

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-[#131313] border border-[#424655] rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden flex flex-col"
        style={{ maxHeight: '85vh' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#424655] shrink-0">
          <h2 className="font-bold text-sm text-[#e5e2e1]">Settings</h2>
          <button onClick={onClose} className="w-7 h-7 rounded-lg bg-[#201f1f] border border-[#424655] flex items-center justify-center text-[#8c90a1] hover:text-[#ffb4ab] hover:border-[#ffb4ab]/40 cursor-pointer transition-all">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Tab bar */}
        <div className="flex border-b border-[#424655] shrink-0 px-2 pt-1">
          {TABS.map(({ id, label, Icon }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 text-[11px] sm:text-xs font-semibold border-b-2 transition-colors cursor-pointer whitespace-nowrap ${
                tab === id
                  ? 'border-[#568dff] text-[#b0c6ff]'
                  : 'border-transparent text-[#8c90a1] hover:text-[#e5e2e1]'
              }`}
            >
              <Icon className="w-3.5 h-3.5 shrink-0" />
              <span>{label}</span>
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div className="flex-1 overflow-y-auto p-5 scrollbar-hide">
          {tab === 'profile'     && <ProfileTab />}
          {tab === 'preferences' && <PreferencesTab />}
          {tab === 'security'    && <SecurityTab />}
          {tab === 'account'     && <AccountTab onClose={onClose} />}
        </div>
      </div>
    </div>
  );
}
