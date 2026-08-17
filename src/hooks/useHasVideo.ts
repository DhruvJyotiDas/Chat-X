// Does this remote stream currently carry a live picture — and if not, is that because
// the peer genuinely has no camera, or because the connection just hasn't finished
// negotiating video yet?
//
// Turning the camera off does the right thing on the SENDING side: `toggleCamera` calls
// `pc.removeTrack(sender)`, stops the hardware track and renegotiates, so the OS camera
// light actually goes out. Measured on the RECEIVING side, the track really is gone —
// `stream.getVideoTracks().length` drops from 1 to 0.
//
// But the `<video>` element does not clear itself. It keeps the last decoded frame
// painted indefinitely: `videoWidth` falls to 0 and `currentTime` stops advancing while
// every other peer's keeps ticking. `RemoteTile` only fell back to the avatar when
// `!peer.stream`, and the stream still exists because it carries audio — so a peer who
// turned their camera off appeared frozen mid-motion rather than off. Indistinguishable,
// from the other side, from a peer whose connection had died.
//
// Watching the stream is deliberately preferred over trusting a signalling message.
// It also covers the cases a message would miss: someone who joined with their camera
// already off (they never had a video track to announce), a peer running an older build,
// and a `camera_state` broadcast that arrived before the renegotiation it describes.
//
// `stillConnecting` exists for a second, distinct case: on a BRAND NEW peer connection
// video often isn't there from the first instant, in two different ways — a track that
// exists but starts `muted: true` per spec until the first frame decodes, AND a window
// before that where the stream can have ZERO video tracks yet at all, because audio and
// video negotiate as separate transceivers that don't necessarily complete at the same
// moment (audio's `ontrack` can fire before video's). Both looked identical to "no
// camera at all" and showed "Camera off" — the wrong label for someone simply still
// connecting, on every OTHER existing participant's connection, every single time
// anyone joins. On a real (laggier than this dev box) connection that window is long
// enough, and can flicker through more than once before settling, to look exactly like
// a camera repeatedly turning off and on right when someone joins.
//
// A track-presence check can't tell "video hasn't attached yet" apart from "peer never
// had a camera" — both are zero video tracks. What can: TIME. A peer's own connection
// (the `!peer.stream` case) already gets a "Connecting…" grace instead of an instant
// verdict; this extends the same idea past the point where *some* stream exists. Within
// GRACE_MS of that stream first appearing, "no live video yet" reads as "Connecting…".
// Once GRACE_MS elapses without video ever going live, it reads as "Camera off" — same
// as immediately before this existed, just delayed long enough for negotiation to
// reasonably finish. `everHadVideo` still means what it did: once video has been live at
// least once, any later loss is a real stop (or the stall useStalledVideoRecovery is
// already trying to repair), never "Connecting…" again for this stream.

import { useEffect, useRef, useState } from 'react';

function hasLivePicture(stream: MediaStream | null): boolean {
  if (!stream) return false;
  const track = stream.getVideoTracks()[0];
  if (!track) return false;
  return track.readyState === 'live' && !track.muted;
}

const GRACE_MS = 6000;

export interface HasVideoState {
  hasVideo: boolean;
  /** True while a stream that has never once shown live video is still within its
   *  post-appearance grace period — show "Connecting…" instead of "Camera off". */
  stillConnecting: boolean;
}

export function useHasVideo(stream: MediaStream | null): HasVideoState {
  const [hasVideo, setHasVideo] = useState(() => hasLivePicture(stream));
  const everHadVideoRef = useRef(hasVideo);
  const [stillConnecting, setStillConnecting] = useState(!hasVideo);

  useEffect(() => {
    const initial = hasLivePicture(stream);
    setHasVideo(initial);
    // A fresh stream (new peer, or the same peer rejoining under a new connection)
    // starts its own grace period — carrying an old stream's answer forward would let
    // a genuinely new, not-yet-connected peer skip straight to "Camera off".
    everHadVideoRef.current = initial;
    setStillConnecting(!initial);
    if (!stream) return;

    const sync = () => {
      const live = hasLivePicture(stream);
      setHasVideo(live);
      if (live && !everHadVideoRef.current) {
        everHadVideoRef.current = true;
        setStillConnecting(false);
      }
    };

    // Track-level listeners have to be re-bound whenever the track set changes, since
    // turning the camera back on produces a brand new track object.
    let watched: MediaStreamTrack | null = null;
    const bind = () => {
      const track = stream.getVideoTracks()[0] ?? null;
      if (track === watched) return;
      if (watched) {
        watched.removeEventListener('mute', sync);
        watched.removeEventListener('unmute', sync);
        watched.removeEventListener('ended', sync);
      }
      watched = track;
      if (watched) {
        watched.addEventListener('mute', sync);
        watched.addEventListener('unmute', sync);
        watched.addEventListener('ended', sync);
      }
    };

    const onTrackChange = () => { bind(); sync(); };
    bind();

    stream.addEventListener('addtrack', onTrackChange);
    stream.addEventListener('removetrack', onTrackChange);

    // Safety net. `removetrack` is not fired by every engine when a remote sender stops
    // sending, and `mute` can lag — so poll slowly as well. 500ms is imperceptible for
    // this purpose and costs a couple of property reads per peer.
    const timer = window.setInterval(sync, 500);

    // Ends the grace period on its own even if nothing else ever fires — otherwise a
    // peer who genuinely has no camera would show "Connecting…" forever instead of
    // settling to "Camera off".
    const graceTimer = initial ? null : window.setTimeout(() => {
      if (!everHadVideoRef.current) setStillConnecting(false);
    }, GRACE_MS);

    return () => {
      window.clearInterval(timer);
      if (graceTimer) window.clearTimeout(graceTimer);
      stream.removeEventListener('addtrack', onTrackChange);
      stream.removeEventListener('removetrack', onTrackChange);
      if (watched) {
        watched.removeEventListener('mute', sync);
        watched.removeEventListener('unmute', sync);
        watched.removeEventListener('ended', sync);
      }
    };
  }, [stream]);

  return { hasVideo, stillConnecting };
}
