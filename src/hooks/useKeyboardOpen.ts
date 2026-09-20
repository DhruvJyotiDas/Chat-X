import { useEffect, useState } from 'react';

/**
 * Phase 3, sub-unit 2. Extracted from Modal.tsx's 'centered' variant
 * (sub-unit 1), which needed the same heuristic and had it inlined --
 * pulled out here now that a second consumer (Ask AIPA's visibility rule)
 * needs it too. Same heuristic, same caveat: no native "is the on-screen
 * keyboard open" signal exists, so this treats window.visualViewport
 * shrinking below ~85% of window.innerHeight as the keyboard being up --
 * chosen to not misfire on the ordinary few px difference from browser
 * chrome (address bar, etc.) that isn't a keyboard at all.
 */
export function useKeyboardOpen(): boolean {
  const [keyboardOpen, setKeyboardOpen] = useState(false);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const check = () => setKeyboardOpen(vv.height < window.innerHeight * 0.85);
    check();
    vv.addEventListener('resize', check);
    return () => vv.removeEventListener('resize', check);
  }, []);

  return keyboardOpen;
}
