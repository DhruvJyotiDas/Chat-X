import { useEffect, useRef } from 'react';

/**
 * Phase 3 foundation, used by Modal and any bottom sheet. `overflow: hidden`
 * on <body> alone does not stop scroll on iOS Safari -- the page can still
 * be dragged behind a fixed-position overlay. The standard iOS-safe fix is
 * to also fix <body> in place at its current scroll offset and restore that
 * offset on unlock, which is what this does.
 */
export function useScrollLock(locked: boolean) {
  const scrollY = useRef(0);

  useEffect(() => {
    if (!locked) return;

    scrollY.current = window.scrollY;
    const { body } = document;
    const prev = {
      position: body.style.position,
      top: body.style.top,
      left: body.style.left,
      right: body.style.right,
      width: body.style.width,
    };

    body.style.position = 'fixed';
    body.style.top = `-${scrollY.current}px`;
    body.style.left = '0';
    body.style.right = '0';
    body.style.width = '100%';

    return () => {
      body.style.position = prev.position;
      body.style.top = prev.top;
      body.style.left = prev.left;
      body.style.right = prev.right;
      body.style.width = prev.width;
      window.scrollTo(0, scrollY.current);
    };
  }, [locked]);
}
