import React, { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, XCircle, AlertTriangle, Loader2, Circle, MinusCircle, X, RefreshCw, Copy, Check } from 'lucide-react';
import { runConnectionTest, INITIAL_STEPS, type Step, type StepStatus, type TestOutcome } from '../../lib/connectionTest';
import { dumpDiagnostics } from '../../lib/diagnostics';

const ICONS: Record<StepStatus, React.ReactNode> = {
  pending: <Circle className="w-4 h-4 text-[#5f6368]" />,
  running: <Loader2 className="w-4 h-4 text-[#8ab4f8] animate-spin" />,
  pass: <CheckCircle2 className="w-4 h-4 text-[#81c995]" />,
  warn: <AlertTriangle className="w-4 h-4 text-[#fdd663]" />,
  fail: <XCircle className="w-4 h-4 text-[#f28b82]" />,
  skipped: <MinusCircle className="w-4 h-4 text-[#5f6368]" />,
};

const VERDICT_STYLE: Record<TestOutcome['verdict'], { bg: string; border: string; text: string; heading: string }> = {
  ok:            { bg: 'bg-[#1e3229]', border: 'border-[#81c995]/40', text: 'text-[#c8e6d0]', heading: 'Ready to go' },
  'relay-only':  { bg: 'bg-[#3d3323]', border: 'border-[#fdd663]/40', text: 'text-[#f8e7bd]', heading: 'Calls will work, but relayed' },
  blocked:       { bg: 'bg-[#3c2b28]', border: 'border-[#f28b82]/40', text: 'text-[#f6d5d2]', heading: 'This network blocks video calls' },
  'no-devices':  { bg: 'bg-[#3c2b28]', border: 'border-[#f28b82]/40', text: 'text-[#f6d5d2]', heading: 'Your camera or microphone is unavailable' },
};

/**
 * Runs the pre-join network check and shows what it found.
 *
 * Deliberately reachable *before* joining, which is the whole point: the answer to
 * "why does this not work on my college wifi" is useless once you are already sitting
 * in a black room. Starts automatically on mount, because someone who opened this
 * panel has already expressed the intent.
 */
export default function ConnectionTestPanel({ onClose }: { onClose: () => void }) {
  const [steps, setSteps] = useState<Step[]>(() => INITIAL_STEPS.map((s) => ({ ...s })));
  const [outcome, setOutcome] = useState<TestOutcome | null>(null);
  const [running, setRunning] = useState(false);
  const [copied, setCopied] = useState(false);

  const start = useCallback(() => {
    setOutcome(null);
    setSteps(INITIAL_STEPS.map((s) => ({ ...s })));
    setRunning(true);
    runConnectionTest(setSteps)
      .then(setOutcome)
      .catch(() => {
        // The runner handles its own step failures; reaching here means something
        // unexpected threw, and leaving the panel spinning forever would be worse
        // than an honest dead end.
        setOutcome({
          steps: [], verdict: 'blocked',
          summary: 'The test could not finish. Reload the page and try again.',
        });
      })
      .finally(() => setRunning(false));
  }, []);

  useEffect(() => { start(); }, [start]);

  // A report worth pasting into a message to whoever administers the network. Includes
  // the diagnostics ring buffer, which is where the signalling and ICE detail lives.
  const copyReport = () => {
    const lines = [
      `IB Connect connection test — ${new Date().toISOString()}`,
      `User agent: ${navigator.userAgent}`,
      outcome ? `Verdict: ${outcome.verdict} — ${outcome.summary}` : 'Verdict: incomplete',
      outcome?.path ? `Media path: ${outcome.path}` : '',
      '',
      ...steps.map((s) => `[${s.status.toUpperCase()}] ${s.label}${s.detail ? ` — ${s.detail}` : ''}`),
      '',
      'Recent diagnostics:',
      ...dumpDiagnostics().slice(-40).map((e) => `  ${e.t} ${e.cat}/${e.level} ${e.event}`),
    ];
    navigator.clipboard.writeText(lines.filter(Boolean).join('\n')).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    }).catch(() => {});
  };

  const verdict = outcome ? VERDICT_STYLE[outcome.verdict] : null;

  return (
    <div className="fixed inset-0 z-[10050] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="w-full max-w-lg max-h-[90vh] overflow-y-auto bg-[#202124] border border-[#5f6368] rounded-2xl shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#3c4043] sticky top-0 bg-[#202124]">
          <div>
            <h2 className="text-sm font-semibold text-[#e8eaed]">Connection test</h2>
            <p className="text-[11px] text-[#9aa0a6] mt-0.5">Checks whether calls can work on this network</p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close connection test"
            className="w-8 h-8 rounded-lg flex items-center justify-center text-[#9aa0a6] hover:text-[#e8eaed] hover:bg-[#3c4043] transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 flex flex-col gap-4">
          {verdict && outcome && (
            <div className={`${verdict.bg} ${verdict.border} ${verdict.text} border rounded-xl px-4 py-3 flex flex-col gap-1`}>
              <p className="text-xs font-bold">{verdict.heading}</p>
              <p className="text-[11px] leading-relaxed">{outcome.summary}</p>
              {outcome.path && (
                <p className="text-[10px] font-mono opacity-70 mt-1">Media path: {outcome.path}</p>
              )}
            </div>
          )}

          <ul className="flex flex-col gap-2.5">
            {steps.map((s) => (
              <li key={s.id} className="flex items-start gap-3">
                <span className="mt-0.5 shrink-0">{ICONS[s.status]}</span>
                <div className="flex-1 min-w-0">
                  <p className={`text-xs ${s.status === 'pending' ? 'text-[#9aa0a6]' : 'text-[#e8eaed]'}`}>{s.label}</p>
                  {s.detail && <p className="text-[11px] text-[#9aa0a6] leading-relaxed mt-0.5">{s.detail}</p>}
                </div>
              </li>
            ))}
          </ul>

          <div className="flex items-center gap-2 pt-1">
            <button
              onClick={start}
              disabled={running}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[#3c4043] text-[#e8eaed] text-xs font-semibold hover:bg-[#4a4d51] disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-colors"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${running ? 'animate-spin' : ''}`} />
              {running ? 'Testing…' : 'Run again'}
            </button>
            <button
              onClick={copyReport}
              disabled={running}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[#3c4043] text-[#e8eaed] text-xs font-semibold hover:bg-[#4a4d51] disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-colors"
            >
              {copied ? <Check className="w-3.5 h-3.5 text-[#81c995]" /> : <Copy className="w-3.5 h-3.5" />}
              {copied ? 'Copied' : 'Copy report'}
            </button>
          </div>

          <p className="text-[10px] text-[#9aa0a6] leading-relaxed">
            The report includes your browser version and recent connection events. Share it with
            whoever runs the network if calls are being blocked.
          </p>
        </div>
      </div>
    </div>
  );
}
