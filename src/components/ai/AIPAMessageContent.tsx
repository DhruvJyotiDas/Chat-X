import React from 'react';
import type { AIPAWebSource } from '../../lib/api';

interface Props {
  text: string;
  sources?: AIPAWebSource[];
}

// A small, safe renderer for the subset of Markdown AIPA uses. It creates
// React nodes directly and never injects model HTML into the page.
function InlineContent({ text, sources = [] }: Props) {
  const tokenPattern = /(\*\*[^*\n]+\*\*|__[^_\n]+__|`[^`\n]+`|\[[^\]\n]+\]\(https?:\/\/[^\s)]+\)|\[\d+\])/g;
  const parts = text.split(tokenPattern).filter(Boolean);
  return (
    <>
      {parts.map((part, index) => {
        if ((part.startsWith('**') && part.endsWith('**')) || (part.startsWith('__') && part.endsWith('__'))) {
          return <strong key={index} className="font-semibold text-[var(--ib-text)]">{part.slice(2, -2)}</strong>;
        }
        if (part.startsWith('`') && part.endsWith('`')) {
          return <code key={index} className="rounded bg-[var(--ib-gray-100)] px-1 py-0.5 font-mono text-[0.92em] text-[var(--ib-text)]">{part.slice(1, -1)}</code>;
        }
        const link = part.match(/^\[([^\]]+)]\((https?:\/\/[^\s)]+)\)$/);
        if (link) {
          return <a key={index} href={link[2]} target="_blank" rel="noreferrer" className="font-medium text-[var(--ib-blue-600)] underline decoration-[var(--ib-blue-300)] underline-offset-2 hover:text-[var(--ib-blue-500)]">{link[1]}</a>;
        }
        const citation = part.match(/^\[(\d+)]$/);
        if (citation) {
          const source = sources[Number(citation[1]) - 1];
          if (source) {
            return <a key={index} href={source.url} target="_blank" rel="noreferrer" title={source.title} className="ml-0.5 inline-flex min-w-4 items-center justify-center rounded-md bg-[var(--ib-blue-50)] px-1 text-[9px] font-bold text-[var(--ib-blue-600)] hover:bg-[var(--ib-blue-100)]">[{citation[1]}]</a>;
          }
        }
        return <React.Fragment key={index}>{part}</React.Fragment>;
      })}
    </>
  );
}

export default function AIPAMessageContent({ text, sources = [] }: Props) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  return (
    <div className="space-y-2">
      {lines.map((rawLine, index) => {
        const line = rawLine.trim();
        if (!line) return <div key={index} className="h-1" aria-hidden="true" />;

        const heading = line.match(/^(#{1,3})\s+(.+)$/);
        if (heading) {
          return <p key={index} className="pt-1 text-[13px] font-semibold leading-5 text-[var(--ib-text)]"><InlineContent text={heading[2]} sources={sources} /></p>;
        }

        const bullet = line.match(/^[-*•]\s+(.+)$/);
        if (bullet) {
          return (
            <div key={index} className="flex items-start gap-2">
              <span className="mt-[8px] h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--ib-blue-500)]" />
              <p className="min-w-0 flex-1"><InlineContent text={bullet[1]} sources={sources} /></p>
            </div>
          );
        }

        const numbered = line.match(/^(\d+)[.)]\s+(.+)$/);
        if (numbered) {
          return (
            <div key={index} className="flex items-start gap-2">
              <span className="mt-0.5 grid h-4 min-w-4 shrink-0 place-items-center rounded-full bg-[var(--ib-blue-50)] px-1 text-[9px] font-bold text-[var(--ib-blue-600)]">{numbered[1]}</span>
              <p className="min-w-0 flex-1"><InlineContent text={numbered[2]} sources={sources} /></p>
            </div>
          );
        }

        return <p key={index}><InlineContent text={line} sources={sources} /></p>;
      })}
    </div>
  );
}
