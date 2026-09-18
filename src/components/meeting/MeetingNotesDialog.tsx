import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, Check, CheckCircle2, Clipboard, Download,
  FileText, Lightbulb, ListChecks, Loader2, Sparkles, X,
} from 'lucide-react';
import { api, type MeetingSummary, type MeetingTranscriptLine } from '../../lib/api';

interface Props {
  roomId: string;
  title: string;
  onClose: () => void;
}

function NotesList({ items, color }: { items: string[]; color: string }) {
  return <div className="space-y-2">{items.map((item, index) => <div key={index} className="flex gap-2.5 text-xs leading-5 text-[#d8dce5]"><span className={`mt-2 h-1.5 w-1.5 shrink-0 rounded-full ${color}`} /><span>{item}</span></div>)}</div>;
}

export default function MeetingNotesDialog({ roomId, title, onClose }: Props) {
  const [summary, setSummary] = useState<MeetingSummary | null>(null);
  const [transcript, setTranscript] = useState<MeetingTranscriptLine[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const transcriptResult = await api.getMeetingTranscript(roomId);
	  const lines = transcriptResult.lines ?? [];
      setTranscript(lines);
      if (!lines.length) throw new Error('No saved transcript is available. Turn on captions during the meeting to save spoken lines.');
      setSummary(await api.getMeetingSummary(roomId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load meeting intelligence.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, [roomId]);

  const summaryText = useMemo(() => {
    if (!summary) return '';
    return [
      title, summary.summary,
      summary.attendees.length ? `Attendees: ${summary.attendees.join(', ')}` : '',
      summary.keyPoints.length ? `Key points\n${summary.keyPoints.map(item => `• ${item}`).join('\n')}` : '',
      summary.decisions.length ? `Decisions\n${summary.decisions.map(item => `• ${item}`).join('\n')}` : '',
      summary.actionItems.length ? `Action items\n${summary.actionItems.map(item => `• ${item.description}${item.owner && item.owner.toLowerCase() !== 'unclear' ? ` — ${item.owner}` : ''}`).join('\n')}` : '',
    ].filter(Boolean).join('\n\n');
  }, [summary, title]);

  const copy = async () => {
    if (!summaryText) return;
    await navigator.clipboard.writeText(summaryText);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  };

  const download = () => {
    if (!transcript.length) return;
    const body = transcript.map(line => `[${new Date(line.createdAt).toLocaleTimeString()}] ${line.speakerName}: ${line.text}`).join('\n');
    const url = URL.createObjectURL(new Blob([body], { type: 'text/plain' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `transcript-${roomId}.txt`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="fixed inset-0 z-[100] grid place-items-center bg-black/70 p-3 backdrop-blur-md" onMouseDown={event => event.target === event.currentTarget && onClose()}>
      <section className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-[28px] border border-white/10 bg-[#10131a] shadow-[0_30px_100px_rgba(0,0,0,.65)]">
        <header className="relative overflow-hidden border-b border-white/[0.07] px-5 py-4 sm:px-6">
          <div className="pointer-events-none absolute -right-16 -top-20 h-48 w-48 rounded-full bg-[#718cff]/15 blur-3xl" />
          <div className="relative flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3"><span className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl border border-[#8ab4f8]/20 bg-[#8ab4f8]/10 text-[#aecbfa]"><Sparkles className="h-5 w-5" /></span><div className="min-w-0"><p className="text-[10px] font-bold uppercase tracking-[.16em] text-[#8490a5]">AIPA meeting intelligence</p><h2 className="truncate text-base font-semibold text-white">{title}</h2><p className="font-mono text-[9px] text-[#69758b]">Room {roomId}</p></div></div>
            <button onClick={onClose} className="grid h-9 w-9 shrink-0 place-items-center rounded-xl text-[#8c96a8] transition hover:bg-white/[0.06] hover:text-white" aria-label="Close meeting notes"><X className="h-4 w-4" /></button>
          </div>
        </header>

        <div className="overflow-y-auto p-5 sm:p-6">
          {loading && <div className="grid min-h-64 place-items-center text-center"><div><span className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-2xl bg-[#718cff]/10 text-[#aebaff]"><Loader2 className="h-5 w-5 animate-spin" /></span><p className="text-sm font-semibold text-white">Reviewing the saved transcript</p><p className="mt-1 text-xs text-[#7e8799]">AIPA is extracting topics, decisions, and assignments.</p></div></div>}
          {!loading && error && <div className="rounded-2xl border border-red-300/15 bg-red-300/[0.06] p-4"><div className="flex gap-3"><AlertTriangle className="h-5 w-5 shrink-0 text-red-300" /><div><p className="text-sm font-semibold text-red-100">Meeting notes are unavailable</p><p className="mt-1 text-xs leading-5 text-red-200/70">{error}</p><button onClick={() => void load()} className="mt-3 rounded-xl border border-red-200/15 bg-red-200/[0.06] px-3 py-2 text-xs font-semibold text-red-100 hover:bg-red-200/[0.1]">Try again</button></div></div></div>}
          {!loading && summary && <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2"><div className="flex flex-wrap gap-1.5">{summary.attendees.map(name => <span key={name} className="rounded-full border border-white/[0.07] bg-white/[0.035] px-2.5 py-1 text-[10px] text-[#aeb7c7]">{name}</span>)}</div><div className="flex gap-2"><button onClick={download} className="flex items-center gap-1.5 rounded-xl border border-white/[0.08] bg-white/[0.035] px-3 py-2 text-[10px] font-semibold text-[#b8c0ce] hover:bg-white/[0.065]"><Download className="h-3.5 w-3.5" />Transcript</button><button onClick={() => void copy()} className="flex items-center gap-1.5 rounded-xl border border-[#718cff]/20 bg-[#718cff]/10 px-3 py-2 text-[10px] font-semibold text-[#b7c2ff] hover:bg-[#718cff]/15">{copied ? <Check className="h-3.5 w-3.5 text-emerald-300" /> : <Clipboard className="h-3.5 w-3.5" />}{copied ? 'Copied' : 'Copy notes'}</button></div></div>
            <div className="rounded-2xl border border-white/[0.07] bg-gradient-to-br from-white/[0.045] to-white/[0.018] p-4"><p className="mb-2 flex items-center gap-2 text-[10px] font-bold uppercase tracking-[.14em] text-[#9eabff]"><FileText className="h-4 w-4" />Overview</p><p className="text-sm leading-6 text-[#e3e6ed]">{summary.summary}</p></div>
            <div className="grid gap-3 md:grid-cols-2">
              <div className="rounded-2xl border border-white/[0.07] bg-white/[0.025] p-4"><p className="mb-3 flex items-center gap-2 text-[10px] font-bold uppercase tracking-[.14em] text-amber-200"><Lightbulb className="h-4 w-4" />Key points</p>{summary.keyPoints.length ? <NotesList items={summary.keyPoints} color="bg-amber-200" /> : <p className="text-xs text-[#6f788a]">No key points detected.</p>}</div>
              <div className="rounded-2xl border border-white/[0.07] bg-white/[0.025] p-4"><p className="mb-3 flex items-center gap-2 text-[10px] font-bold uppercase tracking-[.14em] text-emerald-200"><CheckCircle2 className="h-4 w-4" />Decisions</p>{summary.decisions.length ? <NotesList items={summary.decisions} color="bg-emerald-300" /> : <p className="text-xs text-[#6f788a]">No decisions detected.</p>}</div>
            </div>
            <div className="rounded-2xl border border-[#8ab4f8]/15 bg-[#8ab4f8]/[0.045] p-4"><p className="mb-3 flex items-center gap-2 text-[10px] font-bold uppercase tracking-[.14em] text-[#aecbfa]"><ListChecks className="h-4 w-4" />Action items</p>{summary.actionItems.length ? <div className="space-y-2">{summary.actionItems.map((item, index) => <div key={index} className="flex items-start gap-3 rounded-xl border border-white/[0.05] bg-black/10 px-3 py-2.5"><span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full border border-[#8ab4f8]/30 text-[9px] font-bold text-[#aecbfa]">{index + 1}</span><div><p className="text-xs leading-5 text-[#e1e5ec]">{item.description}</p>{item.owner && item.owner.toLowerCase() !== 'unclear' && <p className="mt-0.5 text-[10px] text-[#7f899b]">Owner: {item.owner}</p>}</div></div>)}</div> : <p className="text-xs text-[#778195]">No action items detected.</p>}</div>
            <p className="text-[10px] leading-4 text-[#687386]">AI-generated notes can miss context. Review important decisions and assignments before sharing or acting on them.</p>
          </div>}
        </div>
      </section>
    </div>
  );
}
