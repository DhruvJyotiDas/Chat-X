import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Paperclip, Sparkles, Bold, Send, FileText, Download, Video,
  PlusCircle, Search, Users, X, Check, ArrowLeft,
  Smile, MoreVertical, MessageSquare
} from 'lucide-react';
import { IBUser, RealChatMessage, RealChatThread, ExtractedItem } from '../../types';
import { useAuth } from '../../context/AuthContext';
import { useChat } from '../../context/ChatContext';
import { useMeeting } from '../../context/MeetingContext';
import { api } from '../../lib/api';
import UserProfileModal from '../chat/UserProfileModal';
import GuestNameModal from '../meeting/GuestNameModal';

// ── Emoji Picker Data ──────────────────────────────────────────────────────

const EMOJI_GROUPS = [
  { label: 'Recent', emojis: ['😊','👍','❤️','😂','🙏','🔥','✅','💯'] },
  { label: 'Smileys', emojis: ['😀','😁','😂','🤣','😊','😇','🙂','🙃','😉','😌','😍','🥰','😘','😗','😙','😚','😋','😛','😝','😜','🤪','🤨','🧐','🤓','😎','🤩','🥳','😏','😒','😞','😔','😟','😕','🙁','☹️','😣','😖','😫','😩','🥺','😢','😭','😤','😠','😡','🤬','😈','👿','💀','☠️','💩','🤡','👹','👺','👻','👽','👾','🤖'] },
  { label: 'Gestures', emojis: ['👋','🤚','🖐️','✋','🖖','👌','🤌','🤏','✌️','🤞','🤟','🤘','🤙','👈','👉','👆','🖕','👇','☝️','👍','👎','✊','👊','🤛','🤜','👏','🙌','👐','🤲','🤝','🙏','✍️','💅','🤳','💪','🦾','🦿','🦵','🦶','👂','🦻','👃','🫀','🫁','🧠','🦷','🦴','👀','👁️','👅','👄','🫦'] },
  { label: 'Objects', emojis: ['💡','🔥','⭐','🌟','💫','✨','🎉','🎊','🎈','🎁','🏆','🥇','🥈','🥉','🎖️','🏅','🎗️','🎀','🎆','🎇','🧨','✅','❌','⚠️','🚀','💻','📱','⌚','📷','🎵','🎶','📚','💰','💎','🔑','🗝️','🔒','🔓','🔔','🔕','📣','📢','💬','💭','🗨️','🗯️','📝','✏️','🖊️','🖋️','📊','📈','📉','📋','📌','📍','📎','🖇️','📏','📐','✂️','🗃️','🗂️','🗄️','🗑️','🔧','🔨','⚙️','🛠️','⛏️','🔩','🪛','🧲','🔭','🔬','🩺','💊','🩹','🩼','🩻','🩸'] },
  { label: 'Nature', emojis: ['🌸','🌺','🌻','🌹','🌷','🌼','💐','🍀','🌿','🍃','🌱','🌲','🌳','🌴','🌵','🎋','🎍','🍄','🌾','🌊','🌙','☀️','⭐','🌈','⛅','🌤️','🌦️','🌧️','⛈️','🌩️','🌪️','🌫️','❄️','🔥','💧','🌊'] },
  { label: 'Food', emojis: ['🍕','🍔','🍟','🌭','🍿','🧂','🥓','🥚','🍳','🧇','🥞','🧈','🍞','🥐','🥖','🫓','🥨','🥯','🧀','🥗','🥙','🥪','🌮','🌯','🫔','🍱','🍘','🍣','🍤','🍙','🍚','🍛','🍜','🍝','🍠','🥮','🍢','🧆','🥟','🦪','🍦','🍧','🍨','🍩','🍪','🎂','🍰','🧁','🥧','🍫','🍬','🍭','🍮','🍯','🍼','🥛','☕','🫖','🍵','🧃','🥤','🧋','🍶','🍺','🍻','🥂','🍷','🥃','🍸','🍹','🧉','🍾'] },
];

function EmojiPicker({ onSelect, onClose }: { onSelect: (e: string) => void; onClose: () => void }) {
  const [tab, setTab] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  
  useEffect(() => {
    const handler = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    setTimeout(() => document.addEventListener('mousedown', handler), 10);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);
  
  return (
    <div ref={ref} className="absolute bottom-full mb-2 left-0 z-50 bg-[#1a1a1a] border border-[#424655] rounded-2xl shadow-2xl overflow-hidden w-72" style={{ maxHeight: '320px' }}>
      <div className="flex gap-1 p-2 border-b border-[#424655] overflow-x-auto scrollbar-none">
        {EMOJI_GROUPS.map((g, i) => (
          <button 
            key={i} 
            onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); setTab(i); }} 
            className={`px-2.5 py-1 rounded-lg text-[10px] font-bold whitespace-nowrap transition-colors ${tab === i ? 'bg-[#568dff] text-white' : 'text-[#8c90a1] hover:text-[#e5e2e1] hover:bg-[#201f1f]'}`}
          >
            {g.label}
          </button>
        ))}
      </div>
      <div className="p-2 overflow-y-auto" style={{ maxHeight: '240px' }}>
        <div className="grid grid-cols-8 gap-0.5">
          {EMOJI_GROUPS[tab].emojis.map((em, i) => (
            <button 
              key={i} 
              onMouseDown={(e) => { e.preventDefault(); onSelect(em); onClose(); }} 
              className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-[#201f1f] text-base transition-colors" 
              style={{ fontSize: '18px', lineHeight: 1 }}
            >
              {em}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Intelligence extraction ────────────────────────────────────────────────

function extractIntelligence(messages: RealChatMessage[]): ExtractedItem[] {
  const items: ExtractedItem[] = [];
  const recent = messages.slice(-30);
  recent.forEach(msg => {
    const t = msg.text;
    const meetRegex = /\b(?:meet|meeting|call|sync|standup|review|chat|catch\s*up)\b[^.!?\n]*?(?:at\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)|(?:tomorrow|today|tonight))/gi;
    let m;
    while ((m = meetRegex.exec(t)) !== null) {
      items.push({ id: `${msg.id}-meet-${items.length}`, type: 'meeting', text: m[0].trim().slice(0, 80), time: m[1], confidence: 0.9 });
    }
    const deadlineRegex = /\b(?:by|due|before|deadline)\s+(?:(?:next\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|tomorrow|end\s+of\s+(?:day|week)|(?:\d{1,2}[\/\-]\d{1,2}))/gi;
    while ((m = deadlineRegex.exec(t)) !== null) {
      items.push({ id: `${msg.id}-dl-${items.length}`, type: 'deadline', text: m[0].trim().slice(0, 80), confidence: 0.85 });
    }
    const timeRegex = /\b(?:at|@)\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm))\b/gi;
    while ((m = timeRegex.exec(t)) !== null) {
      if (!items.find(i => i.time === m![1])) {
        items.push({ id: `${msg.id}-time-${items.length}`, type: 'reminder', text: `Time noted: ${m[1]} — "${t.slice(0, 60)}"`, time: m[1], confidence: 0.8 });
      }
    }
    const actionRegex = /\b(?:need to|have to|must|will|going to|i'll|i will|remember to|don't forget(?:\s+to)?)\s+([a-z][^.!?\n]{4,50})/gi;
    while ((m = actionRegex.exec(t)) !== null) {
      items.push({ id: `${msg.id}-action-${items.length}`, type: 'action', text: m[0].trim().slice(0, 80), confidence: 0.75 });
    }
    const decisionRegex = /\b(?:decided|agreed|confirmed|let's go with|we'll use|final decision)\b[^.!?\n]{3,60}/gi;
    while ((m = decisionRegex.exec(t)) !== null) {
      items.push({ id: `${msg.id}-dec-${items.length}`, type: 'decision', text: m[0].trim().slice(0, 80), confidence: 0.85 });
    }
  });
  const seen = new Set<string>();
  return items.filter(i => { const key = i.text.slice(0, 30); if (seen.has(key)) return false; seen.add(key); return true; }).slice(0, 8);
}

const ITEM_ICONS: Record<ExtractedItem['type'], string> = { meeting: '📅', deadline: '⏰', action: '✅', reminder: '🔔', decision: '💡' };
const ITEM_COLORS: Record<ExtractedItem['type'], string> = {
  meeting: 'text-[#b0c6ff] bg-[#568dff]/10 border-[#568dff]/30',
  deadline: 'text-[#ffb4ab] bg-[#ffb4ab]/10 border-[#ffb4ab]/30',
  action: 'text-[#4dffb1] bg-[#4dffb1]/10 border-[#4dffb1]/30',
  reminder: 'text-[#ffd60a] bg-[#ffd60a]/10 border-[#ffd60a]/30',
  decision: 'text-[#c0c1ff] bg-[#c0c1ff]/10 border-[#c0c1ff]/30',
};

function renderText(text: string): React.ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={i} className="font-bold">{part.slice(2, -2)}</strong>;
    }
    return <span key={i}>{part}</span>;
  });
}

function useFreshUsers(currentUserId: string | undefined): IBUser[] {
  const [users, setUsers] = useState<IBUser[]>([]);
  const refresh = useCallback(() => {
    api.getUsers().then(all => setUsers(all.filter(u => u.id !== currentUserId) as IBUser[])).catch(() => {});
  }, [currentUserId]);
  useEffect(() => { refresh(); }, [refresh]);
  return users;
}

function renderUser(u: IBUser, onClick: () => void, selected?: boolean) {
  return (
    <button key={u.id} onClick={onClick} className={`w-full flex items-center gap-3 p-2.5 rounded-xl transition-colors text-left ${selected ? 'bg-[#568dff]/20 border border-[#568dff]/40' : 'hover:bg-[#201f1f] border border-transparent'}`}>
      {u.avatar ? (
        <img src={u.avatar} alt={u.displayName} className="w-9 h-9 rounded-full object-cover flex-shrink-0" />
      ) : (
        <div className="w-9 h-9 rounded-full bg-[#568dff]/10 flex items-center justify-center flex-shrink-0">
          <span className="text-sm font-bold text-[#b0c6ff]">{u.displayName.charAt(0).toUpperCase()}</span>
        </div>
      )}
      <div className="min-w-0 flex-1">
        <p className="text-xs font-semibold text-[#e5e2e1] truncate">{u.displayName}</p>
        <p className="text-[10px] text-[#8c90a1]">@{u.username}</p>
      </div>
      <div className={`w-2 h-2 rounded-full flex-shrink-0 ${u.status === 'online' ? 'bg-[#4dffb1]' : 'bg-[#8c90a1]'}`} />
      {selected && <Check className="w-3.5 h-3.5 text-[#568dff] flex-shrink-0" />}
    </button>
  );
}

function NewDMModal({ currentUserId, onClose, onSelect }: { currentUserId: string | undefined; onClose: () => void; onSelect: (userId: string) => void }) {
  const [search, setSearch] = useState('');
  const [allRaw, setAllRaw] = useState<IBUser[]>([]);
  const refreshAll = useCallback(() => { api.getUsers().then(all => setAllRaw(all as IBUser[])).catch(() => setAllRaw([])); }, []);
  useEffect(() => {
    refreshAll();
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    let ch: BroadcastChannel | null = null;
    try { ch = new BroadcastChannel('ibconnect_realtime'); ch.onmessage = (e) => { if (e.data?.type === 'users_updated') refreshAll(); }; } catch {}
    return () => { window.removeEventListener('keydown', h); ch?.close(); };
  }, [onClose, refreshAll]);
  const others = allRaw.filter(u => u.id !== currentUserId);
  const filtered = others.filter(u => !search || u.displayName.toLowerCase().includes(search.toLowerCase()) || u.username.toLowerCase().includes(search.toLowerCase()));
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="bg-[#131313] border border-[#424655] rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between p-4 border-b border-[#424655]">
          <span className="font-bold text-sm text-[#e5e2e1]">New Direct Message</span>
          <button onClick={onClose}><X className="w-4 h-4 text-[#8c90a1]" /></button>
        </div>
        <div className="px-4 py-2 bg-[#0e0e0e]/60 border-b border-[#424655]/40 flex items-center justify-between">
          <span className="text-[10px] text-[#8c90a1]">{allRaw.length === 0 ? '⚠️ No accounts in storage' : `${allRaw.length} account${allRaw.length !== 1 ? 's' : ''} registered`}</span>
          <button onClick={refreshAll} className="text-[10px] text-[#b0c6ff] hover:text-[#568dff] font-bold cursor-pointer">↻ Refresh</button>
        </div>
        <div className="p-3">
          <div className="relative mb-3">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-[#8c90a1]" />
            <input autoFocus type="text" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search by name or username…" className="w-full bg-[#0e0e0e] border border-[#424655] rounded-xl pl-9 pr-3 py-2.5 text-xs text-[#e5e2e1] placeholder-[#8c90a1]/60 focus:border-[#568dff] outline-none" />
          </div>
          <div className="flex flex-col gap-1 max-h-64 overflow-y-auto">
            {others.length === 0 ? (
              <div className="py-5 text-center px-3">
                <p className="text-xs font-semibold text-[#e5e2e1] mb-1">Only 1 account in this browser</p>
                <p className="text-[10px] text-[#8c90a1] leading-relaxed">Another person must create their account in this app first.</p>
              </div>
            ) : filtered.length === 0 ? (
              <p className="text-xs text-[#8c90a1] text-center py-4">No match for "{search}"</p>
            ) : filtered.map(u => renderUser(u, () => onSelect(u.id)))}
          </div>
        </div>
      </div>
    </div>
  );
}

function NewGroupModal({ currentUserId, onClose, onCreate }: { currentUserId: string | undefined; onClose: () => void; onCreate: (name: string, memberIds: string[]) => void }) {
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const users = useFreshUsers(currentUserId);
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  const filtered = users.filter(u => !search || u.displayName.toLowerCase().includes(search.toLowerCase()) || u.username.toLowerCase().includes(search.toLowerCase()));
  const toggle = (id: string) => setSelected(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  const canCreate = name.trim().length > 0 && selected.length >= 1;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="bg-[#131313] border border-[#424655] rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between p-4 border-b border-[#424655]">
          <span className="font-bold text-sm text-[#e5e2e1]">New Group Chat</span>
          <button onClick={onClose}><X className="w-4 h-4 text-[#8c90a1]" /></button>
        </div>
        <div className="p-4 flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-[10px] font-bold uppercase tracking-wider text-[#8c90a1]">Group Name</label>
            <input autoFocus type="text" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Team Alpha…" className="bg-[#0e0e0e] border border-[#424655] rounded-xl px-3 py-2.5 text-xs text-[#e5e2e1] placeholder-[#8c90a1]/60 focus:border-[#568dff] outline-none" />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[10px] font-bold uppercase tracking-wider text-[#8c90a1]">Add Members {selected.length > 0 && <span className="text-[#568dff]">({selected.length} selected)</span>}</label>
            <div className="relative">
              <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-[#8c90a1]" />
              <input type="text" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search users…" className="w-full bg-[#0e0e0e] border border-[#424655] rounded-xl pl-8 pr-3 py-2 text-xs text-[#e5e2e1] placeholder-[#8c90a1]/60 focus:border-[#568dff] outline-none" />
            </div>
          </div>
          <div className="flex flex-col gap-1 max-h-48 overflow-y-auto">
            {users.length === 0 ? <p className="text-xs text-[#8c90a1] text-center py-4">No other accounts on this device yet.</p> : filtered.map(u => renderUser(u, () => toggle(u.id), selected.includes(u.id)))}
          </div>
          {selected.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {selected.map(id => { const u = users.find(x => x.id === id); if (!u) return null; return <span key={id} className="flex items-center gap-1 bg-[#568dff]/10 text-[#b0c6ff] border border-[#568dff]/30 rounded-full text-[10px] font-semibold px-2 py-0.5">{u.displayName}<button onClick={() => toggle(id)} className="hover:text-[#ffb4ab]"><X className="w-2.5 h-2.5" /></button></span>; })}
            </div>
          )}
          <button onClick={() => canCreate && onCreate(name.trim(), selected)} disabled={!canCreate} className="w-full py-2.5 bg-[#568dff] text-[#002661] font-bold text-xs rounded-xl hover:bg-[#568dff]/90 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-colors mt-1">Create Group</button>
        </div>
      </div>
    </div>
  );
}

function IntelligenceSidebar({ intelligence, messages, activeThread, currentUser, getUserById, setViewingUser, handleQuickJoin, isJoining, meetingError }: {
  intelligence: ExtractedItem[];
  messages: RealChatMessage[];
  activeThread: RealChatThread | null;
  currentUser: IBUser | null;
  getUserById: (id: string) => IBUser | undefined;
  setViewingUser: (u: IBUser) => void;
  handleQuickJoin: () => void;
  isJoining: boolean;
  meetingError: string | null;
}) {
  return (
    <aside className="hidden xl:flex w-72 flex-shrink-0 flex-col border-l border-[#424655] bg-[#131313] overflow-y-auto select-none">
      <div className="p-4 border-b border-[#424655] sticky top-0 bg-[#131313]/95 backdrop-blur-md z-10 flex items-center gap-2">
        <Sparkles className="w-4 h-4 text-[#c0c1ff]" />
        <h3 className="font-bold text-sm text-[#e5e2e1]">Intelligence Agent</h3>
      </div>
      <div className="p-4 flex flex-col gap-5">
        <div>
          <h4 className="text-[9px] font-bold tracking-widest text-[#8c90a1] uppercase mb-3">Active Meetings</h4>
          <div className="bg-[#568dff]/10 border border-[#b0c6ff]/20 p-3.5 rounded-xl relative overflow-hidden">
            <div className="absolute top-0 right-0 w-20 h-20 bg-gradient-to-bl from-[#568dff]/10 to-transparent rounded-bl-full pointer-events-none" />
            <div className="flex items-center justify-between mb-2">
              <span className="font-semibold text-xs text-[#e5e2e1]">Instant Room</span>
              <span className="bg-[#568dff]/20 text-[#b0c6ff] px-1.5 py-0.5 rounded text-[8px] uppercase font-black tracking-wider border border-[#568dff]/30">Ready</span>
            </div>
            <button onClick={handleQuickJoin} disabled={isJoining} className="w-full bg-[#568dff] text-[#002661] font-bold py-2 rounded-lg text-xs hover:bg-[#568dff]/90 transition-colors flex items-center justify-center gap-1.5 disabled:opacity-50">
              <Video className="w-3.5 h-3.5" />{isJoining ? 'Starting...' : 'Quick Join'}
            </button>
          </div>
        </div>
        <div>
          <div className="flex items-center gap-2 mb-3">
            <h4 className="text-[9px] font-bold tracking-widest text-[#8c90a1] uppercase">AI Extracted Items</h4>
            <span className="text-[8px] bg-[#c0c1ff]/10 text-[#c0c1ff] px-1.5 py-0.5 rounded font-bold border border-[#c0c1ff]/20">LIVE</span>
          </div>
          {intelligence.length === 0 ? (
            <div className="bg-[#0e0e0e] border border-[#424655]/40 rounded-xl p-4 text-center">
              <Sparkles className="w-5 h-5 text-[#424655] mx-auto mb-2" />
              <p className="text-[10px] text-[#8c90a1]">{messages.length === 0 ? 'Start chatting — the AI will extract meetings, deadlines & action items here.' : 'No key items detected yet. Mention times, deadlines, or action items.'}</p>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {intelligence.map(item => (
                <div key={item.id} className={`border rounded-xl p-3 text-[10px] leading-relaxed ${ITEM_COLORS[item.type]}`}>
                  <div className="flex items-start gap-1.5">
                    <span className="mt-0.5">{ITEM_ICONS[item.type]}</span>
                    <div><span className="font-bold uppercase text-[8px] tracking-wider block mb-0.5 opacity-70">{item.type}</span><span>{item.text}</span>{item.time && <span className="block mt-0.5 opacity-70">🕒 {item.time}</span>}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        {activeThread && (
          <div>
            <h4 className="text-[9px] font-bold tracking-widest text-[#8c90a1] uppercase mb-3">Participants</h4>
            <div className="flex flex-col gap-2">
              {activeThread.participants.map(pid => {
                const u = getUserById(pid); if (!u) return null;
                return (
                  <div key={pid} onClick={() => setViewingUser(u)} className="flex items-center gap-2.5 cursor-pointer p-2 rounded-lg hover:bg-[#201f1f] transition-colors">
                    {u.avatar ? <img src={u.avatar} alt={u.displayName} className="w-7 h-7 rounded-full object-cover flex-shrink-0" /> : <div className="w-7 h-7 rounded-full bg-[#568dff]/10 flex items-center justify-center flex-shrink-0"><span className="text-[10px] font-bold text-[#b0c6ff]">{u.displayName.charAt(0).toUpperCase()}</span></div>}
                    <div className="flex-1 min-w-0"><p className="text-xs font-semibold text-[#e5e2e1] truncate">{u.id === currentUser?.id ? `${u.displayName} (you)` : u.displayName}</p></div>
                    <div className={`w-2 h-2 rounded-full flex-shrink-0 ${u.status === 'online' ? 'bg-[#4dffb1]' : 'bg-[#8c90a1]'}`} />
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}

// ── Main ChatsView ─────────────────────────────────────────────────────────

interface ChatsViewProps { onJoinMeeting: () => void; searchFilter: string; }

type MobilePanel = 'list' | 'chat';

export default function ChatsView({ onJoinMeeting, searchFilter }: ChatsViewProps) {
  const { currentUser, getUserById } = useAuth();
  const { threads, getMessages, sendMessage, startDM, createGroup, typingUsers, setTyping, markRead, setActiveThreadId } = useChat();
  const { createMeeting, meetingError, clearMeetingError } = useMeeting();

  const [mobilePanel, setMobilePanel] = useState<MobilePanel>('list');
  const [selectedThreadId, setSelectedThreadIdLocal] = useState<string | null>(null);
  const [inputText, setInputText] = useState('');
  const [showNewThread, setShowNewThread] = useState(false);
  const [showNewGroup, setShowNewGroup] = useState(false);
  const [viewingUser, setViewingUser] = useState<IBUser | null>(null);
  const [showGuestModal, setShowGuestModal] = useState(false);
  const [isJoining, setIsJoining] = useState(false);
  const [messages, setMessages] = useState<RealChatMessage[]>([]);
  const [intelligence, setIntelligence] = useState<ExtractedItem[]>([]);
  const [showEmoji, setShowEmoji] = useState(false);
  const [localSearch, setLocalSearch] = useState('');

  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const typingDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const activeThread = threads.find(t => t.id === selectedThreadId) || null;

  // FIX: activeTypingUsers is moved safely to the top before the useEffect!
  const activeTypingUsers = activeThread ? (typingUsers[activeThread.id] || []) : [];

  useEffect(() => {
    let meta = document.querySelector('meta[name="viewport"]');
    if (!meta) {
      meta = document.createElement('meta');
      meta.setAttribute('name', 'viewport');
      document.head.appendChild(meta);
    }
    meta.setAttribute('content', 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=0');
    window.scrollTo(0, 0); 
  }, []);

  useEffect(() => {
    if (!activeThread) { setMessages([]); setIntelligence([]); return; }
    setActiveThreadId(activeThread.id);
    markRead(activeThread.id);
    
    const cached = getMessages(activeThread.id);
    setMessages([...cached]);
    setIntelligence(extractIntelligence(cached));

    import('../../context/ChatContext').then((module) => {
      const loadFn = (module.ChatProvider as any)?._loadMessages;
      if (loadFn) {
        loadFn(activeThread.id).then((msgs: RealChatMessage[]) => { 
          setMessages([...msgs]); 
          setIntelligence(extractIntelligence(msgs)); 
        }).catch(() => {});
      }
    }).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeThread?.id]);

  useEffect(() => {
    if (!activeThread) return;
    const msgs = getMessages(activeThread.id);
    setMessages([...msgs]);
    setIntelligence(extractIntelligence(msgs));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threads]);

  useEffect(() => {
    requestAnimationFrame(() => {
      if (chatScrollRef.current) {
        chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
      }
    });
  }, [messages, activeTypingUsers]);

  const handleSelectThread = (threadId: string) => {
    setSelectedThreadIdLocal(threadId);
    setActiveThreadId(threadId);
    markRead(threadId);
    const msgs = getMessages(threadId);
    setMessages(msgs);
    setIntelligence(extractIntelligence(msgs));
    setMobilePanel('chat');
  };

  const handleMobileBack = () => setMobilePanel('list');

  const handleSend = () => {
    if (!inputText.trim() || !activeThread) return;
    sendMessage(activeThread.id, inputText.trim());
    setInputText('');
    setTyping(activeThread.id, false);
    setShowEmoji(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInputText(e.target.value);
    if (!activeThread) return;
    if (typingDebounceRef.current) clearTimeout(typingDebounceRef.current);
    setTyping(activeThread.id, true);
    typingDebounceRef.current = setTimeout(() => setTyping(activeThread.id, false), 2000);
    const ta = e.target;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 112) + 'px';
  };

  const handleBold = () => {
    const ta = textareaRef.current;
    if (!ta) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const selected = inputText.slice(start, end);
    if (selected) {
      const newText = inputText.slice(0, start) + `**${selected}**` + inputText.slice(end);
      setInputText(newText);
      setTimeout(() => { ta.selectionStart = start + 2; ta.selectionEnd = end + 2; ta.focus(); }, 0);
    } else {
      const cur = ta.selectionStart;
      const newText = inputText.slice(0, cur) + '****' + inputText.slice(cur);
      setInputText(newText);
      setTimeout(() => { ta.selectionStart = cur + 2; ta.selectionEnd = cur + 2; ta.focus(); }, 0);
    }
  };

  const handleEmojiSelect = (emoji: string) => {
    const ta = textareaRef.current;
    if (ta) {
      const pos = ta.selectionStart;
      const newText = inputText.slice(0, pos) + emoji + inputText.slice(pos);
      setInputText(newText);
      setTimeout(() => { 
        ta.focus();
        ta.setSelectionRange(pos + emoji.length, pos + emoji.length);
      }, 10);
    } else {
      setInputText(prev => prev + emoji);
    }
  };

  const handleFileAttach = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !activeThread) return;
    if (file.size > 5 * 1024 * 1024) { alert('File must be under 5MB'); return; }
    const reader = new FileReader();
    reader.onload = (ev) => {
      sendMessage(activeThread.id, `📎 Shared a file: ${file.name}`, { name: file.name, size: file.size, type: file.type, dataUrl: ev.target?.result as string });
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  const handleNewDM = async (userId: string) => {
    setShowNewThread(false);
    try { const threadId = await startDM(userId); if (threadId) { setSelectedThreadIdLocal(threadId); setActiveThreadId(threadId); setMobilePanel('chat'); } } catch (e) { console.error('startDM failed', e); }
  };

  const handleNewGroup = async (name: string, memberIds: string[]) => {
    setShowNewGroup(false);
    try { const threadId = await createGroup(name, memberIds); if (threadId) { setSelectedThreadIdLocal(threadId); setActiveThreadId(threadId); setMobilePanel('chat'); } } catch (e) { console.error('createGroup failed', e); }
  };

  const handleQuickJoin = async () => {
    setIsJoining(true);
    clearMeetingError();
    try { await createMeeting(); onJoinMeeting(); } catch {} finally { setIsJoining(false); }
  };

  const combinedSearch = localSearch || searchFilter;
  const filteredThreads = threads.filter(t =>
    t.name.toLowerCase().includes(combinedSearch.toLowerCase()) ||
    t.lastMessage.toLowerCase().includes(combinedSearch.toLowerCase())
  ).sort((a, b) => b.lastTimestamp - a.lastTimestamp);

  const getThreadUser = (thread: RealChatThread): IBUser | undefined => {
    if (thread.type !== 'dm') return undefined;
    const otherId = thread.participants.find(p => p !== currentUser?.id);
    return otherId ? getUserById(otherId) : undefined;
  };

  const getSenderUser = (msg: RealChatMessage): IBUser | undefined => getUserById(msg.senderId);

  const renderThreadList = () => (
    <div className="flex flex-col h-full bg-[#0e0e0e]">
      <div className="p-3 border-b border-[#424655] flex justify-between items-center bg-[#0e0e0e] sticky top-0 z-10">
        <h2 className="font-bold text-xs text-[#e5e2e1] uppercase tracking-wider">Messages</h2>
        <div className="flex items-center gap-1">
          <button onClick={() => setShowNewThread(true)} className="w-7 h-7 flex items-center justify-center rounded-lg text-[#8c90a1] hover:text-[#b0c6ff] hover:bg-[#201f1f] transition-colors"><PlusCircle className="w-4 h-4" /></button>
          <button onClick={() => setShowNewGroup(true)} className="w-7 h-7 flex items-center justify-center rounded-lg text-[#8c90a1] hover:text-[#b0c6ff] hover:bg-[#201f1f] transition-colors"><Users className="w-4 h-4" /></button>
        </div>
      </div>
      <div className="px-3 pt-2 pb-1">
        <div className="relative">
          <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-[#8c90a1]" />
          <input
            type="text"
            value={localSearch}
            onChange={e => setLocalSearch(e.target.value)}
            placeholder="Search conversations…"
            className="w-full bg-[#131313] border border-[#424655]/60 rounded-xl pl-8 pr-3 py-2 text-[16px] sm:text-xs text-[#e5e2e1] placeholder-[#8c90a1]/60 focus:border-[#568dff] outline-none transition-colors"
          />
          {localSearch && <button onClick={() => setLocalSearch('')} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[#8c90a1] hover:text-[#e5e2e1]"><X className="w-3 h-3" /></button>}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto flex flex-col gap-0.5 px-2 pt-1 pb-2">
        {filteredThreads.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 text-center px-4">
            <div className="w-10 h-10 rounded-xl bg-[#568dff]/10 flex items-center justify-center mb-2"><PlusCircle className="w-5 h-5 text-[#b0c6ff]" /></div>
            <p className="text-xs font-semibold text-[#e5e2e1]">{combinedSearch ? 'No results found' : 'No conversations yet'}</p>
          </div>
        )}
        {filteredThreads.map(thread => {
          const isSelected = thread.id === selectedThreadId;
          const threadUser = getThreadUser(thread);
          const displayTime = thread.lastTimestamp ? new Date(thread.lastTimestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
          
          return (
            <div key={thread.id} onClick={() => handleSelectThread(thread.id)} className={`p-3 rounded-xl flex items-start gap-2.5 cursor-pointer border transition-all ${isSelected ? 'bg-[#568dff]/15 border-[#568dff]/50' : 'bg-transparent border-transparent hover:bg-[#131313]'}`}>
              <div className="relative flex-shrink-0" onClick={e => { if (threadUser) { e.stopPropagation(); setViewingUser(threadUser); } }}>
                {thread.type === 'group' ? (
                  <div className="w-9 h-9 rounded-xl bg-[#8083ff]/15 text-[#c0c1ff] flex items-center justify-center"><Users className="w-4 h-4" /></div>
                ) : thread.avatar ? (
                  <img alt={thread.name} className="w-9 h-9 rounded-full object-cover" src={thread.avatar} />
                ) : (
                  <div className="w-9 h-9 rounded-xl bg-[#568dff]/10 text-[#b0c6ff] flex items-center justify-center font-bold text-xs">{thread.name.charAt(0).toUpperCase()}</div>
                )}
                {threadUser && <div className={`absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full border border-[#0e0e0e] ${threadUser.status === 'online' ? 'bg-[#4dffb1]' : 'bg-[#8c90a1]'}`} />}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex justify-between items-baseline mb-0.5">
                  <span className="font-semibold text-xs text-[#e5e2e1] truncate">{thread.name}</span>
                  <span className="text-[9px] text-[#8c90a1] flex-shrink-0 ml-1">{displayTime}</span>
                </div>
                <div className="flex justify-between items-center gap-1">
                  <p className="text-[10px] text-[#8c90a1] truncate flex-1 min-w-0">{thread.lastMessage || 'Start a conversation'}</p>
                  {thread.unreadCount && thread.unreadCount > 0 && !isSelected && (
                    <span className="flex-shrink-0 min-w-[16px] h-4 bg-[#568dff] text-[#002661] rounded-full flex items-center justify-center font-bold text-[9px] px-1">{thread.unreadCount}</span>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );

  const renderChat = () => (
    <div className="flex flex-col h-full bg-[#0e0e0e] relative">
      {!activeThread ? (
        <div className="flex-1 flex flex-col items-center justify-center text-center p-8">
          <div className="w-16 h-16 rounded-2xl bg-[#568dff]/10 flex items-center justify-center mb-4"><Sparkles className="w-8 h-8 text-[#b0c6ff]" /></div>
          <h2 className="text-lg font-bold text-[#e5e2e1] mb-2">Welcome to IB Connect</h2>
          <p className="text-sm text-[#8c90a1] mb-4">Select a conversation or start a new one</p>
          <button onClick={() => setShowNewThread(true)} className="flex items-center gap-2 bg-[#568dff] text-[#002661] font-bold px-4 py-2.5 rounded-xl text-xs hover:bg-[#568dff]/90 transition-colors"><PlusCircle className="w-4 h-4" /> Start New Chat</button>
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2 sm:gap-3 px-3 sm:px-4 py-3 border-b border-[#424655] bg-[#0e0e0e] flex-shrink-0">
            <button onClick={handleMobileBack} className="lg:hidden w-8 h-8 flex items-center justify-center rounded-lg text-[#8c90a1] hover:text-[#e5e2e1] hover:bg-[#201f1f] transition-colors flex-shrink-0">
              <ArrowLeft className="w-4 h-4" />
            </button>
            {(() => {
              const threadUser = getThreadUser(activeThread);
              return (
                <div className="relative cursor-pointer flex-shrink-0" onClick={() => threadUser && setViewingUser(threadUser)}>
                  {activeThread.type === 'group' ? (
                    <div className="w-9 h-9 rounded-xl bg-[#8083ff]/15 text-[#c0c1ff] flex items-center justify-center"><Users className="w-4 h-4" /></div>
                  ) : activeThread.avatar ? (
                    <img src={activeThread.avatar} className="w-9 h-9 rounded-full object-cover" />
                  ) : (
                    <div className="w-9 h-9 rounded-xl bg-[#568dff]/10 flex items-center justify-center"><span className="text-sm font-bold text-[#b0c6ff]">{activeThread.name.charAt(0).toUpperCase()}</span></div>
                  )}
                  {threadUser && <div className={`absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full border border-[#0e0e0e] ${threadUser.status === 'online' ? 'bg-[#4dffb1]' : 'bg-[#8c90a1]'}`} />}
                </div>
              );
            })()}
            <div className="flex-1 min-w-0">
              <h3 className="font-bold text-sm text-[#e5e2e1] truncate">{activeThread.name}</h3>
              <p className="text-[10px] text-[#8c90a1] truncate">
                {activeTypingUsers.length > 0 ? `${activeTypingUsers.map(u => u.userName).join(', ')} is typing...` : (() => { const u = getThreadUser(activeThread); return u ? (u.status === 'online' ? 'Online' : 'Offline') : `${activeThread.participants.length} participants`; })()}
              </p>
            </div>
            <button onClick={handleQuickJoin} disabled={isJoining} className="flex items-center gap-1.5 bg-[#568dff]/10 text-[#b0c6ff] border border-[#568dff]/30 px-2.5 sm:px-3 py-1.5 rounded-lg text-xs font-bold hover:bg-[#568dff]/20 transition-colors disabled:opacity-50 flex-shrink-0">
              <Video className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">{isJoining ? '...' : 'Start Call'}</span>
            </button>
          </div>

          <div ref={chatScrollRef} className="flex-1 overflow-y-auto p-3 sm:p-4 flex flex-col gap-3 sm:gap-4 scroll-smooth" style={{ paddingBottom: '130px' }}>
            {messages.length === 0 ? (
              <div className="flex-1 flex items-center justify-center py-16">
                <div className="text-center">
                  <MessageSquare className="w-8 h-8 text-[#424655] mx-auto mb-2" />
                  <p className="text-xs text-[#8c90a1]">No messages yet — say hello!</p>
                </div>
              </div>
            ) : (
              messages.map((msg) => {
                const isMe = msg.senderId === currentUser?.id;
                const sender = !isMe ? getSenderUser(msg) : currentUser;
                
                const messageTime = (msg as any).timestamp 
                  ? new Date((msg as any).timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) 
                  : msg.time;

                return (
                  <div key={msg.id} className={`flex gap-2 sm:gap-2.5 ${isMe ? 'flex-row-reverse' : 'flex-row'}`}>
                    <div className="flex-shrink-0 mt-0.5 cursor-pointer" onClick={() => { if (!isMe && sender) setViewingUser(sender as IBUser); }}>
                      {msg.senderAvatar ? (
                        <img alt={msg.senderName} className="w-7 h-7 sm:w-8 sm:h-8 rounded-full object-cover ring-1 ring-[#424655]" src={msg.senderAvatar} />
                      ) : (
                        <div className={`w-7 h-7 sm:w-8 sm:h-8 rounded-full flex items-center justify-center text-xs font-bold ${isMe ? 'bg-[#568dff] text-[#002661]' : 'bg-[#201f1f] text-[#b0c6ff]'}`}>{msg.senderName.charAt(0).toUpperCase()}</div>
                      )}
                    </div>
                    <div className={`flex flex-col gap-1 ${isMe ? 'items-end' : 'items-start'}`} style={{ maxWidth: 'min(72%, 420px)' }}>
                      <div className={`flex items-baseline gap-2 ${isMe ? 'flex-row-reverse' : 'flex-row'}`}>
                        <span className="text-[10px] font-semibold text-[#c2c6d8]">{msg.senderName}</span>
                        <span className="text-[9px] text-[#8c90a1] flex-shrink-0">{messageTime}</span>
                      </div>
                      {msg.fileAttachment ? (
                        <div className={`p-3 rounded-2xl border ${isMe ? 'bg-[#568dff]/10 border-[#568dff]/30 rounded-tr-sm' : 'bg-[#201f1f] border-[#424655]/40 rounded-tl-sm'}`}>
                          <div className="flex items-center gap-2.5">
                            <div className="w-9 h-9 rounded-lg bg-[#8083ff]/20 flex items-center justify-center flex-shrink-0"><FileText className="w-4 h-4 text-[#c0c1ff]" /></div>
                            <div className="flex-1 min-w-0">
                              <p className="text-xs font-semibold text-[#e5e2e1] truncate">{msg.fileAttachment.name}</p>
                              <p className="text-[10px] text-[#8c90a1]">{(msg.fileAttachment.size / 1024).toFixed(1)} KB</p>
                            </div>
                            {msg.fileAttachment.dataUrl && (
                              <a href={msg.fileAttachment.dataUrl} download={msg.fileAttachment.name} onClick={e => e.stopPropagation()} className="w-7 h-7 flex items-center justify-center rounded-lg bg-[#568dff]/10 text-[#b0c6ff] hover:bg-[#568dff]/20 transition-colors"><Download className="w-3.5 h-3.5" /></a>
                            )}
                          </div>
                        </div>
                      ) : (
                        <div className={`px-3 py-2.5 rounded-2xl text-[16px] sm:text-xs border leading-relaxed ${isMe ? 'bg-[#568dff] text-white border-[#568dff] rounded-tr-sm' : 'bg-[#1c1b1b] text-[#e5e2e1] border-[#424655]/40 rounded-tl-sm'}`}
                          style={{ wordBreak: 'break-word', overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>
                          {renderText(msg.text)}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })
            )}
            {activeTypingUsers.length > 0 && (
              <div className="flex gap-2.5 items-end">
                <div className="w-8 h-8 rounded-full bg-[#201f1f] flex items-center justify-center flex-shrink-0"><span className="text-xs font-bold text-[#b0c6ff]">{activeTypingUsers[0].userName.charAt(0).toUpperCase()}</span></div>
                <div className="bg-[#1c1b1b] border border-[#424655]/40 rounded-2xl rounded-tl-sm px-4 py-3">
                  <div className="flex gap-1 items-center">
                    <div className="w-1.5 h-1.5 bg-[#8c90a1] rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                    <div className="w-1.5 h-1.5 bg-[#8c90a1] rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                    <div className="w-1.5 h-1.5 bg-[#8c90a1] rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                  </div>
                </div>
              </div>
            )}
            <div ref={messagesEndRef} className="h-1 flex-shrink-0" />
          </div>

          <div className="absolute bottom-0 left-0 right-0 p-2 sm:p-3 bg-gradient-to-t from-[#0e0e0e] via-[#0e0e0e]/98 to-transparent pt-6 sm:pt-8">
            <div className="bg-[#131313] rounded-xl border border-[#424655] shadow-lg focus-within:border-[#568dff] focus-within:ring-1 focus-within:ring-[#568dff]/50 transition-all flex flex-col">
              <textarea
                ref={textareaRef}
                className="w-full bg-transparent border-none focus:ring-0 resize-none py-3 px-4 text-[16px] sm:text-xs text-[#e5e2e1] placeholder-[#8c90a1]/60 outline-none leading-relaxed"
                style={{ minHeight: '44px', maxHeight: '112px', overflowY: 'auto' }}
                placeholder="Type a message… (use **text** for bold)"
                value={inputText}
                onChange={handleInputChange}
                onKeyDown={handleKeyDown}
              />
              <div className="flex justify-between items-center px-3 py-2 border-t border-[#424655]/30 bg-[#1c1b1b]/40 rounded-b-xl">
                <div className="flex gap-1 relative">
                  <button onClick={() => fileInputRef.current?.click()} className="w-7 h-7 flex items-center justify-center rounded-lg text-[#8c90a1] hover:bg-[#201f1f] hover:text-[#b0c6ff] transition-colors"><Paperclip className="w-3.5 h-3.5" /></button>
                  <button onClick={handleBold} className="w-7 h-7 flex items-center justify-center rounded-lg text-[#8c90a1] hover:bg-[#201f1f] hover:text-[#e5e2e1] transition-colors"><Bold className="w-3.5 h-3.5" /></button>
                  <button onClick={() => setShowEmoji(v => !v)} className={`w-7 h-7 flex items-center justify-center rounded-lg transition-colors ${showEmoji ? 'bg-[#568dff]/20 text-[#b0c6ff]' : 'text-[#8c90a1] hover:bg-[#201f1f] hover:text-[#b0c6ff]'}`}><Smile className="w-3.5 h-3.5" /></button>
                  {showEmoji && <EmojiPicker onSelect={handleEmojiSelect} onClose={() => setShowEmoji(false)} />}
                </div>
                <button onClick={handleSend} disabled={!inputText.trim()} className="bg-[#568dff] text-[#002661] w-7 h-7 rounded-lg flex items-center justify-center hover:bg-[#568dff]/90 transition-colors shadow-sm disabled:opacity-40 disabled:cursor-not-allowed">
                  <Send className="w-3 h-3 stroke-[2.5]" />
                </button>
              </div>
            </div>
            {meetingError && <p className="text-[10px] text-[#ffb4ab] mt-1 text-center">{meetingError}</p>}
          </div>
        </>
      )}
    </div>
  );

  return (
    <div className="flex-1 flex overflow-hidden h-full" style={{ WebkitOverflowScrolling: 'touch' }}>
      <input ref={fileInputRef} type="file" className="hidden" onChange={handleFileAttach} />
      {showGuestModal && <GuestNameModal action="create" onConfirm={() => { setShowGuestModal(false); handleQuickJoin(); }} onCancel={() => setShowGuestModal(false)} />}
      {showNewThread && <NewDMModal currentUserId={currentUser?.id} onClose={() => setShowNewThread(false)} onSelect={handleNewDM} />}
      {showNewGroup && <NewGroupModal currentUserId={currentUser?.id} onClose={() => setShowNewGroup(false)} onCreate={handleNewGroup} />}
      {viewingUser && <UserProfileModal user={viewingUser} onClose={() => setViewingUser(null)} onStartChat={() => { handleNewDM(viewingUser.id); setViewingUser(null); }} />}

      <div className="lg:hidden flex-1 flex flex-col overflow-hidden">
        {mobilePanel === 'list' ? <div className="flex-1 overflow-hidden">{renderThreadList()}</div> : <div className="flex-1 overflow-hidden">{renderChat()}</div>}
      </div>

      <div className="hidden lg:flex flex-1 overflow-hidden">
        <aside className="w-72 flex-shrink-0 border-r border-[#424655] overflow-hidden flex flex-col">{renderThreadList()}</aside>
        <main className="flex-1 overflow-hidden flex flex-col">{renderChat()}</main>
        <IntelligenceSidebar intelligence={intelligence} messages={messages} activeThread={activeThread} currentUser={currentUser} getUserById={getUserById} setViewingUser={setViewingUser} handleQuickJoin={handleQuickJoin} isJoining={isJoining} meetingError={meetingError ?? null} />
      </div>
    </div>
  );
}
