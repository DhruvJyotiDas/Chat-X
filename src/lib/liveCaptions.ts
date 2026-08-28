// Baseline feature check for live captions — same philosophy as
// isScreenShareSupported (screenShare.ts) and isSpeakerSelectionSupported
// (audioOutput.ts): hide the control entirely where the browser can't do
// this at all, rather than show a toggle that silently fails. Unlike screen
// share this isn't a platform gap (every browser that can join a call at all
// has a mic and Web Audio), it's just guarding against a handful of very old
// or embedded WebViews that lack AudioContext.
export function isLiveCaptionsSupported(): boolean {
  if (typeof navigator === 'undefined' || typeof window === 'undefined') return false;
  return !!(navigator.mediaDevices?.getUserMedia && (window.AudioContext || (window as any).webkitAudioContext));
}
