import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Bell, BellOff, Camera, Check, ChevronRight, Clock3, FileText,
  Image as ImageIcon, Info, Link as LinkIcon, LockKeyhole, Mail,
  MessageSquare, Phone, ShieldCheck, Users, X,
} from 'lucide-react';
import { api } from '../../lib/api';
import {
  loadChatInfoPreferences, saveChatInfoPreferences, type ChatInfoPreferences,
} from '../../lib/chatInfoPreferences';
import type { IBUser, RealChatMessage, RealChatThread } from '../../types';
import { useSuppressAipaLauncher } from '../../hooks/useSuppressAipaLauncher';
import Switch from '../ui/Switch';

interface Props {
  thread: RealChatThread;
  currentUser: IBUser;
  contact?: IBUser;
  messages: RealChatMessage[];
  getUserById: (id: string) => IBUser | undefined;
  onClose: () => void;
  onGroupUpdated: () => Promise<void>;
}

const URL_RE = /https?:\/\/[^\s<]+/gi;

function initials(name: string): string {
  return name.split(/\s+/).map(part => part[0]).join('').slice(0, 2).toUpperCase();
}

function SettingRow({ icon, title, detail, children }: {
  icon: React.ReactNode; title: string; detail?: string; children?: React.ReactNode;
}) {
  return (
    <div className="flex min-h-14 items-center gap-3 px-4 py-3">
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-[var(--ib-blue-50)] text-[var(--ib-blue-500)]">{icon}</span>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-semibold text-[var(--ib-text)]">{title}</p>
        {detail && <p className="mt-0.5 text-[10px] leading-relaxed text-[var(--ib-text-muted)]">{detail}</p>}
      </div>
      {children}
    </div>
  );
}

export default function ConversationInfoPanel({
  thread, currentUser, contact, messages, getUserById, onClose, onGroupUpdated,
}: Props) {
  useSuppressAipaLauncher(true);
  const isGroup = thread.type === 'group';
  const isAdmin = isGroup && thread.createdBy === currentUser.id;
  const canEditGroupInfo = isGroup && (isAdmin || !(thread.adminsEditInfo ?? true));
  const iconInputRef = useRef<HTMLInputElement>(null);
  const [prefs, setPrefs] = useState<ChatInfoPreferences>(() => loadChatInfoPreferences(currentUser.id, thread.id));
  const [name, setName] = useState(thread.name);
  const [description, setDescription] = useState(thread.description || '');
  const [avatar, setAvatar] = useState(thread.avatar || '');
  const [adminsEditInfo, setAdminsEditInfo] = useState(thread.adminsEditInfo ?? true);
  const [adminsSend, setAdminsSend] = useState(thread.adminsSend ?? false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [encryptionOpen, setEncryptionOpen] = useState(false);

  useEffect(() => {
    const keyHandler = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', keyHandler);
    return () => window.removeEventListener('keydown', keyHandler);
  }, [onClose]);

  const attachments = useMemo(() => messages.filter(message => message.fileAttachment), [messages]);
  const links = useMemo(() => messages.flatMap(message => message.text.match(URL_RE) || []), [messages]);
  const mediaCount = attachments.filter(message => message.fileAttachment?.type.startsWith('image/')).length;
  const documentCount = attachments.length - mediaCount;

  const updatePrefs = (next: ChatInfoPreferences) => {
    setPrefs(next);
    saveChatInfoPreferences(currentUser.id, thread.id, next);
  };

  const handleIcon = (file?: File) => {
    if (!file) return;
    if (file.size > 500 * 1024) { setError('Choose an image under 500 KB.'); return; }
    const reader = new FileReader();
    reader.onload = () => setAvatar(String(reader.result || ''));
    reader.readAsDataURL(file);
  };

  const saveGroup = async () => {
    if (!canEditGroupInfo || !name.trim() || saving) return;
    setSaving(true);
    setSaved(false);
    setError('');
    try {
      await api.updateGroup(thread.id, {
        name: name.trim(), description: description.trim(), avatar,
        adminsEditInfo, adminsSend,
      });
      await onGroupUpdated();
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1800);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save group info');
    } finally {
      setSaving(false);
    }
  };

  const title = isGroup ? 'Group info' : 'Contact info';
  const displayName = isGroup ? name : (contact?.displayName || thread.name);
  const displayAvatar = isGroup ? avatar : (contact?.avatar || thread.avatar || '');

  return (
    <div className="fixed inset-0 z-[95] bg-black/55 backdrop-blur-[2px]" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <aside className="ml-auto flex h-full w-full max-w-[420px] animate-[panel-in_.2s_ease-out] flex-col border-l border-[var(--ib-border)] bg-[var(--ib-surface-raised)] shadow-[var(--ib-shadow-lg)]">
        <header className="flex h-16 shrink-0 items-center gap-3 border-b border-[var(--ib-border)] px-4">
          <button onClick={onClose} aria-label="Close info" className="grid h-11 w-11 md:h-9 md:w-9 place-items-center rounded-xl text-[var(--ib-text-muted)] hover:bg-[var(--ib-gray-100)] hover:text-[var(--ib-text)] cursor-pointer"><X className="h-4 w-4" /></button>
          <div><h2 className="text-sm font-bold text-[var(--ib-text)]">{title}</h2><p className="text-[10px] text-[var(--ib-text-muted)]">Details, media and conversation controls</p></div>
        </header>

        <div className="flex-1 overflow-y-auto">
          <section className="relative overflow-hidden px-5 pb-6 pt-7 text-center">
            <div className="pointer-events-none absolute inset-x-0 top-0 h-40 bg-[radial-gradient(circle_at_top,var(--ib-blue-100),transparent_65%)]" />
            <div className="relative mx-auto mb-3 h-24 w-24">
              {displayAvatar ? <img src={displayAvatar} alt="" className="h-full w-full rounded-[28px] border-4 border-[var(--ib-surface-raised)] object-cover shadow-2xl" /> : (
                <div className="grid h-full w-full place-items-center rounded-[28px] border-4 border-[var(--ib-surface-raised)] bg-gradient-to-br from-[var(--ib-blue-100)] to-[var(--ib-good-fill)] text-2xl font-bold text-[var(--ib-text)] shadow-2xl">{isGroup ? <Users className="h-8 w-8" /> : initials(displayName)}</div>
              )}
              {canEditGroupInfo && <button onClick={() => iconInputRef.current?.click()} aria-label="Change group icon" className="absolute -bottom-1 -right-1 grid h-11 w-11 md:h-8 md:w-8 place-items-center rounded-xl border-2 border-[var(--ib-surface-raised)] bg-[var(--ib-blue-500)] text-white shadow-lg cursor-pointer"><Camera className="h-3.5 w-3.5" /></button>}
              <input ref={iconInputRef} type="file" accept="image/*" className="hidden" onChange={event => handleIcon(event.target.files?.[0])} />
            </div>

            {canEditGroupInfo ? (
              <div className="mx-auto max-w-sm space-y-2">
                <input value={name} maxLength={100} onChange={event => setName(event.target.value)} aria-label="Group name" className="w-full rounded-xl border border-[var(--ib-border)] bg-[var(--ib-gray-50)] px-3 py-2 text-center text-base font-bold text-[var(--ib-text)] outline-none focus:border-[var(--ib-blue-500)]" />
                <textarea value={description} maxLength={500} onChange={event => setDescription(event.target.value)} placeholder="Add a group description" aria-label="Group description" rows={2} className="w-full resize-none rounded-xl border border-[var(--ib-border)] bg-[var(--ib-gray-50)] px-3 py-2 text-center text-base md:text-xs leading-relaxed text-[var(--ib-text)] outline-none placeholder:text-[var(--ib-text-muted)] focus:border-[var(--ib-blue-500)] touch-manipulation" />
              </div>
            ) : (
              <>
                <h3 className="text-lg font-bold text-[var(--ib-text)]">{displayName}</h3>
                <p className="mt-1 text-xs text-[var(--ib-text-muted)]">{isGroup ? (thread.description || 'No group description yet') : `@${contact?.username || 'member'}`}</p>
                {!isGroup && contact?.bio && <p className="mx-auto mt-3 max-w-xs text-xs leading-relaxed text-[var(--ib-text)]">{contact.bio}</p>}
              </>
            )}
          </section>

          {!isGroup && (
            <section className="mx-4 mb-3 overflow-hidden rounded-2xl border border-[var(--ib-border)]">
              <div className="border-b border-[var(--ib-border)] px-4 py-3"><p className="text-[9px] font-bold uppercase tracking-[.16em] text-[var(--ib-text-muted)]">About & contact</p></div>
              <SettingRow icon={<Info className="h-4 w-4" />} title="About" detail={contact?.bio || 'Available on IB Connect'} />
              <div className="mx-4 border-t border-[var(--ib-border)]" />
              <SettingRow icon={<Phone className="h-4 w-4" />} title="Phone number" detail="Not shared" />
              <div className="mx-4 border-t border-[var(--ib-border)]" />
              <SettingRow icon={<Mail className="h-4 w-4" />} title="Email" detail={contact?.email || 'Not shared'} />
            </section>
          )}

          <section className="mx-4 mb-3 overflow-hidden rounded-2xl border border-[var(--ib-border)]">
            <div className="border-b border-[var(--ib-border)] px-4 py-3"><p className="text-[9px] font-bold uppercase tracking-[.16em] text-[var(--ib-text-muted)]">Shared content</p></div>
            <SettingRow icon={<ImageIcon className="h-4 w-4" />} title="Media, links & docs" detail={`${mediaCount} media · ${links.length} links · ${documentCount} docs`}>
              <ChevronRight className="h-4 w-4 text-[var(--ib-text-muted)]" />
            </SettingRow>
            {(attachments.length > 0 || links.length > 0) && (
              <div className="flex gap-2 overflow-x-auto border-t border-[var(--ib-border)] px-4 py-3">
                {attachments.slice(0, 4).map(message => message.fileAttachment && (
                  <a key={message.id} href={message.fileAttachment.dataUrl} download={message.fileAttachment.name} title={message.fileAttachment.name} className="grid h-16 w-16 shrink-0 place-items-center overflow-hidden rounded-xl border border-[var(--ib-border)] bg-[var(--ib-gray-100)] text-[var(--ib-blue-500)]">
                    {message.fileAttachment.type.startsWith('image/') && message.fileAttachment.dataUrl ? <img src={message.fileAttachment.dataUrl} alt="" className="h-full w-full object-cover" /> : <FileText className="h-5 w-5" />}
                  </a>
                ))}
                {links.slice(0, 3).map((link, index) => <a key={`${link}-${index}`} href={link} target="_blank" rel="noreferrer" className="grid h-16 w-16 shrink-0 place-items-center rounded-xl border border-[var(--ib-border)] bg-[var(--ib-gray-100)] text-[var(--ib-blue-500)]" title={link}><LinkIcon className="h-5 w-5" /></a>)}
              </div>
            )}
          </section>

          <section className="mx-4 mb-3 overflow-hidden rounded-2xl border border-[var(--ib-border)]">
            <div className="border-b border-[var(--ib-border)] px-4 py-3"><p className="text-[9px] font-bold uppercase tracking-[.16em] text-[var(--ib-text-muted)]">Conversation settings</p></div>
            <SettingRow icon={prefs.muted ? <BellOff className="h-4 w-4" /> : <Bell className="h-4 w-4" />} title="Mute notifications" detail={prefs.muted ? 'Notifications are muted on this device' : 'Message alerts are on'}>
              <Switch checked={prefs.muted} aria-label="Mute notifications" onChange={() => updatePrefs({ ...prefs, muted: !prefs.muted })} />
            </SettingRow>
            <div className="mx-4 border-t border-[var(--ib-border)]" />
            <SettingRow icon={<Clock3 className="h-4 w-4" />} title="Disappearing messages" detail="Choose the default timer for this conversation">
              <select value={prefs.disappearing} onChange={event => updatePrefs({ ...prefs, disappearing: event.target.value as ChatInfoPreferences['disappearing'] })} className="rounded-lg border border-[var(--ib-border)] bg-[var(--ib-gray-50)] px-2 py-1.5 text-[10px] text-[var(--ib-text)] outline-none">
                <option value="off">Off</option><option value="24h">24 hours</option><option value="7d">7 days</option><option value="90d">90 days</option>
              </select>
            </SettingRow>
            {!isGroup && <><div className="mx-4 border-t border-[var(--ib-border)]" /><button onClick={() => setEncryptionOpen(value => !value)} className="w-full text-left"><SettingRow icon={<LockKeyhole className="h-4 w-4" />} title="Encryption info" detail="Messages are encrypted in transit"><ChevronRight className={`h-4 w-4 text-[var(--ib-text-muted)] transition-transform ${encryptionOpen ? 'rotate-90' : ''}`} /></SettingRow></button>{encryptionOpen && <p className="border-t border-[var(--ib-border)] px-4 py-3 text-[10px] leading-relaxed text-[var(--ib-text-muted)]">IB Connect protects messages with TLS while they travel between your device and the service. This is transport encryption, not end-to-end encryption.</p>}</>}
          </section>

          {isGroup && (
            <>
              <section className="mx-4 mb-3 overflow-hidden rounded-2xl border border-[var(--ib-border)]">
                <div className="flex items-center justify-between border-b border-[var(--ib-border)] px-4 py-3"><p className="text-[9px] font-bold uppercase tracking-[.16em] text-[var(--ib-text-muted)]">Participants</p><span className="text-[10px] text-[var(--ib-text-muted)]">{thread.participants.length}</span></div>
                <div className="max-h-64 overflow-y-auto p-2">
                  {thread.participants.map(id => {
                    const user = getUserById(id); if (!user) return null;
                    const admin = id === thread.createdBy;
                    return <div key={id} className="flex items-center gap-3 rounded-xl px-2 py-2.5 hover:bg-[var(--ib-gray-100)]">{user.avatar ? <img src={user.avatar} alt="" className="h-9 w-9 rounded-xl object-cover" /> : <span className="grid h-9 w-9 place-items-center rounded-xl bg-[var(--ib-blue-50)] text-xs font-bold text-[var(--ib-blue-500)]">{initials(user.displayName)}</span>}<div className="min-w-0 flex-1"><p className="truncate text-xs font-semibold text-[var(--ib-text)]">{user.displayName}{id === currentUser.id ? ' (you)' : ''}</p><p className="text-[10px] text-[var(--ib-text-muted)]">{user.status}</p></div>{admin && <span className="rounded-md border border-[var(--ib-good-dot)]/20 bg-[var(--ib-good-fill)] px-2 py-1 text-[8px] font-bold uppercase tracking-wider text-[var(--ib-good-text)]">Admin</span>}</div>;
                  })}
                </div>
              </section>

              <section className="mx-4 mb-6 overflow-hidden rounded-2xl border border-[var(--ib-border)]">
                <div className="border-b border-[var(--ib-border)] px-4 py-3"><p className="text-[9px] font-bold uppercase tracking-[.16em] text-[var(--ib-text-muted)]">Group permissions</p></div>
                <SettingRow icon={<ShieldCheck className="h-4 w-4" />} title="Edit group info" detail={adminsEditInfo ? 'Only admins can change the name, description and icon' : 'All participants can change group info'}>
                  <Switch checked={adminsEditInfo} disabled={!isAdmin} aria-label="Only admins can edit group info" onChange={() => setAdminsEditInfo(value => !value)} />
                </SettingRow>
                <div className="mx-4 border-t border-[var(--ib-border)]" />
                <SettingRow icon={<MessageSquare className="h-4 w-4" />} title="Send messages" detail={adminsSend ? 'Only admins can send messages' : 'All participants can send messages'}>
                  <Switch checked={adminsSend} disabled={!isAdmin} aria-label="Only admins can send messages" onChange={() => setAdminsSend(value => !value)} />
                </SettingRow>
                {!isAdmin && <p className="border-t border-[var(--ib-border)] px-4 py-3 text-[10px] text-[var(--ib-text-muted)]">Only the group admin can change these permissions.</p>}
              </section>
            </>
          )}
        </div>

        {canEditGroupInfo && (
          <footer className="shrink-0 border-t border-[var(--ib-border)] bg-[var(--ib-surface-raised)] p-4">
            {error && <p className="mb-2 text-[10px] text-[var(--ib-bad-text)]">{error}</p>}
            <button onClick={saveGroup} disabled={saving || !name.trim()} className="flex w-full items-center justify-center gap-2 rounded-xl bg-[var(--ib-blue-500)] py-3 text-xs font-bold text-white shadow-[var(--ib-shadow-md)] transition hover:bg-[var(--ib-blue-600)] disabled:opacity-50">{saved ? <><Check className="h-4 w-4" />Saved</> : saving ? 'Saving…' : 'Save group info'}</button>
          </footer>
        )}
      </aside>
    </div>
  );
}
