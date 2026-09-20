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
  return <div className="space-y-2">{items.map((item, index) => <div key={index} className="flex gap-2.5 text-xs leading-5 text-[var(--ib-text)]"><span className={`mt-2 h-1.5 w-1.5 shrink-0 rounded-full ${color}`} /><span>{item}</span></div>)}</div>;
}

// Kept as its own fixed-inset-0 wrapper rather than migrated onto the shared
// Modal (sub-unit 7): this needs a header pinned above a separately
// scrollable body, which Modal's single scrollable region doesn't support --
// same class of limitation disclosed for CalendarView's EventModal (pinned
// footer) in sub-unit 5.
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
    <div className="fixed inset-0 z-[100] grid place-items-center bg-[var(--ib-gray-900)]/40 p-3 backdrop-blur-sm" onMouseDown={event => event.target === event.currentTarget && onClose()}>
      <section className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-[28px] border border-[var(--ib-border)] bg-[var(--ib-surface-raised)] shadow-[var(--ib-shadow-lg)]">
        <header className="relative border-b border-[var(--ib-border)] px-5 py-4 sm:px-6">
          <div className="relative flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3"><span className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl border border-[var(--ib-blue-100)] bg-[var(--ib-blue-50)] text-[var(--ib-blue-600)]"><Sparkles className="h-5 w-5" /></span><div className="min-w-0"><p className="text-[10px] font-bold uppercase tracking-[.16em] text-[var(--ib-text-muted)]">AIPA meeting intelligence</p><h2 className="truncate text-base font-semibold text-[var(--ib-text)]">{title}</h2><p className="font-mono text-[9px] text-[var(--ib-text-muted)]">Room {roomId}</p></div></div>
            <button onClick={onClose} aria-label="Close meeting notes" className="grid h-11 w-11 md:h-9 md:w-9 shrink-0 place-items-center rounded-xl text-[var(--ib-text-muted)] transition hover:bg-[var(--ib-surface)] hover:text-[var(--ib-text)] cursor-pointer"><X className="h-4 w-4" /></button>
          </div>
        </header>

        <div className="overflow-y-auto p-5 sm:p-6">
          {loading && <div className="grid min-h-64 place-items-center text-center"><div><span className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-2xl bg-[var(--ib-blue-50)] text-[var(--ib-blue-600)]"><Loader2 className="h-5 w-5 animate-spin" /></span><p className="text-sm font-semibold text-[var(--ib-text)]">Reviewing the saved transcript</p><p className="mt-1 text-xs text-[var(--ib-text-muted)]">AIPA is extracting topics, decisions, and assignments.</p></div></div>}
          {!loading && error && <div className="rounded-2xl border border-[var(--ib-bad-fill)] bg-[var(--ib-bad-fill)] p-4"><div className="flex gap-3"><AlertTriangle className="h-5 w-5 shrink-0 text-[var(--ib-bad-text)]" /><div><p className="text-sm font-semibold text-[var(--ib-bad-text)]">Meeting notes are unavailable</p><p className="mt-1 text-xs leading-5 text-[var(--ib-bad-text)]">{error}</p><button onClick={() => void load()} className="mt-3 min-h-[44px] rounded-xl border border-[var(--ib-bad-fill)] bg-[var(--ib-bad-fill)] px-3 py-2 text-xs font-semibold text-[var(--ib-bad-text)] hover:opacity-80 cursor-pointer">Try again</button></div></div></div>}
          {!loading && summary && <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2"><div className="flex flex-wrap gap-1.5">{summary.attendees.map(name => <span key={name} className="rounded-full border border-[var(--ib-border)] bg-[var(--ib-surface)] px-2.5 py-1 text-[10px] text-[var(--ib-text-muted)]">{name}</span>)}</div><div className="flex gap-2"><button onClick={download} className="flex items-center gap-1.5 rounded-xl border border-[var(--ib-border)] bg-[var(--ib-surface)] px-3 min-h-[44px] py-2 text-[10px] font-semibold text-[var(--ib-text)] hover:bg-[var(--ib-gray-100)] cursor-pointer"><Download className="h-3.5 w-3.5" />Transcript</button><button onClick={() => void copy()} className="flex items-center gap-1.5 rounded-xl border border-[var(--ib-blue-100)] bg-[var(--ib-blue-50)] px-3 min-h-[44px] py-2 text-[10px] font-semibold text-[var(--ib-blue-600)] hover:bg-[var(--ib-blue-100)] cursor-pointer">{copied ? <Check className="h-3.5 w-3.5 text-[var(--ib-good-text)]" /> : <Clipboard className="h-3.5 w-3.5" />}{copied ? 'Copied' : 'Copy notes'}</button></div></div>
            <div className="rounded-2xl border border-[var(--ib-border)] bg-[var(--ib-surface)] p-4"><p className="mb-2 flex items-center gap-2 text-[10px] font-bold uppercase tracking-[.14em] text-[var(--ib-blue-600)]"><FileText className="h-4 w-4" />Overview</p><p className="text-sm leading-6 text-[var(--ib-text)]">{summary.summary}</p></div>
            <div className="grid gap-3 md:grid-cols-2">
              <div className="rounded-2xl border border-[var(--ib-border)] bg-[var(--ib-surface)] p-4"><p className="mb-3 flex items-center gap-2 text-[10px] font-bold uppercase tracking-[.14em] text-[var(--ib-warn-text)]"><Lightbulb className="h-4 w-4" />Key points</p>{summary.keyPoints.length ? <NotesList items={summary.keyPoints} color="bg-[var(--ib-warn-dot)]" /> : <p className="text-xs text-[var(--ib-text-muted)]">No key points detected.</p>}</div>
              <div className="rounded-2xl border border-[var(--ib-border)] bg-[var(--ib-surface)] p-4"><p className="mb-3 flex items-center gap-2 text-[10px] font-bold uppercase tracking-[.14em] text-[var(--ib-good-text)]"><CheckCircle2 className="h-4 w-4" />Decisions</p>{summary.decisions.length ? <NotesList items={summary.decisions} color="bg-[var(--ib-good-dot)]" /> : <p className="text-xs text-[var(--ib-text-muted)]">No decisions detected.</p>}</div>
            </div>
            <div className="rounded-2xl border border-[var(--ib-blue-100)] bg-[var(--ib-blue-50)] p-4"><p className="mb-3 flex items-center gap-2 text-[10px] font-bold uppercase tracking-[.14em] text-[var(--ib-blue-600)]"><ListChecks className="h-4 w-4" />Action items</p>{summary.actionItems.length ? <div className="space-y-2">{summary.actionItems.map((item, index) => <div key={index} className="flex items-start gap-3 rounded-xl border border-[var(--ib-border)] bg-[var(--ib-surface-raised)] px-3 py-2.5"><span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full border border-[var(--ib-blue-100)] text-[9px] font-bold text-[var(--ib-blue-600)]">{index + 1}</span><div><p className="text-xs leading-5 text-[var(--ib-text)]">{item.description}</p>{item.owner && item.owner.toLowerCase() !== 'unclear' && <p className="mt-0.5 text-[10px] text-[var(--ib-text-muted)]">Owner: {item.owner}</p>}</div></div>)}</div> : <p className="text-xs text-[var(--ib-text-muted)]">No action items detected.</p>}</div>
            <p className="text-[10px] leading-4 text-[var(--ib-text-muted)]">AI-generated notes can miss context. Review important decisions and assignments before sharing or acting on them.</p>
          </div>}
        </div>
      </section>
    </div>
  );
}
