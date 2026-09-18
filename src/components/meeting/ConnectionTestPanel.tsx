import React, { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, XCircle, AlertTriangle, Loader2, Circle, MinusCircle, RefreshCw, Copy, Check } from 'lucide-react';
import { runConnectionTest, INITIAL_STEPS, type Step, type StepStatus, type TestOutcome } from '../../lib/connectionTest';
import { dumpDiagnostics } from '../../lib/diagnostics';
import Modal from '../ui/Modal';
import Button from '../ui/Button';

const ICONS: Record<StepStatus, React.ReactNode> = {
  pending: <Circle className="w-4 h-4 text-[var(--ib-gray-400)]" />,
  running: <Loader2 className="w-4 h-4 text-[var(--ib-blue-500)] animate-spin" />,
  pass: <CheckCircle2 className="w-4 h-4 text-[var(--ib-good-dot)]" />,
  warn: <AlertTriangle className="w-4 h-4 text-[var(--ib-warn-dot)]" />,
  fail: <XCircle className="w-4 h-4 text-[var(--ib-bad-dot)]" />,
  skipped: <MinusCircle className="w-4 h-4 text-[var(--ib-gray-400)]" />,
};

// Verdict maps onto the same good/warn/bad fill+text pairing Badge uses --
// same idea (severity, at a glance), same tokens, just a banner instead of a pill.
const VERDICT_STYLE: Record<TestOutcome['verdict'], { fill: string; border: string; text: string; heading: string }> = {
  ok:            { fill: 'bg-[var(--ib-good-fill)]', border: 'border-[var(--ib-good-dot)]/30', text: 'text-[var(--ib-good-text)]', heading: 'Ready to go' },
  'relay-only':  { fill: 'bg-[var(--ib-warn-fill)]', border: 'border-[var(--ib-warn-dot)]/30', text: 'text-[var(--ib-warn-text)]', heading: 'Calls will work, but relayed' },
  blocked:       { fill: 'bg-[var(--ib-bad-fill)]', border: 'border-[var(--ib-bad-dot)]/30', text: 'text-[var(--ib-bad-text)]', heading: 'This network blocks video calls' },
  'no-devices':  { fill: 'bg-[var(--ib-bad-fill)]', border: 'border-[var(--ib-bad-dot)]/30', text: 'text-[var(--ib-bad-text)]', heading: 'Your camera or microphone is unavailable' },
};

/**
 * Runs the pre-join network check and shows what it found.
 *
 * Deliberately reachable *before* joining, which is the whole point: the answer to
 * "why does this not work on my college wifi" is useless once you are already sitting
 * in a black room. Starts automatically on mount, because someone who opened this
 * panel has already expressed the intent.
 *
 * Migrated onto the shared Modal/Button primitives 2026-09-18 -- gap found
 * during step 6's own review: this is opened from PreJoinScreen's "Test your
 * connection" link on the now-light lobby, but was still fully dark-hardcoded.
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
    <Modal open onClose={onClose} size="lg" aria-label="Connection test">
      <div className="px-5 pt-5 pb-1 pr-14">
        <h2 className="text-sm font-semibold text-[var(--ib-gray-900)]">Connection test</h2>
        <p className="text-[11px] text-[var(--ib-gray-600)] mt-0.5">Checks whether calls can work on this network</p>
      </div>

      <div className="p-5 flex flex-col gap-4">
        {verdict && outcome && (
          <div className={`${verdict.fill} ${verdict.border} ${verdict.text} border rounded-xl px-4 py-3 flex flex-col gap-1`}>
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
                <p className={`text-xs ${s.status === 'pending' ? 'text-[var(--ib-gray-600)]' : 'text-[var(--ib-gray-900)]'}`}>{s.label}</p>
                {s.detail && <p className="text-[11px] text-[var(--ib-gray-600)] leading-relaxed mt-0.5">{s.detail}</p>}
              </div>
            </li>
          ))}
        </ul>

        <div className="flex items-center gap-2 pt-1">
          <Button onClick={start} disabled={running} variant="secondary" size="sm" icon={<RefreshCw className={`w-3.5 h-3.5 ${running ? 'animate-spin' : ''}`} />}>
            {running ? 'Testing…' : 'Run again'}
          </Button>
          <Button onClick={copyReport} disabled={running} variant="secondary" size="sm" icon={copied ? <Check className="w-3.5 h-3.5 text-[var(--ib-good-dot)]" /> : <Copy className="w-3.5 h-3.5" />}>
            {copied ? 'Copied' : 'Copy report'}
          </Button>
        </div>

        <p className="text-[10px] text-[var(--ib-gray-600)] leading-relaxed">
          The report includes your browser version and recent connection events. Share it with
          whoever runs the network if calls are being blocked.
        </p>
      </div>
    </Modal>
  );
}
