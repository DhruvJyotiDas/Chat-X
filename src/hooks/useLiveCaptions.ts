import { useCallback, useEffect, useRef, useState } from 'react';
import { isLiveCaptionsSupported } from '../lib/liveCaptions';
import { config } from '../config';

// Streams this participant's OWN mic to the live-captions relay — never a
// peer's already-decoded remote audio, which is what the retired
// useSpeechTranscription.ts prototype did (opening one pipeline per OTHER
// participant too, O(N²) GPU work for O(N) speakers across a room). One
// stream per active speaker is all that's needed: the resulting captions
// (partial AND final, in every viewer's own chosen language) come back
// through the existing signalling socket's "caption" broadcast — see
// MeetingContext.tsx — which already reaches everyone in the room including
// this same browser, so there is nothing to parse out of THIS socket except
// the "unavailable" state below.

const ASR_WS_URL = config.asrWsUrl;

const SAMPLE_RATE = 16000;

export type ASRUnavailableReason = 'not_configured' | 'unreachable' | 'loading' | 'unauthorized' | 'bad_handshake' | 'room_not_found' | 'not_in_room' | string;

export interface UseLiveCaptionsResult {
  isActive: boolean;
  isSupported: boolean;
  /** Set when the relay/GPU VM told us captions can't run right now — show a
   *  clear, non-blocking notice rather than silently doing nothing. Never
   *  set from opening a mic that then fails; that's a separate, ordinary
   *  media-permission failure, same as camera/mic elsewhere in the app. */
  unavailableReason: ASRUnavailableReason | null;
  start: () => Promise<void>;
  stop: () => void;
}

function floatTo16BitPCM(input: Float32Array): ArrayBuffer {
  const buf = new ArrayBuffer(input.length * 2);
  const view = new DataView(buf);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buf;
}

export function useLiveCaptions(roomId: string | null, userId: string, userName: string): UseLiveCaptionsResult {
  const [isActive, setIsActive] = useState(false);
  const [isSupported] = useState(isLiveCaptionsSupported);
  const [unavailableReason, setUnavailableReason] = useState<ASRUnavailableReason | null>(null);

  const pipelineRef = useRef<{
    ws: WebSocket | null;
    audioCtx: AudioContext | null;
    processor: ScriptProcessorNode | null;
    stream: MediaStream | null;
  }>({ ws: null, audioCtx: null, processor: null, stream: null });
  const isActiveRef = useRef(false);

  const stop = useCallback(() => {
    isActiveRef.current = false;
    const p = pipelineRef.current;
    if (p.ws && p.ws.readyState === WebSocket.OPEN) p.ws.close();
    p.processor?.disconnect();
    p.audioCtx?.close();
    p.stream?.getTracks().forEach((t) => t.stop());
    pipelineRef.current = { ws: null, audioCtx: null, processor: null, stream: null };
    setIsActive(false);
  }, []);

  const start = useCallback(async () => {
    if (!isSupported || !roomId || isActiveRef.current) return;
    setUnavailableReason(null);
    try {
      // Handshake first, mic second: the relay sends "ready" only once it has
      // successfully dialed the GPU VM, or "unavailable" immediately if it's
      // not configured/unreachable — never opens a microphone before knowing
      // there's somewhere for the audio to go, per ASR_CONTRACT.md.
      const ws = new WebSocket(ASR_WS_URL);
      ws.binaryType = 'arraybuffer';
      const opened = await new Promise<boolean>((resolve) => {
        const timeout = setTimeout(() => resolve(false), 5000);
        ws.onopen = () => {
          clearTimeout(timeout);
          ws.send(JSON.stringify({ room_id: roomId, user_id: userId, user_name: userName }));
          resolve(true);
        };
        ws.onerror = () => { clearTimeout(timeout); resolve(false); };
      });
      if (!opened) { setUnavailableReason('unreachable'); ws.close(); return; }

      const ready = await new Promise<boolean>((resolve) => {
        const timeout = setTimeout(() => resolve(false), 8000);
        ws.onmessage = (ev) => {
          try {
            const msg = JSON.parse(ev.data as string);
            if (msg.type === 'ready') { clearTimeout(timeout); resolve(true); }
            else if (msg.type === 'unavailable') {
              clearTimeout(timeout);
              setUnavailableReason(msg.reason ?? 'unreachable');
              resolve(false);
            }
          } catch { /* ignore */ }
        };
        ws.onclose = () => { clearTimeout(timeout); resolve(false); };
      });
      if (!ready) { ws.close(); return; }

      const micStream = await navigator.mediaDevices.getUserMedia({
        audio: { sampleRate: SAMPLE_RATE, channelCount: 1, echoCancellation: true, noiseSuppression: true },
        video: false,
      });

      // Only "unavailable" is meaningful after this point — "ready" already
      // fired once and won't repeat.
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data as string);
          if (msg.type === 'unavailable') {
            setUnavailableReason(msg.reason ?? 'unreachable');
            stop();
          }
        } catch { /* ignore */ }
      };
      ws.onclose = () => { if (isActiveRef.current) stop(); };

      const audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
      const source = audioCtx.createMediaStreamSource(micStream);
      const processor = audioCtx.createScriptProcessor(4096, 1, 1);
      processor.onaudioprocess = (ev) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.send(floatTo16BitPCM(ev.inputBuffer.getChannelData(0)));
      };
      source.connect(processor);
      processor.connect(audioCtx.destination);

      pipelineRef.current = { ws, audioCtx, processor, stream: micStream };
      isActiveRef.current = true;
      setIsActive(true);
    } catch (e) {
      console.error('[captions] failed to start:', e);
      stop();
    }
  }, [isSupported, roomId, userId, userName, stop]);

  useEffect(() => () => stop(), [stop]);

  return { isActive, isSupported, unavailableReason, start, stop };
}
