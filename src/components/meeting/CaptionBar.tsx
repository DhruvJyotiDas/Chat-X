import { useEffect, useState } from 'react';
import { CaptionEvent, CaptionSize, CAPTION_SIZE_TEXT_CLASS, resolveCaptionText } from '../../lib/captions';

const STALE_MS = 4000;   // hide a speaker's line this long after their last event
const MAX_SPEAKERS = 2;  // Meet-style: show whoever's most recently/currently talking, not everyone at once

interface CaptionBarProps {
  liveCaptions: ReadonlyMap<string, CaptionEvent>;
  myLang: string | null;
  size: CaptionSize;
}

// Plain, centered, movie-subtitle styling — no per-control chrome of its own.
// Language and size are both set from the Live Captions tab (RightPanel) now,
// so this component has nothing left to be interactive about: it is a pure,
// pointer-events-none overlay, same as a real subtitle track would be.
export default function CaptionBar({ liveCaptions, myLang, size }: CaptionBarProps) {
  // Forces a re-render every second purely so STALE_MS filtering actually
  // expires old lines — liveCaptions itself only changes when a new event
  // arrives, which doesn't happen once someone stops talking.
  const [, forceTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const now = Date.now();
  const active = Array.from(liveCaptions.values())
    .filter((c) => c.text && now - c.receivedAt < STALE_MS)
    .sort((a, b) => b.receivedAt - a.receivedAt)
    .slice(0, MAX_SPEAKERS)
    .reverse(); // oldest of the shown ones on top, most recent at the bottom — reads like a conversation

  if (active.length === 0) return null;

  return (
    // Sits directly above the control bar (which is bottom-3 md:bottom-6,
    // ~2.5rem/3.5rem tall) with enough clearance to never overlap it.
    <div className="absolute bottom-20 md:bottom-24 left-1/2 -translate-x-1/2 z-10 w-[min(94vw,50rem)] flex flex-col items-center gap-1 pointer-events-none px-2">
      {active.map((evt) => (
        <div
          key={evt.peerId}
          className="bg-black/80 rounded-md px-4 py-1.5 md:px-5 md:py-2 shadow-2xl max-w-full text-center"
        >
          <span className="text-[#8ab4f8] font-semibold text-[0.8em] mr-1.5 align-baseline">{evt.peerName}:</span>
          <span className={`text-white leading-snug ${CAPTION_SIZE_TEXT_CLASS[size]} ${evt.isFinal ? '' : 'opacity-70'}`}>
            {resolveCaptionText(evt, myLang)}
          </span>
        </div>
      ))}
    </div>
  );
}
