import { useCallback, useEffect, useRef, useState } from 'react';
import { diag } from '../lib/diagnostics';
import { describeMediaError, describeFatalMediaError } from '../lib/mediaErrors';

/**
 * Captures an interview answer as a WAV file plus a handful of JPEG stills.
 *
 * WHY NOT MediaRecorder / webm:
 * There is no `ffmpeg` on the app server, and the GPU box should not need one
 * either. A webm/opus container would have to be demuxed and decoded somewhere
 * before the model could read it. Instead the browser does the only encoding
 * step that matters — raw 16 kHz mono PCM wrapped in a WAV header — which
 * Qwen3-Omni reads natively. Same approach already proven in
 * `useSpeechTranscription.ts`.
 *
 * Video is sampled as JPEG stills (~1 every 5s, capped) rather than streamed.
 * That is enough for the model to judge presence and delivery, and avoids
 * shipping tens of megabytes per answer.
 *
 * Sizes: 90s of 16 kHz mono 16-bit ≈ 2.9 MB WAV, plus ~6 frames ≈ 300 KB.
 */

const SAMPLE_RATE = 16000;
const FRAME_INTERVAL_MS = 5000;
const MAX_FRAMES = 6;
const FRAME_WIDTH = 320;
const JPEG_QUALITY = 0.6;

export interface RecordedAnswer {
  audioWavB64: string;
  framesB64: string[];
  durationSec: number;
}

function encodeWav(chunks: Float32Array[], sampleRate: number): Blob {
  let total = 0;
  for (const c of chunks) total += c.length;

  const buffer = new ArrayBuffer(44 + total * 2);
  const view = new DataView(buffer);
  const str = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };

  str(0, 'RIFF');
  view.setUint32(4, 36 + total * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  view.setUint32(16, 16, true);          // PCM chunk size
  view.setUint16(20, 1, true);           // format: PCM
  view.setUint16(22, 1, true);           // channels: mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true);           // block align
  view.setUint16(34, 16, true);          // bits per sample
  str(36, 'data');
  view.setUint32(40, total * 2, true);

  let off = 44;
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i++) {
      // Clamp before scaling, or samples above 1.0 wrap round to loud noise.
      const s = Math.max(-1, Math.min(1, chunk[i]));
      view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      off += 2;
    }
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result ?? '');
      const c = s.indexOf(',');
      resolve(c >= 0 ? s.slice(c + 1) : s);
    };
    r.onerror = () => reject(new Error('Could not encode the recording'));
    r.readAsDataURL(blob);
  });
}

export function useInterviewRecorder() {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [level, setLevel] = useState(0);        // 0..1, drives the mic meter
  const [error, setError] = useState<string | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const procRef = useRef<ScriptProcessorNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const chunksRef = useRef<Float32Array[]>([]);
  const framesRef = useRef<string[]>([]);
  const startedAtRef = useRef(0);
  const frameTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const rafRef = useRef(0);
  const videoElRef = useRef<HTMLVideoElement | null>(null);

  /** Attach the <video> the frame grabber samples from. */
  const attachVideo = useCallback((el: HTMLVideoElement | null) => {
    videoElRef.current = el;
    if (el && streamRef.current && el.srcObject !== streamRef.current) {
      el.srcObject = streamRef.current;
      el.play().catch(() => {});
    }
  }, []);

  const openDevices = useCallback(async (): Promise<boolean> => {
    if (streamRef.current) return true;
    setError(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setError('Camera and microphone access needs a secure (https) connection.');
      return false;
    }
    let s: MediaStream | null = null;
    let videoErr: unknown = null;
    try {
      s = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 } },
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
    } catch (e) {
      videoErr = e;
    }
    if (!s) {
      // Same reasoning as the call path: a blocked camera must not stop someone
      // doing an audio-only interview, and browsers reject the combined request
      // when only the camera is denied.
      try {
        s = await navigator.mediaDevices.getUserMedia({ audio: true });
        diag('media', 'warn', 'interview: camera unavailable, continuing audio-only',
          { reason: describeMediaError(videoErr, 'camera') });
      } catch (audioErr) {
        const msg = describeFatalMediaError(videoErr, audioErr);
        setError(msg);
        diag('media', 'error', 'interview: no usable devices', { msg });
        return false;
      }
    }
    streamRef.current = s;
    setStream(s);
    if (videoElRef.current) {
      videoElRef.current.srcObject = s;
      videoElRef.current.play().catch(() => {});
    }
    diag('media', 'info', 'interview: devices opened', {
      video: s.getVideoTracks().length, audio: s.getAudioTracks().length,
    });
    return true;
  }, []);

  const grabFrame = useCallback(() => {
    const v = videoElRef.current;
    if (!v || v.videoWidth === 0 || framesRef.current.length >= MAX_FRAMES) return;
    const scale = FRAME_WIDTH / v.videoWidth;
    const c = document.createElement('canvas');
    c.width = FRAME_WIDTH;
    c.height = Math.round(v.videoHeight * scale);
    const g = c.getContext('2d');
    if (!g) return;
    g.drawImage(v, 0, 0, c.width, c.height);
    const url = c.toDataURL('image/jpeg', JPEG_QUALITY);
    framesRef.current.push(url.slice(url.indexOf(',') + 1));
  }, []);

  const start = useCallback(async (): Promise<boolean> => {
    if (isRecording) return true;
    if (!(await openDevices())) return false;
    const s = streamRef.current;
    if (!s || s.getAudioTracks().length === 0) {
      setError('No microphone is available, so the answer cannot be recorded.');
      return false;
    }

    chunksRef.current = [];
    framesRef.current = [];
    startedAtRef.current = performance.now();

    const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
    const src = ctx.createMediaStreamSource(s);
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;

    proc.onaudioprocess = (ev) => {
      // Copy: the event buffer is reused by the audio thread on the next call.
      chunksRef.current.push(new Float32Array(ev.inputBuffer.getChannelData(0)));
    };
    src.connect(analyser);
    src.connect(proc);
    // ScriptProcessor only runs while connected to a destination. Routing the
    // mic to the speakers would cause feedback, so a muted gain node terminates
    // the graph instead.
    const mute = ctx.createGain();
    mute.gain.value = 0;
    proc.connect(mute);
    mute.connect(ctx.destination);

    ctxRef.current = ctx;
    procRef.current = proc;
    analyserRef.current = analyser;

    const bins = new Uint8Array(analyser.frequencyBinCount);
    const meter = () => {
      if (!analyserRef.current) return;
      analyserRef.current.getByteTimeDomainData(bins);
      let peak = 0;
      for (let i = 0; i < bins.length; i++) peak = Math.max(peak, Math.abs(bins[i] - 128) / 128);
      setLevel(peak);
      rafRef.current = requestAnimationFrame(meter);
    };
    rafRef.current = requestAnimationFrame(meter);

    grabFrame();
    frameTimerRef.current = setInterval(grabFrame, FRAME_INTERVAL_MS);
    tickRef.current = setInterval(
      () => setElapsedSec(Math.round((performance.now() - startedAtRef.current) / 1000)), 500);

    setIsRecording(true);
    setElapsedSec(0);
    diag('media', 'info', 'interview: recording started');
    return true;
  }, [isRecording, openDevices, grabFrame]);

  const stop = useCallback(async (): Promise<RecordedAnswer | null> => {
    if (!isRecording) return null;
    setIsRecording(false);

    if (frameTimerRef.current) { clearInterval(frameTimerRef.current); frameTimerRef.current = null; }
    if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; }
    cancelAnimationFrame(rafRef.current);
    setLevel(0);

    grabFrame(); // one final frame so a short answer still has at least two

    procRef.current?.disconnect();
    analyserRef.current?.disconnect();
    await ctxRef.current?.close().catch(() => {});
    procRef.current = null;
    analyserRef.current = null;
    ctxRef.current = null;

    const durationSec = Math.max(0.1, (performance.now() - startedAtRef.current) / 1000);
    const wav = encodeWav(chunksRef.current, SAMPLE_RATE);
    const audioWavB64 = await blobToBase64(wav);
    const framesB64 = [...framesRef.current];
    chunksRef.current = [];
    framesRef.current = [];

    diag('media', 'info', 'interview: recording stopped', {
      durationSec: Math.round(durationSec), wavKB: Math.round(wav.size / 1024), frames: framesB64.length,
    });
    return { audioWavB64, framesB64, durationSec: Math.round(durationSec * 10) / 10 };
  }, [isRecording, grabFrame]);

  /** Releases the camera and microphone so the OS indicator actually goes out. */
  const release = useCallback(() => {
    if (frameTimerRef.current) clearInterval(frameTimerRef.current);
    if (tickRef.current) clearInterval(tickRef.current);
    cancelAnimationFrame(rafRef.current);
    procRef.current?.disconnect();
    analyserRef.current?.disconnect();
    void ctxRef.current?.close().catch(() => {});
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    procRef.current = null;
    analyserRef.current = null;
    ctxRef.current = null;
    setStream(null);
    setIsRecording(false);
    setLevel(0);
  }, []);

  useEffect(() => () => release(), [release]);

  return {
    stream, isRecording, elapsedSec, level, error,
    openDevices, attachVideo, start, stop, release,
  };
}
