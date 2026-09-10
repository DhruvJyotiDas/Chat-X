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
        <div className="fixed inset-0 z-[100] flex justify-end bg-black/60 backdrop-blur-sm" role="dialog" aria-modal="true">
          <button className="absolute inset-0" onClick={() => setSelectedQuestion(null)} aria-label="Close article" />
          <aside className="relative flex h-full w-full max-w-lg flex-col border-l border-white/[0.08] bg-[#0e1015]/98 p-6 shadow-2xl">
            <div className="flex items-start justify-between gap-4">
              <span className="rounded-full border border-[#718cff]/25 bg-[#718cff]/10 px-3 py-1 text-[9px] font-bold uppercase tracking-[.14em] text-[#aebaff]">Help article</span>
              <button onClick={() => setSelectedQuestion(null)} className="rounded-xl p-2 text-[#7d8597] hover:bg-white/[0.06] hover:text-white"><X className="h-4 w-4" /></button>
            </div>
            <h2 className="mt-7 text-2xl font-semibold tracking-tight text-white">{selectedQuestion}</h2>
            <p className="mt-5 text-sm leading-7 text-[#a7adba]">{FAQAnswers[selectedQuestion]}</p>
            <div className="mt-6 flex gap-3 rounded-2xl border border-amber-300/15 bg-amber-300/[0.055] p-4">
              <Lightbulb className="mt-0.5 h-5 w-5 shrink-0 text-amber-300" />
              <p className="text-[11px] leading-5 text-[#b8b9b4]">Product behavior can change as security and AI controls are completed. The Security Center distinguishes active controls from roadmap items.</p>
            </div>
          </aside>
        </div>
      )}

      <div className="relative z-10 mx-auto grid max-w-6xl gap-5 xl:grid-cols-[1fr_310px]">
        <main className="flex flex-col gap-5">
          <section className="relative overflow-hidden rounded-[28px] border border-white/[0.08] bg-gradient-to-br from-[#151925] via-[#11141b] to-[#0d0f14] p-6 sm:p-8">
            <div className="pointer-events-none absolute -right-20 -top-24 h-64 w-64 rounded-full bg-[#718cff]/15 blur-3xl" />
            <div className="relative max-w-2xl">
              <div className="mb-3 flex items-center gap-2 text-[10px] font-bold uppercase tracking-[.18em] text-[#aebaff]"><BookOpen className="h-4 w-4" /> Help center</div>
              <h1 className="text-2xl font-semibold tracking-tight text-white sm:text-3xl">Find a clear answer</h1>
              <p className="mt-3 text-sm leading-6 text-[#929aad]">Practical guidance for conversations, meetings, AIPA and account security, based on features available in this build.</p>
              <div className="mt-5 flex items-center gap-2 rounded-2xl border border-white/[0.08] bg-black/15 px-4 py-3 text-xs text-[#7f8799]"><Search className="h-4 w-4 text-[#91a5ff]" />Use the search field in the top bar to filter every article.</div>
            </div>
          </section>

          <section className="rounded-2xl border border-white/[0.07] bg-white/[0.025] p-5">
            <div className="mb-4"><h2 className="text-sm font-semibold text-white">Browse topics</h2><p className="mt-1 text-[11px] text-[#747d8e]">Short answers without unsupported security promises</p></div>
            {visibleCategories.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-white/[0.08] px-5 py-10 text-center text-xs text-[#697184]">No articles match “{searchFilter}”.</div>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                {visibleCategories.map(category => (
                  <article key={category.id} className="rounded-2xl border border-white/[0.07] bg-[#0e1015]/55 p-4">
                    <h3 className="mb-3 text-[10px] font-bold uppercase tracking-[.14em] text-[#8994ab]">{category.title}</h3>
                    <div className="space-y-1">{category.items.map(item => <button key={item} onClick={() => setSelectedQuestion(item)} className="group flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-left text-[11px] text-[#b9beca] transition hover:bg-[#718cff]/[0.08] hover:text-white"><span>{item}</span><ChevronRight className="h-3.5 w-3.5 shrink-0 text-[#586075] transition group-hover:translate-x-0.5 group-hover:text-[#91a5ff]" /></button>)}</div>
                  </article>
                ))}
              </div>
            )}
          </section>

          <section className="grid gap-3 md:grid-cols-3">
            {featuredGuides.map(guide => (
              <article key={guide.id} className="rounded-2xl border border-white/[0.07] bg-white/[0.025] p-5">
                <span className="mb-4 grid h-9 w-9 place-items-center rounded-xl bg-[#718cff]/10 text-[#aebaff]"><BookOpen className="h-4 w-4" /></span>
                <h3 className="text-xs font-semibold text-white">{guide.title}</h3>
                <p className="mt-2 text-[10px] leading-5 text-[#7d8597]">{guide.detail}</p>
              </article>
            ))}
          </section>
        </main>

        <aside className="flex flex-col gap-4">
          <section className="rounded-2xl border border-emerald-300/15 bg-emerald-300/[0.045] p-5">
            <div className="flex items-center gap-2 text-xs font-semibold text-white"><ShieldCheck className="h-4 w-4 text-emerald-300" />Current service model</div>
            <div className="mt-4 space-y-3">
              {['IB Account handles credentials', 'LiveKit provides meeting media', 'AIPA features require the configured AI service'].map(item => <div key={item} className="flex items-start gap-2 text-[10px] leading-4 text-[#a2aaa9]"><CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-300" />{item}</div>)}
            </div>
          </section>
          <section className="rounded-2xl border border-white/[0.07] bg-white/[0.025] p-5">
            <h2 className="flex items-center gap-2 text-xs font-semibold text-white"><HelpCircle className="h-4 w-4 text-[#91a5ff]" />Troubleshooting</h2>
            <ol className="mt-4 space-y-3 text-[10px] leading-5 text-[#858d9d]"><li><strong className="text-[#c4c9d3]">1.</strong> Refresh once and check your network.</li><li><strong className="text-[#c4c9d3]">2.</strong> Use the pre-call test for camera or microphone issues.</li><li><strong className="text-[#c4c9d3]">3.</strong> If AIPA is unavailable, your core chat and meeting features continue to work.</li></ol>
          </section>
        </aside>
      </div>
    </div>
  );
}
