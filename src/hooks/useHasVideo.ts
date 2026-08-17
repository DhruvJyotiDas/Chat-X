// Does this remote stream currently carry a live picture?
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

import { useEffect, useState } from 'react';

function hasLivePicture(stream: MediaStream | null): boolean {
  if (!stream) return false;
  const track = stream.getVideoTracks()[0];
  if (!track) return false;
  // `muted` is the browser telling us no media is arriving for this track — which is how
  // some engines represent a remote camera going away instead of removing the track.
  return track.readyState === 'live' && !track.muted;
}

/**
 * True while `stream` has a video track that is actually delivering frames.
 *
 * Re-evaluated on `addtrack`/`removetrack` on the stream and `mute`/`unmute`/`ended` on
 * the track, so the tile flips to an avatar the moment the picture stops rather than on
 * the next unrelated re-render.
 */
export function useHasVideo(stream: MediaStream | null): boolean {
  const [hasVideo, setHasVideo] = useState(() => hasLivePicture(stream));

  useEffect(() => {
    setHasVideo(hasLivePicture(stream));
    if (!stream) return;

    const sync = () => setHasVideo(hasLivePicture(stream));

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
    const timer = window.setInterval(() => { bind(); sync(); }, 500);

    return () => {
      window.clearInterval(timer);
      stream.removeEventListener('addtrack', onTrackChange);
      stream.removeEventListener('removetrack', onTrackChange);
      if (watched) {
        watched.removeEventListener('mute', sync);
        watched.removeEventListener('unmute', sync);
        watched.removeEventListener('ended', sync);
      }
    };
  }, [stream]);

  return hasVideo;
}
