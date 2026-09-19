import React from 'react';
import {
  Activity, CheckCircle2, Clock3, ExternalLink, Fingerprint,
  KeyRound, LockKeyhole, Server, ShieldCheck,
} from 'lucide-react';
import { ComplianceLog } from '../../types';

interface SecurityViewProps {
  logs: ComplianceLog[];
  onAddLog: (event: string, status: 'SUCCESS' | 'FLAGGED') => void;
  onClearLogs: () => void;
  searchFilter: string;
}

const safeguards = [
  { icon: Fingerprint, title: 'IB Account sign-in', detail: 'Authorization code flow with PKCE and nonce validation.', state: 'Active' },
  { icon: KeyRound, title: 'Password protection', detail: 'Passwords are salted and hashed with PBKDF2 before storage.', state: 'Active' },
  { icon: LockKeyhole, title: 'Short-lived media access', detail: 'LiveKit room tokens expire after the initial connection window.', state: 'Active' },
  { icon: Server, title: 'Private service credentials', detail: 'Database, identity, media and AI secrets are provided at runtime.', state: 'Active' },
];

const planned = [
  'Device and session management',
  'Workspace roles and permission policies',
  'Configurable transcript retention',
  'Audited data export and deletion',
];

export default function SecurityView({ logs, onClearLogs, searchFilter }: SecurityViewProps) {
  const filteredLogs = logs.filter(log =>
    log.event.toLowerCase().includes(searchFilter.toLowerCase()) ||
    log.actor.toLowerCase().includes(searchFilter.toLowerCase()) ||
    log.status.toLowerCase().includes(searchFilter.toLowerCase()),
  );

  return (
    <div className="dashboard-surface flex-1 overflow-y-auto p-4 sm:p-6">
      <div className="relative z-10 mx-auto flex max-w-6xl flex-col gap-5">
        <section className="relative overflow-hidden rounded-[28px] border border-[var(--ib-border)] bg-[var(--ib-surface-raised)] p-6 sm:p-8 shadow-[var(--ib-shadow-sm)]">
          <div className="relative max-w-2xl">
            <div className="mb-3 flex items-center gap-2 text-[10px] font-bold uppercase tracking-[.18em] text-[var(--ib-good-text)]"><ShieldCheck className="h-4 w-4" /> Security center</div>
            <h1 className="text-2xl font-semibold tracking-tight text-[var(--ib-text)] sm:text-3xl">Clear, verifiable protection</h1>
            <p className="mt-3 text-sm leading-6 text-[var(--ib-text-muted)]">This page describes safeguards that are active in IB Connect today. Features still being built are labeled clearly so you can make informed privacy decisions.</p>
          </div>
        </section>

        <section>
          <div className="mb-3 flex items-end justify-between">
            <div><h2 className="text-sm font-semibold text-[var(--ib-text)]">Active safeguards</h2><p className="mt-1 text-[11px] text-[var(--ib-text-muted)]">Controls backed by the current application</p></div>
            <span className="rounded-full border border-[var(--ib-good-fill)] bg-[var(--ib-good-fill)] px-2.5 py-1 text-[9px] font-bold uppercase tracking-wider text-[var(--ib-good-text)]">4 active</span>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {safeguards.map(({ icon: Icon, title, detail, state }) => (
              <article key={title} className="group rounded-2xl border border-[var(--ib-border)] bg-[var(--ib-surface-raised)] p-5 transition hover:-translate-y-0.5 hover:shadow-[var(--ib-shadow-sm)]">
                <div className="flex items-start gap-4">
                  <span className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-[var(--ib-good-fill)] text-[var(--ib-good-text)]"><Icon className="h-5 w-5" /></span>
                  <div className="min-w-0 flex-1"><div className="flex items-center justify-between gap-3"><h3 className="text-sm font-semibold text-[var(--ib-text)]">{title}</h3><span className="flex items-center gap-1 text-[9px] font-semibold text-[var(--ib-good-text)]"><CheckCircle2 className="h-3 w-3" />{state}</span></div><p className="mt-1.5 text-[11px] leading-5 text-[var(--ib-text-muted)]">{detail}</p></div>
                </div>
              </article>
            ))}
          </div>
        </section>

        <section className="grid gap-4 lg:grid-cols-[1.2fr_.8fr]">
          <div className="rounded-2xl border border-[var(--ib-border)] bg-[var(--ib-surface-raised)] p-5">
            <div className="flex items-start justify-between gap-4">
              <div><h2 className="flex items-center gap-2 text-sm font-semibold text-[var(--ib-text)]"><Activity className="h-4 w-4 text-[var(--ib-blue-600)]" />This session</h2><p className="mt-1 text-[11px] text-[var(--ib-text-muted)]">Local UI activity for this browser tab; this is not an immutable compliance audit.</p></div>
              {logs.length > 0 && <button onClick={onClearLogs} className="min-h-[44px] md:min-h-0 rounded-xl border border-[var(--ib-border)] px-3 py-1.5 text-[10px] font-semibold text-[var(--ib-text-muted)] hover:bg-[var(--ib-surface)] hover:text-[var(--ib-text)] cursor-pointer">Clear</button>}
            </div>
            <div className="mt-4 space-y-2">
              {filteredLogs.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-[var(--ib-border)] px-4 py-8 text-center text-[11px] text-[var(--ib-text-muted)]">No local activity to show.</div>
              ) : filteredLogs.slice(0, 20).map(log => (
                <div key={log.id} className="flex items-center gap-3 rounded-xl bg-[var(--ib-surface)] px-3 py-2.5"><span className={`h-2 w-2 rounded-full ${log.status === 'SUCCESS' ? 'bg-[var(--ib-good-dot)]' : 'bg-[var(--ib-warn-dot)]'}`} /><span className="min-w-0 flex-1 truncate text-[11px] text-[var(--ib-text)]">{log.event}</span><time className="text-[9px] text-[var(--ib-text-muted)]">{log.timestamp}</time></div>
              ))}
            </div>
          </div>

          <div className="rounded-2xl border border-[var(--ib-blue-100)] bg-[var(--ib-blue-50)] p-5">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-[var(--ib-text)]"><Clock3 className="h-4 w-4 text-[var(--ib-blue-600)]" />Planned controls</h2>
            <p className="mt-1 text-[11px] leading-5 text-[var(--ib-text-muted)]">These capabilities are on the security roadmap and are not active yet.</p>
            <div className="mt-4 space-y-2.5">{planned.map(item => <div key={item} className="flex items-center gap-2 text-[11px] text-[var(--ib-text)]"><span className="h-1.5 w-1.5 rounded-full bg-[var(--ib-blue-500)]" />{item}</div>)}</div>
            <a href="/auth/account" className="mt-5 flex items-center justify-between rounded-xl border border-[var(--ib-blue-100)] bg-[var(--ib-surface-raised)] px-3 py-2.5 text-[11px] font-semibold text-[var(--ib-blue-600)] hover:bg-[var(--ib-blue-100)] min-h-[44px]">Manage your IB Account <ExternalLink className="h-3.5 w-3.5" /></a>
          </div>
        </section>
      </div>
    </div>
  );
}
