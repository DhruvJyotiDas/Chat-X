import { useEffect, useRef, useState } from 'react';

export interface AudioLevelSource {
  id: string;
  stream: MediaStream | null;
}

const SPEAKING_THRESHOLD = 0.02; // RMS on a 0..1 scale — tuned for typical mic gain
const HOLD_MS = 600; // keep a tile highlighted briefly after it goes quiet, avoids flicker between words
const POLL_MS = 120;

/**
 * Client-side stand-in for LiveKit's server-computed `participant.isSpeaking`/`audioLevel`
 * (see @livekit/components-react's useIsSpeaking, backed by the SFU's active-speaker
 * detection). IB Connect is mesh WebRTC with no SFU, so this analyses each peer's own
 * MediaStream locally via the Web Audio API instead. Returns the set of source ids
 * currently judged to be speaking.
 */
export function useAudioLevels(sources: AudioLevelSource[]): Set<string> {
  const [speaking, setSpeaking] = useState<Set<string>>(() => new Set());
  const speakingRef = useRef(speaking);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const nodesRef = useRef<Map<string, { analyser: AnalyserNode; source: MediaStreamAudioSourceNode; trackId: string }>>(new Map());
  const lastLoudRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    speakingRef.current = speaking;
  }, [speaking]);

  // Lifecycle: one shared AudioContext for the whole call.
  useEffect(() => {
    const AudioContextCtor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) return;
    const ctx = new AudioContextCtor();
    audioCtxRef.current = ctx;
    return () => {
      nodesRef.current.forEach(({ source, analyser }) => {
        try { source.disconnect(); analyser.disconnect(); } catch { /* already torn down */ }
      });
      nodesRef.current.clear();
      ctx.close().catch(() => {});
      audioCtxRef.current = null;
    };
  }, []);

  // Keep one analyser node per live audio track, recreating only when the track itself changes.
  useEffect(() => {
    const ctx = audioCtxRef.current;
    if (!ctx) return;
    const liveIds = new Set(sources.map((s) => s.id));

    nodesRef.current.forEach((node, id) => {
      if (!liveIds.has(id)) {
        try { node.source.disconnect(); node.analyser.disconnect(); } catch { /* already torn down */ }
        nodesRef.current.delete(id);
        lastLoudRef.current.delete(id);
      }
    });

    sources.forEach(({ id, stream }) => {
      const audioTrack = stream?.getAudioTracks()[0];
      const existing = nodesRef.current.get(id);

      if (!audioTrack) {
        if (existing) {
          try { existing.source.disconnect(); existing.analyser.disconnect(); } catch { /* already torn down */ }
          nodesRef.current.delete(id);
        }
        return;
      }
      if (existing && existing.trackId === audioTrack.id) return; // unchanged, keep the node

      if (existing) {
        try { existing.source.disconnect(); existing.analyser.disconnect(); } catch { /* already torn down */ }
      }
      try {
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0.6;
        const source = ctx.createMediaStreamSource(stream!);
        source.connect(analyser);
        nodesRef.current.set(id, { analyser, source, trackId: audioTrack.id });
      } catch {
        // A track can't be routed through Web Audio in rare browser states — that tile
        // just never highlights as speaking, nothing else depends on this succeeding.
      }
    });
  }, [sources]);

  // Poll levels and derive a hysteresis-smoothed "speaking" set.
  useEffect(() => {
    const data = new Uint8Array(256);
    let timer = 0;

    const tick = () => {
      const now = performance.now();
      let changed = false;
      const next = new Set(speakingRef.current);

      nodesRef.current.forEach(({ analyser }, id) => {
        analyser.getByteTimeDomainData(data);
        let sumSquares = 0;
        for (let i = 0; i < data.length; i++) {
          const v = (data[i] - 128) / 128;
          sumSquares += v * v;
        }
        const rms = Math.sqrt(sumSquares / data.length);
        if (rms > SPEAKING_THRESHOLD) lastLoudRef.current.set(id, now);

        const isSpeaking = now - (lastLoudRef.current.get(id) ?? -Infinity) < HOLD_MS;
        if (isSpeaking && !next.has(id)) { next.add(id); changed = true; }
        else if (!isSpeaking && next.has(id)) { next.delete(id); changed = true; }
      });

      next.forEach((id) => {
        if (!nodesRef.current.has(id)) { next.delete(id); changed = true; }
      });

      if (changed) { speakingRef.current = next; setSpeaking(next); }
      timer = window.setTimeout(tick, POLL_MS);
    };

    tick();
    return () => window.clearTimeout(timer);
  }, []);

  return speaking;
}
