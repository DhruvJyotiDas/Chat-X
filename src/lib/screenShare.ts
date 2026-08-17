/**
 * iOS Safari has never shipped `getDisplayMedia` for web content — Apple only exposes
 * screen capture to native apps via ReplayKit, not to the browser. Most other mobile
 * browsers (Android Chrome included) either lack it too or support it too
 * inconsistently across OS/browser versions to rely on. The "Share screen" button was
 * shown unconditionally and called `getDisplayMedia` directly: on a phone without it,
 * the call threw a bare `TypeError` (the method doesn't exist at all, so it isn't even
 * a `DOMException` with a `.name` to branch on) which `toggleScreenShare`'s catch
 * block only ever sent to `console.warn` — nobody sees devtools on a phone, so tapping
 * the button did, from the user's perspective, nothing at all.
 *
 * Same fix as the speaker picker (`isSpeakerSelectionSupported` in audioOutput.ts):
 * hide the control where the capability doesn't exist rather than leave it present
 * and silently inert — that combination is the actual bug, on both features.
 */
export function isScreenShareSupported(): boolean {
  if (typeof navigator === 'undefined') return false;
  return typeof navigator.mediaDevices?.getDisplayMedia === 'function';
}
