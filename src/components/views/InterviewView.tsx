import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Upload, FileText, Github, Linkedin, Link as LinkIcon, Sparkles, Play, Square,
  ChevronRight, Loader2, AlertTriangle, CheckCircle2, Mic, Video, VideoOff,
  RotateCcw, Clock, TrendingUp, X, Award, ArrowLeft,
} from 'lucide-react';
import { interviewApi, fileToBase64 } from '../../lib/interviewApi';
import { useInterviewRecorder } from '../../hooks/useInterviewRecorder';
import { diag } from '../../lib/diagnostics';
import type {
  InterviewProfile, InterviewSession, InterviewAnswer, InterviewReport,
  InterviewEngineStatus, Seniority, InterviewKind,
} from '../../types';

type Stage = 'landing' | 'setup' | 'ready' | 'live' | 'report';

const SENIORITIES: { v: Seniority; label: string }[] = [
  { v: 'intern', label: 'Intern' }, { v: 'junior', label: 'Junior' },
  { v: 'mid', label: 'Mid' }, { v: 'senior', label: 'Senior' }, { v: 'staff', label: 'Staff' },
];
const KINDS: { v: InterviewKind; label: string; hint: string }[] = [
  { v: 'mixed', label: 'Mixed', hint: 'Behavioural + technical + design' },
  { v: 'behavioral', label: 'Behavioural', hint: 'Experience and working style' },
  { v: 'technical', label: 'Technical', hint: 'Depth in your listed skills' },
  { v: 'system_design', label: 'System design', hint: 'Architecture and trade-offs' },
];

const DIMENSION_LABELS: Record<string, string> = {
  communication: 'Communication', technical_depth: 'Technical depth',
  structure: 'Structure', confidence: 'Confidence', relevance: 'Relevance',
};

function scoreColor(n: number): string {
  if (n >= 8) return 'text-[var(--ib-good-dot)]';
  if (n >= 6) return 'text-[var(--ib-warn-text)]';
  return 'text-[var(--ib-bad-dot)]';
}
function scoreBar(n: number): string {
  if (n >= 8) return 'bg-[var(--ib-good-dot)]';
  if (n >= 6) return 'bg-[var(--ib-warn-dot)]';
  return 'bg-[var(--ib-bad-dot)]';
}

function ScoreRow({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center gap-3">
      <span className="text-[11px] text-[var(--ib-text-muted)] w-28 shrink-0">{label}</span>
      <div className="flex-1 h-1.5 rounded-full bg-[var(--ib-border)]/40 overflow-hidden">
        <div className={`h-full rounded-full ${scoreBar(value)}`} style={{ width: `${value * 10}%` }} />
      </div>
      <span className={`text-xs font-bold tabular-nums w-8 text-right ${scoreColor(value)}`}>
        {value.toFixed(1)}
      </span>
    </div>
  );
}

// ─── Engine banner ───────────────────────────────────────────────────────────
// The model lives on a separate GPU machine. Saying so plainly beats letting a
// user upload a CV, fill in a role and only then discover nothing works.
function EngineBanner({ status }: { status: InterviewEngineStatus | null }) {
  if (!status || status.ready) return null;
  const configuring = !status.configured;
  return (
    <div className={`flex items-start gap-3 rounded-xl border px-4 py-3 mb-5 ${
      configuring
        ? 'bg-[var(--ib-warn-dot)]/10 border-[var(--ib-warn-dot)]/30 text-[var(--ib-warn-text)]'
        : 'bg-[var(--ib-blue-500)]/10 border-[var(--ib-blue-500)]/30 text-[var(--ib-blue-500)]'}`}>
      {configuring ? <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                   : <Loader2 className="w-4 h-4 shrink-0 mt-0.5 animate-spin" />}
      <div className="text-xs leading-relaxed">
        <p className="font-semibold mb-0.5">
          {configuring ? 'AI interviewer not connected yet' : 'AI interviewer is starting up'}
        </p>
        <p className="opacity-90">
          {status.detail ?? 'Please try again in a moment.'}
          {configuring && ' You can still upload your CV and review what we extract.'}
        </p>
      </div>
    </div>
  );
}

export default function InterviewView() {
  const [stage, setStage] = useState<Stage>('landing');
  const [status, setStatus] = useState<InterviewEngineStatus | null>(null);
  const [profile, setProfile] = useState<InterviewProfile | null>(null);
  const [history, setHistory] = useState<InterviewSession[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [role, setRole] = useState('');
  const [seniority, setSeniority] = useState<Seniority>('junior');
  const [kind, setKind] = useState<InterviewKind>('mixed');
  const [count, setCount] = useState(5);

  const [session, setSession] = useState<InterviewSession | null>(null);
  const [qIndex, setQIndex] = useState(0);
  const [answers, setAnswers] = useState<InterviewAnswer[]>([]);
  const [report, setReport] = useState<InterviewReport | null>(null);
  const [lastAnswer, setLastAnswer] = useState<InterviewAnswer | null>(null);

  const rec = useInterviewRecorder();
  const fileRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  // ── Load ───────────────────────────────────────────────────────────────────
  useEffect(() => {
    interviewApi.status().then(setStatus).catch(() => setStatus(null));
    interviewApi.currentProfile().then(setProfile).catch(() => {});
    interviewApi.listSessions().then(setHistory).catch(() => {});
  }, []);

  useEffect(() => {
    if (stage === 'ready' || stage === 'live') rec.attachVideo(videoRef.current);
  }, [stage, rec]);

  // Release the camera whenever we leave the interview screens, so the hardware
  // light actually goes out rather than staying on behind a results page.
  useEffect(() => {
    if (stage !== 'ready' && stage !== 'live') rec.release();
  }, [stage, rec]);

  const speak = useCallback((text: string) => {
    // Browser speech, deliberately: the model's own Talker is not exposed
    // through the serving stack yet (gpu/CONTRACT.md §/v1/speak). This costs
    // nothing and can be swapped for real model audio without touching the UI.
    try {
      window.speechSynthesis?.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 0.98;
      window.speechSynthesis?.speak(u);
    } catch { /* speech is a nicety, never a requirement */ }
  }, []);

  // ── CV upload ──────────────────────────────────────────────────────────────
  const onFile = async (file: File) => {
    setError(null);
    setBusy('Reading your CV…');
    try {
      const b64 = await fileToBase64(file);
      const p = await interviewApi.uploadCV(file.name, b64);
      setProfile(p);
      diag('media', 'info', 'interview: CV parsed', { skills: p.skills.length, links: p.links.length });
      setStage('setup');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not read that CV');
    } finally {
      setBusy(null);
    }
  };

  const startSession = async () => {
    if (!profile || !role.trim()) return;
    setError(null);
    setBusy('Reading your CV and writing questions…');
    try {
      const s = await interviewApi.createSession({
        profileId: profile.id, role: role.trim(), seniority, kind, count,
      });
      setSession(s);
      setQIndex(0);
      setAnswers([]);
      setReport(null);
      setLastAnswer(null);
      setStage('ready');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start the interview');
    } finally {
      setBusy(null);
    }
  };

  const beginInterview = async () => {
    const okDev = await rec.openDevices();
    if (!okDev) return;
    setStage('live');
    const q = session?.questions[0];
    if (q) setTimeout(() => speak(q.text), 400);
  };

  const submitAnswer = async () => {
    if (!session) return;
    const q = session.questions[qIndex];
    const recorded = await rec.stop();
    if (!recorded) return;
    setBusy('Scoring your answer…');
    setError(null);
    try {
      const a = await interviewApi.submitAnswer(session.id, {
        questionId: q.id,
        audioWavB64: recorded.audioWavB64,
        framesB64: recorded.framesB64,
        durationSec: recorded.durationSec,
      });
      setAnswers((prev) => [...prev, a]);
      setLastAnswer(a);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not score that answer');
    } finally {
      setBusy(null);
    }
  };

  const nextQuestion = () => {
    if (!session) return;
    setLastAnswer(null);
    const next = qIndex + 1;
    if (next >= session.questions.length) { void finishInterview(); return; }
    setQIndex(next);
    setTimeout(() => speak(session.questions[next].text), 300);
  };

  const finishInterview = async () => {
    if (!session) return;
    setBusy('Putting your report together…');
    try {
      const r = await interviewApi.finish(session.id);
      setReport(r);
      rec.release();
      setStage('report');
      interviewApi.listSessions().then(setHistory).catch(() => {});
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not build the report');
    } finally {
      setBusy(null);
    }
  };

  const restart = () => {
    rec.release();
    setSession(null); setAnswers([]); setReport(null); setLastAnswer(null);
    setQIndex(0); setStage('landing'); setError(null);
  };

  // ─────────────────────────────────────────────────────────────────────────────

  const renderLanding = () => (
    <div className="flex flex-col gap-5">
      <EngineBanner status={status} />

      {!profile ? (
        <div
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) void onFile(f); }}
          className="border-2 border-dashed border-[var(--ib-border)] rounded-2xl p-8 sm:p-12 text-center bg-[var(--ib-surface-raised)]"
        >
          <div className="w-14 h-14 rounded-2xl bg-[var(--ib-blue-500)]/15 border border-[var(--ib-blue-500)]/30 flex items-center justify-center mx-auto mb-4">
            <Upload className="w-6 h-6 text-[var(--ib-blue-500)]" />
          </div>
          <h2 className="text-lg font-bold text-[var(--ib-text)] mb-1.5">Start with your CV</h2>
          <p className="text-xs text-[var(--ib-text-muted)] max-w-md mx-auto mb-5 leading-relaxed">
            We read your CV to write questions about <em>your</em> work rather than generic ones,
            and we&apos;ll pull in your public GitHub activity if you link it.
            PDF, DOCX or plain text.
          </p>
          <button
            onClick={() => fileRef.current?.click()}
            className="px-5 py-2.5 min-h-[44px] rounded-xl bg-[var(--ib-blue-500)] text-[#002661] text-xs font-bold hover:bg-[var(--ib-blue-500)]/90 transition-colors cursor-pointer"
          >
            Choose a file
          </button>
          <p className="text-[10px] text-[var(--ib-text-muted)] mt-3">or drop it here</p>
        </div>
      ) : (
        <div className="bg-[var(--ib-surface-raised)] border border-[var(--ib-border)] rounded-2xl p-5">
          <div className="flex items-start justify-between gap-3 mb-4">
            <div className="min-w-0">
              <h2 className="text-base font-bold text-[var(--ib-text)] truncate">
                {profile.fullName || 'Your profile'}
              </h2>
              {profile.headline && <p className="text-xs text-[var(--ib-text-muted)] truncate">{profile.headline}</p>}
              <p className="text-[10px] text-[var(--ib-text-muted)] mt-1 flex items-center gap-1.5">
                <FileText className="w-3 h-3" /> {profile.fileName}
              </p>
            </div>
            <button
              onClick={() => fileRef.current?.click()}
              className="text-[11px] text-[var(--ib-blue-500)] hover:text-[var(--ib-blue-500)] shrink-0 min-h-[36px] px-2 cursor-pointer"
            >
              Replace
            </button>
          </div>

          {profile.skills.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-4">
              {profile.skills.slice(0, 14).map((s) => (
                <span key={s} className="px-2 py-1 rounded-lg bg-[var(--ib-blue-500)]/10 border border-[var(--ib-blue-500)]/20 text-[10px] text-[var(--ib-blue-500)]">
                  {s}
                </span>
              ))}
            </div>
          )}

          {profile.links.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-4">
              {profile.links.map((l) => (
                <a key={l.url} href={l.url} target="_blank" rel="noreferrer"
                   className="flex items-center gap-1.5 px-2.5 py-1.5 min-h-[32px] rounded-lg bg-[var(--ib-gray-100)] border border-[var(--ib-border)] text-[10px] text-[var(--ib-text)] hover:border-[var(--ib-blue-500)] transition-colors">
                  {l.platform === 'github' ? <Github className="w-3 h-3" />
                    : l.platform === 'linkedin' ? <Linkedin className="w-3 h-3" />
                    : <LinkIcon className="w-3 h-3" />}
                  {l.handle || l.platform}
                </a>
              ))}
            </div>
          )}

          {profile.github && (
            <div className="rounded-xl bg-[var(--ib-gray-100)] border border-[var(--ib-border)]/60 p-3.5">
              {profile.github.unavailable ? (
                <p className="text-[11px] text-[var(--ib-text-muted)] flex items-center gap-2">
                  <Github className="w-3.5 h-3.5 shrink-0" /> {profile.github.unavailable}
                </p>
              ) : (
                <>
                  <p className="text-[11px] font-semibold text-[var(--ib-text)] flex items-center gap-2 mb-2">
                    <Github className="w-3.5 h-3.5" /> {profile.github.login}
                    <span className="text-[10px] font-normal text-[var(--ib-text-muted)]">
                      {profile.github.publicRepos} repos · {profile.github.totalStars} stars
                    </span>
                  </p>
                  {profile.github.topLanguages.length > 0 && (
                    <p className="text-[10px] text-[var(--ib-text-muted)]">
                      Mostly {profile.github.topLanguages.slice(0, 4).join(', ')}
                    </p>
                  )}
                </>
              )}
            </div>
          )}

          <button
            onClick={() => setStage('setup')}
            disabled={!status?.ready}
            className="mt-4 w-full py-3 min-h-[44px] rounded-xl bg-[var(--ib-blue-500)] text-[#002661] text-xs font-bold hover:bg-[var(--ib-blue-500)]/90 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-colors flex items-center justify-center gap-2"
          >
            <Sparkles className="w-4 h-4" /> Set up an interview
          </button>
        </div>
      )}

      {history.length > 0 && (
        <div>
          <h3 className="text-[11px] font-bold uppercase tracking-wider text-[var(--ib-text-muted)] mb-2.5">
            Past interviews
          </h3>
          <div className="flex flex-col gap-2">
            {history.map((h) => (
              <button
                key={h.id}
                onClick={async () => {
                  try {
                    const full = await interviewApi.getSession(h.id);
                    setSession(full); setAnswers(full.answers);
                    setReport(full.report ?? null); setStage('report');
                  } catch { /* stays on the list */ }
                }}
                className="w-full flex items-center gap-3 p-3 min-h-[52px] rounded-xl bg-[var(--ib-surface-raised)] border border-[var(--ib-border)] hover:border-[var(--ib-blue-500)]/50 transition-colors text-left cursor-pointer"
              >
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-semibold text-[var(--ib-text)] truncate">{h.role}</p>
                  <p className="text-[10px] text-[var(--ib-text-muted)]">
                    {h.seniority} · {h.kind.replace('_', ' ')} ·{' '}
                    {new Date(h.createdAt).toLocaleDateString()}
                  </p>
                </div>
                {typeof h.overallScore === 'number' ? (
                  <span className={`text-sm font-bold tabular-nums ${scoreColor(h.overallScore)}`}>
                    {h.overallScore.toFixed(1)}
                  </span>
                ) : (
                  <span className="text-[10px] text-[var(--ib-text-muted)]">{h.status.replace('_', ' ')}</span>
                )}
                <ChevronRight className="w-4 h-4 text-[var(--ib-text-muted)] shrink-0" />
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );

  const renderSetup = () => (
    <div className="flex flex-col gap-5 max-w-xl">
      <EngineBanner status={status} />
      <div>
        <label className="text-[10px] font-bold uppercase tracking-wider text-[var(--ib-text-muted)]">Role</label>
        <input
          value={role} onChange={(e) => setRole(e.target.value)} autoFocus
          placeholder="e.g. Backend Engineer"
          className="mt-1.5 w-full px-3 py-3 min-h-[44px] bg-[var(--ib-surface-raised)] border border-[var(--ib-border)] rounded-xl text-xs text-[var(--ib-text)] placeholder-[var(--ib-text-muted)]/60 focus:border-[var(--ib-blue-500)] outline-none"
        />
      </div>

      <div>
        <label className="text-[10px] font-bold uppercase tracking-wider text-[var(--ib-text-muted)]">Level</label>
        <div className="mt-1.5 flex flex-wrap gap-2">
          {SENIORITIES.map((s) => (
            <button key={s.v} onClick={() => setSeniority(s.v)}
              className={`px-3 py-2 min-h-[40px] rounded-xl text-[11px] font-semibold border transition-colors cursor-pointer ${
                seniority === s.v ? 'bg-[var(--ib-blue-500)]/20 border-[var(--ib-blue-500)] text-[var(--ib-blue-500)]'
                                  : 'bg-[var(--ib-gray-100)] border-[var(--ib-border)] text-[var(--ib-text-muted)] hover:text-[var(--ib-text)]'}`}>
              {s.label}
            </button>
          ))}
        </div>
      </div>

      <div>
        <label className="text-[10px] font-bold uppercase tracking-wider text-[var(--ib-text-muted)]">Focus</label>
        <div className="mt-1.5 grid sm:grid-cols-2 gap-2">
          {KINDS.map((k) => (
            <button key={k.v} onClick={() => setKind(k.v)}
              className={`px-3 py-2.5 min-h-[52px] rounded-xl text-left border transition-colors cursor-pointer ${
                kind === k.v ? 'bg-[var(--ib-blue-500)]/20 border-[var(--ib-blue-500)]' : 'bg-[var(--ib-gray-100)] border-[var(--ib-border)] hover:border-[var(--ib-blue-500)]/40'}`}>
              <p className={`text-[11px] font-semibold ${kind === k.v ? 'text-[var(--ib-blue-500)]' : 'text-[var(--ib-text)]'}`}>{k.label}</p>
              <p className="text-[10px] text-[var(--ib-text-muted)] mt-0.5">{k.hint}</p>
            </button>
          ))}
        </div>
      </div>

      <div>
        <label className="text-[10px] font-bold uppercase tracking-wider text-[var(--ib-text-muted)]">
          Questions — {count}
        </label>
        <input type="range" min={3} max={10} value={count}
          onChange={(e) => setCount(Number(e.target.value))}
          className="mt-2 w-full accent-[var(--ib-blue-500)]" />
        <p className="text-[10px] text-[var(--ib-text-muted)]">About {count * 2} minutes</p>
      </div>

      <div className="flex gap-3">
        <button onClick={() => setStage('landing')}
          className="px-4 py-3 min-h-[44px] rounded-xl bg-[var(--ib-gray-100)] border border-[var(--ib-border)] text-xs font-semibold text-[var(--ib-text)] hover:bg-[var(--ib-gray-200)] cursor-pointer transition-colors">
          Back
        </button>
        <button onClick={startSession} disabled={!role.trim() || !!busy || !status?.ready}
          className="flex-1 py-3 min-h-[44px] rounded-xl bg-[var(--ib-blue-500)] text-[#002661] text-xs font-bold hover:bg-[var(--ib-blue-500)]/90 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-colors flex items-center justify-center gap-2">
          {busy ? <><Loader2 className="w-4 h-4 animate-spin" /> {busy}</> : <>Generate questions <ChevronRight className="w-4 h-4" /></>}
        </button>
      </div>
    </div>
  );

  const renderReady = () => (
    <div className="flex flex-col gap-5 max-w-2xl">
      <h2 className="text-lg font-bold text-[var(--ib-text)]">Check your camera and mic</h2>
      <div className="relative rounded-2xl overflow-hidden bg-[var(--ib-gray-800)] border border-[var(--ib-border)] aspect-video">
        <video ref={videoRef} autoPlay playsInline muted className="w-full h-full object-cover" />
        {!rec.stream && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-[var(--ib-text-muted)]">
            <VideoOff className="w-8 h-8" />
            <span className="text-xs">Camera preview</span>
          </div>
        )}
      </div>
      {rec.error && (
        <p className="text-xs text-[var(--ib-bad-dot)] flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" /> {rec.error}
        </p>
      )}
      <div className="rounded-xl bg-[var(--ib-gray-100)] border border-[var(--ib-border)]/60 p-4">
        <p className="text-xs text-[var(--ib-text)] leading-relaxed">
          <strong className="text-[var(--ib-text)]">{session?.questions.length} questions</strong> for a{' '}
          {session?.seniority} {session?.role}. Each question is read aloud; press record, answer
          naturally, then stop. You&apos;ll get feedback after every answer.
        </p>
      </div>
      <div className="flex gap-3">
        <button onClick={restart}
          className="px-4 py-3 min-h-[44px] rounded-xl bg-[var(--ib-gray-100)] border border-[var(--ib-border)] text-xs font-semibold text-[var(--ib-text)] hover:bg-[var(--ib-gray-200)] cursor-pointer transition-colors">
          Cancel
        </button>
        <button onClick={beginInterview}
          className="flex-1 py-3 min-h-[44px] rounded-xl bg-[var(--ib-good-dot)] text-[#002661] text-xs font-bold hover:bg-[var(--ib-good-dot)]/90 cursor-pointer transition-colors flex items-center justify-center gap-2">
          <Play className="w-4 h-4" /> Start interview
        </button>
      </div>
    </div>
  );

  const renderLive = () => {
    if (!session) return null;
    const q = session.questions[qIndex];
    const progress = ((qIndex + (lastAnswer ? 1 : 0)) / session.questions.length) * 100;

    return (
      <div className="flex flex-col gap-4 max-w-3xl">
        <div>
          <div className="flex items-center justify-between text-[10px] text-[var(--ib-text-muted)] mb-1.5">
            <span>Question {qIndex + 1} of {session.questions.length}</span>
            <span className="uppercase tracking-wider">{q.category}</span>
          </div>
          <div className="h-1 rounded-full bg-[var(--ib-border)]/40 overflow-hidden">
            <div className="h-full bg-[var(--ib-blue-500)] transition-all duration-500" style={{ width: `${progress}%` }} />
          </div>
        </div>

        <div className="bg-[var(--ib-surface-raised)] border border-[var(--ib-border)] rounded-2xl p-5">
          <p className="text-sm sm:text-base text-[var(--ib-text)] leading-relaxed">{q.text}</p>
          {q.rationale && (
            <p className="text-[10px] text-[var(--ib-text-muted)] mt-2.5 italic">Why this question: {q.rationale}</p>
          )}
          <button onClick={() => speak(q.text)}
            className="mt-3 text-[10px] text-[var(--ib-blue-500)] hover:text-[var(--ib-blue-500)] min-h-[32px] cursor-pointer">
            Read it again
          </button>
        </div>

        <div className="relative rounded-2xl overflow-hidden bg-[var(--ib-gray-800)] border border-[var(--ib-border)] aspect-video">
          <video ref={videoRef} autoPlay playsInline muted className="w-full h-full object-cover" />
          {rec.isRecording && (
            <>
              <div className="absolute top-3 left-3 flex items-center gap-2 px-2.5 py-1 rounded-full bg-[var(--ib-bad-dot)] backdrop-blur-sm">
                <span className="w-2 h-2 rounded-full bg-white animate-pulse" />
                <span className="text-[10px] font-bold text-white tabular-nums">
                  {String(Math.floor(rec.elapsedSec / 60)).padStart(2, '0')}:
                  {String(rec.elapsedSec % 60).padStart(2, '0')}
                </span>
              </div>
              <div className="absolute bottom-3 left-3 right-3 h-1 rounded-full bg-black/40 overflow-hidden">
                <div className="h-full bg-[var(--ib-good-dot)] transition-[width] duration-75"
                     style={{ width: `${Math.min(100, rec.level * 160)}%` }} />
              </div>
            </>
          )}
        </div>

        {lastAnswer ? (
          <div className="bg-[var(--ib-surface-raised)] border border-[var(--ib-border)] rounded-2xl p-5 flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-bold text-[var(--ib-text)] flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 text-[var(--ib-good-dot)]" /> Answer scored
              </h3>
              <span className={`text-lg font-bold tabular-nums ${scoreColor(lastAnswer.overall)}`}>
                {lastAnswer.overall.toFixed(1)}
              </span>
            </div>
            <div className="flex flex-col gap-1.5">
              {Object.entries(lastAnswer.scores).map(([k, v]) => (
                <div key={k}><ScoreRow label={DIMENSION_LABELS[k] ?? k} value={Number(v)} /></div>
              ))}
            </div>
            <p className="text-[11px] text-[var(--ib-text)] leading-relaxed">{lastAnswer.feedback}</p>
            <div className="flex flex-wrap gap-3 text-[10px] text-[var(--ib-text-muted)]">
              <span className="flex items-center gap-1"><Clock className="w-3 h-3" /> {Math.round(lastAnswer.durationSec)}s</span>
              <span>{lastAnswer.wordsPerMinute} wpm</span>
              <span>{lastAnswer.fillerWords} filler words</span>
            </div>
            <button onClick={nextQuestion}
              className="mt-1 w-full py-3 min-h-[44px] rounded-xl bg-[var(--ib-blue-500)] text-[#002661] text-xs font-bold hover:bg-[var(--ib-blue-500)]/90 cursor-pointer transition-colors flex items-center justify-center gap-2">
              {qIndex + 1 >= session.questions.length
                ? <>Finish and see report <Award className="w-4 h-4" /></>
                : <>Next question <ChevronRight className="w-4 h-4" /></>}
            </button>
          </div>
        ) : (
          <div className="flex gap-3">
            <button onClick={() => void finishInterview()} disabled={answers.length === 0 || !!busy}
              className="px-4 py-3 min-h-[44px] rounded-xl bg-[var(--ib-gray-100)] border border-[var(--ib-border)] text-xs font-semibold text-[var(--ib-text)] hover:bg-[var(--ib-gray-200)] disabled:opacity-40 cursor-pointer transition-colors">
              End early
            </button>
            {!rec.isRecording ? (
              <button onClick={() => void rec.start()} disabled={!!busy}
                className="flex-1 py-3 min-h-[44px] rounded-xl bg-[var(--ib-good-dot)] text-[#002661] text-xs font-bold hover:bg-[var(--ib-good-dot)]/90 disabled:opacity-40 cursor-pointer transition-colors flex items-center justify-center gap-2">
                <Mic className="w-4 h-4" /> Record answer
              </button>
            ) : (
              <button onClick={submitAnswer} disabled={!!busy}
                className="flex-1 py-3 min-h-[44px] rounded-xl bg-[var(--ib-bad-dot)] text-[#601410] text-xs font-bold hover:bg-[var(--ib-bad-dot)]/90 disabled:opacity-40 cursor-pointer transition-colors flex items-center justify-center gap-2">
                {busy ? <><Loader2 className="w-4 h-4 animate-spin" /> {busy}</> : <><Square className="w-4 h-4" /> Stop and submit</>}
              </button>
            )}
          </div>
        )}
      </div>
    );
  };

  const renderReport = () => {
    const r = report;
    return (
      <div className="flex flex-col gap-5 max-w-3xl">
        <button onClick={restart}
          className="flex items-center gap-1.5 text-[11px] text-[var(--ib-blue-500)] hover:text-[var(--ib-blue-500)] min-h-[36px] self-start cursor-pointer">
          <ArrowLeft className="w-3.5 h-3.5" /> Back to interviews
        </button>

        {r && (
          <div className="bg-[var(--ib-surface-raised)] border border-[var(--ib-border)] rounded-2xl p-5 sm:p-6">
            <div className="flex items-start justify-between gap-4 mb-4">
              <div className="min-w-0">
                <p className="text-[10px] uppercase tracking-wider text-[var(--ib-text-muted)]">Overall</p>
                <p className={`text-4xl font-bold tabular-nums ${scoreColor(r.overall)}`}>
                  {r.overall.toFixed(1)}<span className="text-lg text-[var(--ib-text-muted)]">/10</span>
                </p>
                <p className="text-xs font-semibold text-[var(--ib-text)] mt-1">{r.verdict}</p>
              </div>
              <div className="w-12 h-12 rounded-2xl bg-[var(--ib-blue-500)]/15 border border-[var(--ib-blue-500)]/30 flex items-center justify-center shrink-0">
                <TrendingUp className="w-5 h-5 text-[var(--ib-blue-500)]" />
              </div>
            </div>

            <p className="text-xs text-[var(--ib-text)] leading-relaxed mb-4">{r.summary}</p>

            {r.scores && (
              <div className="flex flex-col gap-1.5 mb-4">
                {Object.entries(r.scores).map(([k, v]) => (
                  <div key={k}><ScoreRow label={DIMENSION_LABELS[k] ?? k} value={Number(v)} /></div>
                ))}
              </div>
            )}

            <div className="grid sm:grid-cols-2 gap-3">
              <div className="rounded-xl bg-[var(--ib-good-dot)]/5 border border-[var(--ib-good-dot)]/20 p-3.5">
                <p className="text-[10px] font-bold uppercase tracking-wider text-[var(--ib-good-dot)] mb-2">Strengths</p>
                <ul className="flex flex-col gap-1.5">
                  {r.strengths.map((s, i) => (
                    <li key={i} className="text-[11px] text-[var(--ib-text)] leading-relaxed">{s}</li>
                  ))}
                </ul>
              </div>
              <div className="rounded-xl bg-[var(--ib-warn-dot)]/5 border border-[var(--ib-warn-dot)]/20 p-3.5">
                <p className="text-[10px] font-bold uppercase tracking-wider text-[var(--ib-warn-text)] mb-2">Work on</p>
                <ul className="flex flex-col gap-1.5">
                  {r.improvements.map((s, i) => (
                    <li key={i} className="text-[11px] text-[var(--ib-text)] leading-relaxed">{s}</li>
                  ))}
                </ul>
              </div>
            </div>

            {r.focus_areas?.length > 0 && (
              <div className="mt-4">
                <p className="text-[10px] font-bold uppercase tracking-wider text-[var(--ib-text-muted)] mb-2">Focus next on</p>
                <div className="flex flex-wrap gap-1.5">
                  {r.focus_areas.map((f) => (
                    <span key={f} className="px-2.5 py-1 rounded-lg bg-[var(--ib-blue-500)]/10 border border-[var(--ib-blue-500)]/20 text-[10px] text-[var(--ib-blue-500)]">{f}</span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {answers.length > 0 && (
          <div>
            <h3 className="text-[11px] font-bold uppercase tracking-wider text-[var(--ib-text-muted)] mb-2.5">
              Question by question
            </h3>
            <div className="flex flex-col gap-2.5">
              {answers.map((a, i) => {
                const q = session?.questions.find((x) => x.id === a.questionId);
                return (
                  <div key={a.questionId} className="bg-[var(--ib-surface-raised)] border border-[var(--ib-border)] rounded-xl p-4">
                    <div className="flex items-start justify-between gap-3 mb-2">
                      <p className="text-xs font-semibold text-[var(--ib-text)] leading-relaxed">
                        {i + 1}. {q?.text ?? 'Question'}
                      </p>
                      <span className={`text-sm font-bold tabular-nums shrink-0 ${scoreColor(a.overall)}`}>
                        {a.overall.toFixed(1)}
                      </span>
                    </div>
                    <p className="text-[11px] text-[var(--ib-text)] leading-relaxed mb-2">{a.feedback}</p>
                    <details className="group">
                      <summary className="text-[10px] text-[var(--ib-text-muted)] cursor-pointer hover:text-[var(--ib-blue-500)] min-h-[28px] flex items-center">
                        Your answer
                      </summary>
                      <p className="text-[10px] text-[var(--ib-text-muted)] leading-relaxed mt-1.5 pl-2 border-l-2 border-[var(--ib-border)]">
                        {a.transcript}
                      </p>
                    </details>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <button onClick={restart}
          className="w-full py-3 min-h-[44px] rounded-xl bg-[var(--ib-blue-500)] text-[#002661] text-xs font-bold hover:bg-[var(--ib-blue-500)]/90 cursor-pointer transition-colors flex items-center justify-center gap-2">
          <RotateCcw className="w-4 h-4" /> Practise again
        </button>
      </div>
    );
  };

  return (
    <div className="p-4 sm:p-6 lg:p-8 overflow-y-auto h-full">
      <input
        ref={fileRef} type="file" accept=".pdf,.docx,.txt,.md,application/pdf,text/plain"
        className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) void onFile(f); e.target.value = ''; }}
      />

      {error && (
        <div className="flex items-start gap-3 rounded-xl border border-[var(--ib-bad-dot)]/40 bg-[var(--ib-bad-fill)]/15 px-4 py-3 mb-4 max-w-3xl">
          <AlertTriangle className="w-4 h-4 text-[var(--ib-bad-dot)] shrink-0 mt-0.5" />
          <p className="text-xs text-[var(--ib-bad-dot)] flex-1 leading-relaxed">{error}</p>
          <button onClick={() => setError(null)} aria-label="Dismiss"
            className="w-7 h-7 rounded-lg flex items-center justify-center text-[var(--ib-bad-dot)]/70 hover:text-white cursor-pointer shrink-0">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {busy && stage === 'landing' && (
        <p className="text-xs text-[var(--ib-blue-500)] flex items-center gap-2 mb-4">
          <Loader2 className="w-4 h-4 animate-spin" /> {busy}
        </p>
      )}

      {stage === 'landing' && renderLanding()}
      {stage === 'setup' && renderSetup()}
      {stage === 'ready' && renderReady()}
      {stage === 'live' && renderLive()}
      {stage === 'report' && renderReport()}
    </div>
  );
}
