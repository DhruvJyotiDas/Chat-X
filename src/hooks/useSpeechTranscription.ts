import { useRef, useState, useCallback, useEffect } from 'react';

export interface TranscriptLine {
  id: string;
  text: string;
  isFinal: boolean;
  timestamp: string;
  speaker?: string;
}

export interface KeyPoint {
  id: string;
  type: 'action' | 'decision' | 'question' | 'number' | 'name';
  text: string;
}

const KEY_PATTERNS = [
  { type: 'action' as const,   re: /\b(?:will|need to|must|should|going to|let's|we'll)\s+([a-z][^.!?\n]{4,60})/gi },
  { type: 'decision' as const, re: /\b(?:decided|agreed|confirmed|approved|resolved|let's go with|we're going with)\b[^.!?\n]{3,60}/gi },
  { type: 'question' as const, re: /\b(?:why|what|how|when|where|who|can we|should we)[^.!?\n]{5,60}\?/gi },
  { type: 'number' as const,   re: /\b(?:\$|€|£)?\d[\d,.]*\s*(?:million|billion|percent|%|k\b|m\b)?/gi },
];

const ASR_WS_URL = import.meta.env.VITE_ASR_WS_URL
  ?? (typeof window !== 'undefined'
    ? `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/asr`
    : 'ws://localhost:8765');
const SAMPLE_RATE = 16000;

interface RemotePeer { id: string; name: string; stream: MediaStream | null }

interface AudioPipeline {
  ws: WebSocket;
  audioCtx: AudioContext;
  processor: ScriptProcessorNode;
  buffer: Float32Array[];
}

export function useSpeechTranscription(speakerName: string, remotePeers: RemotePeer[] = []) {
  const [isActive, setIsActive] = useState(false);
  const [isSupported] = useState(() => !!(navigator.mediaDevices && window.AudioContext));
  const [lines, setLines] = useState<TranscriptLine[]>([]);
  const [keyPoints, setKeyPoints] = useState<KeyPoint[]>([]);

  // Local mic pipeline
  const localPipelineRef = useRef<{
    ws: WebSocket | null;
    audioCtx: AudioContext | null;
    processor: ScriptProcessorNode | null;
    stream: MediaStream | null;
  }>({ ws: null, audioCtx: null, processor: null, stream: null });

  // Remote peer pipelines keyed by peer id
  const remotePipelinesRef = useRef<Map<string, AudioPipeline>>(new Map());
  const isActiveRef = useRef(false);

  const extractKeyPoints = useCallback((text: string) => {
    const found: KeyPoint[] = [];
    for (const { type, re } of KEY_PATTERNS) {
      re.lastIndex = 0;
      let match;
      while ((match = re.exec(text)) !== null) {
        const content = match[0].trim();
        if (content.length > 5) {
          found.push({ id: `kp-${Date.now()}-${Math.random()}`, type, text: content });
        }
      }
    }
    return found;
  }, []);

  const addFinalLine = useCallback((text: string, speaker: string) => {
    const line: TranscriptLine = {
      id: `line-${Date.now()}-${Math.random()}`,
      text,
      isFinal: true,
      timestamp: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
      speaker,
    };
    setLines(prev => [...prev, line].slice(-50));
    const kps = extractKeyPoints(text);
    if (kps.length) setKeyPoints(prev => [...prev, ...kps].slice(-20));
  }, [extractKeyPoints]);

  const openAsrWs = useCallback((speaker: string, onMessage: (text: string) => void): Promise<WebSocket> => {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(ASR_WS_URL);
      ws.binaryType = 'arraybuffer';
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data as string);
          if (msg.type === 'transcript' && msg.text) onMessage(msg.text);
        } catch {}
      };
      ws.onerror = () => reject(new Error('WS error'));
      const timeout = setTimeout(() => reject(new Error('WS connect timeout')), 5000);
      ws.onopen = () => { clearTimeout(timeout); resolve(ws); };
      ws.onclose = () => {
        // Pipeline already torn down if we initiated; otherwise stop everything
        if (isActiveRef.current) stop();
      };
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const buildAudioPipeline = useCallback((
    ws: WebSocket,
    stream: MediaStream,
  ): { audioCtx: AudioContext; processor: ScriptProcessorNode } => {
    const audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
    const source = audioCtx.createMediaStreamSource(stream);
    const processor = audioCtx.createScriptProcessor(4096, 1, 1);
    processor.onaudioprocess = (ev) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      const data = ev.inputBuffer.getChannelData(0);
      ws.send(data.buffer.slice(0));
    };
    source.connect(processor);
    processor.connect(audioCtx.destination);
    return { audioCtx, processor };
  }, []);

  const teardownPipeline = useCallback((p: { ws: WebSocket | null; audioCtx: AudioContext | null; processor: ScriptProcessorNode | null; stream?: MediaStream | null }) => {
    if (p.ws && p.ws.readyState === WebSocket.OPEN) {
      p.ws.send(JSON.stringify({ type: 'flush' }));
      p.ws.close();
    }
    p.processor?.disconnect();
    p.audioCtx?.close();
    if (p.stream) p.stream.getTracks().forEach(t => t.stop());
  }, []);

  const stop = useCallback(() => {
    isActiveRef.current = false;
    const lp = localPipelineRef.current;
    teardownPipeline({ ws: lp.ws, audioCtx: lp.audioCtx, processor: lp.processor, stream: lp.stream });
    localPipelineRef.current = { ws: null, audioCtx: null, processor: null, stream: null };

    remotePipelinesRef.current.forEach(rp => {
      teardownPipeline({ ws: rp.ws, audioCtx: rp.audioCtx, processor: rp.processor });
    });
    remotePipelinesRef.current.clear();

    setIsActive(false);
  }, [teardownPipeline]);

  const start = useCallback(async () => {
    if (isActiveRef.current) return;
    try {
      const micStream = await navigator.mediaDevices.getUserMedia({
        audio: { sampleRate: SAMPLE_RATE, channelCount: 1, echoCancellation: true, noiseSuppression: true },
        video: false,
      });

      const localWs = await openAsrWs(speakerName, (text) => addFinalLine(text, speakerName));
      const { audioCtx, processor } = buildAudioPipeline(localWs, micStream);

      localPipelineRef.current = { ws: localWs, audioCtx, processor, stream: micStream };
      isActiveRef.current = true;
      setIsActive(true);
    } catch (e) {
      console.error('[ASR] Failed to start:', e);
      stop();
    }
  }, [speakerName, openAsrWs, buildAudioPipeline, addFinalLine, stop]);

  // Sync remote peers: open/close pipelines as peers join/leave
  useEffect(() => {
    if (!isActiveRef.current) return;

    const existing = remotePipelinesRef.current;
    const currentIds = new Set(remotePeers.map(p => p.id));

    // Tear down pipelines for peers that left
    existing.forEach((rp, id) => {
      if (!currentIds.has(id)) {
        teardownPipeline({ ws: rp.ws, audioCtx: rp.audioCtx, processor: rp.processor });
        existing.delete(id);
      }
    });

    // Open pipelines for new peers that have a stream
    remotePeers.forEach(async (peer) => {
      if (!peer.stream || existing.has(peer.id)) return;
      try {
        const ws = await openAsrWs(peer.name, (text) => addFinalLine(text, peer.name));
        const { audioCtx, processor } = buildAudioPipeline(ws, peer.stream);
        existing.set(peer.id, { ws, audioCtx, processor, buffer: [] });
      } catch (e) {
        console.warn('[ASR] Remote pipeline failed for', peer.name, e);
      }
    });
  }, [remotePeers, isActive, openAsrWs, buildAudioPipeline, addFinalLine, teardownPipeline]);

  const clearAll = useCallback(() => {
    setLines([]);
    setKeyPoints([]);
  }, []);

  useEffect(() => () => stop(), [stop]);

  return { isActive, isSupported, lines, keyPoints, start, stop, clearAll };
}
