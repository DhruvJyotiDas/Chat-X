import { useEffect, useRef, useState } from 'react';
import {
  ArrowUp, Check, Database, Globe2, Mic, MicOff, RotateCcw, Sparkles, X,
  WifiOff, RefreshCw, ChevronDown,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import {
  api,
  type AIAssistantMessage,
  type AIPACalendarAction,
  type AIPAContextSummary,
  type AIPAWebSource,
} from '../../lib/api';
import { useAuth } from '../../context/AuthContext';
import { loadCalendarEvents } from '../../lib/calendarLocal';
import { loadCalls } from '../../lib/callsLocal';
import AIPAMessageContent from './AIPAMessageContent';
import Modal from '../ui/Modal';
import BrandDots from '../BrandDots';
import { useAnyOverlayOpen } from '../../lib/overlayStack';
import { useKeyboardOpen } from '../../hooks/useKeyboardOpen';

/**
 * Phase 3, sub-unit 2 — replaces AIAssistantPanel.tsx (deleted, sole
 * consumer was TopBar.tsx). Read first, per this sub-unit's own
 * instruction, rather than assumed: AIPA today opens ONLY from a TopBar
 * button ("Ask AIPA", Sparkles icon, local `assistantOpen` state) that
 * mounts AIAssistantPanel as a full-height right-edge slide-in panel.
 * There is no sidebar entry, no command-palette entry, and no keyboard
 * shortcut for AIPA — the Sparkles icon that DOES appear in Sidebar.tsx
 * and CommandPalette.tsx is the unrelated "Virtual Interview" nav item,
 * not AIPA. Nothing to "keep" for those three per this sub-unit's own
 * instruction, since none of them existed; not inventing new ones either,
 * since only removing the TopBar button and keeping existing entries was
 * asked for.
 *
 * AIAssistantPanel was already a self-contained `fixed inset-0` overlay
 * with its own state/handlers, not coupled to TopBar's layout — reusable
 * without a stop-and-report. Every piece of conversation logic below
 * (SpeechRecognition detection, STARTERS, the message shape, `send()`'s
 * calendar/calls context building and api.aiChat call, the calendar
 * confirm/cancel handlers) is carried over UNCHANGED in behavior; only
 * the JSX around it is new.
 *
 * Known, disclosed gaps against this sub-unit's full spec:
 * - No "unread/proactive" state is exposed anywhere AIPA can read it —
 *   proactive opportunities (PR #2 / commit db4bb82) surface as their own
 *   cards on DashboardView, not through this component — so no dot is
 *   shown, per the instruction's own "ONLY if that state is already
 *   exposed."
 * - No full AIPA page exists (AppView has no such route), so no Expand
 *   action is added, per the instruction's own "if a full AIPA page
 *   exists."
 * - No streaming exists in the API (api.aiChat returns one complete
 *   response) and no cancel/abort path exists either — so "streamed text
 *   without layout jump" is a BrandDots typing indicator while waiting,
 *   not token-by-token rendering, and there is no Stop button.
 * - "Hidden while a chat thread is open" (mobile) is NOT wired — ChatsView
 *   doesn't expose its selected-thread state to a parent today, and
 *   ChatsView's own mobile restructuring is sub-unit 4's job; wiring this
 *   now would mean touching ChatsView ahead of its own pass. Left as a
 *   known gap for sub-unit 4 to close, since it will already be reshaping
 *   ChatsView's mobile state.
 * - No toast system exists anywhere in this codebase (grepped, not
 *   assumed) — "toasts must not overlap it" has nothing to apply to today.
 * - "Hidden while any Modal/sheet or the mobile drawer is open" and the
 *   keyboard-open check are read as governing the LAUNCHER's visibility
 *   only (when the popup is closed) — once the popup itself is open it
 *   always shows regardless of those signals, since the point of both
 *   rules is to keep the closed launcher from visually colliding with
 *   other floating UI, not to force-hide an active conversation. The
 *   overlay registry (src/lib/overlayStack.ts) covers every Modal-based
 *   dialog automatically plus CommandPalette and the Sidebar mobile
 *   drawer explicitly; older ad hoc overlays (MeetingInviteDialog, etc.)
 *   aren't wired in yet, same disclosed boundary as that file's own doc
 *   comment.
 *
 * Bug-batch 2026-09-19, section 2 (regression fixes, not new scope):
 * - The launcher used to unmount entirely while `open` was true, leaving
 *   desktop with no visible way to close the popup except Esc or the
 *   header's own X -- it now stays mounted at the same position and becomes
 *   a 56px circular close button on desktop (see Launcher below).
 * - The desktop popup's height/width were tuned against a guessed TopBar
 *   height; on real Windows viewport heights (browser chrome eating more of
 *   the window than assumed) the popup's top edge could land under the
 *   TopBar. It now sizes against `--topbar-h`, the TopBar's own measured
 *   height (TopBar.tsx publishes it via ResizeObserver), and adds a
 *   `compact` mode below ~520px of viewport height that docks the popup
 *   from just under the TopBar to the bottom instead of shrinking further.
 */

// Web Speech API — deliberately NOT the room-scoped /asr nemotron pipeline
// (that's for live in-call captions, a completely different consumer). This
// is plain browser dictation into the composer, same mechanism a phone
// keyboard's own mic button uses. Chrome/Edge/Safari ship it under the
// vendor-prefixed constructor; Firefox does not ship it at all, so the mic
// control is feature-detected and hidden rather than shown-and-broken.
type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};
function getSpeechRecognitionCtor(): (new () => SpeechRecognitionLike) | undefined {
  const w = window as unknown as Record<string, unknown>;
  return (w.SpeechRecognition ?? w.webkitSpeechRecognition) as (new () => SpeechRecognitionLike) | undefined;
}
const voiceSupported = typeof window !== 'undefined' && !!getSpeechRecognitionCtor();

const STARTERS = [
  "What's on my calendar this week?",
  'Catch me up on my recent chats',
  'What tasks, reminders and appointments need attention?',
  'Search the web for the latest technology news',
];

type AIPAMessage = AIAssistantMessage & {
  context?: AIPAContextSummary;
  sources?: AIPAWebSource[];
  confirmationToken?: string;
  proposedAction?: AIPACalendarAction;
  actionResolved?: 'confirmed' | 'cancelled';
};

function useAIPAConversation() {
  const { currentUser } = useAuth();
  const [messages, setMessages] = useState<AIPAMessage[]>([]);
  const [input, setInput] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [error, setError] = useState('');
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);

  useEffect(() => () => { recognitionRef.current?.stop(); }, []);

  const toggleVoice = () => {
    if (isListening) {
      recognitionRef.current?.stop();
      return;
    }
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) return;
    const recognition = new Ctor();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = navigator.language || 'en-US';
    recognition.onresult = (event) => {
      const e = event as { results: { length: number; [i: number]: { [j: number]: { transcript: string } } } };
      let transcript = '';
      for (let i = 0; i < e.results.length; i++) {
        transcript += e.results[i][0].transcript;
      }
      if (transcript) setInput(transcript);
    };
    recognition.onerror = () => setIsListening(false);
    recognition.onend = () => setIsListening(false);
    recognitionRef.current = recognition;
    setError('');
    setIsListening(true);
    recognition.start();
  };

  const send = async (suggested?: string) => {
    const text = (suggested ?? input).trim();
    if (!text || isSending) return;
    const history: AIAssistantMessage[] = messages.slice(-10).map(({ role, text: messageText }) => ({ role, text: messageText }));
    setMessages(prev => [...prev, { role: 'user', text }]);
    setInput('');
    setError('');
    setIsSending(true);
    try {
      const now = new Date();
      const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      const personalEvents = currentUser
        ? [
            ...loadCalendarEvents(currentUser.id)
              .filter(event => event.date >= today)
              .sort((a, b) => `${a.date}T${a.startTime}`.localeCompare(`${b.date}T${b.startTime}`))
              .slice(0, 40),
            ...loadCalendarEvents(currentUser.id)
              .filter(event => event.date < today)
              .sort((a, b) => `${b.date}T${b.startTime}`.localeCompare(`${a.date}T${a.startTime}`))
              .slice(0, 10),
          ]
            .map(e => ({
              id: e.id, title: e.title, date: e.date, startTime: e.startTime,
              endTime: e.endTime, allDay: e.allDay, description: e.description, location: e.location,
            }))
        : [];
      const recentCalls = currentUser
        ? loadCalls(currentUser.id)
            .sort((a, b) => b.timestamp - a.timestamp)
            .slice(0, 20)
            .map(call => ({
              type: call.type, callType: call.callType, participantName: call.participantName,
              duration: call.duration, occurredAt: new Date(call.timestamp).toISOString(),
            }))
        : [];
      const response = await api.aiChat(text, history, personalEvents, recentCalls);
      setMessages(prev => [...prev, {
        role: 'assistant',
        text: response.result,
        context: response.context,
        sources: response.sources,
        confirmationToken: response.confirmationToken,
        proposedAction: response.proposedAction,
      }]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'AIPA could not respond right now.');
    } finally {
      setIsSending(false);
    }
  };

  const retryLast = () => {
    const lastUser = [...messages].reverse().find(m => m.role === 'user');
    if (lastUser) void send(lastUser.text);
  };

  const confirmAction = async (message: AIPAMessage) => {
    try {
      const result = await api.confirmCalendarAction(message.confirmationToken!, true);
      setMessages(current => current.map(item => item === message ? { ...item, text: result.message, actionResolved: 'confirmed' } : item));
      window.dispatchEvent(new CustomEvent('ibconnect_calendar_changed'));
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : 'Could not confirm the action.');
    }
  };

  const cancelAction = async (message: AIPAMessage) => {
    await api.confirmCalendarAction(message.confirmationToken!, false).catch(() => {});
    setMessages(current => current.map(item => item === message ? { ...item, actionResolved: 'cancelled' } : item));
  };

  const reset = () => { setMessages([]); setError(''); };

  return { messages, input, setInput, isSending, isListening, error, toggleVoice, send, retryLast, confirmAction, cancelAction, reset };
}

type Conversation = ReturnType<typeof useAIPAConversation>;

function TypingIndicator() {
  return (
    <div className="flex justify-start">
      <div className="flex items-center gap-2 rounded-2xl rounded-bl-md border border-[var(--ib-border)] bg-[var(--ib-surface-raised)] px-4 py-3 text-xs text-[var(--ib-text-muted)]">
        <BrandDots mode="loading" size={6} /> AIPA is thinking…
      </div>
    </div>
  );
}

function MessageBubble({ message, conv }: { message: AIPAMessage; conv: Conversation }) {
  const isUser = message.role === 'user';
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[88%] rounded-2xl px-4 py-3 text-xs leading-5 ${
        isUser
          ? 'rounded-br-md bg-[var(--ib-blue-500)] text-white'
          : 'rounded-bl-md border border-[var(--ib-border)] bg-[var(--ib-surface-raised)] text-[var(--ib-text)]'
      }`}>
        {isUser
          ? <span className="whitespace-pre-wrap">{message.text}</span>
          : <AIPAMessageContent text={message.text} sources={message.sources} />}

        {!isUser && message.context && (
          <div className="mt-3 border-t border-[var(--ib-border)] pt-2.5">
            {message.context.sources.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5" aria-label="IB Connect sources used">
                <Database className="mr-0.5 h-3 w-3 text-[var(--ib-text-muted)]" />
                {message.context.sources.map(source => (
                  <span key={source.kind} className="rounded-md border border-[var(--ib-border)] bg-[var(--ib-gray-50)] px-1.5 py-0.5 text-[8px] font-medium text-[var(--ib-text-muted)]">
                    {source.label} · {source.count}
                  </span>
                ))}
              </div>
            )}
            {message.context.unavailable.length > 0 && (
              <p className="mt-2 flex items-start gap-1.5 text-[9px] leading-4 text-[var(--ib-warn-text)]">
                <Globe2 className="mt-0.5 h-3 w-3 shrink-0" />
                Unavailable: {message.context.unavailable.join(', ')}
              </p>
            )}
          </div>
        )}

        {!isUser && message.sources && message.sources.length > 0 && (
          <div className="mt-3 space-y-1.5">
            <p className="flex items-center gap-1.5 text-[9px] font-semibold uppercase tracking-[.12em] text-[var(--ib-text-muted)]"><Globe2 className="h-3 w-3" />Web sources</p>
            {message.sources.map((source, sourceIndex) => (
              <a key={source.url} href={source.url} target="_blank" rel="noreferrer" className="block rounded-xl border border-[var(--ib-border)] bg-[var(--ib-gray-50)] px-2.5 py-2 transition hover:border-[var(--ib-blue-500)]/30 hover:bg-[var(--ib-blue-50)]">
                <span className="block truncate text-[10px] font-medium text-[var(--ib-blue-800)]">[{sourceIndex + 1}] {source.title}</span>
                <span className="mt-0.5 block truncate text-[8px] text-[var(--ib-text-muted)]">{source.url}</span>
              </a>
            ))}
          </div>
        )}

        {!isUser && message.confirmationToken && message.proposedAction && (
          <div className="mt-3 rounded-xl border border-[var(--ib-blue-500)]/20 bg-[var(--ib-blue-50)] p-3">
            <p className="text-[9px] font-bold uppercase tracking-[.12em] text-[var(--ib-blue-800)]">Review calendar action</p>
            <p className="mt-1.5 text-[11px] font-semibold text-[var(--ib-text)]">
              {message.proposedAction.action === 'create' ? 'Create' : message.proposedAction.action === 'delete' ? 'Cancel' : 'Reschedule'} · {message.proposedAction.title}
            </p>
            <p className="mt-1 text-[9px] text-[var(--ib-text-muted)]">{message.proposedAction.date} · {message.proposedAction.startTime}–{message.proposedAction.endTime} · {message.proposedAction.timeZone}</p>
            {!!message.proposedAction.attendeeNames?.length && <p className="mt-1 text-[9px] text-[var(--ib-text-muted)]">Invite: {message.proposedAction.attendeeNames.join(', ')}</p>}
            {message.proposedAction.warning && <p className="mt-2 rounded-lg border border-[var(--ib-warn-dot)]/25 bg-[var(--ib-warn-fill)] px-2 py-1.5 text-[9px] leading-4 text-[var(--ib-warn-text)]">{message.proposedAction.warning}</p>}
            {message.actionResolved ? (
              <p className="mt-2 flex items-center gap-1.5 text-[10px] font-semibold text-[var(--ib-good-text)]"><Check className="h-3.5 w-3.5" />{message.actionResolved === 'confirmed' ? 'Confirmed and saved' : 'Cancelled'}</p>
            ) : (
              <div className="mt-3 flex gap-2">
                <button onClick={() => conv.confirmAction(message)} className="rounded-lg bg-[var(--ib-blue-500)] px-3 py-1.5 text-[9px] font-semibold text-white cursor-pointer hover:bg-[var(--ib-blue-600)]">Confirm</button>
                <button onClick={() => conv.cancelAction(message)} className="rounded-lg border border-[var(--ib-border)] px-3 py-1.5 text-[9px] font-semibold text-[var(--ib-text-muted)] cursor-pointer hover:bg-[var(--ib-gray-50)]">Cancel</button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Composer({ conv }: { conv: Conversation }) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isComposingRef = useRef(false);

  // Auto-grow up to ~5 lines, then scroll internally.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const lineHeight = 20;
    const maxHeight = lineHeight * 5 + 16;
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
  }, [conv.input]);

  return (
    <div className="border-t border-[var(--ib-border)] bg-[var(--ib-surface-raised)] p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
      {!navigator.onLine && (
        <div className="mb-2 flex items-center gap-2 rounded-xl border border-[var(--ib-warn-dot)]/25 bg-[var(--ib-warn-fill)] px-3 py-2 text-[11px] text-[var(--ib-warn-text)]">
          <WifiOff className="h-3.5 w-3.5 shrink-0" /> You&apos;re offline — messages won&apos;t send until you&apos;re back online.
        </div>
      )}
      {conv.error && (
        <div className="mb-2 flex items-center gap-2 rounded-xl border border-[var(--ib-bad-dot)]/25 bg-[var(--ib-bad-fill)] px-3 py-2">
          <p className="flex-1 text-[11px] text-[var(--ib-bad-text)]">{conv.error}</p>
          <button onClick={conv.retryLast} title="Retry" aria-label="Retry" className="shrink-0 text-[var(--ib-bad-text)] hover:text-[var(--ib-bad-dot)] cursor-pointer">
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
      <form
        onSubmit={(e) => { e.preventDefault(); void conv.send(); }}
        className="flex items-end gap-2 rounded-2xl border border-[var(--ib-border)] bg-[var(--ib-gray-50)] p-2 focus-within:border-[var(--ib-blue-500)] focus-within:shadow-[var(--ib-shadow-focus)]"
      >
        <textarea
          ref={textareaRef}
          value={conv.input}
          onChange={(e) => conv.setInput(e.target.value)}
          onCompositionStart={() => { isComposingRef.current = true; }}
          onCompositionEnd={() => { isComposingRef.current = false; }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !isComposingRef.current) {
              e.preventDefault();
              void conv.send();
            }
          }}
          maxLength={4000}
          rows={1}
          enterKeyHint="send"
          autoCapitalize="sentences"
          placeholder={conv.isListening ? 'Listening…' : 'Message AIPA…'}
          className="min-h-11 md:min-h-9 flex-1 resize-none bg-transparent px-2 py-2 text-base md:text-sm text-[var(--ib-text)] outline-none touch-manipulation placeholder:text-[var(--ib-text-muted)]"
        />
        {voiceSupported && (
          <button
            type="button"
            onClick={conv.toggleVoice}
            disabled={conv.isSending}
            aria-label={conv.isListening ? 'Stop voice input' : 'Speak to AIPA'}
            title={conv.isListening ? 'Stop voice input' : 'Speak to AIPA'}
            className={`grid h-11 w-11 md:h-9 md:w-9 shrink-0 place-items-center rounded-xl transition cursor-pointer disabled:cursor-not-allowed disabled:opacity-35 ${
              conv.isListening
                ? 'animate-pulse bg-[var(--ib-bad-dot)] text-white hover:bg-[var(--ib-bad-text)]'
                : 'text-[var(--ib-text-muted)] hover:bg-[var(--ib-gray-100)] hover:text-[var(--ib-text)]'
            }`}
          >
            {conv.isListening ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
          </button>
        )}
        <button
          type="submit"
          disabled={!conv.input.trim() || conv.isSending}
          className="grid h-11 w-11 md:h-9 md:w-9 shrink-0 place-items-center rounded-xl bg-[var(--ib-blue-500)] text-white transition cursor-pointer hover:bg-[var(--ib-blue-600)] disabled:cursor-not-allowed disabled:opacity-35"
          aria-label="Send"
        >
          {conv.isSending ? <BrandDots mode="loading" size={4} /> : <ArrowUp className="h-4 w-4" />}
        </button>
      </form>
      <p className="mt-2 text-center text-[9px] text-[var(--ib-text-muted)]">AI can make mistakes. Review important details.</p>
    </div>
  );
}

function EmptyState({ conv }: { conv: Conversation }) {
  return (
    <div className="flex h-full flex-col justify-center pb-10">
      <BrandDots size={12} className="mb-5" />
      <h3 className="max-w-xs text-xl font-semibold tracking-tight text-[var(--ib-text)]">What can I help you move forward?</h3>
      <p className="mt-2 max-w-sm text-xs leading-5 text-[var(--ib-text-muted)]">
        AIPA can use your chats, calendar, appointments, memory, tasks, reminders, transcripts, documents,
        interviews and recent calls. Ask for current web information when web search is connected.
      </p>
      <div className="mt-6 flex flex-col gap-2">
        {STARTERS.map(starter => (
          <button
            key={starter}
            onClick={() => conv.send(starter)}
            className="group flex items-center justify-between rounded-2xl border border-[var(--ib-border)] bg-[var(--ib-surface-raised)] px-4 py-3 text-left text-xs text-[var(--ib-text)] transition cursor-pointer hover:border-[var(--ib-blue-500)]/35 hover:bg-[var(--ib-blue-50)]"
          >
            {starter}
            <ArrowUp className="h-3.5 w-3.5 rotate-45 text-[var(--ib-text-muted)] transition group-hover:text-[var(--ib-blue-500)]" />
          </button>
        ))}
      </div>
    </div>
  );
}

function MessageList({ conv }: { conv: Conversation }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const [pinnedToBottom, setPinnedToBottom] = useState(true);
  const [showJump, setShowJump] = useState(false);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    setPinnedToBottom(atBottom);
    setShowJump(!atBottom);
  };

  useEffect(() => {
    if (pinnedToBottom) endRef.current?.scrollIntoView({ behavior: 'smooth' });
    else setShowJump(true);
  }, [conv.messages, conv.isSending, pinnedToBottom]);

  const jumpToLatest = () => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
    setPinnedToBottom(true);
    setShowJump(false);
  };

  return (
    <div className="relative flex-1 min-h-0">
      <div ref={scrollRef} onScroll={onScroll} className="h-full overflow-y-auto overscroll-contain px-4 py-5">
        {conv.messages.length === 0 ? (
          <EmptyState conv={conv} />
        ) : (
          <div className="space-y-4">
            {conv.messages.map((message, index) => (
              <MessageBubble key={`${message.role}-${index}`} message={message} conv={conv} />
            ))}
            {conv.isSending && <TypingIndicator />}
            <div ref={endRef} />
          </div>
        )}
      </div>
      {showJump && (
        <button
          onClick={jumpToLatest}
          className="absolute bottom-3 left-1/2 -translate-x-1/2 flex items-center gap-1 rounded-full bg-[var(--ib-gray-900)]/85 backdrop-blur-sm px-3 py-1.5 text-[10px] font-semibold text-white shadow-[var(--ib-shadow-md)] cursor-pointer hover:bg-[var(--ib-gray-900)]"
        >
          <ChevronDown className="h-3 w-3" />Jump to latest
        </button>
      )}
    </div>
  );
}

function Header({ conv, onClose }: { conv: Conversation; onClose: () => void }) {
  return (
    <header className="flex items-center gap-3 border-b border-[var(--ib-border)] px-4 py-3 shrink-0">
      <BrandDots size={10} />
      <div className="min-w-0 flex-1">
        <h2 className="text-sm font-semibold text-[var(--ib-text)]">Ask AIPA</h2>
        <p className="text-[11px] text-[var(--ib-text-muted)]">Planning, writing and thinking partner</p>
      </div>
      {conv.messages.length > 0 && (
        <button onClick={conv.reset} className="rounded-xl w-11 h-11 flex items-center justify-center text-[var(--ib-text-muted)] hover:bg-[var(--ib-gray-100)] hover:text-[var(--ib-text)] cursor-pointer" title="Start over">
          <RotateCcw className="h-4 w-4" />
        </button>
      )}
      <button onClick={onClose} aria-label="Close" className="rounded-xl w-11 h-11 flex items-center justify-center text-[var(--ib-text-muted)] hover:bg-[var(--ib-gray-100)] hover:text-[var(--ib-text)] cursor-pointer">
        <X className="h-4 w-4" />
      </button>
    </header>
  );
}

// Bug-batch 2026-09-19, section 2: the launcher used to unmount entirely
// while the popup was open, so desktop had no visible way to close it except
// Esc or the header's own X. It now stays mounted at the SAME position and
// becomes a 56px circular close button on desktop (md+) -- unchanged on
// mobile, where the popup is a full sheet and there's nothing for a floating
// FAB to do underneath it, so it still hides while that sheet is open.
function Launcher({ open, onClick }: { open: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      aria-label={open ? 'Close AIPA' : 'Ask AIPA'}
      aria-expanded={open}
      className={`fixed z-[110] flex items-center justify-center gap-2 rounded-full bg-[var(--ib-blue-500)] text-white
        shadow-[var(--ib-shadow-lg)] transition-all hover:-translate-y-0.5 hover:shadow-[0_16px_40px_rgba(0,102,255,0.35)]
        active:scale-95 cursor-pointer w-14 h-14
        focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ib-focus)]
        ${open ? 'hidden md:flex' : 'flex md:w-auto md:h-auto md:px-5 md:py-3.5'}`}
      style={{
        right: 'calc(20px + env(safe-area-inset-right))',
        bottom: 'calc(20px + env(safe-area-inset-bottom))',
      }}
    >
      {open ? <X className="w-5 h-5 shrink-0" /> : <Sparkles className="w-5 h-5 md:w-4 md:h-4 shrink-0" />}
      {!open && <span className="hidden md:inline text-sm font-semibold">Ask AIPA</span>}
    </button>
  );
}

// Bug-batch 2026-09-19, section 2: below ~520px of viewport height (a small
// laptop window, or Windows display scaling eating most of it) there isn't
// enough room for a floating card even at its smallest -- same matchMedia
// pattern as useTheme.ts's system-preference listener and Modal.tsx's
// useReducedMotion shim, not a new mechanism.
function useCompactAIPA() {
  const [compact, setCompact] = useState(
    () => window.matchMedia?.('(max-height: 520px)').matches ?? false,
  );
  useEffect(() => {
    const mq = window.matchMedia('(max-height: 520px)');
    const handler = () => setCompact(mq.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);
  return compact;
}

interface AskAIPAProps {
  /** True on pre-join/in-meeting/InterviewView/auth -- the whole surface hides, launcher and popup alike. */
  hidden: boolean;
}

export default function AskAIPA({ hidden }: AskAIPAProps) {
  const conv = useAIPAConversation();
  const [open, setOpen] = useState(false);
  const overlayOpen = useAnyOverlayOpen();
  const keyboardOpen = useKeyboardOpen();
  const compact = useCompactAIPA();

  // Esc closes the desktop popup too (Modal already handles this for the
  // mobile sheet on its own).
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open]);

  if (hidden) return null;

  // Launcher-only visibility gates (see the module doc comment for why
  // these don't also apply to an already-open popup).
  const launcherHidden = overlayOpen || keyboardOpen;

  return (
    <>
      {/* Mobile: Modal's sheet variant, near full height. */}
      <div className="md:hidden">
        <Modal open={open} onClose={() => setOpen(false)} variant="sheet" fullHeight hideCloseButton aria-label="Ask AIPA">
          <div className="flex flex-col h-full">
            <Header conv={conv} onClose={() => setOpen(false)} />
            <MessageList conv={conv} />
            <Composer conv={conv} />
          </div>
        </Modal>
      </div>

      {/* Desktop: non-blocking anchored popup, not a Modal (aria-modal=false, no backdrop, no scroll lock). */}
      <div className="hidden md:block">
        <AnimatePresence>
          {open && (
            <motion.section
              role="dialog"
              aria-modal="false"
              aria-label="Ask AIPA"
              initial={{ opacity: 0, scale: 0.95, x: 8, y: 8 }}
              animate={{ opacity: 1, scale: 1, x: 0, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, x: 8, y: 8 }}
              transition={{ duration: 0.18, ease: [0.2, 0.8, 0.2, 1] }}
              style={compact ? {
                // Under ~520px tall there's no room for a floating card even
                // at its smallest -- dock it from just below the TopBar to
                // the bottom instead of shrinking further (section 2, "if
                // the viewport height is under ~520px, use the compact
                // mode... instead of shrinking further").
                transformOrigin: 'bottom right',
                right: 'calc(20px + env(safe-area-inset-right))',
                bottom: 'calc(20px + env(safe-area-inset-bottom))',
                top: 'calc(var(--topbar-h, 56px) + 8px)',
                width: 'min(420px, 100vw - 40px)',
              } : {
                // Height/width formulas measure the REAL TopBar height
                // (--topbar-h, published by TopBar.tsx) rather than a guessed
                // constant -- the popup used to overlap the TopBar on real
                // Windows viewport heights where browser chrome eats enough
                // of the window that the old "100dvh - 120px" guess wasn't
                // enough headroom. "116px" is the launcher zone + gaps below
                // the TopBar (88px bottom offset + 56px launcher - 28px
                // overlap with the popup's own bottom edge, tuned against
                // the spec's own worked example of ~172px total for a 56px
                // TopBar). Never above 640px regardless.
                transformOrigin: 'bottom right',
                right: 'calc(20px + env(safe-area-inset-right))',
                bottom: 'calc(88px + env(safe-area-inset-bottom))',
                width: 'min(420px, 100vw - 40px)',
                height: 'min(640px, calc(100dvh - var(--topbar-h, 56px) - 116px))',
              }}
              className="fixed z-[110] flex flex-col overflow-hidden rounded-[var(--ib-radius-xl)]
                bg-[var(--ib-surface-raised)] border border-[var(--ib-border)] shadow-[var(--ib-shadow-lg)]"
            >
              <Header conv={conv} onClose={() => setOpen(false)} />
              <MessageList conv={conv} />
              <Composer conv={conv} />
            </motion.section>
          )}
        </AnimatePresence>
      </div>

      {(open || !launcherHidden) && <Launcher open={open} onClick={() => setOpen(v => !v)} />}
    </>
  );
}
