import React, { useEffect, useRef, useState } from 'react';
import { ArrowUp, Bot, Check, Database, Globe2, LoaderCircle, Mic, MicOff, RotateCcw, Sparkles, X } from 'lucide-react';
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

interface Props {
  open: boolean;
  onClose: () => void;
}

const STARTERS = [
  "What's on my calendar this week?",
  'Catch me up on my recent chats',
  'What tasks, reminders and appointments need attention?',
  'Search the web for the latest technology news',
];

type PanelMessage = AIAssistantMessage & {
  context?: AIPAContextSummary;
  sources?: AIPAWebSource[];
  confirmationToken?: string;
  proposedAction?: AIPACalendarAction;
  actionResolved?: 'confirmed' | 'cancelled';
};

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

export default function AIAssistantPanel({ open, onClose }: Props) {
  const { currentUser } = useAuth();
  const [messages, setMessages] = useState<PanelMessage[]>([]);
  const [input, setInput] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [error, setError] = useState('');
  const endRef = useRef<HTMLDivElement>(null);
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
      // SpeechRecognitionEvent isn't in this project's lib.dom target — read
      // through the shape directly rather than widening the whole type above.
      // `results` is array-like (has .length + numeric indices) covering the
      // whole utterance from index 0, so the full transcript is just every
      // result's best alternative concatenated in order.
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

  useEffect(() => {
    if (open) endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [open, messages, isSending]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

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

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[120] flex justify-end" role="dialog" aria-modal="true" aria-label="Ask AIPA">
      <button className="absolute inset-0 bg-black/55 backdrop-blur-sm" onClick={onClose} aria-label="Close AIPA" />
      <section className="relative h-full w-full max-w-[440px] border-l border-white/10 bg-[#0b0d12]/95 shadow-[-24px_0_80px_rgba(0,0,0,.45)] backdrop-blur-2xl flex flex-col animate-[panel-in_.2s_ease-out]">
        <header className="flex items-center gap-3 border-b border-white/[0.08] px-5 py-4">
          <div className="relative grid h-10 w-10 place-items-center rounded-2xl bg-gradient-to-br from-[#6f8cff] to-[#8b5cf6] shadow-[0_8px_28px_rgba(111,140,255,.3)]">
            <Sparkles className="h-5 w-5 text-white" />
            <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border-2 border-[#0b0d12] bg-emerald-400" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-white">Ask AIPA</h2>
            <p className="text-[11px] text-[#9298aa]">Planning, writing and thinking partner</p>
          </div>
          {messages.length > 0 && (
            <button onClick={() => { setMessages([]); setError(''); }} className="rounded-xl p-2 text-[#7f879a] hover:bg-white/[0.06] hover:text-white" title="Start over">
              <RotateCcw className="h-4 w-4" />
            </button>
          )}
          <button onClick={onClose} className="rounded-xl p-2 text-[#7f879a] hover:bg-white/[0.06] hover:text-white" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-4 py-5">
          {messages.length === 0 ? (
            <div className="flex h-full flex-col justify-center pb-20">
              <div className="mb-5 grid h-12 w-12 place-items-center rounded-2xl border border-[#718cff]/20 bg-[#718cff]/10">
                <Bot className="h-6 w-6 text-[#91a5ff]" />
              </div>
              <h3 className="max-w-xs text-xl font-semibold tracking-tight text-white">What can I help you move forward?</h3>
              <p className="mt-2 max-w-sm text-xs leading-5 text-[#8f96a8]">
                AIPA can use your chats, calendar, appointments, memory, tasks, reminders, transcripts, documents,
                interviews and recent calls. Ask for current web information when web search is connected.
              </p>
              <div className="mt-6 flex flex-col gap-2">
                {STARTERS.map(starter => (
                  <button key={starter} onClick={() => send(starter)} className="group flex items-center justify-between rounded-2xl border border-white/[0.08] bg-white/[0.035] px-4 py-3 text-left text-xs text-[#cbd0dc] transition hover:border-[#718cff]/35 hover:bg-[#718cff]/[0.08] hover:text-white">
                    {starter}
                    <ArrowUp className="h-3.5 w-3.5 rotate-45 text-[#697187] transition group-hover:text-[#91a5ff]" />
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              {messages.map((message, index) => (
                <div key={`${message.role}-${index}`} className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[88%] rounded-2xl px-4 py-3 text-xs leading-5 ${
                    message.role === 'user'
                      ? 'rounded-br-md bg-[#6d7fff] text-white shadow-[0_8px_24px_rgba(89,106,255,.2)]'
                      : 'rounded-bl-md border border-white/[0.08] bg-white/[0.045] text-[#d9dce5]'
                  }`}>
                    {message.role === 'assistant'
                      ? <AIPAMessageContent text={message.text} sources={message.sources} />
                      : <span className="whitespace-pre-wrap">{message.text}</span>}
                    {message.role === 'assistant' && message.context && (
                      <div className="mt-3 border-t border-white/[0.07] pt-2.5">
                        {message.context.sources.length > 0 && (
                          <div className="flex flex-wrap items-center gap-1.5" aria-label="IB Connect sources used">
                            <Database className="mr-0.5 h-3 w-3 text-[#8290aa]" />
                            {message.context.sources.map(source => (
                              <span key={source.kind} className="rounded-md border border-white/[0.07] bg-black/15 px-1.5 py-0.5 text-[8px] font-medium text-[#929caf]">
                                {source.label} · {source.count}
                              </span>
                            ))}
                          </div>
                        )}
                        {message.context.unavailable.length > 0 && (
                          <p className="mt-2 flex items-start gap-1.5 text-[9px] leading-4 text-amber-200/70">
                            <Globe2 className="mt-0.5 h-3 w-3 shrink-0" />
                            Unavailable: {message.context.unavailable.join(', ')}
                          </p>
                        )}
                      </div>
                    )}
                    {message.role === 'assistant' && message.sources && message.sources.length > 0 && (
                      <div className="mt-3 space-y-1.5">
                        <p className="flex items-center gap-1.5 text-[9px] font-semibold uppercase tracking-[.12em] text-[#8995aa]"><Globe2 className="h-3 w-3" />Web sources</p>
                        {message.sources.map((source, sourceIndex) => (
                          <a key={source.url} href={source.url} target="_blank" rel="noreferrer" className="block rounded-xl border border-white/[0.07] bg-black/15 px-2.5 py-2 transition hover:border-[#718cff]/25 hover:bg-[#718cff]/[0.06]">
                            <span className="block truncate text-[10px] font-medium text-[#c7ceff]">[{sourceIndex + 1}] {source.title}</span>
                            <span className="mt-0.5 block truncate text-[8px] text-[#707b90]">{source.url}</span>
                          </a>
                        ))}
                      </div>
                    )}
                    {message.role === 'assistant' && message.confirmationToken && message.proposedAction && (
                      <div className="mt-3 rounded-xl border border-[#718cff]/20 bg-[#718cff]/[0.06] p-3">
                        <p className="text-[9px] font-bold uppercase tracking-[.12em] text-[#98a9ff]">Review calendar action</p>
                        <p className="mt-1.5 text-[11px] font-semibold text-white">{message.proposedAction.action === 'create' ? 'Create' : message.proposedAction.action === 'delete' ? 'Cancel' : 'Reschedule'} · {message.proposedAction.title}</p>
                        <p className="mt-1 text-[9px] text-[#a3adbf]">{message.proposedAction.date} · {message.proposedAction.startTime}–{message.proposedAction.endTime} · {message.proposedAction.timeZone}</p>
                        {!!message.proposedAction.attendeeNames?.length && <p className="mt-1 text-[9px] text-[#7f8a9d]">Invite: {message.proposedAction.attendeeNames.join(', ')}</p>}
                        {message.proposedAction.warning && <p className="mt-2 rounded-lg border border-amber-300/15 bg-amber-300/[0.06] px-2 py-1.5 text-[9px] leading-4 text-amber-100/80">{message.proposedAction.warning}</p>}
                        {message.actionResolved ? <p className="mt-2 flex items-center gap-1.5 text-[10px] font-semibold text-emerald-300"><Check className="h-3.5 w-3.5" />{message.actionResolved === 'confirmed' ? 'Confirmed and saved' : 'Cancelled'}</p> : <div className="mt-3 flex gap-2"><button onClick={async () => { try { const result = await api.confirmCalendarAction(message.confirmationToken!, true); setMessages(current => current.map(item => item === message ? { ...item, text: result.message, actionResolved: 'confirmed' } : item)); window.dispatchEvent(new CustomEvent('ibconnect_calendar_changed')); } catch (actionError) { setError(actionError instanceof Error ? actionError.message : 'Could not confirm the action.'); } }} className="rounded-lg bg-[#3978ff] px-3 py-1.5 text-[9px] font-semibold text-white">Confirm</button><button onClick={async () => { await api.confirmCalendarAction(message.confirmationToken!, false).catch(() => {}); setMessages(current => current.map(item => item === message ? { ...item, actionResolved: 'cancelled' } : item)); }} className="rounded-lg border border-white/[0.09] px-3 py-1.5 text-[9px] font-semibold text-[#a7b0c0]">Cancel</button></div>}
                      </div>
                    )}
                  </div>
                </div>
              ))}
              {isSending && (
                <div className="flex justify-start">
                  <div className="flex items-center gap-2 rounded-2xl rounded-bl-md border border-white/[0.08] bg-white/[0.045] px-4 py-3 text-xs text-[#a8afbf]">
                    <LoaderCircle className="h-3.5 w-3.5 animate-spin text-[#91a5ff]" /> AIPA is thinking…
                  </div>
                </div>
              )}
              <div ref={endRef} />
            </div>
          )}
        </div>

        <div className="border-t border-white/[0.08] bg-[#0b0d12]/90 p-4">
          {error && <p className="mb-2 rounded-xl border border-red-400/20 bg-red-400/[0.08] px-3 py-2 text-[11px] text-red-200">{error}</p>}
          <form onSubmit={event => { event.preventDefault(); void send(); }} className="flex items-end gap-2 rounded-2xl border border-white/10 bg-white/[0.045] p-2 focus-within:border-[#718cff]/50 focus-within:ring-2 focus-within:ring-[#718cff]/10">
            <textarea
              value={input}
              onChange={event => setInput(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  void send();
                }
              }}
              maxLength={4000}
              rows={1}
              placeholder={isListening ? 'Listening…' : 'Message AIPA…'}
              className="max-h-32 min-h-9 flex-1 resize-none bg-transparent px-2 py-2 text-xs text-white outline-none placeholder:text-[#666e82]"
            />
            {voiceSupported && (
              <button
                type="button"
                onClick={toggleVoice}
                disabled={isSending}
                aria-label={isListening ? 'Stop voice input' : 'Speak to AIPA'}
                title={isListening ? 'Stop voice input' : 'Speak to AIPA'}
                className={`grid h-9 w-9 shrink-0 place-items-center rounded-xl transition disabled:cursor-not-allowed disabled:opacity-35 ${
                  isListening
                    ? 'animate-pulse bg-red-500/90 text-white hover:bg-red-500'
                    : 'text-[#9298aa] hover:bg-white/[0.06] hover:text-white'
                }`}
              >
                {isListening ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
              </button>
            )}
            <button type="submit" disabled={!input.trim() || isSending} className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-[#718cff] text-white transition hover:bg-[#8094ff] disabled:cursor-not-allowed disabled:opacity-35" aria-label="Send">
              {isSending ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-4 w-4" />}
            </button>
          </form>
          <p className="mt-2 text-center text-[9px] text-[#5f6678]">AI can make mistakes. Review important details.</p>
        </div>
      </section>
    </div>
  );
}
