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

// `light` -- see the note above Toggle; same narrow scope (group-admin
// controls only).
function SettingRow({ icon, title, detail, children, light = false }: {
  icon: React.ReactNode; title: string; detail?: string; children?: React.ReactNode; light?: boolean;
}) {
  return (
    <div className="flex min-h-14 items-center gap-3 px-4 py-3">
      <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-xl ${light ? 'bg-[var(--ib-blue-50)] text-[var(--ib-blue-500)]' : 'bg-[#718cff]/10 text-[#9bafff]'}`}>{icon}</span>
      <div className="min-w-0 flex-1">
        <p className={`text-xs font-semibold ${light ? 'text-[var(--ib-text)]' : 'text-[#e5e2e1]'}`}>{title}</p>
        {detail && <p className={`mt-0.5 text-[10px] leading-relaxed ${light ? 'text-[var(--ib-text-muted)]' : 'text-[#8c90a1]'}`}>{detail}</p>}
      </div>
      {children}
    </div>
  );
}

// `light` is scoped to the group-admin permission toggles only (sub-unit 4:
// "group-admin controls retheme only") -- the rest of this panel (mute
// notifications, etc.) is untouched this pass, so the default dark styling
// stays the default and only these two instances opt into tokens.
function Toggle({ checked, disabled, label, onChange, light = false }: { checked: boolean; disabled?: boolean; label: string; onChange: () => void; light?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={onChange}
      className={`relative h-6 w-11 shrink-0 rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        light
          // bug-batch 2026-09-19, section 3: off-state border was
          // --ib-gray-200, the same low (~2.5:1, fails the 3:1 non-text
          // floor) contrast bug the new shared Switch component was built
          // to fix. Can't just migrate this one onto Switch -- the same
          // component also serves the still-dark rest of this panel via
          // this `light` prop -- so the fix is applied here directly.
          ? checked ? 'border-[var(--ib-blue-500)] bg-[var(--ib-blue-500)]' : 'border-[var(--ib-gray-600)] bg-[var(--ib-gray-100)]'
          : checked ? 'border-[#718cff] bg-[#718cff]' : 'border-[#424655] bg-[#201f1f]'
      }`}
    >
      <span className={`absolute top-0.5 h-4.5 w-4.5 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-5' : 'translate-x-0.5'}`} />
    </button>
  );
}

export default function ConversationInfoPanel({
  thread, currentUser, contact, messages, getUserById, onClose, onGroupUpdated,
}: Props) {
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
      <aside className="ml-auto flex h-full w-full max-w-[420px] animate-[panel-in_.2s_ease-out] flex-col border-l border-white/10 bg-[#0d121d]/98 shadow-[-24px_0_70px_rgba(0,0,0,.42)]">
        <header className="flex h-16 shrink-0 items-center gap-3 border-b border-white/[0.08] px-4">
          <button onClick={onClose} aria-label="Close info" className="grid h-11 w-11 md:h-9 md:w-9 place-items-center rounded-xl text-[#8c90a1] hover:bg-white/[0.06] hover:text-white cursor-pointer"><X className="h-4 w-4" /></button>
          <div><h2 className="text-sm font-bold text-[#e5e2e1]">{title}</h2><p className="text-[10px] text-[#8c90a1]">Details, media and conversation controls</p></div>
        </header>

        <div className="flex-1 overflow-y-auto">
          <section className="relative overflow-hidden px-5 pb-6 pt-7 text-center">
            <div className="pointer-events-none absolute inset-x-0 top-0 h-40 bg-[radial-gradient(circle_at_top,rgba(113,140,255,.2),transparent_65%)]" />
            <div className="relative mx-auto mb-3 h-24 w-24">
              {displayAvatar ? <img src={displayAvatar} alt="" className="h-full w-full rounded-[28px] border-4 border-[#151c2a] object-cover shadow-2xl" /> : (
                <div className="grid h-full w-full place-items-center rounded-[28px] border-4 border-[#151c2a] bg-gradient-to-br from-[#718cff]/35 to-[#35cdb0]/20 text-2xl font-bold text-white shadow-2xl">{isGroup ? <Users className="h-8 w-8" /> : initials(displayName)}</div>
              )}
              {canEditGroupInfo && <button onClick={() => iconInputRef.current?.click()} aria-label="Change group icon" className="absolute -bottom-1 -right-1 grid h-11 w-11 md:h-8 md:w-8 place-items-center rounded-xl border-2 border-[#0d121d] bg-[#718cff] text-white shadow-lg cursor-pointer"><Camera className="h-3.5 w-3.5" /></button>}
              <input ref={iconInputRef} type="file" accept="image/*" className="hidden" onChange={event => handleIcon(event.target.files?.[0])} />
            </div>

            {canEditGroupInfo ? (
              <div className="mx-auto max-w-sm space-y-2">
                <input value={name} maxLength={100} onChange={event => setName(event.target.value)} aria-label="Group name" className="w-full rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-center text-base font-bold text-white outline-none focus:border-[#718cff]/60" />
                <textarea value={description} maxLength={500} onChange={event => setDescription(event.target.value)} placeholder="Add a group description" aria-label="Group description" rows={2} className="w-full resize-none rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-center text-base md:text-xs leading-relaxed text-[#c2c6d8] outline-none placeholder:text-[#596174] focus:border-[#718cff]/60 touch-manipulation" />
              </div>
            ) : (
              <>
                <h3 className="text-lg font-bold text-white">{displayName}</h3>
                <p className="mt-1 text-xs text-[#8c90a1]">{isGroup ? (thread.description || 'No group description yet') : `@${contact?.username || 'member'}`}</p>
                {!isGroup && contact?.bio && <p className="mx-auto mt-3 max-w-xs text-xs leading-relaxed text-[#c2c6d8]">{contact.bio}</p>}
              </>
            )}
          </section>

          {!isGroup && (
            <section className="mx-4 mb-3 overflow-hidden rounded-2xl border border-white/[0.08] bg-white/[0.025]">
              <div className="border-b border-white/[0.06] px-4 py-3"><p className="text-[9px] font-bold uppercase tracking-[.16em] text-[#667085]">About & contact</p></div>
              <SettingRow icon={<Info className="h-4 w-4" />} title="About" detail={contact?.bio || 'Available on IB Connect'} />
              <div className="mx-4 border-t border-white/[0.06]" />
              <SettingRow icon={<Phone className="h-4 w-4" />} title="Phone number" detail="Not shared" />
              <div className="mx-4 border-t border-white/[0.06]" />
              <SettingRow icon={<Mail className="h-4 w-4" />} title="Email" detail={contact?.email || 'Not shared'} />
            </section>
          )}

          <section className="mx-4 mb-3 overflow-hidden rounded-2xl border border-white/[0.08] bg-white/[0.025]">
            <div className="border-b border-white/[0.06] px-4 py-3"><p className="text-[9px] font-bold uppercase tracking-[.16em] text-[#667085]">Shared content</p></div>
            <SettingRow icon={<ImageIcon className="h-4 w-4" />} title="Media, links & docs" detail={`${mediaCount} media · ${links.length} links · ${documentCount} docs`}>
              <ChevronRight className="h-4 w-4 text-[#667085]" />
            </SettingRow>
            {(attachments.length > 0 || links.length > 0) && (
              <div className="flex gap-2 overflow-x-auto border-t border-white/[0.06] px-4 py-3">
                {attachments.slice(0, 4).map(message => message.fileAttachment && (
                  <a key={message.id} href={message.fileAttachment.dataUrl} download={message.fileAttachment.name} title={message.fileAttachment.name} className="grid h-16 w-16 shrink-0 place-items-center overflow-hidden rounded-xl border border-white/10 bg-[#151c2a] text-[#9bafff]">
                    {message.fileAttachment.type.startsWith('image/') && message.fileAttachment.dataUrl ? <img src={message.fileAttachment.dataUrl} alt="" className="h-full w-full object-cover" /> : <FileText className="h-5 w-5" />}
                  </a>
                ))}
                {links.slice(0, 3).map((link, index) => <a key={`${link}-${index}`} href={link} target="_blank" rel="noreferrer" className="grid h-16 w-16 shrink-0 place-items-center rounded-xl border border-white/10 bg-[#151c2a] text-[#35cdb0]" title={link}><LinkIcon className="h-5 w-5" /></a>)}
              </div>
            )}
          </section>

          <section className="mx-4 mb-3 overflow-hidden rounded-2xl border border-white/[0.08] bg-white/[0.025]">
            <div className="border-b border-white/[0.06] px-4 py-3"><p className="text-[9px] font-bold uppercase tracking-[.16em] text-[#667085]">Conversation settings</p></div>
            <SettingRow icon={prefs.muted ? <BellOff className="h-4 w-4" /> : <Bell className="h-4 w-4" />} title="Mute notifications" detail={prefs.muted ? 'Notifications are muted on this device' : 'Message alerts are on'}>
              <Toggle checked={prefs.muted} label="Mute notifications" onChange={() => updatePrefs({ ...prefs, muted: !prefs.muted })} />
            </SettingRow>
            <div className="mx-4 border-t border-white/[0.06]" />
            <SettingRow icon={<Clock3 className="h-4 w-4" />} title="Disappearing messages" detail="Choose the default timer for this conversation">
              <select value={prefs.disappearing} onChange={event => updatePrefs({ ...prefs, disappearing: event.target.value as ChatInfoPreferences['disappearing'] })} className="rounded-lg border border-white/10 bg-[#151c2a] px-2 py-1.5 text-[10px] text-[#c2c6d8] outline-none">
                <option value="off">Off</option><option value="24h">24 hours</option><option value="7d">7 days</option><option value="90d">90 days</option>
              </select>
            </SettingRow>
            {!isGroup && <><div className="mx-4 border-t border-white/[0.06]" /><button onClick={() => setEncryptionOpen(value => !value)} className="w-full text-left"><SettingRow icon={<LockKeyhole className="h-4 w-4" />} title="Encryption info" detail="Messages are encrypted in transit"><ChevronRight className={`h-4 w-4 text-[#667085] transition-transform ${encryptionOpen ? 'rotate-90' : ''}`} /></SettingRow></button>{encryptionOpen && <p className="border-t border-white/[0.06] px-4 py-3 text-[10px] leading-relaxed text-[#8c90a1]">IB Connect protects messages with TLS while they travel between your device and the service. This is transport encryption, not end-to-end encryption.</p>}</>}
          </section>

          {isGroup && (
            <>
              <section className="mx-4 mb-3 overflow-hidden rounded-2xl border border-white/[0.08] bg-white/[0.025]">
                <div className="flex items-center justify-between border-b border-white/[0.06] px-4 py-3"><p className="text-[9px] font-bold uppercase tracking-[.16em] text-[#667085]">Participants</p><span className="text-[10px] text-[#8c90a1]">{thread.participants.length}</span></div>
                <div className="max-h-64 overflow-y-auto p-2">
                  {thread.participants.map(id => {
                    const user = getUserById(id); if (!user) return null;
                    const admin = id === thread.createdBy;
                    return <div key={id} className="flex items-center gap-3 rounded-xl px-2 py-2.5 hover:bg-white/[0.04]">{user.avatar ? <img src={user.avatar} alt="" className="h-9 w-9 rounded-xl object-cover" /> : <span className="grid h-9 w-9 place-items-center rounded-xl bg-[#718cff]/12 text-xs font-bold text-[#9bafff]">{initials(user.displayName)}</span>}<div className="min-w-0 flex-1"><p className="truncate text-xs font-semibold text-[#e5e2e1]">{user.displayName}{id === currentUser.id ? ' (you)' : ''}</p><p className="text-[10px] text-[#8c90a1]">{user.status}</p></div>{admin && <span className="rounded-md border border-[#35cdb0]/20 bg-[#35cdb0]/10 px-2 py-1 text-[8px] font-bold uppercase tracking-wider text-[#54d6c8]">Admin</span>}</div>;
                  })}
                </div>
              </section>

              {/* Group permissions -- retoned onto tokens (sub-unit 4: "group-admin
                  controls retheme only"); the rest of this panel is untouched
                  this pass, so it stays on its existing dark styling. */}
              <section className="mx-4 mb-6 overflow-hidden rounded-2xl border border-[var(--ib-border)] bg-[var(--ib-surface-raised)]">
                <div className="border-b border-[var(--ib-border)] px-4 py-3"><p className="text-[9px] font-bold uppercase tracking-[.16em] text-[var(--ib-text-muted)]">Group permissions</p></div>
                <SettingRow light icon={<ShieldCheck className="h-4 w-4" />} title="Edit group info" detail={adminsEditInfo ? 'Only admins can change the name, description and icon' : 'All participants can change group info'}>
                  <Toggle light checked={adminsEditInfo} disabled={!isAdmin} label="Only admins can edit group info" onChange={() => setAdminsEditInfo(value => !value)} />
                </SettingRow>
                <div className="mx-4 border-t border-[var(--ib-border)]" />
                <SettingRow light icon={<MessageSquare className="h-4 w-4" />} title="Send messages" detail={adminsSend ? 'Only admins can send messages' : 'All participants can send messages'}>
                  <Toggle light checked={adminsSend} disabled={!isAdmin} label="Only admins can send messages" onChange={() => setAdminsSend(value => !value)} />
                </SettingRow>
                {!isAdmin && <p className="border-t border-[var(--ib-border)] px-4 py-3 text-[10px] text-[var(--ib-text-muted)]">Only the group admin can change these permissions.</p>}
              </section>
            </>
          )}
        </div>

        {canEditGroupInfo && (
          <footer className="shrink-0 border-t border-white/[0.08] bg-[#0d121d]/95 p-4">
            {error && <p className="mb-2 text-[10px] text-[#ffb4ab]">{error}</p>}
            <button onClick={saveGroup} disabled={saving || !name.trim()} className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#718cff] py-3 text-xs font-bold text-white shadow-[0_10px_30px_rgba(113,140,255,.2)] transition hover:bg-[#8199ff] disabled:opacity-50">{saved ? <><Check className="h-4 w-4" />Saved</> : saving ? 'Saving…' : 'Save group info'}</button>
          </footer>
        )}
      </aside>
    </div>
  );
}
