// AI Writing tools — the mode keys here MUST match rewriteModeInstructions in
// server/ai.go exactly. The server owns the actual instruction text (a fixed
// allow-list, not a client-supplied prompt — see that map's own comment for
// why); this file only owns the label shown in the composer's menu.
export interface RewriteMode {
  key: string;
  label: string;
}

export const REWRITE_MODES: RewriteMode[] = [
  { key: 'grammar', label: 'Fix grammar' },
  { key: 'clarity', label: 'Improve clarity' },
  { key: 'professional', label: 'Make professional' },
  { key: 'casual', label: 'Make casual' },
  { key: 'polite', label: 'Make polite' },
  { key: 'confident', label: 'Make confident' },
  { key: 'persuasive', label: 'Make persuasive' },
  { key: 'humorous', label: 'Make humorous' },
  { key: 'shorten', label: 'Shorten' },
  { key: 'expand', label: 'Expand' },
  { key: 'summarize', label: 'Summarize' },
  { key: 'simplify', label: 'Simplify' },
];
