// Build-time feature flags.
//
// TRANSCRIPTION: the Whisper ASR pipeline (server/transcription_server.py, proxied at /asr)
// is functionally correct but runs at ~27x real time on this CPU-only box, so live
// transcription never produces output during a call — the Transcript panel just sits empty
// with no indication it has fallen behind. Turned off until the ASR box gets a GPU or the
// model is swapped for a faster one (see "Audio-to-text (ASR)" in CLAUDE.md).
//
// Set VITE_ENABLE_TRANSCRIPTION=true at build time to bring the UI back without a code change.
export const TRANSCRIPTION_ENABLED = import.meta.env.VITE_ENABLE_TRANSCRIPTION === 'true';
