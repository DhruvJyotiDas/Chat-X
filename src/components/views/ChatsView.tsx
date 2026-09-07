import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Paperclip, Sparkles, Bold, Send, FileText, Download, Video,
  PlusCircle, Search, Users, X, Check, ArrowLeft,
  Smile, MoreVertical, MessageSquare, ChevronsRight, ChevronsLeft, Share2,
  Wand2, Loader2, RotateCcw, Trash2, Brain, ListChecks, Mic, Play, Pause
} from 'lucide-react';
import { IBUser, RealChatMessage, RealChatThread, ExtractedItem } from '../../types';
import { useAuth } from '../../context/AuthContext';
import { useChat } from '../../context/ChatContext';
import { useMeeting } from '../../context/MeetingContext';
import { api, AIThreadAnalysis, AIMemoryItem, AITaskItem, AIReminderItem, AIMeetingSuggestion, AISearchResult } from '../../lib/api';
import { addCalendarEvent } from '../../lib/calendarLocal';
import { parseWhenPhrase } from '../../lib/aiDateParse';
import { parseMeetingCard, type MeetingCardPayload } from '../../lib/aiMeetingCard';
import { CalendarClock, CalendarX2, Palette } from 'lucide-react';
import { loadChatPersonalization, saveChatPersonalization, WALLPAPERS, ACCENTS, FONTS, DEFAULT_PERSONALIZATION, type ChatPersonalization } from '../../lib/chatPersonalization';
import { extractIntelligence, ITEM_ICONS, ITEM_COLORS } from '../../lib/intelligence';
import { REWRITE_MODES } from '../../lib/aiWriting';
import { CAPTION_LANGUAGES } from '../../lib/captions';
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

// ── AI Writing: rewrite/tone menu ────────────────────────────────────────────
// Same click-outside-to-close shape as EmojiPicker above, anchored the same way.
function RewriteMenu({ onPick, onClose, busy }: { onPick: (mode: string) => void; onClose: () => void; busy: boolean }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    setTimeout(() => document.addEventListener('mousedown', handler), 10);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  return (
    <div ref={ref} className="absolute bottom-full mb-2 left-0 z-50 bg-[#1a1a1a] border border-[#424655] rounded-2xl shadow-2xl overflow-hidden w-48 py-1">
      {REWRITE_MODES.map((m) => (
        <button
          key={m.key}
          onMouseDown={(e) => { e.preventDefault(); onPick(m.key); }}
          disabled={busy}
          className="w-full text-left px-3 py-2 text-xs text-[#e5e2e1] hover:bg-[#201f1f] transition-colors disabled:opacity-40"
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}

// ── AI Translation ────────────────────────────────────────────────────────────
// A small, always-visible text link under a message rather than a hover-only
// affordance — hover doesn't exist on touch, and this app has been bitten by
// that exact mistake before (see the New DM/New Group buttons' own history).
// Reuses CAPTION_LANGUAGES (already curated for this app) rather than a
// second language list, and the existing NLLB model via /api/ai/translate —
// not the slow Qwen chat model (see gpu/AI_CONTRACT.md's closing section).
function TranslateMessage({ text, isMe }: { text: string; isMe: boolean }) {
  const [open, setOpen] = useState(false);
  const [translated, setTranslated] = useState<string | null>(null);
  const [isTranslating, setIsTranslating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  // Same outside-click-to-close pattern as EmojiPicker/RewriteMenu above —
  // this dropdown previously had none at all, so it stayed open until a
  // language was picked.
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const timer = setTimeout(() => document.addEventListener('mousedown', handler), 10);
    return () => { clearTimeout(timer); document.removeEventListener('mousedown', handler); };
  }, [open]);

  const handlePick = async (lang: string) => {
    setOpen(false);
    setIsTranslating(true);
    setError(null);
    try {
      const { result } = await api.aiTranslate(text, lang);
      setTranslated(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Translation failed');
    } finally {
      setIsTranslating(false);
    }
  };

  return (
    <div className={`mt-0.5 ${isMe ? 'text-right' : 'text-left'}`}>
      {translated ? (
        <p className={`text-[10px] sm:text-[9px] italic ${isMe ? 'text-[#dbe6ff]' : 'text-[#8c90a1]'}`}>{translated} <button onClick={() => setTranslated(null)} className="underline ml-1">hide</button></p>
      ) : (
        <div ref={ref} className="relative inline-block">
          <button onClick={() => setOpen((v) => !v)} disabled={isTranslating} className={`text-[9px] underline ${isMe ? 'text-[#dbe6ff]/70' : 'text-[#8c90a1]'} disabled:opacity-50`}>
            {isTranslating ? 'Translating…' : 'Translate'}
          </button>
          {open && (
            // bottom-full (opens UPWARD), not top-full — the messages list is
            // a scrollable container (chatScrollRef, overflow-y-auto), and the
            // message you actually want to translate is disproportionately
            // likely to be the LATEST one, sitting right at the bottom edge of
            // that scroll area with no room below it. A top-full dropdown
            // there renders clipped/off-screen — technically in the DOM,
            // invisible in practice, which reads as "clicking Translate does
            // nothing." EmojiPicker and RewriteMenu above already solve this
            // exact problem the same way (bottom-full) since they live in the
            // composer at the very bottom of the screen; this dropdown just
            // hadn't followed that same convention.
            <div className={`absolute z-50 bottom-full mb-1 ${isMe ? 'right-0' : 'left-0'} bg-[#1a1a1a] border border-[#424655] rounded-lg shadow-2xl py-1 w-32 max-h-48 overflow-y-auto`}>
              {CAPTION_LANGUAGES.map((l) => (
                <button key={l.code} onMouseDown={(e) => { e.preventDefault(); handlePick(l.code); }} className="w-full text-left px-2.5 py-1.5 text-[10px] text-[#e5e2e1] hover:bg-[#201f1f] transition-colors">
                  {l.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {error && <p className="text-[9px] text-[#ffb4ab]">{error}</p>}
    </div>
  );
}

// ── AI Calendar Intelligence: in-chat meeting card ───────────────────────────
// Rendered for both participants identically (centered, not left/right —
// this isn't "from" either person). The actual calendar write already
// happened automatically the moment this message was seen (ChatContext's
// new_message handler / loadMessages, both via syncMeetingCardsToCalendar) —
// this is confirmation of what happened, not a prompt asking permission.
function MeetingCardBubble({ card }: { card: MeetingCardPayload }) {
  const cancelled = card.action === 'cancelled';
  const dateLabel = card.date
    ? new Date(`${card.date}T${card.time || '00:00'}`).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : '';
  return (
    <div className="flex justify-center my-1">
      <div className={`flex items-center gap-2.5 rounded-2xl border px-4 py-2.5 max-w-[92%] ${cancelled ? 'bg-[#ffb4ab]/10 border-[#ffb4ab]/30' : 'bg-[#568dff]/10 border-[#568dff]/30'}`}>
        {cancelled ? <CalendarX2 className="w-4 h-4 text-[#ffb4ab] flex-shrink-0" /> : <CalendarClock className="w-4 h-4 text-[#b0c6ff] flex-shrink-0" />}
        <div className="text-xs">
          {cancelled ? (
            <span className="text-[#ffb4ab]">Meeting cancelled: <strong>{card.title}</strong></span>
          ) : (
            <span className="text-[#e5e2e1]">
              <strong>{card.action === 'updated' ? 'Meeting updated' : 'Meeting scheduled'}:</strong> {card.title} — {dateLabel}
              <span className="text-[#8c90a1]"> · added to your calendar automatically</span>
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Per-chat personalization popover ─────────────────────────────────────────
// Same click-outside-to-close shape as RewriteMenu/EmojiPicker above.
function PersonalizeMenu({ value, onChange, onClose }: { value: ChatPersonalization; onChange: (v: ChatPersonalization) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  // onClose kept in a ref rather than an effect dependency: this menu's
  // parent re-renders often for reasons that have nothing to do with this
  // menu (live AI panel updates, chat-ws messages), which recreated the
  // inline `onClose={() => setShowPersonalize(false)}` closure on every one
  // of those renders. With `onClose` in the dependency array, EVERY one of
  // those unrelated re-renders tore down and rebuilt the outside-click
  // listener via a `setTimeout(..., 10)` whose id was never captured —
  // so a listener teardown could easily race its own still-pending
  // re-add, leaving a stray listener attached whose closure had gone stale.
  // Confirmed directly: logging the handler showed it firing with
  // `contains: false` for a click on a swatch that was visibly inside the
  // menu, i.e. exactly this raciness, not a real outside click — which is
  // why selecting a wallpaper appeared to also instantly close the menu.
  // A ref keeps the effect's dependency array empty, so the listener is
  // attached exactly once for the menu's actual lifetime.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const handler = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onCloseRef.current(); };
    const timer = setTimeout(() => document.addEventListener('mousedown', handler), 10);
    return () => { clearTimeout(timer); document.removeEventListener('mousedown', handler); };
  }, []);

  // All three sections below use onMouseDown + preventDefault, not onClick —
  // this menu's own outside-click-to-close listener fires on `mousedown`
  // (same pattern as RewriteMenu/EmojiPicker in this file), and mousedown
  // fires BEFORE click. A plain onClick handler here lost the race: the menu
  // closed and unmounted these buttons before their click ever had a chance
  // to fire, so nothing selected here ever visibly did anything — confirmed
  // directly (state never updated, localStorage never wrote) before finding
  // this was the actual cause, not a styling or persistence bug.
  //
  // Also stopPropagation() here, unlike RewriteMenu/EmojiPicker: this menu
  // is meant to stay open across several picks (wallpaper, then accent, then
  // font), unlike those two which close on their very first selection. That
  // exposed a second, independent race the other two never hit: selecting a
  // wallpaper re-renders this menu's parent (ChatsView re-renders often —
  // live AI panel, chat-ws messages), which — confirmed directly by
  // instrumenting the listener — can even swap in a fresh DOM node for this
  // popover between the click and its own bubble reaching `document`, so
  // `ref.current.contains(e.target)` can come back false for a click that
  // plainly landed inside the menu. stopPropagation keeps the outside-click
  // listener from ever seeing an inside click at all, sidestepping the
  // containment check (and its render-timing hazard) entirely rather than
  // trying to make the check itself race-proof.
  return (
    <div ref={ref} className="absolute top-full right-0 mt-2 z-50 bg-[#1a1a1a] border border-[#424655] rounded-2xl shadow-2xl p-3.5 w-64">
      <div className="mb-3">
        <span className="text-[9px] font-bold uppercase tracking-wider text-[#8c90a1] block mb-2">Wallpaper</span>
        <div className="flex flex-wrap gap-2">
          {WALLPAPERS.map((w) => (
            <button
              key={w.key}
              onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); onChange({ ...value, wallpaper: w.key }); }}
              title={w.label}
              aria-label={`Wallpaper: ${w.label}`}
              className={`w-9 h-9 rounded-lg border-2 flex-shrink-0 ${value.wallpaper === w.key ? 'border-[#e5e2e1]' : 'border-[#424655]/50'}`}
              style={{ background: w.css || '#0e0e0e' }}
            />
          ))}
        </div>
      </div>
      <div className="mb-3">
        <span className="text-[9px] font-bold uppercase tracking-wider text-[#8c90a1] block mb-2">Accent color</span>
        <div className="flex flex-wrap gap-2">
          {ACCENTS.map((a) => (
            <button
              key={a.key}
              onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); onChange({ ...value, accent: a.key }); }}
              title={a.label}
              aria-label={`Accent: ${a.label}`}
              className={`w-7 h-7 rounded-full border-2 flex-shrink-0 ${value.accent === a.key ? 'border-[#e5e2e1]' : 'border-transparent'}`}
              style={{ background: a.hex }}
            />
          ))}
        </div>
      </div>
      <div>
        <span className="text-[9px] font-bold uppercase tracking-wider text-[#8c90a1] block mb-2">Font</span>
        <div className="flex flex-col gap-1">
          {FONTS.map((f) => (
            <button
              key={f.key}
              onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); onChange({ ...value, font: f.key }); }}
              className={`text-left px-2.5 py-1.5 rounded-lg text-xs transition-colors ${value.font === f.key ? 'bg-[#568dff]/15 text-[#b0c6ff]' : 'text-[#e5e2e1] hover:bg-[#201f1f]'}`}
              style={{ fontFamily: f.css }}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

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

type Attachment = NonNullable<RealChatMessage['fileAttachment']>;

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i;

// `type` comes straight off the browser's File object and is empty for a few sources
// (some Android pickers, drag-and-drop from certain apps), so fall back to sniffing the
// data URL and then the extension rather than dropping to a file card for a real image.
function isImageAttachment(f: Attachment): boolean {
  if (!f.dataUrl) return false;
  return f.type?.startsWith('image/') || f.dataUrl.startsWith('data:image/') || IMAGE_EXT_RE.test(f.name ?? '');
}

// Voice messages are just another file attachment (audio/webm from
// MediaRecorder) — same 5MB cap, same storage, same send path as any other
// file. This is the only extra check needed to render one as a player
// instead of a generic download card.
function isAudioAttachment(f: Attachment): boolean {
  if (!f.dataUrl) return false;
  return f.type?.startsWith('audio/') || f.dataUrl.startsWith('data:audio/');
}

// AI Documents: a document attachment is just a normal file attachment too —
// same 5MB cap, same send path — this is the only check needed to also offer
// the summarize/ask-questions panel on it (server/ai_documents.go does the
// actual extraction, dispatched by this same set of extensions).
const DOC_EXT_RE = /\.(pdf|docx?|xlsx?|pptx?|txt|md)$/i;
function isDocumentAttachment(f: Attachment): boolean {
  return DOC_EXT_RE.test(f.name ?? '');
}

// `fetch` handles data: URLs, so this is the shortest route from the stored attachment
// back to a real File for the Web Share API / clipboard.
async function attachmentToFile(file: Attachment): Promise<File> {
  const blob = await (await fetch(file.dataUrl!)).blob();
  return new File([blob], file.name, { type: file.type || blob.type });
}

// Custom voice-message player: real decoded waveform (not a fake/random one —
// the actual audio's own peak amplitudes, downsampled into bars), a played/
// unplayed two-tone fill that tracks real playback position, click-to-seek,
// and a play/pause button matching the app's own visual language instead of
// the browser's native <audio controls> widget.
const VOICE_BARS = 40;
function VoicePlayer({ src, isMe }: { src: string; isMe: boolean }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [bars, setBars] = useState<number[] | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);

  // Decode once, on mount — this is a one-off analysis of a short voice clip
  // (5MB cap upstream), not a streaming operation, so a single
  // decodeAudioData call is the right tool rather than anything incremental.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const AudioContextCtor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!AudioContextCtor) return;
        const res = await fetch(src);
        const arrayBuffer = await res.arrayBuffer();
        const audioCtx = new AudioContextCtor();
        const decoded = await audioCtx.decodeAudioData(arrayBuffer);
        if (cancelled) return;
        const channel = decoded.getChannelData(0);
        const bucketSize = Math.max(1, Math.floor(channel.length / VOICE_BARS));
        const peaks: number[] = [];
        for (let i = 0; i < VOICE_BARS; i++) {
          const start = i * bucketSize;
          let peak = 0;
          for (let j = start; j < start + bucketSize && j < channel.length; j++) {
            peak = Math.max(peak, Math.abs(channel[j]));
          }
          peaks.push(peak);
        }
        // Normalize so the loudest moment in THIS clip reaches full height —
        // a quiet recording shouldn't render as a flat line just because it
        // never got close to 0dB.
        const max = Math.max(...peaks, 0.01);
        setBars(peaks.map((p) => Math.max(0.06, p / max)));
        audioCtx.close().catch(() => {});
      } catch {
        // Decoding can fail on a genuinely corrupt clip or an unsupported
        // codec in this browser — the player still works via the real
        // <audio> element below, just without a waveform (a flat fallback
        // bar row is drawn instead, see the render below).
      }
    })();
    return () => { cancelled = true; };
  }, [src]);

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    const onTime = () => setCurrentTime(el.currentTime);
    const onLoaded = () => setDuration(el.duration);
    const onEnd = () => { setIsPlaying(false); setCurrentTime(0); };
    el.addEventListener('timeupdate', onTime);
    el.addEventListener('loadedmetadata', onLoaded);
    el.addEventListener('ended', onEnd);
    return () => {
      el.removeEventListener('timeupdate', onTime);
      el.removeEventListener('loadedmetadata', onLoaded);
      el.removeEventListener('ended', onEnd);
    };
  }, []);

  const togglePlay = () => {
    const el = audioRef.current;
    if (!el) return;
    if (isPlaying) { el.pause(); setIsPlaying(false); }
    else { playWhenAllowedLocal(el); setIsPlaying(true); }
  };

  const seekTo = (ratio: number) => {
    const el = audioRef.current;
    if (!el || !duration) return;
    el.currentTime = ratio * duration;
    setCurrentTime(el.currentTime);
  };

  const displaySeconds = isPlaying || currentTime > 0 ? currentTime : duration;
  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  const progress = duration > 0 ? currentTime / duration : 0;
  const shownBars = bars ?? new Array(VOICE_BARS).fill(0.3); // flat fallback if decoding failed/hasn't finished yet

  return (
    <div className={`flex items-center gap-2.5 p-2.5 rounded-2xl border ${isMe ? 'bg-[#568dff]/10 border-[#568dff]/30 rounded-tr-sm' : 'bg-[#201f1f] border-[#424655]/40 rounded-tl-sm'}`} style={{ minWidth: '220px', maxWidth: '260px' }}>
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <audio ref={audioRef} src={src} preload="metadata" style={{ display: 'none' }} />
      <button onClick={togglePlay} aria-label={isPlaying ? 'Pause voice message' : 'Play voice message'} className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 transition-colors ${isMe ? 'bg-[#568dff] text-[#002661]' : 'bg-[#568dff]/20 text-[#b0c6ff]'}`}>
        {isPlaying ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5 ml-0.5" />}
      </button>
      <div className="flex-1 min-w-0">
        <div
          className="flex items-center gap-[2px] h-6 cursor-pointer"
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            seekTo(Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)));
          }}
        >
          {shownBars.map((h, i) => (
            <span
              key={i}
              className={`flex-1 min-w-[2px] rounded-full transition-colors ${i / VOICE_BARS < progress ? (isMe ? 'bg-[#dbe6ff]' : 'bg-[#b0c6ff]') : (isMe ? 'bg-[#568dff]/30' : 'bg-[#8c90a1]/40')}`}
              style={{ height: `${Math.max(12, h * 100)}%` }}
            />
          ))}
        </div>
        <span className={`text-[9px] tabular-nums ${isMe ? 'text-[#dbe6ff]/80' : 'text-[#8c90a1]'}`}>{fmt(displaySeconds || 0)}</span>
      </div>
    </div>
  );
}

// Same rejected-autoplay recovery as playWhenAllowed elsewhere in this app,
// kept local and minimal here since a voice message is user-initiated
// playback (a real click already happened), not an autoplaying remote
// stream — the retry-on-next-gesture path essentially never triggers, but
// costs nothing to have as a safety net.
function playWhenAllowedLocal(el: HTMLMediaElement) {
  el.play().catch(() => {});
}

const TEXT_EXT_RE = /\.(txt|md|markdown|csv|tsv|log|json|xml|ya?ml|ini|conf|env|sql|css|html?|js|jsx|ts|tsx|py|go|rb|java|c|h|cpp|sh)$/i;

type PreviewKind = 'image' | 'pdf' | 'text' | 'none';

// What we can show inline. Anything unrecognised (docx/xlsx/pptx/zip/…) still gets the
// box — with the same Share/Download controls — just with a "no preview" body, which
// beats a click that appears to do nothing.
function previewKind(f: Attachment): PreviewKind {
  if (!f.dataUrl) return 'none';
  if (isImageAttachment(f)) return 'image';
  const type = f.type ?? '';
  const name = f.name ?? '';
  if (type === 'application/pdf' || /\.pdf$/i.test(name) || f.dataUrl.startsWith('data:application/pdf')) return 'pdf';
  // NOTE: html/svg-as-document land here on purpose and are shown as *escaped text*, never
  // rendered. Attachments come from other users, and a blob: URL inherits this origin — so
  // iframing their markup would run their script against our session. Only PDFs, which the
  // browser hands to its own sandboxed viewer, get an iframe.
  if (type.startsWith('text/') || type === 'application/json' || TEXT_EXT_RE.test(name)) return 'text';
  return 'none';
}

// Not every browser has a built-in PDF viewer (some mobile browsers, locked-down
// enterprise builds, and headless Chromium all report false). Without this check the
// iframe renders as a silent blank rectangle, which reads as a broken feature — so ask
// first and fall back to the download prompt instead.
function browserRendersPdf(): boolean {
  if (typeof navigator === 'undefined') return false;
  if (typeof navigator.pdfViewerEnabled === 'boolean') return navigator.pdfViewerEnabled;
  return !!navigator.mimeTypes?.['application/pdf']; // older browsers
}

// PDFs need a blob: URL — Chrome refuses to load a data: URL into an iframe.
function PdfPreviewBody({ file }: { file: Attachment }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const supported = browserRendersPdf();

  useEffect(() => {
    if (!supported) return;
    let revoked = false;
    let objectUrl: string | null = null;
    fetch(file.dataUrl!)
      .then(r => r.blob())
      .then(b => {
        if (revoked) return;
        objectUrl = URL.createObjectURL(b.type ? b : new Blob([b], { type: 'application/pdf' }));
        setUrl(objectUrl);
      })
      .catch(() => setFailed(true));
    return () => {
      revoked = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [file.dataUrl, supported]);

  if (!supported) return <PreviewUnavailableBody reason="This browser can't display PDFs inline — download it to open." />;
  if (failed) return <PreviewUnavailableBody reason="This PDF could not be opened." />;
  if (!url) return <div className="h-[70vh] flex items-center justify-center text-[10px] text-[#8c90a1]">Loading preview…</div>;
  return <iframe src={url} title={`Preview of ${file.name}`} className="w-full h-[70vh] bg-[#0e0e0e]" />;
}

function TextPreviewBody({ file }: { file: Attachment }) {
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(file.dataUrl!)
      .then(r => r.text())
      // Cap it: these are data URLs held in memory and a multi-MB log would jank the modal.
      .then(t => { if (!cancelled) setText(t.length > 200_000 ? t.slice(0, 200_000) + '\n\n… truncated — download to see the rest.' : t); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [file.dataUrl]);

  if (failed) return <PreviewUnavailableBody reason="This file could not be read." />;
  if (text === null) return <div className="h-40 flex items-center justify-center text-[10px] text-[#8c90a1]">Loading preview…</div>;
  return (
    <pre className="max-h-[60vh] overflow-auto p-3 text-[11px] leading-relaxed text-[#e5e2e1] whitespace-pre-wrap break-words font-mono">
      {text}
    </pre>
  );
}

function PreviewUnavailableBody({ reason }: { reason: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-10 px-4 text-center">
      <div className="w-10 h-10 rounded-xl bg-[#8083ff]/20 flex items-center justify-center"><FileText className="w-5 h-5 text-[#c0c1ff]" /></div>
      <p className="text-xs text-[#8c90a1]">{reason}</p>
    </div>
  );
}

// In-place preview for an attachment: a modal box over the chat rather than a new tab,
// with the download and share controls living on the box itself.
function AttachmentPreviewModal({ file, onClose }: { file: Attachment; onClose: () => void }) {
  const [shareLabel, setShareLabel] = useState<string | null>(null);
  const kind = previewKind(file);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  const handleShare = async () => {
    try {
      const f = await attachmentToFile(file);
      // Real share sheet where the browser has one (mobile Safari/Chrome, Edge).
      if (navigator.canShare?.({ files: [f] })) {
        await navigator.share({ files: [f], title: file.name });
        return;
      }
      // Desktop browsers mostly can't share files, so put the image on the clipboard
      // instead — Chrome only accepts image/png here, hence the try/catch below. For
      // non-images this reliably throws and we fall through to the Download hint.
      if (kind === 'image' && navigator.clipboard && 'ClipboardItem' in window) {
        const blob = await (await fetch(file.dataUrl!)).blob();
        await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
        setShareLabel('Copied');
        setTimeout(() => setShareLabel(null), 2000);
        return;
      }
      setShareLabel('Use Download');
      setTimeout(() => setShareLabel(null), 2000);
    } catch (e) {
      // Dismissing the share sheet rejects with AbortError — not a failure.
      if ((e as Error)?.name === 'AbortError') return;
      setShareLabel('Use Download');
      setTimeout(() => setShareLabel(null), 2000);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4"
      onClick={onClose} role="dialog" aria-modal="true" aria-label={`Preview of ${file.name}`}
    >
      <div
        className={`bg-[#131313] border border-[#424655] rounded-2xl shadow-2xl w-full overflow-hidden flex flex-col ${
          kind === 'pdf' ? 'max-w-3xl' : kind === 'text' ? 'max-w-2xl' : 'max-w-lg'
        }`}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 p-3 border-b border-[#424655]">
          <div className="min-w-0">
            <p className="text-xs font-semibold text-[#e5e2e1] truncate">{file.name}</p>
            <p className="text-[10px] text-[#8c90a1]">{(file.size / 1024).toFixed(1)} KB</p>
          </div>
          <button onClick={onClose} aria-label="Close preview" className="w-7 h-7 flex items-center justify-center rounded-lg text-[#8c90a1] hover:bg-[#201f1f] hover:text-[#e5e2e1] transition-colors flex-shrink-0">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="bg-[#0e0e0e] flex flex-col justify-center min-h-0">
          {kind === 'image' && (
            <div className="flex items-center justify-center p-2">
              <img src={file.dataUrl} alt={file.name} className="max-w-full max-h-[60vh] object-contain" />
            </div>
          )}
          {kind === 'pdf' && <PdfPreviewBody file={file} />}
          {kind === 'text' && <TextPreviewBody file={file} />}
          {kind === 'none' && <PreviewUnavailableBody reason="No inline preview for this file type — download it to open." />}
        </div>

        <div className="flex items-center justify-end gap-2 p-3 border-t border-[#424655]">
          <button
            onClick={handleShare} aria-label={`Share ${file.name}`}
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-bold bg-[#201f1f] text-[#e5e2e1] hover:bg-[#2a2929] transition-colors"
          >
            <Share2 className="w-3.5 h-3.5" /> {shareLabel ?? 'Share'}
          </button>
          <a
            href={file.dataUrl} download={file.name} aria-label={`Download ${file.name}`}
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-bold bg-[#568dff] text-[#002661] hover:bg-[#568dff]/90 transition-colors"
          >
            <Download className="w-3.5 h-3.5" /> Download
          </a>
        </div>
      </div>
    </div>
  );
}

// Images render as images; everything else keeps the file card. A truncated or otherwise
// undecodable data URL falls back to the card via onError, so a broken image is still
// downloadable rather than an empty box.
// AI Documents: summarize + ask-questions panel under a document attachment.
// Deliberately button-triggered, not automatic on mount — matches this app's
// existing "Summarize this conversation" pattern (IntelligenceSidebar) for
// the same reason: this model measures 15-30s+ per call (gpu/AI_CONTRACT.md),
// and auto-firing that on every page load/reload for every document in a
// thread's history would be both slow and wasteful. One tap gets the summary
// once; the extracted text is cached server-side (server/ai_documents.go),
// so follow-up questions after that first tap are a single call each, not a
// re-extraction.
function DocumentQA({ messageId, fileName }: { messageId: string; fileName: string }) {
  const [summary, setSummary] = useState<string | null>(null);
  const [isSummarizing, setIsSummarizing] = useState(false);
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<string | null>(null);
  const [isAsking, setIsAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSummarize = async () => {
    if (isSummarizing) return;
    setIsSummarizing(true);
    setError(null);
    try {
      const { summary: s } = await api.aiExtractDocument(messageId);
      setSummary(s || 'No summary was returned, but the document was read — you can still ask questions about it below.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read this document');
    } finally {
      setIsSummarizing(false);
    }
  };

  const handleAsk = async () => {
    if (!question.trim() || isAsking) return;
    setIsAsking(true);
    setError(null);
    setAnswer(null);
    try {
      const { result } = await api.aiAskDocument(messageId, question.trim());
      setAnswer(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not answer that question');
    } finally {
      setIsAsking(false);
    }
  };

  return (
    <div className="mt-1.5 pt-1.5 border-t border-[#424655]/30">
      {summary ? (
        <>
          <p className="text-[10px] text-[#e5e2e1] leading-relaxed mb-1.5">{summary}</p>
          <div className="flex items-center gap-1.5">
            <input
              type="text"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAsk(); } }}
              placeholder={`Ask about ${fileName}…`}
              className="flex-1 min-w-0 bg-[#0e0e0e] border border-[#424655]/60 rounded-lg px-2 py-1 text-[10px] text-[#e5e2e1] placeholder-[#8c90a1]/60 focus:border-[#568dff] outline-none"
            />
            <button onClick={handleAsk} disabled={!question.trim() || isAsking} className="text-[9px] font-bold text-[#c0c1ff] hover:text-[#e5e2e1] disabled:opacity-40 whitespace-nowrap flex-shrink-0">
              {isAsking ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Ask'}
            </button>
          </div>
          {answer && <p className="text-[10px] text-[#8c90a1] leading-relaxed mt-1.5 italic">{answer}</p>}
        </>
      ) : (
        <button onClick={handleSummarize} disabled={isSummarizing} className="flex items-center gap-1.5 text-[10px] text-[#b0c6ff] hover:text-[#c0c1ff] disabled:opacity-50">
          {isSummarizing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
          {isSummarizing ? 'Reading document… this can take a minute or two' : 'Summarize & ask questions'}
        </button>
      )}
      {error && <p className="text-[9px] text-[#ffb4ab] mt-1">{error}</p>}
    </div>
  );
}

function MessageAttachment({ file, isMe, onPreview, messageId }: { file: Attachment; isMe: boolean; onPreview: (f: Attachment) => void; messageId: string }) {
  const [imageFailed, setImageFailed] = useState(false);

  if (isImageAttachment(file) && !imageFailed) {
    return (
      <button
        type="button"
        onClick={e => { e.stopPropagation(); onPreview(file); }}
        title={`Preview ${file.name}`} aria-label={`Preview image ${file.name}`}
        className={`block overflow-hidden rounded-2xl border cursor-zoom-in ${isMe ? 'border-[#568dff]/30 rounded-tr-sm' : 'border-[#424655]/40 rounded-tl-sm'}`}
      >
        <img
          src={file.dataUrl} alt={file.name} loading="lazy"
          onError={() => setImageFailed(true)}
          className="block w-auto max-w-full max-h-[320px] object-contain bg-[#0e0e0e]"
        />
      </button>
    );
  }

  // Voice messages: a custom WhatsApp-style bubble (play button + real
  // waveform + duration), not the browser's native <audio controls> — tried
  // first and looked exactly like what it was, a raw OS media widget dropped
  // into a chat bubble, nothing about it matching the rest of the app. Still
  // just a file attachment underneath (same 5MB cap, same send path).
  if (isAudioAttachment(file)) {
    return <VoicePlayer src={file.dataUrl!} isMe={isMe} />;
  }

  // The card body opens the preview; the download button stays where it has always been so
  // "just save it" is still one click and doesn't route through the modal.
  return (
    <div className={`p-3 rounded-2xl border ${isMe ? 'bg-[#568dff]/10 border-[#568dff]/30 rounded-tr-sm' : 'bg-[#201f1f] border-[#424655]/40 rounded-tl-sm'}`}>
      <div className="flex items-center gap-2.5">
        <button
          type="button"
          onClick={e => { e.stopPropagation(); onPreview(file); }}
          disabled={!file.dataUrl}
          title={`Preview ${file.name}`} aria-label={`Preview file ${file.name}`}
          className="flex items-center gap-2.5 flex-1 min-w-0 text-left cursor-pointer disabled:cursor-default"
        >
          <div className="w-9 h-9 rounded-lg bg-[#8083ff]/20 flex items-center justify-center flex-shrink-0"><FileText className="w-4 h-4 text-[#c0c1ff]" /></div>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-semibold text-[#e5e2e1] truncate">{file.name}</p>
            <p className="text-[10px] text-[#8c90a1]">{(file.size / 1024).toFixed(1)} KB</p>
          </div>
        </button>
        {file.dataUrl && (
          <a href={file.dataUrl} download={file.name} onClick={e => e.stopPropagation()} aria-label={`Download ${file.name}`} className="w-7 h-7 flex items-center justify-center rounded-lg bg-[#568dff]/10 text-[#b0c6ff] hover:bg-[#568dff]/20 transition-colors flex-shrink-0"><Download className="w-3.5 h-3.5" /></a>
        )}
      </div>
      {isDocumentAttachment(file) && <DocumentQA messageId={messageId} fileName={file.name} />}
    </div>
  );
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
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4" onClick={onClose}>
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
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4" onClick={onClose}>
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

function IntelligenceSidebar({ intelligence, messages, activeThread, currentUser, getUserById, setViewingUser, handleQuickJoin, isJoining, meetingError, onClose }: {
  intelligence: ExtractedItem[];
  messages: RealChatMessage[];
  activeThread: RealChatThread | null;
  currentUser: IBUser | null;
  getUserById: (id: string) => IBUser | undefined;
  setViewingUser: (u: IBUser) => void;
  handleQuickJoin: () => void;
  isJoining: boolean;
  meetingError: string | null;
  onClose: () => void;
}) {
  // ── AI Conversation Understanding (summary/decisions/questions/action items) ──
  const [analysis, setAnalysis] = useState<AIThreadAnalysis | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);

  // ── AI Memory, scoped to this chat ───────────────────────────────────────
  const [threadMemory, setThreadMemory] = useState<AIMemoryItem[] | null>(null);

  // ── AI Task Extraction — global, not thread-scoped ("what do I owe people") ──
  const [tasks, setTasks] = useState<{ owedByMe: AITaskItem[]; owedToMe: AITaskItem[] } | null>(null);

  // ── AI Reminders — personal, global like tasks ───────────────────────────
  const [reminders, setReminders] = useState<AIReminderItem[] | null>(null);

  // ── AI Calendar Intelligence — which suggestions from THIS analysis have
  // already been added, so the button can't double-add on a second click ──
  const [addedToCalendar, setAddedToCalendar] = useState<Set<number>>(() => new Set());

  // ── Ask AIPA — free-text Q&A over this one thread's recent messages.
  // Deliberately separate from "Summarize this conversation" (a fixed
  // 7-field report) and from the global "Search all messages" bar (literal
  // text matching across every thread) — this is a single conversational
  // question, answered from just this thread, as prose rather than a
  // structured report.
  const [askQuestion, setAskQuestion] = useState('');
  const [askAnswer, setAskAnswer] = useState<string | null>(null);
  const [isAsking, setIsAsking] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);

  const loadMemory = useCallback((threadId: string) => {
    api.getAIMemory(threadId).then((r) => setThreadMemory(r.memory)).catch(() => setThreadMemory([]));
  }, []);

  useEffect(() => {
    // A fresh thread means a fresh analysis — carrying a previous chat's
    // summary/decisions forward would be actively misleading, not just stale.
    setAnalysis(null);
    setAnalyzeError(null);
    setThreadMemory(null);
    setAddedToCalendar(new Set());
    setAskQuestion('');
    setAskAnswer(null);
    setAskError(null);
    if (activeThread) loadMemory(activeThread.id);
  }, [activeThread?.id, loadMemory]);

  useEffect(() => {
    api.getAITasks().then(setTasks).catch(() => setTasks({ owedByMe: [], owedToMe: [] }));
    api.getAIReminders().then((r) => setReminders(r.reminders)).catch(() => setReminders([]));
  }, []);

  const handleAnalyze = async () => {
    if (!activeThread || isAnalyzing) return;
    setIsAnalyzing(true);
    setAnalyzeError(null);
    try {
      const result = await api.aiAnalyzeThread(activeThread.id);
      setAnalysis(result);
      setAddedToCalendar(new Set());
      loadMemory(activeThread.id); // decisions from this analysis just got saved as memory
      api.getAITasks().then(setTasks).catch(() => {}); // action items just got saved as tasks
      api.getAIReminders().then((r) => setReminders(r.reminders)).catch(() => {}); // ditto for reminders
    } catch (err) {
      setAnalyzeError(err instanceof Error ? err.message : 'Could not analyze this conversation');
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleAsk = async () => {
    const q = askQuestion.trim();
    if (!activeThread || !q || isAsking) return;
    setIsAsking(true);
    setAskError(null);
    setAskAnswer(null);
    try {
      const { result } = await api.aiAskThread(activeThread.id, q);
      setAskAnswer(result);
    } catch (err) {
      setAskError(err instanceof Error ? err.message : 'Could not get an answer');
    } finally {
      setIsAsking(false);
    }
  };

  const handleAskKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') { e.preventDefault(); handleAsk(); }
  };

  const handleDeleteMemory = (id: string) => {
    setThreadMemory((prev) => (prev ? prev.filter((m) => m.id !== id) : prev));
    api.deleteAIMemory(id).catch(() => { if (activeThread) loadMemory(activeThread.id); });
  };

  const handleCompleteTask = (id: string) => {
    setTasks((prev) => prev ? {
      owedByMe: prev.owedByMe.filter((t) => t.id !== id),
      owedToMe: prev.owedToMe.filter((t) => t.id !== id),
    } : prev);
    api.completeAITask(id).catch(() => api.getAITasks().then(setTasks).catch(() => {}));
  };

  const handleCompleteReminder = (id: string) => {
    setReminders((prev) => (prev ? prev.filter((r) => r.id !== id) : prev));
    api.completeAIReminder(id).catch(() => api.getAIReminders().then((r) => setReminders(r.reminders)).catch(() => {}));
  };

  // Best-effort date parsing (see aiDateParse.ts) — the raw phrase always
  // rides along in the saved event's description precisely because the
  // parsed date/time is a guess, not a confirmed fact from the model.
  const handleAddToCalendar = (m: AIMeetingSuggestion, idx: number) => {
    if (!currentUser) return;
    const { date, startTime } = parseWhenPhrase(m.when);
    addCalendarEvent(currentUser.id, {
      id: `ai-${Date.now()}-${idx}`,
      title: m.title,
      date,
      startTime,
      description: `Suggested by AI from this conversation — mentioned as "${m.when}". Double-check the date/time.`,
      color: '#b0c6ff',
      creatorId: currentUser.id,
    });
    setAddedToCalendar((prev) => new Set(prev).add(idx));
  };

  return (
    <aside className="hidden xl:flex w-72 flex-shrink-0 flex-col border-l border-[#424655] bg-[#131313] overflow-y-auto select-none">
      <div className="p-4 border-b border-[#424655] sticky top-0 bg-[#131313]/95 backdrop-blur-md z-10 flex items-center gap-2">
        <Sparkles className="w-4 h-4 text-[#c0c1ff]" />
        <h3 className="font-bold text-sm text-[#e5e2e1] flex-1">Intelligence Agent</h3>
        <button onClick={onClose} title="Collapse panel" className="w-6 h-6 flex items-center justify-center rounded-lg text-[#8c90a1] hover:bg-[#201f1f] hover:text-[#e5e2e1] transition-colors cursor-pointer">
          <ChevronsRight className="w-3.5 h-3.5" />
        </button>
      </div>
      <div className="p-4 flex flex-col gap-5">
        {activeThread && (
          <div>
            <div className="relative">
              <Sparkles className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-[#c0c1ff] pointer-events-none" />
              <input
                type="text"
                value={askQuestion}
                onChange={(e) => setAskQuestion(e.target.value)}
                onKeyDown={handleAskKeyDown}
                placeholder="Ask AIPA…"
                aria-label="Ask AIPA a question about this conversation"
                disabled={isAsking}
                className="w-full bg-[#0e0e0e] border border-[#424655] rounded-xl pl-9 pr-9 py-2.5 text-xs text-[#e5e2e1] placeholder-[#8c90a1] focus:border-[#c0c1ff]/60 outline-none disabled:opacity-60"
              />
              <button
                onClick={handleAsk}
                disabled={isAsking || !askQuestion.trim()}
                title="Ask"
                aria-label="Ask AIPA"
                className="absolute right-1.5 top-1/2 -translate-y-1/2 w-6 h-6 flex items-center justify-center rounded-lg text-[#8c90a1] hover:text-[#c0c1ff] hover:bg-[#201f1f] disabled:opacity-30 transition-colors"
              >
                {isAsking ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3 h-3" />}
              </button>
            </div>
            {isAsking && <p className="text-[10px] text-[#8c90a1] mt-2">AIPA is thinking… usually under a minute</p>}
            {askError && <p className="text-[10px] text-[#ffb4ab] mt-2">{askError}</p>}
            {askAnswer && !isAsking && (
              <div className="mt-2 bg-[#0e0e0e] border border-[#c0c1ff]/20 rounded-xl p-3 flex flex-col gap-2">
                <p className="text-[10px] text-[#e5e2e1] leading-relaxed whitespace-pre-wrap">{askAnswer}</p>
                <button onClick={() => { setAskAnswer(null); setAskQuestion(''); }} className="self-start text-[9px] font-bold uppercase tracking-wider text-[#8c90a1] hover:text-[#e5e2e1] transition-colors">Clear</button>
              </div>
            )}
          </div>
        )}
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
        {(tasks && (tasks.owedByMe.length > 0 || tasks.owedToMe.length > 0)) && (
          <div>
            <div className="flex items-center gap-1.5 mb-3">
              <ListChecks className="w-3.5 h-3.5 text-[#c0c1ff]" />
              <h4 className="text-[9px] font-bold tracking-widest text-[#8c90a1] uppercase">My Tasks</h4>
            </div>
            <div className="flex flex-col gap-2">
              {tasks.owedByMe.map((t) => (
                <div key={t.id} className="flex items-start gap-2 bg-[#0e0e0e] border border-[#424655]/40 rounded-xl p-2.5 text-[10px] leading-relaxed">
                  <button onClick={() => handleCompleteTask(t.id)} title="Mark done" className="mt-0.5 w-4 h-4 rounded border border-[#424655] hover:border-[#4dffb1] hover:bg-[#4dffb1]/10 flex-shrink-0 transition-colors" />
                  <div className="flex-1 min-w-0"><span className="text-[8px] font-bold uppercase tracking-wider text-[#8c90a1] block mb-0.5">You owe</span><span className="text-[#e5e2e1]">{t.description}</span></div>
                </div>
              ))}
              {tasks.owedToMe.map((t) => (
                <div key={t.id} className="flex items-start gap-2 bg-[#0e0e0e] border border-[#424655]/40 rounded-xl p-2.5 text-[10px] leading-relaxed">
                  <button onClick={() => handleCompleteTask(t.id)} title="Mark done" className="mt-0.5 w-4 h-4 rounded border border-[#424655] hover:border-[#4dffb1] hover:bg-[#4dffb1]/10 flex-shrink-0 transition-colors" />
                  <div className="flex-1 min-w-0"><span className="text-[8px] font-bold uppercase tracking-wider text-[#8c90a1] block mb-0.5">Owed to you</span><span className="text-[#e5e2e1]">{t.description}</span></div>
                </div>
              ))}
            </div>
          </div>
        )}
        {reminders && reminders.length > 0 && (
          <div>
            <h4 className="text-[9px] font-bold tracking-widest text-[#8c90a1] uppercase mb-3">Reminders</h4>
            <div className="flex flex-col gap-2">
              {reminders.map((r) => (
                <div key={r.id} className="flex items-start gap-2 bg-[#0e0e0e] border border-[#424655]/40 rounded-xl p-2.5 text-[10px] leading-relaxed">
                  <button onClick={() => handleCompleteReminder(r.id)} title="Mark done" className="mt-0.5 w-4 h-4 rounded border border-[#424655] hover:border-[#4dffb1] hover:bg-[#4dffb1]/10 flex-shrink-0 transition-colors" />
                  <span className="flex-1 text-[#e5e2e1]">{r.text}</span>
                </div>
              ))}
            </div>
          </div>
        )}
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
            <div className="flex items-center gap-1.5 mb-3">
              <Brain className="w-3.5 h-3.5 text-[#c0c1ff]" />
              <h4 className="text-[9px] font-bold tracking-widest text-[#8c90a1] uppercase">Conversation Summary</h4>
            </div>
            {analysis ? (
              <div className="flex flex-col gap-3">
                <p className="text-[10px] text-[#e5e2e1] leading-relaxed bg-[#0e0e0e] border border-[#424655]/40 rounded-xl p-3">{analysis.summary}</p>
                {analysis.keyPoints.length > 0 && (
                  <div>
                    <span className="text-[8px] font-bold uppercase tracking-wider text-[#8c90a1] block mb-1.5">Key points</span>
                    <ul className="flex flex-col gap-1">{analysis.keyPoints.map((p, i) => <li key={i} className="text-[10px] text-[#e5e2e1] leading-relaxed pl-3 relative before:content-['•'] before:absolute before:left-0 before:text-[#8c90a1]">{p}</li>)}</ul>
                  </div>
                )}
                {analysis.decisions.length > 0 && (
                  <div>
                    <span className="text-[8px] font-bold uppercase tracking-wider text-[#8c90a1] block mb-1.5">Decisions</span>
                    <ul className="flex flex-col gap-1">{analysis.decisions.map((d, i) => <li key={i} className="text-[10px] text-[#4dffb1] leading-relaxed pl-3 relative before:content-['✓'] before:absolute before:left-0">{d}</li>)}</ul>
                  </div>
                )}
                {analysis.questions.length > 0 && (
                  <div>
                    <span className="text-[8px] font-bold uppercase tracking-wider text-[#8c90a1] block mb-1.5">Open questions</span>
                    <ul className="flex flex-col gap-1">{analysis.questions.map((q, i) => <li key={i} className="text-[10px] text-[#fdd663] leading-relaxed pl-3 relative before:content-['?'] before:absolute before:left-0">{q}</li>)}</ul>
                  </div>
                )}
                {analysis.actionItems.length > 0 && (
                  <div>
                    <span className="text-[8px] font-bold uppercase tracking-wider text-[#8c90a1] block mb-1.5">Action items</span>
                    <ul className="flex flex-col gap-1">{analysis.actionItems.map((a, i) => (
                      <li key={i} className="text-[10px] text-[#e5e2e1] leading-relaxed pl-3 relative before:content-['→'] before:absolute before:left-0">
                        {a.description}{a.assignee && a.assignee.toLowerCase() !== 'unclear' && <span className="text-[#8c90a1]"> — {a.assignee}</span>}{a.due && <span className="text-[#8c90a1]"> ({a.due})</span>}
                      </li>
                    ))}</ul>
                  </div>
                )}
                {analysis.reminders.length > 0 && (
                  <div>
                    <span className="text-[8px] font-bold uppercase tracking-wider text-[#8c90a1] block mb-1.5">Reminders for you</span>
                    <ul className="flex flex-col gap-1">{analysis.reminders.map((rm, i) => (
                      <li key={i} className="text-[10px] text-[#e5e2e1] leading-relaxed pl-3 relative before:content-['⏰'] before:absolute before:left-[-2px]">
                        {rm.text}{rm.when && <span className="text-[#8c90a1]"> ({rm.when})</span>}
                      </li>
                    ))}</ul>
                  </div>
                )}
                {analysis.meetingSuggestions.length > 0 && (
                  <div>
                    <span className="text-[8px] font-bold uppercase tracking-wider text-[#8c90a1] block mb-1.5">Meeting suggestions</span>
                    <div className="flex flex-col gap-1.5">{analysis.meetingSuggestions.map((m, i) => (
                      <div key={i} className="flex items-center justify-between gap-2 bg-[#0e0e0e] border border-[#424655]/40 rounded-lg p-2">
                        <span className="text-[10px] text-[#e5e2e1] flex-1 min-w-0 truncate">{m.title}{m.when && <span className="text-[#8c90a1]"> — {m.when}</span>}</span>
                        <button
                          onClick={() => handleAddToCalendar(m, i)}
                          disabled={addedToCalendar.has(i)}
                          className="text-[9px] font-bold text-[#c0c1ff] hover:text-[#e5e2e1] disabled:text-[#4dffb1] disabled:cursor-default whitespace-nowrap flex-shrink-0"
                        >
                          {addedToCalendar.has(i) ? 'Added ✓' : 'Add to calendar'}
                        </button>
                      </div>
                    ))}</div>
                  </div>
                )}
                <button onClick={handleAnalyze} disabled={isAnalyzing} className="text-[10px] text-[#8c90a1] hover:text-[#c0c1ff] transition-colors disabled:opacity-50 self-start flex items-center gap-1">
                  {isAnalyzing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
                  {isAnalyzing ? 'Re-analyzing…' : 'Re-analyze'}
                </button>
              </div>
            ) : (
              <button
                onClick={handleAnalyze}
                disabled={isAnalyzing || messages.length === 0}
                className="w-full flex items-center justify-center gap-1.5 bg-[#0e0e0e] border border-[#424655]/40 hover:border-[#c0c1ff]/40 rounded-xl p-3 text-[10px] text-[#c0c1ff] transition-colors disabled:opacity-40"
              >
                {isAnalyzing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                {isAnalyzing ? 'Analyzing… this can take a couple of minutes' : 'Summarize this conversation'}
              </button>
            )}
            {analyzeError && <p className="text-[10px] text-[#ffb4ab] mt-2">{analyzeError}</p>}
          </div>
        )}
        {activeThread && threadMemory && threadMemory.length > 0 && (
          <div>
            <h4 className="text-[9px] font-bold tracking-widest text-[#8c90a1] uppercase mb-3">Remembered about this chat</h4>
            <div className="flex flex-col gap-1.5">
              {threadMemory.map((m) => (
                <div key={m.id} className="flex items-start gap-2 bg-[#0e0e0e] border border-[#424655]/40 rounded-lg p-2 text-[10px] leading-relaxed group">
                  <span className="flex-1 text-[#e5e2e1]">{m.fact}</span>
                  <button onClick={() => handleDeleteMemory(m.id)} title="Forget this" className="text-[#8c90a1] hover:text-[#ffb4ab] transition-colors opacity-0 group-hover:opacity-100 flex-shrink-0">
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
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
  const [previewFile, setPreviewFile] = useState<Attachment | null>(null);
  const [showGuestModal, setShowGuestModal] = useState(false);
  const [isJoining, setIsJoining] = useState(false);
  const [messages, setMessages] = useState<RealChatMessage[]>([]);
  const [intelligence, setIntelligence] = useState<ExtractedItem[]>([]);
  const [showEmoji, setShowEmoji] = useState(false);
  const [localSearch, setLocalSearch] = useState('');

  // ── Per-chat personalization (theme accent, wallpaper, font) ─────────────
  const [personalization, setPersonalization] = useState<ChatPersonalization>(DEFAULT_PERSONALIZATION);
  const [showPersonalize, setShowPersonalize] = useState(false);
  const accentHex = ACCENTS.find((a) => a.key === personalization.accent)?.hex || '#568dff';

  // ── Voice messages ────────────────────────────────────────────────────────
  // Just another file attachment underneath (see isAudioAttachment/
  // MessageAttachment) — this is only the recording UI. MediaRecorder's
  // output format varies by browser (webm/opus on Chrome/Firefox, mp4/aac on
  // Safari) — recorded with no explicit mimeType so each browser picks its
  // own native, actually-supported one, and the resulting blob's own .type
  // is what gets stored and later used to decide how to play it back, rather
  // than assuming one format everywhere.
  const [isRecording, setIsRecording] = useState(false);
  // Guards the async gap between clicking the mic button and getUserMedia
  // actually resolving (the permission prompt, or just a slow device open).
  // Without this, a double-tap — the single most common way a real touch
  // screen fires a button twice, and something the automated Playwright
  // suite (one synthetic click, one mic already fake/instant) never
  // exercises — could call handleStartRecording twice before isRecording's
  // state update lands, opening TWO getUserMedia streams and TWO
  // MediaRecorders. The second silently overwrites mediaRecorderRef, so
  // finishRecording only ever stops the second one: the first stream and its
  // mic track are orphaned, still live, with no UI control able to reach
  // them again — the OS mic indicator would stay lit after "stopping", and
  // is exactly the kind of thing a user reports as "the record button
  // doesn't work well" without being able to say more precisely why. A ref,
  // not state, because the check must be synchronous on the very first line
  // of the handler, before any render could apply a state update.
  const startingRecordingRef = useRef(false);
  const [isStartingRecording, setIsStartingRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const recordTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recordStreamRef = useRef<MediaStream | null>(null);

  // Live waveform while recording — real mic levels via an AnalyserNode on
  // the SAME stream MediaRecorder is already using (a second getUserMedia
  // call would prompt for permission twice and could grab a different
  // device). Sampled at ~12/sec into a fixed-width rolling window, not on
  // every animation frame — that's already smooth for a bar animation and
  // avoids re-rendering this component 60x/sec for the whole recording.
  const WAVEFORM_BARS = 32;
  const [waveformLevels, setWaveformLevels] = useState<number[]>(() => new Array(32).fill(0));
  const waveformAudioCtxRef = useRef<AudioContext | null>(null);
  const waveformRafRef = useRef<number | null>(null);

  const stopWaveform = () => {
    if (waveformRafRef.current !== null) { cancelAnimationFrame(waveformRafRef.current); waveformRafRef.current = null; }
    waveformAudioCtxRef.current?.close().catch(() => {});
    waveformAudioCtxRef.current = null;
  };

  const startWaveform = (stream: MediaStream) => {
    const AudioContextCtor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) return; // no Web Audio support — recording itself still works, just without the visual
    const audioCtx = new AudioContextCtor();
    waveformAudioCtxRef.current = audioCtx;
    const source = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    setWaveformLevels(new Array(WAVEFORM_BARS).fill(0));
    let lastSample = 0;
    const tick = (t: number) => {
      if (t - lastSample > 80) {
        lastSample = t;
        analyser.getByteTimeDomainData(data);
        let sumSquares = 0;
        for (let i = 0; i < data.length; i++) { const v = (data[i] - 128) / 128; sumSquares += v * v; }
        const rms = Math.sqrt(sumSquares / data.length);
        // *5 brings typical speech up near the top of the bar without
        // clipping silence-floor noise into a visible bar — tuned by eye
        // against a real mic, not derived from a formula.
        const level = Math.max(0.04, Math.min(1, rms * 5));
        setWaveformLevels((prev) => [...prev.slice(1), level]);
      }
      waveformRafRef.current = requestAnimationFrame(tick);
    };
    waveformRafRef.current = requestAnimationFrame(tick);
  };

  // ── AI Search — searches actual message CONTENT across every thread the
  // user is in, not just thread names/previews the way localSearch above
  // does. Deliberately on-demand (a button), not fired on every keystroke —
  // this hits the real messages table across potentially many threads and
  // there's no reason to run it before the user has finished typing.
  const [msgSearchResults, setMsgSearchResults] = useState<AISearchResult[] | null>(null);
  const [isSearchingMsgs, setIsSearchingMsgs] = useState(false);

  // ── AI Writing (rewrite/tone tools) ─────────────────────────────────────
  const [showRewriteMenu, setShowRewriteMenu] = useState(false);
  const [isRewriting, setIsRewriting] = useState(false);
  const [aiError, setAIError] = useState<string | null>(null);
  // One-level undo: the draft as it was right before the last rewrite
  // overwrote it. Cleared the moment the user edits the text themselves, so
  // "undo" never restores a stale draft from several edits ago.
  const [rewriteUndo, setRewriteUndo] = useState<string | null>(null);

  // ── AI Reply (context-aware suggested replies) ──────────────────────────
  const [replySuggestions, setReplySuggestions] = useState<{ tone: string; text: string }[] | null>(null);
  const [isSuggestingReplies, setIsSuggestingReplies] = useState(false);
  const [showIntel, setShowIntel] = useState(() => {
    try { return localStorage.getItem('ibconnect_intel_panel_open') !== 'false'; } catch { return true; }
  });

  const toggleIntel = (open: boolean) => {
    setShowIntel(open);
    try { localStorage.setItem('ibconnect_intel_panel_open', String(open)); } catch {}
  };

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
    // Suggestions and a pending rewrite-undo are both specific to the thread
    // being left — carrying either into a different thread would offer to
    // "undo" or "use" text that has nothing to do with the new conversation.
    setReplySuggestions(null);
    setRewriteUndo(null);
    setAIError(null);
    if (!activeThread) { setMessages([]); setIntelligence([]); return; }
    setActiveThreadId(activeThread.id);
    markRead(activeThread.id);
    setPersonalization(currentUser ? loadChatPersonalization(currentUser.id, activeThread.id) : DEFAULT_PERSONALIZATION);

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

  // Component unmounting mid-recording (navigating away, closing the tab)
  // must not leave the OS mic indicator lit — stop the raw hardware track
  // directly rather than going through finishRecording, which does React
  // state updates that are pointless (and, post-unmount, a warning) here.
  useEffect(() => () => {
    stopRecordTimer();
    stopWaveform();
    if (mediaRecorderRef.current?.state === 'recording') mediaRecorderRef.current.stop();
    recordStreamRef.current?.getTracks().forEach((t) => t.stop());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSearchMessages = async () => {
    const q = (localSearch || searchFilter).trim();
    if (!q || isSearchingMsgs) return;
    setIsSearchingMsgs(true);
    try {
      const { results } = await api.aiSearch(q);
      setMsgSearchResults(results);
    } catch {
      setMsgSearchResults([]);
    } finally {
      setIsSearchingMsgs(false);
    }
  };

  const handleSelectSearchResult = (r: AISearchResult) => {
    setMsgSearchResults(null);
    setLocalSearch('');
    handleSelectThread(r.threadId);
  };

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
    // A rewrite's undo is only valid against the exact draft it just replaced —
    // once the user types anything else, "undo" restoring an older draft would
    // be more confusing than having no undo at all.
    setRewriteUndo(null);
    if (!activeThread) return;
    if (typingDebounceRef.current) clearTimeout(typingDebounceRef.current);
    setTyping(activeThread.id, true);
    typingDebounceRef.current = setTimeout(() => setTyping(activeThread.id, false), 2000);
    const ta = e.target;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 112) + 'px';
  };

  // ── AI Writing: rewrite the current draft in a given mode/tone ──────────
  const handleRewrite = async (mode: string) => {
    if (!inputText.trim() || isRewriting) return;
    setShowRewriteMenu(false);
    setIsRewriting(true);
    setAIError(null);
    const before = inputText;
    try {
      const { result } = await api.aiRewrite(before, mode);
      setInputText(result);
      setRewriteUndo(before);
    } catch (err) {
      setAIError(err instanceof Error ? err.message : 'Rewrite failed');
    } finally {
      setIsRewriting(false);
    }
  };

  const handleUndoRewrite = () => {
    if (rewriteUndo === null) return;
    setInputText(rewriteUndo);
    setRewriteUndo(null);
  };

  // ── AI Reply: fetch context-aware suggestions for the thread's last message ──
  const handleSuggestReplies = async () => {
    if (!activeThread || isSuggestingReplies) return;
    setIsSuggestingReplies(true);
    setAIError(null);
    try {
      const { suggestions } = await api.aiReplySuggestions(activeThread.id);
      setReplySuggestions(suggestions);
    } catch (err) {
      setAIError(err instanceof Error ? err.message : 'Could not get reply suggestions');
    } finally {
      setIsSuggestingReplies(false);
    }
  };

  const handleUseSuggestion = (text: string) => {
    setInputText(text);
    setReplySuggestions(null);
    setRewriteUndo(null);
    textareaRef.current?.focus();
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

  const stopRecordTimer = () => {
    if (recordTimerRef.current) { clearInterval(recordTimerRef.current); recordTimerRef.current = null; }
  };

  const handleStartRecording = async () => {
    if (isRecording || !activeThread || startingRecordingRef.current) return;
    startingRecordingRef.current = true;
    setIsStartingRecording(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // A double-tap (or a cancel/second click) that landed while this await
      // was pending is exactly the race this guard exists for — if recording
      // was already started (or the component moved on) by the time this
      // resolves, stop the newly-opened stream immediately rather than
      // silently making it the new active one out from under the user.
      if (isRecording) { stream.getTracks().forEach((t) => t.stop()); return; }
      recordStreamRef.current = stream;
      recordedChunksRef.current = [];
      const recorder = new MediaRecorder(stream);
      recorder.ondataavailable = (e) => { if (e.data.size > 0) recordedChunksRef.current.push(e.data); };
      mediaRecorderRef.current = recorder;
      recorder.start();
      setIsRecording(true);
      setRecordSeconds(0);
      recordTimerRef.current = setInterval(() => setRecordSeconds((s) => s + 1), 1000);
      startWaveform(stream);
    } catch (err) {
      setAIError(err instanceof Error ? err.message : 'Could not access the microphone');
    } finally {
      startingRecordingRef.current = false;
      setIsStartingRecording(false);
    }
  };

  // Stops the recorder and hardware track either way — cancel and send only
  // differ in whether the resulting blob is actually sent, never in whether
  // the mic itself is released, so a cancelled recording never leaves the
  // OS mic indicator lit.
  const finishRecording = (send: boolean) => {
    const recorder = mediaRecorderRef.current;
    if (!recorder) return;
    stopRecordTimer();
    stopWaveform();
    const thread = activeThread;
    recorder.onstop = () => {
      recordStreamRef.current?.getTracks().forEach((t) => t.stop());
      recordStreamRef.current = null;
      setIsRecording(false);
      if (!send || !thread || recordedChunksRef.current.length === 0) { recordedChunksRef.current = []; return; }
      const blob = new Blob(recordedChunksRef.current, { type: recorder.mimeType || 'audio/webm' });
      recordedChunksRef.current = [];
      if (blob.size > 5 * 1024 * 1024) { setAIError('Voice message too long (over 5MB) — keep it shorter'); return; }
      const reader = new FileReader();
      reader.onload = (ev) => {
        sendMessage(thread.id, '🎤 Voice message', {
          name: `voice-message.${blob.type.includes('mp4') ? 'm4a' : 'webm'}`,
          size: blob.size,
          type: blob.type,
          dataUrl: ev.target?.result as string,
        });
      };
      reader.readAsDataURL(blob);
    };
    recorder.stop();
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

  const getThreadUser = (thread: RealChatThread): IBUser | undefined => {
    if (thread.type !== 'dm') return undefined;
    const otherId = thread.participants.find(p => p !== currentUser?.id);
    return otherId ? getUserById(otherId) : undefined;
  };

  // A DM row carries the name/avatar the *creator* saw when the thread was made, so served
  // as-is the other side sees their own name and face as the person they're talking to
  // (fixed at source in loadThread, server/main.go — this keeps the UI right regardless of
  // what the API hands back, and picks up live display-name/avatar changes).
  const getThreadDisplay = (thread: RealChatThread): { name: string; avatar?: string } => {
    const other = getThreadUser(thread);
    if (thread.type === 'dm' && other) return { name: other.displayName, avatar: other.avatar };
    return { name: thread.name, avatar: thread.avatar };
  };

  const getSenderUser = (msg: RealChatMessage): IBUser | undefined => getUserById(msg.senderId);

  const combinedSearch = localSearch || searchFilter;
  const filteredThreads = threads.filter(t =>
    getThreadDisplay(t).name.toLowerCase().includes(combinedSearch.toLowerCase()) ||
    t.lastMessage.toLowerCase().includes(combinedSearch.toLowerCase())
  ).sort((a, b) => b.lastTimestamp - a.lastTimestamp);

  const renderThreadList = () => (
    <div className="flex flex-col h-full bg-[#0e0e0e]">
      <div className="p-3 border-b border-[#424655] flex justify-between items-center bg-[#0e0e0e] sticky top-0 z-10">
        <h2 className="font-bold text-xs text-[#e5e2e1] uppercase tracking-wider">Messages</h2>
        <div className="flex items-center gap-1">
          {/* Both of these were unlabelled 28x28 glyphs whose only affordance was a
              hover state — which does not exist on touch, so on a phone they were two
              indistinguishable grey icons. Group chat has shipped for months and users
              still report it missing for exactly this reason. */}
          <button onClick={() => setShowNewThread(true)} title="New direct message" aria-label="New direct message" className="w-9 h-9 sm:w-7 sm:h-7 flex items-center justify-center rounded-lg text-[#8c90a1] hover:text-[#b0c6ff] hover:bg-[#201f1f] transition-colors cursor-pointer"><PlusCircle className="w-4 h-4" /></button>
          <button onClick={() => setShowNewGroup(true)} title="New group" aria-label="New group" className="w-9 h-9 sm:w-7 sm:h-7 flex items-center justify-center rounded-lg text-[#8c90a1] hover:text-[#b0c6ff] hover:bg-[#201f1f] transition-colors cursor-pointer"><Users className="w-4 h-4" /></button>
        </div>
      </div>
      <div className="px-3 pt-2 pb-1">
        <div className="relative">
          <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-[#8c90a1]" />
          <input
            type="text"
            value={localSearch}
            onChange={e => { setLocalSearch(e.target.value); setMsgSearchResults(null); }}
            placeholder="Search conversations…"
            className="w-full bg-[#131313] border border-[#424655]/60 rounded-xl pl-8 pr-3 py-2 text-[16px] sm:text-xs text-[#e5e2e1] placeholder-[#8c90a1]/60 focus:border-[#568dff] outline-none transition-colors"
          />
          {localSearch && <button onClick={() => { setLocalSearch(''); setMsgSearchResults(null); }} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[#8c90a1] hover:text-[#e5e2e1]"><X className="w-3 h-3" /></button>}
        </div>
        {/* AI Search over actual message content — separate from the plain
            thread-name/preview filter above, which can't find a message
            buried in an old conversation whose title doesn't mention it. */}
        {combinedSearch.trim() && (
          <button
            onClick={handleSearchMessages}
            disabled={isSearchingMsgs}
            className="w-full flex items-center justify-center gap-1.5 mt-1.5 text-[10px] text-[#b0c6ff] hover:text-[#c0c1ff] disabled:opacity-50 py-1"
          >
            {isSearchingMsgs ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
            {isSearchingMsgs ? 'Searching messages…' : `Search all messages for "${combinedSearch.trim()}"`}
          </button>
        )}
        {msgSearchResults && (
          <div className="mt-1.5 flex flex-col gap-1 max-h-64 overflow-y-auto">
            {msgSearchResults.length === 0 ? (
              <p className="text-[10px] text-[#8c90a1] text-center py-2">No messages found.</p>
            ) : msgSearchResults.map((r) => (
              <div key={r.messageId} onClick={() => handleSelectSearchResult(r)} className="cursor-pointer bg-[#131313] border border-[#424655]/40 hover:border-[#568dff]/40 rounded-lg p-2 text-[10px] transition-colors">
                <div className="flex items-center justify-between mb-0.5">
                  <span className="font-semibold text-[#e5e2e1] truncate">{r.threadName}</span>
                  <span className="text-[#8c90a1] flex-shrink-0 ml-2">{r.senderName}</span>
                </div>
                <p className="text-[#8c90a1] truncate">{r.text}</p>
              </div>
            ))}
          </div>
        )}
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
          const { name: threadName, avatar: threadAvatar } = getThreadDisplay(thread);
          const displayTime = thread.lastTimestamp ? new Date(thread.lastTimestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
          
          return (
            <div key={thread.id} onClick={() => handleSelectThread(thread.id)} className={`p-3 rounded-xl flex items-start gap-2.5 cursor-pointer border transition-all ${isSelected ? 'bg-[#568dff]/15 border-[#568dff]/50' : 'bg-transparent border-transparent hover:bg-[#131313]'}`}>
              <div className="relative flex-shrink-0" onClick={e => { if (threadUser) { e.stopPropagation(); setViewingUser(threadUser); } }}>
                {thread.type === 'group' ? (
                  <div className="w-9 h-9 rounded-xl bg-[#8083ff]/15 text-[#c0c1ff] flex items-center justify-center"><Users className="w-4 h-4" /></div>
                ) : threadAvatar ? (
                  <img alt={threadName} className="w-9 h-9 rounded-full object-cover" src={threadAvatar} />
                ) : (
                  <div className="w-9 h-9 rounded-xl bg-[#568dff]/10 text-[#b0c6ff] flex items-center justify-center font-bold text-xs">{threadName.charAt(0).toUpperCase()}</div>
                )}
                {threadUser && <div className={`absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full border border-[#0e0e0e] ${threadUser.status === 'online' ? 'bg-[#4dffb1]' : 'bg-[#8c90a1]'}`} />}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex justify-between items-baseline mb-0.5">
                  <span className="font-semibold text-xs text-[#e5e2e1] truncate">{threadName}</span>
                  <span className="text-[9px] text-[#8c90a1] flex-shrink-0 ml-1">{displayTime}</span>
                </div>
                <div className="flex justify-between items-center gap-1">
                  <p className="text-[10px] text-[#8c90a1] truncate flex-1 min-w-0">{thread.lastMessage || 'Start a conversation'}</p>
                  {/* (x ?? 0) > 0, not `x && x > 0`: a leading `0 &&` short-circuits to the number
                      0, which React renders as a literal "0" text node next to every read thread. */}
                  {(thread.unreadCount ?? 0) > 0 && !isSelected && (
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
              const { name: headerName, avatar: headerAvatar } = getThreadDisplay(activeThread);
              return (
                <div className="relative cursor-pointer flex-shrink-0" onClick={() => threadUser && setViewingUser(threadUser)}>
                  {activeThread.type === 'group' ? (
                    <div className="w-9 h-9 rounded-xl bg-[#8083ff]/15 text-[#c0c1ff] flex items-center justify-center"><Users className="w-4 h-4" /></div>
                  ) : headerAvatar ? (
                    <img src={headerAvatar} alt={headerName} className="w-9 h-9 rounded-full object-cover" />
                  ) : (
                    <div className="w-9 h-9 rounded-xl bg-[#568dff]/10 flex items-center justify-center"><span className="text-sm font-bold text-[#b0c6ff]">{headerName.charAt(0).toUpperCase()}</span></div>
                  )}
                  {threadUser && <div className={`absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full border border-[#0e0e0e] ${threadUser.status === 'online' ? 'bg-[#4dffb1]' : 'bg-[#8c90a1]'}`} />}
                </div>
              );
            })()}
            <div className="flex-1 min-w-0">
              <h3 className="font-bold text-sm text-[#e5e2e1] truncate">{getThreadDisplay(activeThread).name}</h3>
              <p className="text-[10px] text-[#8c90a1] truncate">
                {activeTypingUsers.length > 0 ? `${activeTypingUsers.map(u => u.userName).join(', ')} is typing...` : (() => { const u = getThreadUser(activeThread); return u ? (u.status === 'online' ? 'Online' : 'Offline') : `${activeThread.participants.length} participants`; })()}
              </p>
            </div>
            <div className="relative flex-shrink-0">
              <button onClick={() => setShowPersonalize(v => !v)} title="Personalize this chat" aria-label="Personalize this chat" className="w-8 h-8 flex items-center justify-center rounded-lg text-[#8c90a1] hover:text-[#e5e2e1] hover:bg-[#201f1f] transition-colors">
                <Palette className="w-4 h-4" />
              </button>
              {showPersonalize && (
                <PersonalizeMenu
                  value={personalization}
                  onChange={(next) => {
                    setPersonalization(next);
                    if (currentUser && activeThread) saveChatPersonalization(currentUser.id, activeThread.id, next);
                  }}
                  onClose={() => setShowPersonalize(false)}
                />
              )}
            </div>
            <button onClick={handleQuickJoin} disabled={isJoining} className="flex items-center gap-1.5 bg-[#568dff]/10 text-[#b0c6ff] border border-[#568dff]/30 px-2.5 sm:px-3 py-1.5 rounded-lg text-xs font-bold hover:bg-[#568dff]/20 transition-colors disabled:opacity-50 flex-shrink-0">
              <Video className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">{isJoining ? '...' : 'Start Call'}</span>
            </button>
          </div>

          <div
            ref={chatScrollRef}
            className="flex-1 overflow-y-auto p-3 sm:p-4 flex flex-col gap-3 sm:gap-4 scroll-smooth"
            style={{
              paddingBottom: '130px',
              background: WALLPAPERS.find(w => w.key === personalization.wallpaper)?.css || undefined,
              fontFamily: FONTS.find(f => f.key === personalization.font)?.css,
            }}
          >
            {messages.length === 0 ? (
              <div className="flex-1 flex items-center justify-center py-16">
                <div className="text-center">
                  <MessageSquare className="w-8 h-8 text-[#424655] mx-auto mb-2" />
                  <p className="text-xs text-[#8c90a1]">No messages yet — say hello!</p>
                </div>
              </div>
            ) : (
              messages.map((msg) => {
                // AI Calendar Intelligence: a meeting card is a real, persisted
                // message (sender_id NULL server-side) but rendered as a
                // centered system card, not a left/right chat bubble — it
                // belongs to neither participant.
                const meetingCard = parseMeetingCard(msg.text);
                if (meetingCard) {
                  return <div key={msg.id}><MeetingCardBubble card={meetingCard} /></div>;
                }

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
                        <MessageAttachment file={msg.fileAttachment} isMe={isMe} onPreview={setPreviewFile} messageId={msg.id} />
                      ) : (
                        <>
                          <div
                            className={`px-3 py-2.5 rounded-2xl text-[16px] sm:text-xs border leading-relaxed ${isMe ? 'text-white rounded-tr-sm' : 'bg-[#1c1b1b] text-[#e5e2e1] border-[#424655]/40 rounded-tl-sm'}`}
                            style={{
                              wordBreak: 'break-word', overflowWrap: 'anywhere', whiteSpace: 'pre-wrap',
                              ...(isMe ? { background: accentHex, borderColor: accentHex } : {}),
                            }}
                          >
                            {renderText(msg.text)}
                          </div>
                          <TranslateMessage text={msg.text} isMe={isMe} />
                        </>
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
            {/* AI Reply: only worth offering when there's something to reply TO and the
                composer isn't already mid-draft — filling suggestions into someone's own
                half-written message would be more annoying than helpful. */}
            {!inputText.trim() && messages.length > 0 && messages[messages.length - 1]?.senderId !== currentUser?.id && (
              replySuggestions ? (
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {replySuggestions.map((s, i) => (
                    <button
                      key={i}
                      onClick={() => handleUseSuggestion(s.text)}
                      title={s.tone}
                      className="text-[11px] text-[#e5e2e1] bg-[#1c1b1b] border border-[#424655]/60 hover:border-[#568dff]/50 rounded-full px-3 py-1.5 max-w-[220px] truncate transition-colors"
                    >
                      {s.text}
                    </button>
                  ))}
                  <button onClick={() => setReplySuggestions(null)} className="text-[11px] text-[#8c90a1] hover:text-[#e5e2e1] px-2 py-1.5"><X className="w-3 h-3" /></button>
                </div>
              ) : (
                <button
                  onClick={handleSuggestReplies}
                  disabled={isSuggestingReplies}
                  className="flex items-center gap-1.5 text-[11px] text-[#b0c6ff] hover:text-[#c0c1ff] mb-2 disabled:opacity-50"
                >
                  {isSuggestingReplies ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
                  {isSuggestingReplies ? 'Thinking…' : 'Suggest replies'}
                </button>
              )
            )}
            <div className="bg-[#131313] rounded-xl border border-[#424655] shadow-lg focus-within:border-[#568dff] focus-within:ring-1 focus-within:ring-[#568dff]/50 transition-all flex flex-col">
              {isRecording ? (
                <div className="flex items-center gap-3 px-4 py-3">
                  <button onClick={() => finishRecording(false)} title="Cancel recording" aria-label="Cancel recording" className="text-[#8c90a1] hover:text-[#ffb4ab] transition-colors flex-shrink-0">
                    <Trash2 className="w-4 h-4" />
                  </button>
                  <span className="w-2 h-2 rounded-full bg-[#ffb4ab] animate-pulse flex-shrink-0" />
                  <span className="text-xs text-[#e5e2e1] flex-shrink-0 tabular-nums">
                    {String(Math.floor(recordSeconds / 60)).padStart(2, '0')}:{String(recordSeconds % 60).padStart(2, '0')}
                  </span>
                  {/* Real mic levels (see startWaveform), not a decorative
                      animation — bars scale with actual amplitude so this
                      genuinely shows you're being heard, silence included. */}
                  <div className="flex-1 flex items-center gap-[2px] h-6 min-w-0 overflow-hidden" aria-hidden="true">
                    {waveformLevels.map((lvl, i) => (
                      <span
                        key={i}
                        className="flex-1 min-w-[2px] rounded-full bg-[#568dff] transition-[height] duration-75"
                        style={{ height: `${Math.max(8, lvl * 100)}%` }}
                      />
                    ))}
                  </div>
                  <button onClick={() => finishRecording(true)} title="Send voice message" aria-label="Send voice message" className="bg-[#568dff] text-[#002661] w-8 h-8 rounded-lg flex items-center justify-center hover:bg-[#568dff]/90 transition-colors shadow-sm flex-shrink-0">
                    <Send className="w-3.5 h-3.5 stroke-[2.5]" />
                  </button>
                </div>
              ) : (
                <>
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
                    <div className="flex gap-1 relative items-center">
                      <button onClick={() => fileInputRef.current?.click()} className="w-7 h-7 flex items-center justify-center rounded-lg text-[#8c90a1] hover:bg-[#201f1f] hover:text-[#b0c6ff] transition-colors"><Paperclip className="w-3.5 h-3.5" /></button>
                      <button onClick={handleBold} className="w-7 h-7 flex items-center justify-center rounded-lg text-[#8c90a1] hover:bg-[#201f1f] hover:text-[#e5e2e1] transition-colors"><Bold className="w-3.5 h-3.5" /></button>
                      <button onClick={() => setShowEmoji(v => !v)} className={`w-7 h-7 flex items-center justify-center rounded-lg transition-colors ${showEmoji ? 'bg-[#568dff]/20 text-[#b0c6ff]' : 'text-[#8c90a1] hover:bg-[#201f1f] hover:text-[#b0c6ff]'}`}><Smile className="w-3.5 h-3.5" /></button>
                      {showEmoji && <EmojiPicker onSelect={handleEmojiSelect} onClose={() => setShowEmoji(false)} />}
                      {/* AI Writing: rewrite/tone tools, disabled on an empty draft since there's
                          nothing to rewrite. */}
                      <button
                        onClick={() => setShowRewriteMenu(v => !v)}
                        disabled={!inputText.trim() || isRewriting}
                        title="Rewrite with AI"
                        className={`w-7 h-7 flex items-center justify-center rounded-lg transition-colors disabled:opacity-30 ${showRewriteMenu ? 'bg-[#568dff]/20 text-[#b0c6ff]' : 'text-[#8c90a1] hover:bg-[#201f1f] hover:text-[#b0c6ff]'}`}
                      >
                        {isRewriting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Wand2 className="w-3.5 h-3.5" />}
                      </button>
                      {showRewriteMenu && <RewriteMenu onPick={handleRewrite} onClose={() => setShowRewriteMenu(false)} busy={isRewriting} />}
                      {rewriteUndo !== null && (
                        <button onClick={handleUndoRewrite} title="Undo rewrite" className="flex items-center gap-1 text-[10px] text-[#8c90a1] hover:text-[#e5e2e1] px-1.5">
                          <RotateCcw className="w-3 h-3" />Undo
                        </button>
                      )}
                    </div>
                    {inputText.trim() ? (
                      <button onClick={handleSend} className="text-[#002661] w-7 h-7 rounded-lg flex items-center justify-center transition-colors shadow-sm" style={{ background: accentHex }}>
                        <Send className="w-3 h-3 stroke-[2.5]" />
                      </button>
                    ) : (
                      <button
                        onClick={handleStartRecording}
                        disabled={isStartingRecording}
                        title="Record a voice message"
                        aria-label="Record a voice message"
                        className="w-7 h-7 flex items-center justify-center rounded-lg text-[#8c90a1] hover:bg-[#201f1f] hover:text-[#b0c6ff] transition-colors disabled:opacity-50"
                      >
                        {/* Visual feedback for the gap between the click and getUserMedia
                            actually resolving (a permission prompt can take a few seconds) —
                            previously nothing happened on screen during that window, which
                            reads as "the button doesn't work" even though it's already busy
                            opening the mic. Also the UI half of the double-tap guard above:
                            disabled here means a second tap can't even reach the handler. */}
                        {isStartingRecording ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Mic className="w-3.5 h-3.5" />}
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>
            {meetingError && <p className="text-[10px] text-[#ffb4ab] mt-1 text-center">{meetingError}</p>}
            {aiError && <p className="text-[10px] text-[#ffb4ab] mt-1 text-center">{aiError}</p>}
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
      {/* Rendered here, alongside the other modals, so the lg:hidden and desktop branches
          below don't each mount their own copy. */}
      {previewFile && <AttachmentPreviewModal file={previewFile} onClose={() => setPreviewFile(null)} />}

      <div className="lg:hidden flex-1 flex flex-col overflow-hidden">
        {mobilePanel === 'list' ? <div className="flex-1 overflow-hidden">{renderThreadList()}</div> : <div className="flex-1 overflow-hidden">{renderChat()}</div>}
      </div>

      <div className="hidden lg:flex flex-1 overflow-hidden">
        <aside className="w-72 flex-shrink-0 border-r border-[#424655] overflow-hidden flex flex-col">{renderThreadList()}</aside>
        <main className="flex-1 overflow-hidden flex flex-col relative">
          {renderChat()}
          {!showIntel && (
            <button
              onClick={() => toggleIntel(true)}
              title="Open Intelligence Agent"
              className="hidden xl:flex absolute top-3 right-3 items-center gap-1.5 bg-[#1c1b1b]/95 backdrop-blur-md border border-[#424655] hover:border-[#c0c1ff]/50 text-[#c0c1ff] rounded-full pl-2.5 pr-3 py-1.5 text-[10px] font-bold shadow-lg cursor-pointer transition-all z-20"
            >
              <Sparkles className="w-3.5 h-3.5" />
              <ChevronsLeft className="w-3 h-3" />
            </button>
          )}
        </main>
        {showIntel && (
          <IntelligenceSidebar intelligence={intelligence} messages={messages} activeThread={activeThread} currentUser={currentUser} getUserById={getUserById} setViewingUser={setViewingUser} handleQuickJoin={handleQuickJoin} isJoining={isJoining} meetingError={meetingError ?? null} onClose={() => toggleIntel(false)} />
        )}
      </div>
    </div>
  );
}
