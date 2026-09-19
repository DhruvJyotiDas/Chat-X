import React, { useMemo, useState } from 'react';
import { BookOpen, CheckCircle2, ChevronRight, HelpCircle, Lightbulb, Search, ShieldCheck, X } from 'lucide-react';
import { faqCategories, FAQAnswers, featuredGuides } from '../../data';

interface SupportViewProps { searchFilter: string }

export default function SupportView({ searchFilter }: SupportViewProps) {
  const [selectedQuestion, setSelectedQuestion] = useState<string | null>(null);
  const query = searchFilter.trim().toLowerCase();
  const visibleCategories = useMemo(() => faqCategories.map(category => ({
    ...category,
    items: category.items.filter(item => !query || item.toLowerCase().includes(query) || FAQAnswers[item]?.toLowerCase().includes(query)),
  })).filter(category => category.items.length > 0), [query]);

  return (
    <div className="dashboard-surface flex-1 overflow-y-auto p-4 sm:p-6">
      {selectedQuestion && (
        <div className="fixed inset-0 z-[100] flex justify-end bg-[var(--ib-gray-900)]/40 backdrop-blur-sm" role="dialog" aria-modal="true">
          <button className="absolute inset-0" onClick={() => setSelectedQuestion(null)} aria-label="Close article" />
          <aside className="relative flex h-full w-full max-w-lg flex-col border-l border-[var(--ib-border)] bg-[var(--ib-surface-raised)] p-6 shadow-[var(--ib-shadow-lg)] pb-[calc(1.5rem+env(safe-area-inset-bottom))]">
            <div className="flex items-start justify-between gap-4">
              <span className="rounded-full border border-[var(--ib-blue-100)] bg-[var(--ib-blue-50)] px-3 py-1 text-[9px] font-bold uppercase tracking-[.14em] text-[var(--ib-blue-600)]">Help article</span>
              <button onClick={() => setSelectedQuestion(null)} aria-label="Close" className="w-11 h-11 flex items-center justify-center rounded-xl text-[var(--ib-text-muted)] hover:bg-[var(--ib-surface)] hover:text-[var(--ib-text)] cursor-pointer"><X className="h-4 w-4" /></button>
            </div>
            <h2 className="mt-7 text-2xl font-semibold tracking-tight text-[var(--ib-text)]">{selectedQuestion}</h2>
            <p className="mt-5 text-sm leading-7 text-[var(--ib-text-muted)]">{FAQAnswers[selectedQuestion]}</p>
            <div className="mt-6 flex gap-3 rounded-2xl border border-[var(--ib-warn-fill)] bg-[var(--ib-warn-fill)] p-4">
              <Lightbulb className="mt-0.5 h-5 w-5 shrink-0 text-[var(--ib-warn-text)]" />
              <p className="text-[11px] leading-5 text-[var(--ib-warn-text)]">Product behavior can change as security and AI controls are completed. The Security Center distinguishes active controls from roadmap items.</p>
            </div>
          </aside>
        </div>
      )}

      <div className="relative z-10 mx-auto grid max-w-6xl gap-5 xl:grid-cols-[1fr_310px]">
        <main className="flex flex-col gap-5">
          <section className="relative overflow-hidden rounded-[28px] border border-[var(--ib-border)] bg-[var(--ib-surface-raised)] p-6 sm:p-8 shadow-[var(--ib-shadow-sm)]">
            <div className="relative max-w-2xl">
              <div className="mb-3 flex items-center gap-2 text-[10px] font-bold uppercase tracking-[.18em] text-[var(--ib-blue-600)]"><BookOpen className="h-4 w-4" /> Help center</div>
              <h1 className="text-2xl font-semibold tracking-tight text-[var(--ib-text)] sm:text-3xl">Find a clear answer</h1>
              <p className="mt-3 text-sm leading-6 text-[var(--ib-text-muted)]">Practical guidance for conversations, meetings, AIPA and account security, based on features available in this build.</p>
              <div className="mt-5 flex items-center gap-2 rounded-2xl border border-[var(--ib-border)] bg-[var(--ib-surface)] px-4 py-3 text-xs text-[var(--ib-text-muted)]"><Search className="h-4 w-4 text-[var(--ib-blue-600)]" />Use the search field in the top bar to filter every article.</div>
            </div>
          </section>

          <section className="rounded-2xl border border-[var(--ib-border)] bg-[var(--ib-surface-raised)] p-5">
            <div className="mb-4"><h2 className="text-sm font-semibold text-[var(--ib-text)]">Browse topics</h2><p className="mt-1 text-[11px] text-[var(--ib-text-muted)]">Short answers without unsupported security promises</p></div>
            {visibleCategories.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-[var(--ib-border)] px-5 py-10 text-center text-xs text-[var(--ib-text-muted)]">No articles match "{searchFilter}".</div>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                {visibleCategories.map(category => (
                  <article key={category.id} className="rounded-2xl border border-[var(--ib-border)] bg-[var(--ib-surface)] p-4">
                    <h3 className="mb-3 text-[10px] font-bold uppercase tracking-[.14em] text-[var(--ib-text-muted)]">{category.title}</h3>
                    <div className="space-y-1">{category.items.map(item => <button key={item} onClick={() => setSelectedQuestion(item)} className="group flex w-full items-center justify-between gap-3 rounded-xl px-3 min-h-[44px] py-2.5 text-left text-[11px] text-[var(--ib-text)] transition hover:bg-[var(--ib-blue-50)] cursor-pointer"><span>{item}</span><ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--ib-text-muted)] transition group-hover:translate-x-0.5 group-hover:text-[var(--ib-blue-600)]" /></button>)}</div>
                  </article>
                ))}
              </div>
            )}
          </section>

          <section className="grid gap-3 md:grid-cols-3">
            {featuredGuides.map(guide => (
              <article key={guide.id} className="rounded-2xl border border-[var(--ib-border)] bg-[var(--ib-surface-raised)] p-5">
                <span className="mb-4 grid h-9 w-9 place-items-center rounded-xl bg-[var(--ib-blue-50)] text-[var(--ib-blue-600)]"><BookOpen className="h-4 w-4" /></span>
                <h3 className="text-xs font-semibold text-[var(--ib-text)]">{guide.title}</h3>
                <p className="mt-2 text-[10px] leading-5 text-[var(--ib-text-muted)]">{guide.detail}</p>
              </article>
            ))}
          </section>
        </main>

        <aside className="flex flex-col gap-4">
          <section className="rounded-2xl border border-[var(--ib-good-fill)] bg-[var(--ib-good-fill)] p-5">
            <div className="flex items-center gap-2 text-xs font-semibold text-[var(--ib-text)]"><ShieldCheck className="h-4 w-4 text-[var(--ib-good-text)]" />Current service model</div>
            <div className="mt-4 space-y-3">
              {['IB Account handles credentials', 'LiveKit provides meeting media', 'AIPA features require the configured AI service'].map(item => <div key={item} className="flex items-start gap-2 text-[10px] leading-4 text-[var(--ib-text)]"><CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--ib-good-text)]" />{item}</div>)}
            </div>
          </section>
          <section className="rounded-2xl border border-[var(--ib-border)] bg-[var(--ib-surface-raised)] p-5">
            <h2 className="flex items-center gap-2 text-xs font-semibold text-[var(--ib-text)]"><HelpCircle className="h-4 w-4 text-[var(--ib-blue-600)]" />Troubleshooting</h2>
            <ol className="mt-4 space-y-3 text-[10px] leading-5 text-[var(--ib-text-muted)]"><li><strong className="text-[var(--ib-text)]">1.</strong> Refresh once and check your network.</li><li><strong className="text-[var(--ib-text)]">2.</strong> Use the pre-call test for camera or microphone issues.</li><li><strong className="text-[var(--ib-text)]">3.</strong> If AIPA is unavailable, your core chat and meeting features continue to work.</li></ol>
          </section>
        </aside>
      </div>
    </div>
  );
}
