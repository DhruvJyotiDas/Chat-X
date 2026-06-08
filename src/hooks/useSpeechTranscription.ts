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

// Browser Speech Recognition types
interface ISpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  onresult: ((e: ISpeechRecognitionEvent) => void) | null;
  onerror: ((e: ISpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}
interface ISpeechRecognitionEvent { resultIndex: number; results: ISpeechRecognitionResultList; }
interface ISpeechRecognitionResultList { length: number; [i: number]: ISpeechRecognitionResult; }
interface ISpeechRecognitionResult { isFinal: boolean; [i: number]: { transcript: string }; }
interface ISpeechRecognitionErrorEvent { error: string; }
type SpeechRecognitionCtor = new () => ISpeechRecognition;

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  }
}

const KEY_PATTERNS = [
  { type: 'action' as const,   re: /\b(?:will|need to|must|should|going to|let's|we'll)\s+([a-z][^.!?\n]{4,60})/gi },
  { type: 'decision' as const, re: /\b(?:decided|agreed|confirmed|approved|resolved|let's go with|we're going with)\b[^.!?\n]{3,60}/gi },
  { type: 'question' as const, re: /\b(?:why|what|how|when|where|who|can we|should we)[^.!?\n]{5,60}\?/gi },
  { type: 'number' as const,   re: /\b(?:\$|€|£)?\d[\d,.]*\s*(?:million|billion|percent|%|k\b|m\b)?/gi },
];

export function useSpeechTranscription(speakerName: string) {
  const [isActive, setIsActive] = useState(false);
  const [isSupported] = useState(() => 'SpeechRecognition' in window || 'webkitSpeechRecognition' in window);
  const [lines, setLines] = useState<TranscriptLine[]>([]);
  const [keyPoints, setKeyPoints] = useState<KeyPoint[]>([]);
  const recognitionRef = useRef<ISpeechRecognition | null>(null);
  const interimIdRef = useRef<string>(`interim-${Date.now()}`);

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

  const start = useCallback(() => {
    if (!isSupported || recognitionRef.current) return;

    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return;
    const recognition = new SR();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';
    recognition.maxAlternatives = 1;

    recognition.onresult = (event: ISpeechRecognitionEvent) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          const text = result[0].transcript.trim();
          if (!text) continue;
          const finalLine: TranscriptLine = {
            id: `line-${Date.now()}-${Math.random()}`,
            text,
            isFinal: true,
            timestamp: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
            speaker: speakerName,
          };
          setLines(prev => {
            // Replace the interim line with the final one
            const filtered = prev.filter(l => l.id !== interimIdRef.current);
            return [...filtered, finalLine].slice(-50);
          });
          interimIdRef.current = `interim-${Date.now()}`;

          // Extract key points from final text
          const newPoints = extractKeyPoints(text);
          if (newPoints.length) {
            setKeyPoints(prev => [...prev, ...newPoints].slice(-20));
          }
        } else {
          interim += result[0].transcript;
        }
      }

      if (interim) {
        setLines(prev => {
          const filtered = prev.filter(l => l.id !== interimIdRef.current);
          const interimLine: TranscriptLine = {
            id: interimIdRef.current,
            text: interim,
            isFinal: false,
            timestamp: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
            speaker: speakerName,
          };
          return [...filtered, interimLine].slice(-50);
        });
      }
    };

    recognition.onerror = (event: ISpeechRecognitionErrorEvent) => {
      if (event.error === 'no-speech') return; // normal timeout
      console.warn('[Transcription] error:', event.error);
      if (event.error === 'not-allowed') setIsActive(false);
    };

    recognition.onend = () => {
      // Auto-restart if still active
      if (recognitionRef.current) {
        try { recognitionRef.current.start(); } catch {}
      }
    };

    recognitionRef.current = recognition;
    try {
      recognition.start();
      setIsActive(true);
    } catch (e) {
      console.warn('[Transcription] start failed', e);
    }
  }, [isSupported, speakerName, extractKeyPoints]);

  const stop = useCallback(() => {
    if (recognitionRef.current) {
      recognitionRef.current.onend = null; // prevent auto-restart
      recognitionRef.current.stop();
      recognitionRef.current = null;
    }
    setIsActive(false);
  }, []);

  const clearAll = useCallback(() => {
    setLines([]);
    setKeyPoints([]);
  }, []);

  useEffect(() => () => stop(), [stop]);

  return { isActive, isSupported, lines, keyPoints, start, stop, clearAll };
}
