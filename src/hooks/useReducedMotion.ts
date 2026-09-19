import { useEffect, useState } from 'react';

// motion's useReducedMotion isn't exported by the installed version of the
// package (checked directly, not assumed, in Modal.tsx originally) — same
// matchMedia read useTheme.ts already uses for prefers-color-scheme, applied
// to prefers-reduced-motion. Extracted here (bug-batch 2026-09-19, section 3)
// so Switch.tsx can reuse it instead of a third private copy; Modal.tsx's own
// copy removed in the same commit, behavior unchanged.
export function useReducedMotion() {
  const [reduced, setReduced] = useState(
    () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
  );
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const handler = () => setReduced(mq.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);
  return reduced;
}
