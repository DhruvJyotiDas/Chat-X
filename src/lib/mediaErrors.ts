/**
 * getUserMedia failure taxonomy.
 *
 * Everything used to collapse into two messages: "permission denied" for
 * NotAllowedError and "No camera or microphone found" for literally every other
 * failure. That second one is actively misleading — the most common non-denial
 * failure is NotReadableError, which means the device exists and is *in use by
 * another application* (Zoom, Teams, OBS, another tab). Telling that user to
 * connect a device sends them to debug hardware that is working fine.
 *
 * Shared by the call itself (useWebRTC) and the guest lobby (PreJoinScreen) so
 * the same failure never gets described two different ways.
 */

export type MediaDeviceLabel = 'camera' | 'microphone' | 'camera and microphone';

export function mediaErrorName(err: unknown): string {
  return (err as { name?: string } | null)?.name ?? '';
}

/** True when the user (or policy) actively refused, as opposed to a device fault. */
export function isPermissionDenial(err: unknown): boolean {
  const n = mediaErrorName(err);
  return n === 'NotAllowedError' || n === 'PermissionDeniedError';
}

/** True when the device exists but could not be started. */
export function isDeviceBusy(err: unknown): boolean {
  const n = mediaErrorName(err);
  // Chrome/Edge: NotReadableError. Firefox historically: AbortError.
  // Legacy Chrome: TrackStartError.
  return n === 'NotReadableError' || n === 'TrackStartError' || n === 'AbortError';
}

export function isDeviceMissing(err: unknown): boolean {
  const n = mediaErrorName(err);
  return n === 'NotFoundError' || n === 'DevicesNotFoundError';
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * A message that tells the user what actually went wrong and what to do about
 * it. `device` names the thing that failed, so the same error reads correctly
 * whether it came from a combined request or an audio-only retry.
 */
export function describeMediaError(err: unknown, device: MediaDeviceLabel): string {
  const name = mediaErrorName(err);

  if (isPermissionDenial(err)) {
    return `${capitalise(device)} access is blocked. Allow it for this site using the icon in your browser's address bar, then try again.`;
  }
  if (isDeviceBusy(err)) {
    return `Your ${device} is already being used by another app — close Zoom, Teams, or any other tab using it and try again.`;
  }
  if (isDeviceMissing(err)) {
    return `No ${device} was found. Connect a device and try again.`;
  }
  if (name === 'OverconstrainedError' || name === 'ConstraintNotSatisfiedError') {
    return `Your ${device} does not support the requested settings.`;
  }
  if (name === 'SecurityError') {
    return `${capitalise(device)} access is blocked on an insecure connection. Open this site over https:// and try again.`;
  }
  return `Could not start your ${device}${name ? ` (${name})` : ''}.`;
}

/**
 * Message for the case where the call cannot start at all — audio failed too.
 * Prefers the audio failure, since without a microphone there is no usable call,
 * but mentions the camera when it failed for a genuinely different reason.
 */
export function describeFatalMediaError(videoErr: unknown, audioErr: unknown): string {
  const base = describeMediaError(audioErr, 'microphone');
  if (!videoErr) return base;
  if (mediaErrorName(videoErr) === mediaErrorName(audioErr)) {
    return describeMediaError(audioErr, 'camera and microphone');
  }
  return `${base} (Your camera also failed: ${describeMediaError(videoErr, 'camera').replace(/^[A-Z]/, (c) => c.toLowerCase())})`;
}
