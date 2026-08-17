// Silent-microphone detection.
//
// A live microphone always produces at least a noise floor. A track that stays pinned
// at exactly zero is therefore not a quiet room — it is an OS-level permission block
// (macOS and Windows both have one that the browser cannot see), a hardware mute switch
// on a headset, or a device that enumerated but does not actually work.
//
// This is the failure mode with the worst user experience in any call app, because
// every signal the user has says it is working: the browser granted permission, the
// track is live, the mute button says unmuted, and the app shows no error. They talk
// for a minute before someone tells them nobody can hear them.
//
// Ported from suitenumerique/meet's stores/silentMic.ts. The analysis is cheap here
// because useAudioLevels already proved the approach on this codebase — same RMS over
// an AnalyserNode, applied to the local track and accumulated over time.

import { useEffect, useRef, useState } from 'react';

/**
 *   watching → passed    first non-zero sample; the check is over, no UI
 *   watching → silent    enough accumulated silence to warn
 *   silent   → passed    sound finally arrives; the warning clears itself
 *   any      → dismissed user closed the warning (remembered on this browser)
 */
export type SilentMicStatus = 'watching' | 'silent' | 'passed' | 'dismissed';

const DISMISS_KEY = 'ibconnect_silent_mic_dismissed';

// Absolute silence is a much stronger signal than "quiet", so the threshold sits just
// above the floating-point noise of the FFT rather than at a speech level. Anything
// above this — breathing, a fan, a room — counts as a working microphone.
const SILENCE_RMS = 0.001;

// Accumulated, not consecutive: someone who is genuinely muted for 20s, speaks, and
// mutes again must not be warned. Only uninterrupted-in-total silence trips it.
const SILENT_BUDGET_MS = 12_000;
const POLL_MS = 200;

function wasDismissed(): boolean {
  try { return localStorage.getItem(DISMISS_KEY) === '1'; } catch { return false; }
}

export interface SilentMicResult {
  status: SilentMicStatus;
  /** Hide the warning for good on this browser. */
  dismiss: () => void;
}

/**
 * Watch a stream's audio track for total silence.
 *
 * Pass `active: false` while the user is intentionally muted — a muted track is
 * legitimately silent and warning about it would be nonsense.
 */
export function useSilentMic(stream: MediaStream | null, active: boolean): SilentMicResult {
  const [status, setStatus] = useState<SilentMicStatus>(() => (wasDismissed() ? 'dismissed' : 'watching'));

  const silentMsRef = useRef(0);
  const watchedTrackRef = useRef<string | undefined>(undefined);
  const statusRef = useRef(status);
  useEffect(() => { statusRef.current = status; }, [status]);

  useEffect(() => {
    if (!active || status === 'passed' || status === 'dismissed') return;

    const track = stream?.getAudioTracks()[0];
    if (!track) return;

    // A device switch or re-acquire is a new microphone and deserves a fresh budget,
    // otherwise silence accrued on a broken device immediately condemns its replacement.
    if (watchedTrackRef.current !== track.id) {
      watchedTrackRef.current = track.id;
      silentMsRef.current = 0;
    }

    const AudioContextCtor = window.AudioContext
      ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) return;

    let ctx: AudioContext;
    let source: MediaStreamAudioSourceNode;
    let analyser: AnalyserNode;
    try {
      ctx = new AudioContextCtor();
      analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      source = ctx.createMediaStreamSource(stream!);
      source.connect(analyser);
    } catch {
      // Some browser states refuse to route a track through Web Audio. The check
      // simply does not run; nothing else depends on it.
      return;
    }

    const data = new Uint8Array(analyser.fftSize);
    let timer = 0;
    let last = performance.now();

    const tick = () => {
      const now = performance.now();
      const delta = now - last;
      last = now;

      analyser.getByteTimeDomainData(data);
      let sumSquares = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128;
        sumSquares += v * v;
      }
      const rms = Math.sqrt(sumSquares / data.length);

      if (rms > SILENCE_RMS) {
        // Any real sound settles the question permanently, including recovery from
        // an earlier warning — a headset switch flipped back on should clear it.
        setStatus('passed');
        return;
      }

      silentMsRef.current += delta;
      if (silentMsRef.current >= SILENT_BUDGET_MS && statusRef.current === 'watching') {
        setStatus('silent');
      }
      timer = window.setTimeout(tick, POLL_MS);
    };

    timer = window.setTimeout(tick, POLL_MS);

    return () => {
      window.clearTimeout(timer);
      try { source.disconnect(); analyser.disconnect(); } catch { /* already torn down */ }
      void ctx.close().catch(() => {});
    };
  }, [stream, active, status]);

  const dismiss = () => {
    try { localStorage.setItem(DISMISS_KEY, '1'); } catch { /* private mode */ }
    setStatus('dismissed');
  };

  return { status, dismiss };
}
