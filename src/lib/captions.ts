// Shared types + helpers for live captions, used by MeetingContext (which owns
// the state — it's the thing holding the signalling socket that "caption"
// events arrive on), CaptionBar (on-screen overlay), and the Transcript side
// panel. Kept as pure data/functions here rather than a hook, since there's
// no local state to manage beyond what MeetingContext already tracks.

export interface CaptionEvent {
  peerId: string;
  peerName: string;
  text: string;
  lang: string;
  isFinal: boolean;
  confidence?: number;
  /** Only present on finals, and only for languages someone in the room has
   *  actually selected — see activeCaptionLangs in transcription_relay.go. */
  translations?: Record<string, string>;
  /** Correlates a final with the "caption_translation" event that may follow
   *  it — see server/transcription_relay.go's handleASREvent. Translation
   *  now runs after the original final is already broadcast (so translating
   *  never delays the original caption every viewer sees), so it arrives as
   *  its own later event rather than already attached; capId is how a
   *  translation update finds the right line to attach itself to instead of
   *  being mistaken for a new utterance. Only finals carry one. */
  capId?: string;
  /** Wall-clock time this event was received, client-side — CaptionBar uses
   *  this to fade out a speaker's line once no new events have arrived for a
   *  while (they stopped talking), since the event stream itself carries no
   *  explicit "end of turn" marker beyond the next isFinal. */
  receivedAt: number;
}

export interface TranscriptLine {
  id: string;
  text: string;
  isFinal: true;
  timestamp: string;
  speaker: string;
  lang: string;
  translations?: Record<string, string>;
  /** See CaptionEvent.capId. */
  capId?: string;
}

/** What a viewer should actually see for one caption event, given their own
 *  chosen language. Falls back to the original when no translation was
 *  requested/ready (own language, or a partial — partials are never
 *  translated, see ASR_CONTRACT.md) rather than showing nothing. Shared by
 *  CaptionEvent (live) and TranscriptLine (logged) — both carry the same
 *  {text, lang, translations} shape. */
export function resolveCaptionText(evt: { text: string; lang: string; translations?: Record<string, string> }, myLang: string | null): string {
  if (!myLang || myLang === evt.lang) return evt.text;
  return evt.translations?.[myLang] ?? evt.text;
}

// Used both by the chat "Translate" button (translating a message into any
// of these, English included — a real, valid target there) and by live
// captions' translate-target picker (English excluded there — see
// CAPTION_TARGET_LANGUAGES below — since speech recognition itself only
// produces English now, see gpu/ASR_CONTRACT.md's 2026-09 update).
export const CAPTION_LANGUAGES: { code: string; label: string }[] = [
  { code: 'en', label: 'English' },
  { code: 'hi', label: 'Hindi' },
  { code: 'bn', label: 'Bengali' },
  { code: 'ta', label: 'Tamil' },
  { code: 'te', label: 'Telugu' },
  { code: 'mr', label: 'Marathi' },
  { code: 'es', label: 'Spanish' },
  { code: 'fr', label: 'French' },
  { code: 'de', label: 'German' },
  { code: 'ja', label: 'Japanese' },
];

// English excluded — live speech is always recognized as English now (the
// GPU VM only runs nemotron for ASR), so "translate into English" is a
// no-op there in a way it never is for the chat translate feature above.
export const CAPTION_TARGET_LANGUAGES = CAPTION_LANGUAGES.filter((l) => l.code !== 'en');

// Caption text size — a personal display preference, not something that
// needs to sync between peers (unlike caption language, which affects what
// text a translate call even needs to produce). Persisted the same way
// devicePrefs.ts persists camera/mic choices, so it survives across calls.
export type CaptionSize = 'small' | 'medium' | 'large';

const SIZE_KEY = 'ibconnect_caption_size';

export const CAPTION_SIZES: { value: CaptionSize; label: string }[] = [
  { value: 'small', label: 'Small' },
  { value: 'medium', label: 'Medium' },
  { value: 'large', label: 'Large' },
];

/** Tailwind classes for the on-screen subtitle text at each size — CaptionBar
 *  applies these directly rather than each caller picking pixel values. */
export const CAPTION_SIZE_TEXT_CLASS: Record<CaptionSize, string> = {
  small: 'text-xs md:text-sm',
  medium: 'text-sm md:text-lg',
  large: 'text-base md:text-2xl',
};

export function loadCaptionSize(): CaptionSize {
  try {
    const v = localStorage.getItem(SIZE_KEY);
    if (v === 'small' || v === 'medium' || v === 'large') return v;
  } catch { /* private mode */ }
  return 'medium';
}

export function saveCaptionSize(size: CaptionSize) {
  try { localStorage.setItem(SIZE_KEY, size); } catch { /* private mode */ }
}

export interface KeyPoint {
  id: string;
  type: 'action' | 'decision' | 'question' | 'number' | 'name';
  text: string;
}

const KEY_PATTERNS = [
  { type: 'action' as const, re: /\b(?:will|need to|must|should|going to|let's|we'll)\s+([a-z][^.!?\n]{4,60})/gi },
  { type: 'decision' as const, re: /\b(?:decided|agreed|confirmed|approved|resolved|let's go with|we're going with)\b[^.!?\n]{3,60}/gi },
  { type: 'question' as const, re: /\b(?:why|what|how|when|where|who|can we|should we)[^.!?\n]{5,60}\?/gi },
  { type: 'number' as const, re: /\b(?:\$|€|£)?\d[\d,.]*\s*(?:million|billion|percent|%|k\b|m\b)?/gi },
];

/** Only meaningful for English-shaped text — same limitation the old
 *  useSpeechTranscription.ts prototype had. Run against whatever text a
 *  given viewer is actually reading (translated or original), so it still
 *  works for an English-speaking viewer reading translated captions of a
 *  Hindi speaker, for instance. */
export function extractKeyPoints(text: string): KeyPoint[] {
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
}
