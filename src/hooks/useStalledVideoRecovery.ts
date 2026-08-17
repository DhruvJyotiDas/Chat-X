// Detects a remote tile that is decoding nothing while `useHasVideo` still says it
// should be: a live, unmuted video track whose <video> element has stopped advancing.
//
// This is the specific failure `useHasVideo` cannot see. `useHasVideo` answers "does a
// live track exist" — true the instant `ontrack` fires and stays true for as long as
// the track is `live`/unmuted, regardless of whether any of its packets are actually
// being decoded. In a mesh call each viewer has an independent P2P (or TURN-relayed)
// path to every peer, so one specific pairwise link can lose enough packets that the
// decoder never gets a usable keyframe — RTCP keepalive is enough to keep
// `iceConnectionState` at 'connected' and the track at 'live', but `<video>` just sits
// on its last frame. Indistinguishable from every other tile without watching playback
// actually progress.
//
// The fix mirrors what Zoom/Meet do on a stalled decode: force a fresh ICE restart +
// renegotiation on that one connection rather than waiting for the user to notice and
// reload. Scoped to a single peer's connection, so it can't be "fixing" a link that
// Preetha and everyone else already sees fine.
//
// Detection itself lives in `src/lib/stallDetector.ts` (`StallTracker`) rather than
// inline here, so the threshold/cooldown behaviour can be unit-tested without a real
// <video> element or React's effect timing.

import { useEffect, useRef, type RefObject } from 'react';
import { StallTracker } from '../lib/stallDetector';

const CHECK_INTERVAL_MS = 3000;

export function useStalledVideoRecovery(
  videoRef: RefObject<HTMLVideoElement | null>,
  hasVideo: boolean,
  onStalled: () => void,
) {
  const onStalledRef = useRef(onStalled);
  onStalledRef.current = onStalled;

  useEffect(() => {
    if (!hasVideo) return;

    const tracker = new StallTracker(videoRef.current?.currentTime ?? 0, Date.now());

    const timer = window.setInterval(() => {
      const vid = videoRef.current;
      if (!vid) return;
      if (tracker.sample(vid.currentTime, Date.now())) onStalledRef.current();
    }, CHECK_INTERVAL_MS);

    return () => window.clearInterval(timer);
    // hasVideo re-running this effect is deliberate: camera-off -> camera-on is a fresh
    // stream/track, so progress tracking should restart clean rather than compare
    // against a currentTime left over from before the toggle.
  }, [hasVideo, videoRef]);
}
