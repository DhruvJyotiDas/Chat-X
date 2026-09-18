import React, { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import {
  Mic, MicOff, Video, VideoOff, ScreenShare, ScreenShareOff,
  PhoneOff, MessageSquare, Send, X, Users, Copy, Check,
  MoreVertical, Volume2, Lightbulb, Tag, Hash, HelpCircle,
  Activity, Zap, Mic2, ChevronDown, Link, ChevronLeft, ChevronRight,
  Pin, PinOff, Minimize2, ArrowLeft, AlertTriangle, Hand, Smile, Captions,
  Loader2, Download, FileText, CheckCircle2, ListChecks, RotateCcw, Sparkles,
} from 'lucide-react';
import { useMeeting } from '../../context/MeetingContext';
import { PeerInfo } from '../../hooks/useWebRTC';
import { useLiveCaptions } from '../../hooks/useLiveCaptions';
import { isLiveCaptionsSupported } from '../../lib/liveCaptions';
import {
  resolveCaptionText, CAPTION_TARGET_LANGUAGES, CAPTION_SIZES, loadCaptionSize, saveCaptionSize,
  type TranscriptLine, type KeyPoint, type CaptionSize,
} from '../../lib/captions';
import CaptionBar from './CaptionBar';
import { useAuth } from '../../context/AuthContext';
import { useGridLayout, computeTileSize } from '../../hooks/useGridLayout';
import { usePagination, type Pagination } from '../../hooks/usePagination';
import MeetingInviteDialog from './MeetingInviteDialog';
import { registerAudioSink, isSpeakerSelectionSupported, setPreferredSpeaker } from '../../lib/audioOutput';
import { isScreenShareSupported } from '../../lib/screenShare';
import { watchDevices, resolveSelection, loadDevicePrefs, EMPTY_SNAPSHOT, type DeviceSnapshot } from '../../lib/devicePrefs';
import type { PeerLink, LinkQuality } from '../../lib/connectionStats';
import { useTileOrder } from '../../hooks/useTileOrder';
import { useHasVideo } from '../../hooks/useHasVideo';
import { useStalledVideoRecovery } from '../../hooks/useStalledVideoRecovery';
import { api, type MeetingSummary } from '../../lib/api';
import { useSilentMic } from '../../hooks/useSilentMic';
import { useCallShortcuts, SHORTCUT_HINTS } from '../../hooks/useCallShortcuts';
import { REACTIONS } from '../../lib/reactions';
import Avatar from '../ui/Avatar';
import BrandDots from '../BrandDots';

export type BgMode = 'none' | 'blur' | 'blur-heavy' | 'color-dark' | 'color-space';

/**
 * A grid slot: either a remote peer or the local participant. Named explicitly because
 * it flows through useMemo -> useTileOrder -> usePagination, and TypeScript will happily
 * infer `unknown` for a union element type somewhere along that chain.
 */
type MeetingTile = PeerInfo | { id: string; name: string; isLocal: true };

interface Props {
  onLeaveMeeting: () => void;
  /** Omitted for guests — they have no app to go back to, so no minimise button. */
  onMinimize?: () => void;
}

// Starting playback on a remote tile can be refused outright, and the refusal is
// asynchronous and silent: a page that has just been reloaded holds no user
// activation, and a remote stream carries audio (the local tile is muted, which is
// why it never hits this), so the browser's autoplay policy can reject play() with
// NotAllowedError. Nothing retried, so the tile sat frozen on a black frame with
// live media arriving underneath — indistinguishable, from the user's side, from
// the peer having vanished. Retry on the next interaction anywhere in the document
// so the first tap restores the picture instead of the call staying dead.
function playWhenAllowed(el: HTMLMediaElement) {
  el.play().catch((err: unknown) => {
    if ((err as { name?: string })?.name !== 'NotAllowedError') return;
    const retry = () => {
      document.removeEventListener('pointerdown', retry);
      document.removeEventListener('keydown', retry);
      el.play().catch(() => {});
    };
    document.addEventListener('pointerdown', retry);
    document.addEventListener('keydown', retry);
  });
}

// ─── Remote audio ────────────────────────────────────────────────────────────
//
// Every peer's audio is played by one of these, mounted once per peer for the
// whole lifetime of the call — deliberately OUTSIDE the grid, the spotlight
// carousel and `usePagination`.
//
// It used to come out of the peer's own <video> in `RemoteTile`, which meant
// audio was only audible for tiles that happened to be rendered. The grid
// renders one page at a time (`gridPagination.tiles`) and `GRID_LAYOUTS` caps at
// 16 tiles — 12 at a typical laptop width — so in a large call you could hear at
// most 11 of the other participants, and paging changed *which* 11.
//
// This is also why every peer's audio subscribes unconditionally in
// useWebRTC.ts regardless of the visible-tile set that gates camera video
// (see setVisiblePeerIds) — an off-page peer still needs to be heard.
//
// `RemoteTile`'s <video> is `muted`, and since it now attaches the peer's
// video Track directly (track.attach(), not a combined-stream srcObject —
// see peer.videoTrack's comment in useWebRTC.ts) there is no audio track on
// that element to begin with; this <audio> is structurally the only place
// this peer's audio can come out of, not just "don't unmute it or it'll echo".
function PeerAudio({ peer }: { peer: PeerInfo }) {
  const ref = useRef<HTMLAudioElement>(null);

  // track.attach() rather than a manual srcObject assignment — see peer.audioTrack's
  // own comment in useWebRTC.ts. Attaches ONLY the audio track, so (unlike the old
  // combined-MediaStream approach) there is no audio track riding along on RemoteTile's
  // muted <video> to begin with — structurally, not just by convention, one place this
  // peer's audio can ever come out of.
  useEffect(() => {
    const el = ref.current;
    const track = peer.audioTrack;
    if (!el || !track) return;
    track.attach(el);
    playWhenAllowed(el);
    return () => { track.detach(el); };
  }, [peer.audioTrack]);

  // Peers join and leave throughout a call, so each new element has to be pointed at
  // the chosen speaker as it mounts — a device selected earlier cannot reach an
  // element that did not exist yet, and the whole point of the picker is that it
  // applies to everyone you can hear.
  useEffect(() => registerAudioSink(ref.current), []);

  const ensurePlaying = () => {
    const el = ref.current;
    if (el && el.paused) playWhenAllowed(el);
  };

  return (
    <audio
      ref={ref}
      autoPlay
      // eslint-disable-next-line jsx-a11y/media-has-caption
      onCanPlay={ensurePlaying}
      onPause={ensurePlaying}
      style={{ display: 'none' }}
    />
  );
}

// ─── Link quality badge ──────────────────────────────────────────────────────
//
// Three bars, filled according to the grade. Shown only when there is something worth
// saying: a healthy link renders nothing at all. An indicator that is always lit is an
// indicator nobody reads, and in a mesh call the useful signal is precisely the
// exception — one peer's link degrading while everyone else's is fine.
function QualityBadge({ quality, relayed }: { quality: LinkQuality; relayed: boolean }) {
  if (quality === 'good' || quality === 'unknown') return null;

  const bars = quality === 'fair' ? 2 : 1;
  const colour = quality === 'fair' ? 'bg-[var(--ib-warn-dot)]' : 'bg-[var(--ib-bad-dot)]';
  const label = quality === 'fair'
    ? `Unstable connection${relayed ? ' (relayed)' : ''}`
    : `Poor connection${relayed ? ' (relayed)' : ''}`;

  return (
    <div
      className="flex items-end gap-[2px] h-3 px-1.5 py-1 rounded-md bg-black/60 backdrop-blur-sm"
      title={label}
      aria-label={label}
      role="img"
    >
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className={`w-[3px] rounded-sm ${i < bars ? colour : 'bg-[#5f6368]'}`}
          style={{ height: `${4 + i * 3}px` }}
        />
      ))}
    </div>
  );
}

// ─── Floating reactions ──────────────────────────────────────────────────────
//
// Rendered once for the whole call rather than per tile: a reaction belongs to the
// room, and in a paginated grid the sender's tile may not even be on screen — tying
// the animation to a tile would make reactions randomly invisible.
function ReactionOverlay({ reactions }: { reactions: { id: string; emoji: string; peerName: string; lane: number }[] }) {
  if (reactions.length === 0) return null;
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden z-[60]" aria-live="polite" aria-atomic="false">
      {reactions.map((r) => (
        <div
          key={r.id}
          className="absolute bottom-4 flex flex-col items-center gap-1 ib-reaction-rise"
          style={{ left: `${8 + r.lane * 76}%` }}
        >
          <span className="text-3xl md:text-5xl drop-shadow-lg">{r.emoji}</span>
          <span className="text-[10px] font-semibold text-white bg-black/60 rounded-full px-2 py-0.5 whitespace-nowrap">
            {r.peerName}
          </span>
        </div>
      ))}
    </div>
  );
}

// ─── Reaction picker ─────────────────────────────────────────────────────────

function ReactionBar({ onPick, onClose }: { onPick: (emoji: string) => void; onClose: () => void }) {
  return (
    // Eight 40px targets plus padding come to 366px, which overflows a 360px phone.
    // Tighter on mobile — 36px is still at the tap-target minimum used elsewhere in
    // this file — and wrapping as a last resort rather than spilling off screen.
    <div
      className="absolute bottom-20 left-1/2 -translate-x-1/2 flex flex-wrap justify-center items-center gap-1 p-1.5 md:p-2 rounded-2xl bg-white border border-[var(--ib-gray-100)] shadow-[var(--ib-shadow-lg)] z-30 max-w-[92vw]"
      role="group"
      aria-label="Send a reaction"
    >
      {REACTIONS.map((emoji) => (
        <button
          key={emoji}
          onClick={() => { onPick(emoji); onClose(); }}
          className="w-9 h-9 md:w-10 md:h-10 flex items-center justify-center rounded-xl text-lg md:text-xl hover:bg-[var(--ib-gray-100)] active:scale-90 transition-all cursor-pointer"
          aria-label={`React with ${emoji}`}
        >
          {emoji}
        </button>
      ))}
    </div>
  );
}

// ─── Local video tile ────────────────────────────────────────────────────────

function LocalTile({ stream, isVideoOff, name, bgMode }: { stream: MediaStream | null; isVideoOff: boolean; name: string; bgMode: BgMode; }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number>(0);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const segRef = useRef<any>(null);
  const segReadyRef = useRef(false);
  const bgModeRef = useRef<BgMode>(bgMode);
  const offscreenRef = useRef<HTMLCanvasElement | null>(null);

  // Keep bgModeRef current so callbacks always see the latest mode
  useEffect(() => { bgModeRef.current = bgMode; }, [bgMode]);

  // Video stream attachment
  useEffect(() => {
    const vid = videoRef.current;
    if (!vid || !stream) return;
    if (vid.srcObject !== stream) vid.srcObject = stream;
    vid.play().catch(() => {});
  }, [stream, isVideoOff]);

  // MediaPipe init — runs once on mount, pipeline is: send → onResults(draw + scheduleNextRAF)
  useEffect(() => {
    const offscreen = document.createElement('canvas');
    offscreenRef.current = offscreen;

    import('@mediapipe/selfie_segmentation').then(({ SelfieSegmentation }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const seg = new (SelfieSegmentation as any)({ locateFile: (f: string) => `/mediapipe/${f}` });
      seg.setOptions({ modelSelection: 1, selfieMode: false });

      seg.onResults((results: { image: CanvasImageSource; segmentationMask: CanvasImageSource }) => {
        const canvas = canvasRef.current;
        const offsc = offscreenRef.current;
        const mode = bgModeRef.current;
        if (!canvas || !offsc || mode === 'none') return;

        const vid = videoRef.current;
        if (vid && vid.videoWidth > 0) {
          if (canvas.width !== vid.videoWidth)  canvas.width  = vid.videoWidth;
          if (canvas.height !== vid.videoHeight) canvas.height = vid.videoHeight;
        }
        if (offsc.width !== canvas.width)  offsc.width  = canvas.width;
        if (offsc.height !== canvas.height) offsc.height = canvas.height;

        const ctx  = canvas.getContext('2d')!;
        const octx = offsc.getContext('2d')!;
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        if (mode === 'blur' || mode === 'blur-heavy') {
          const blurPx = mode === 'blur-heavy' ? '20px' : '12px';
          (ctx as CanvasRenderingContext2D & { filter: string }).filter = `blur(${blurPx})`;
          ctx.drawImage(results.image, 0, 0, canvas.width, canvas.height);
          (ctx as CanvasRenderingContext2D & { filter: string }).filter = 'none';
          // Composite sharp person on top
          octx.clearRect(0, 0, offsc.width, offsc.height);
          octx.drawImage(results.image, 0, 0, offsc.width, offsc.height);
          octx.globalCompositeOperation = 'destination-in';
          octx.drawImage(results.segmentationMask, 0, 0, offsc.width, offsc.height);
          octx.globalCompositeOperation = 'source-over';
          ctx.drawImage(offsc, 0, 0);
        } else {
          // Solid color background + person cutout
          ctx.fillStyle = mode === 'color-dark' ? '#1a1a2e' : '#0f0c29';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          octx.clearRect(0, 0, offsc.width, offsc.height);
          octx.drawImage(results.image, 0, 0, offsc.width, offsc.height);
          octx.globalCompositeOperation = 'destination-in';
          octx.drawImage(results.segmentationMask, 0, 0, offsc.width, offsc.height);
          octx.globalCompositeOperation = 'source-over';
          ctx.drawImage(offsc, 0, 0);
        }

        // Correct pipeline: draw → schedule next send via RAF (never call send before onResults fires)
        if (bgModeRef.current !== 'none') {
          rafRef.current = requestAnimationFrame(() => {
            const v = videoRef.current;
            if (bgModeRef.current !== 'none' && v && v.readyState >= 2) {
              seg.send({ image: v }).catch(() => {});
            }
          });
        }
      });

      seg.initialize().then(() => {
        segRef.current = seg;
        segReadyRef.current = true;
        // If a bg mode is already active, kick off the pipeline (replaces fallback loop)
        cancelAnimationFrame(rafRef.current);
        const v = videoRef.current;
        if (bgModeRef.current !== 'none' && v && v.readyState >= 2) {
          seg.send({ image: v }).catch(() => {});
        }
      }).catch(() => {});
    }).catch(() => {});

    return () => { cancelAnimationFrame(rafRef.current); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Start/stop loop when bgMode changes
  useEffect(() => {
    cancelAnimationFrame(rafRef.current);
    if (bgMode === 'none') return;

    const vid = videoRef.current;
    const canvas = canvasRef.current;
    if (!vid || !canvas) return;

    if (segReadyRef.current && segRef.current) {
      // MediaPipe already ready — start pipeline immediately
      const kick = () => {
        if (vid.readyState >= 2) { segRef.current.send({ image: vid }).catch(() => {}); }
        else rafRef.current = requestAnimationFrame(kick);
      };
      kick();
      return;
    }

    // Fallback loop (runs while MediaPipe is still loading)
    const offsc = offscreenRef.current ?? document.createElement('canvas');
    const offCtx = offsc.getContext('2d')!;

    const fallback = () => {
      if (bgModeRef.current === 'none') return;
      if (segReadyRef.current) return; // MediaPipe ready now, its pipeline takes over
      if (!vid || vid.readyState < 2 || vid.videoWidth === 0) { rafRef.current = requestAnimationFrame(fallback); return; }

      const w = vid.videoWidth, h = vid.videoHeight;
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; offsc.width = w; offsc.height = h; }

      const ctx = canvas.getContext('2d')!;
      const mode = bgModeRef.current;
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      if (mode === 'blur' || mode === 'blur-heavy') {
        const blurPx = mode === 'blur-heavy' ? '20px' : '12px';
        (ctx as CanvasRenderingContext2D & { filter: string }).filter = `blur(${blurPx})`;
        ctx.drawImage(vid, -20, -20, canvas.width + 40, canvas.height + 40);
        (ctx as CanvasRenderingContext2D & { filter: string }).filter = 'none';
      } else {
        // Color fallback: draw video then lay a dark tint on top
        ctx.drawImage(vid, 0, 0, canvas.width, canvas.height);
        ctx.fillStyle = mode === 'color-dark' ? 'rgba(10,10,40,0.65)' : 'rgba(5,4,25,0.75)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }

      rafRef.current = requestAnimationFrame(fallback);
    };

    rafRef.current = requestAnimationFrame(fallback);
  }, [bgMode]);

  const showCanvas = bgMode !== 'none' && !isVideoOff;

  return (
    <div className="w-full h-full relative bg-[#202124]">
      <video
        ref={videoRef} autoPlay playsInline muted
        style={{ willChange: 'transform' }}
        className={`w-full h-full object-cover transition-opacity duration-150 ${isVideoOff || showCanvas ? 'opacity-0 absolute inset-0 pointer-events-none' : 'opacity-100'}`}
      />
      {showCanvas && <canvas ref={canvasRef} className="w-full h-full object-cover" style={{ display: 'block' }} />}
      {isVideoOff && (
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <Avatar initials={name.charAt(0).toUpperCase()} size="lg" className="mb-2 shadow-lg" />
          <span className="text-xs text-[#9aa0a6] font-medium tracking-wide truncate max-w-[90%]">{name}</span>
        </div>
      )}
    </div>
  );
}

// ─── Remote tile ─────────────────────────────────────────────────────────────

// ─── Subscription tiers ──────────────────────────────────────────────────────
//
// Above TIER_THRESHOLD participants a client stops subscribing to everyone and
// takes only the top-ranked few. Below it nothing changes at all, which is
// deliberate: the caps buy nothing in a small call and cost real
// responsiveness (see audioPeerIdsRef in useWebRTC for the round-trip a capped
// speaker pays), so they stay off where they would only do harm.
//
// Sizing, from the measured egress model (ibconnect-planning/model2.py):
//   video only, 16/page   -> one room caps out at N=58 on this host's link
//   video 9               -> N=75
//   video 9 + audio 12    -> N=125
// Audio is worth more than video because it is quadratic and uncapped:
// N*(N-1)*48kbps is 295 Mbps at N=76, 47% of the link, for audio alone.
const VIDEO_TIER_THRESHOLD = 16;
const VIDEO_TIER_CAP = 9;

// The audio cap is deliberately set ABOVE the current MAX_ROOM_SIZE (24), so it
// is dormant in every room this deployment can create today. That is not
// caution for its own sake — it rests on one assumption that has not been
// verified on this deployment:
//
//   LiveKit must report RoomEvent.ActiveSpeakersChanged for participants whose
//   audio you are NOT subscribed to. If it does, an unsubscribed speaker is
//   detected and promoted into the subscribed set within a round trip. If it
//   does NOT, they are inaudible and stay inaudible, with no way back.
//
// The SDK side is confirmed to support it: handleActiveSpeakersUpdate resolves
// speakers via getRemoteParticipantBySid against room.remoteParticipants, which
// holds every participant regardless of subscription, with no subscription
// filter anywhere in the path. The SERVER side is not confirmed here.
//
// Failure mode if the assumption is wrong: in a 20-person meeting, 8 people are
// silently inaudible — exactly the meetings this exists to enable. That is not
// a gamble worth taking on an unverified premise, so it stays dormant until the
// test below passes. To verify: drop AUDIO_TIER_THRESHOLD to 2 in a dev build,
// join with three tabs, confirm the third participant is NOT audio-subscribed
// (chrome://webrtc-internals shows no inbound-rtp audio for them), have them
// speak, and confirm they appear in activeSpeakerIds and become audible.
// Three browser tabs — ordinary use, not a load test.
const AUDIO_TIER_THRESHOLD = 24;
const AUDIO_TIER_CAP = 12;

function RemoteTile({ peer, videoWithheld = false }: { peer: PeerInfo; videoWithheld?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);

  // A one-shot play() on mount isn't enough. The element is created the moment a
  // peer's stream arrives (before that this tile renders the "Connecting…" state
  // instead, so there is no <video> at all), and that first play() can be rejected
  // outright — the promise loses the race with the stream still being wired up, or
  // with the tile being moved between the grid, the focus stage and the carousel.
  // It failed silently, leaving a tile that has live, arriving media but is stuck
  // paused on a black frame: the "I reloaded and now I can't see them" symptom.
  // Re-asserting playback whenever the element reports new data (and if it ever
  // ends up paused, which nothing in the UI does deliberately) is self-healing.
  //
  // track.attach() rather than a manual srcObject assignment — this is what wires
  // this element into Room's adaptiveStream tracking (see peer.videoTrack's own
  // comment in useWebRTC.ts): LiveKit watches attached elements' viewport
  // visibility and size to request a lower simulcast layer, or none at all, for
  // one that's off-screen or small — a manual srcObject assignment gives it
  // nothing to observe. detach() on cleanup matters here specifically because
  // this peer's video can be unsubscribed entirely (paginated away) while this
  // component may still be mounted for one more render.
  useEffect(() => {
    const vid = ref.current;
    const track = peer.videoTrack;
    if (!vid || !track) return;
    track.attach(vid);
    playWhenAllowed(vid);
    return () => { track.detach(vid); };
  }, [peer.videoTrack]);

  const ensurePlaying = () => {
    const vid = ref.current;
    if (vid && vid.paused) playWhenAllowed(vid);
  };

  // A peer who turns their camera off still has a stream — it carries their audio —
  // so `!peer.stream` alone never caught it. The <video> kept the last decoded frame
  // painted, which looked exactly like a frozen connection.
  //
  // `stillConnecting` matters separately: a BRAND NEW connection can show zero video
  // (or a muted track) for a few seconds while video negotiation finishes, which is
  // normal and happens on every existing participant's connection to whoever just
  // joined. Without this, that startup window showed the same "Camera off" label as a
  // real, deliberate camera stop — wrong wording for someone simply still connecting,
  // and on a real network that window can flicker through more than once before
  // settling. See useHasVideo for the full story, including why it still converges to
  // "Camera off" for someone who genuinely has no camera, just after a short grace.
  const { hasVideo, stillConnecting } = useHasVideo(peer.stream);

  // `hasVideo` alone cannot catch a link that is 'connected' and still marked live but
  // has quietly stopped decoding — see useStalledVideoRecovery for why. This is a
  // separate failure mode from camera-off and needs an active repair, not just a
  // different overlay.
  const { restartPeerConnection } = useMeeting();
  const onStalled = useCallback(() => restartPeerConnection(peer.id), [restartPeerConnection, peer.id]);
  useStalledVideoRecovery(ref, hasVideo, onStalled);

  if (!peer.stream) {
    return (
      <div className="w-full h-full flex flex-col items-center justify-center bg-[#202124]">
        <Avatar initials={peer.name.charAt(0).toUpperCase()} size="lg" className="mb-2" />
        <span className="text-xs font-medium text-[#e8eaed] truncate max-w-[90%]">{peer.name}</span>
        <span className="flex items-center gap-1.5 text-[9px] md:text-[10px] text-[#8ab4f8] mt-1">
          <BrandDots mode="loading" size={6} />Connecting…
        </span>
      </div>
    );
  }

  return (
    <>
      <video
        ref={ref}
        autoPlay
        playsInline
        // Video only — this peer's audio comes out of the persistent <PeerAudio>
        // mounted outside the grid, so it keeps playing when this tile is on
        // another page, in the carousel, or unmounted by a layout switch.
        muted
        onLoadedMetadata={ensurePlaying}
        onCanPlay={ensurePlaying}
        onPause={ensurePlaying}
        style={{ willChange: 'transform' }}
        className={`w-full h-full object-cover ${hasVideo ? '' : 'invisible'}`}
      />
      {/* Covers the element rather than replacing it: unmounting the <video> would
          drop the srcObject, so turning the camera back on would have to re-attach and
          re-negotiate autoplay. Keeping it mounted and hidden means the picture returns
          the instant frames do. Deliberately worded and styled apart from "Connecting…"
          — a camera that is off is a choice, not a fault — but only once we've actually
          seen it be on: a track that exists but has never yet decoded a frame (a peer
          who just joined, still negotiating) gets "Connecting…" instead, same wording as
          the `!peer.stream` branch above. Someone with NO video track at all — joined
          camera-off, or genuinely toggled it off — skips straight to "Camera off", same
          as before this distinction existed. */}
      {!hasVideo && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-[#202124]">
          <Avatar initials={peer.name.charAt(0).toUpperCase()} size="lg" />
          {/* A tile whose video we deliberately did not subscribe (see the
              subscription tiers above) is neither connecting nor camera-off —
              claiming either would be a lie. Show the avatar and say nothing. */}
          {videoWithheld ? null : stillConnecting ? (
            <span className="flex items-center gap-1.5 text-[9px] md:text-[10px] text-[#8ab4f8]">
              <BrandDots mode="loading" size={6} />Connecting…
            </span>
          ) : (
            <span className="text-[9px] md:text-[10px] text-[#9aa0a6] flex items-center gap-1">
              <VideoOff className="w-3 h-3" />Camera off
            </span>
          )}
        </div>
      )}
    </>
  );
}

// ─── Screen-share spotlight tile ───────────────────────────────────────────────
// Uses object-contain (not object-cover) so shared screens are never cropped —
// unlike camera tiles, a screen's content (text, slides, code) is unusable if
// half of it gets clipped off to fill a square-ish grid cell.

// ============================================================================
// DO NOT CONVERT THIS TILE TO track.attach(). READ THIS FIRST.
// ============================================================================
// This tile assigns a hand-built MediaStream to <video>.srcObject and never
// calls track.attach(). That is DELIBERATE and it is load-bearing for screen
// share quality. LiveKit only observes an element's size when you attach()
// through it, so with srcObject adaptiveStream never measures this tile, and
// the setVideoQuality(HIGH) that applyVideoSubscription sends for ScreenShare
// (useWebRTC.ts) is the only instruction the SFU has. Result: the top rung.
//
// Switch this to track.attach() and emitTrackUpdate() starts taking
// min(what we asked for, this element's CSS size). A screen-share tile is
// never as wide as the source, so the SFU quietly forwards a lower rung.
// MEASURED 2026-09-08, same source, same 1188x668 stage:
//     srcObject (this file)  -> viewer receives 1920x1080
//     track.attach()         -> viewer receives 1280x720
//     track.attach() + setVideoQuality(HIGH)     -> still 1280x720 (overruled)
//     track.attach() + setVideoDimensions(1920)  -> still 1280x720 (overruled)
// There is NO error, NO warning and NO log when that happens. Text just goes
// soft and someone reopens this ticket in three months.
//
// RemoteTile (camera) is the opposite case and correctly DOES use attach() -
// camera tiles WANT to be sized down when they are small. Screen share does not.
// ============================================================================
function ScreenTile({ stream, label, compact = false, isPinned = false, onToggleFocus }: {
  stream: MediaStream | null;
  label: string;
  compact?: boolean;
  isPinned?: boolean;
  onToggleFocus?: () => void;
}) {
  const ref = useRef<HTMLVideoElement>(null);

  // Same mount race as RemoteTile — the <video> only exists once a stream arrives,
  // so attach on the ref callback and re-assert playback rather than relying on a
  // single play() that can be rejected into a silently frozen share.
  const attach = useCallback((vid: HTMLVideoElement | null) => {
    ref.current = vid;
    if (!vid || !stream) return;
    // srcObject, NOT track.attach() - see the banner above this function.
    if (vid.srcObject !== stream) vid.srcObject = stream;
    playWhenAllowed(vid);
  }, [stream]);

  useEffect(() => { attach(ref.current); }, [attach]);

  const ensurePlaying = () => {
    const vid = ref.current;
    if (vid && vid.paused) playWhenAllowed(vid);
  };

  return (
    <div className={`group relative w-full h-full overflow-hidden bg-black border border-[#3c4043] shadow-lg flex items-center justify-center ${compact ? 'rounded-xl' : 'rounded-2xl'}`}>
      {stream ? (
        <video
          ref={attach}
          autoPlay
          playsInline
          muted
          onLoadedMetadata={ensurePlaying}
          onCanPlay={ensurePlaying}
          onPause={ensurePlaying}
          className="w-full h-full object-contain"
        />
      ) : (
        <div className="flex flex-col items-center gap-2 text-[#9aa0a6]">
          <ScreenShare className={compact ? 'w-5 h-5 animate-pulse' : 'w-8 h-8 animate-pulse'} />
          <span className="text-xs">Connecting…</span>
        </div>
      )}
      <div className={`absolute bg-[#111]/80 backdrop-blur-sm font-semibold text-white flex items-center gap-1.5 shadow-sm truncate ${
        compact
          ? 'bottom-1 left-1 px-1.5 py-0.5 rounded-md text-[9px] max-w-[85%]'
          : 'bottom-2 left-2 md:bottom-3 md:left-3 px-2 py-1 md:px-3 md:py-1.5 rounded-lg text-[10px] md:text-xs'
      }`}>
        <ScreenShare className={`${compact ? 'w-2.5 h-2.5' : 'w-3 h-3'} shrink-0`} />
        <span className="truncate">{label}</span>
      </div>

      {onToggleFocus && (
        <button
          onClick={onToggleFocus}
          aria-label={isPinned ? `Unpin ${label}` : `Pin ${label}`}
          title={isPinned ? 'Unpin' : 'Pin to main view'}
          className={`absolute top-1.5 right-1.5 md:top-2 md:right-2 p-1.5 rounded-lg bg-[#202124]/85 backdrop-blur-sm border border-[#5f6368]/50 text-white shadow-lg cursor-pointer transition-opacity hover:bg-[#3c4043] focus-visible:opacity-100 ${
            isPinned ? 'opacity-100 text-[#8ab4f8]' : 'opacity-0 group-hover:opacity-100'
          }`}
        >
          {isPinned ? <PinOff className={compact ? 'w-3 h-3' : 'w-3.5 h-3.5'} /> : <Pin className={compact ? 'w-3 h-3' : 'w-3.5 h-3.5'} />}
        </button>
      )}
    </div>
  );
}

// ─── Participant tile ────────────────────────────────────────────────────────
// One component for every place a camera feed appears — the grid, the focus
// stage, and the carousel — so the chrome (speaking ring, name badge, mute
// pip, pin affordance) can't drift between them the way it used to when the
// grid and the screen-share strip each hand-rolled their own copy.

interface ParticipantTileProps {
  id: string;
  name: string;
  isLocal: boolean;
  localStream: MediaStream | null;
  peer?: PeerInfo;
  isVideoOff: boolean;
  isMuted: boolean;
  bgMode: BgMode;
  isSpeaking: boolean;
  isPresenting: boolean;
  isFocused: boolean;
  onToggleFocus: () => void;
  /** Carousel tiles shrink their badges/controls so they stay legible when small. */
  compact?: boolean;
  /** Grade of *our* link to this peer, from getStats(). Absent for the local tile. */
  quality?: LinkQuality;
  relayed?: boolean;
  handRaised?: boolean;
  /** Tile is mounted but its camera video was intentionally not subscribed. */
  videoWithheld?: boolean;
}

// Your OWN share, shown to you. Deliberately a static card and never a <video>
// of your own screen: painting your display onto your display is the infinite
// mirror tunnel, and it is instant the moment you share a whole screen rather
// than a single window. Filtering 'local-screen' out of one render site at a
// time does not fix that - the stage, the carousel and an explicit pin are
// three separate paths to the same tunnel - so the self-view simply stops
// being a video anywhere. This also restores the "you are presenting"
// indicator, which the previous auto-focus guard had removed entirely.
function PresentingCard({ compact = false, onStop, onToggleFocus }: {
  compact?: boolean;
  onStop?: () => void;
  onToggleFocus?: () => void;
}) {
  return (
    <div
      onClick={onToggleFocus}
      className={`group relative w-full h-full overflow-hidden bg-[#202124] border border-[#3c4043] shadow-lg flex flex-col items-center justify-center gap-2 ${
        compact ? 'rounded-xl gap-1' : 'rounded-2xl md:gap-3'
      } ${onToggleFocus ? 'cursor-pointer' : ''}`}
    >
      <div className={`rounded-full bg-[#1a73e8]/15 flex items-center justify-center ${compact ? 'w-7 h-7' : 'w-12 h-12 md:w-16 md:h-16'}`}>
        <ScreenShare className={`text-[#8ab4f8] ${compact ? 'w-3.5 h-3.5' : 'w-6 h-6 md:w-8 md:h-8'}`} />
      </div>
      <span className={`font-semibold text-[#e8eaed] ${compact ? 'text-[10px]' : 'text-sm md:text-base'}`}>
        You&apos;re presenting
      </span>
      {!compact && (
        <span className="text-[11px] md:text-xs text-[#9aa0a6] px-4 text-center">
          Everyone else in the meeting can see your screen.
        </span>
      )}
      {!compact && onStop && (
        <button
          onClick={(e) => { e.stopPropagation(); onStop(); }}
          className="mt-1 md:mt-2 flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#ea4335] hover:bg-[#d33b2c] active:scale-95 text-white text-xs font-semibold transition-all cursor-pointer"
        >
          <ScreenShareOff className="w-3.5 h-3.5" />
          Stop sharing
        </button>
      )}
    </div>
  );
}

function ParticipantTile({
  name, isLocal, localStream, peer, isVideoOff, isMuted, bgMode,
  isSpeaking, isPresenting, isFocused, onToggleFocus, compact = false,
  quality = 'unknown', relayed = false, handRaised = false, videoWithheld = false,
}: ParticipantTileProps) {
  return (
    <div
      className={`group relative w-full h-full rounded-xl md:rounded-2xl overflow-hidden bg-[#202124] border shadow-lg transition-colors ${
        isSpeaking ? 'border-[var(--ib-blue-500)] ring-2 ring-[var(--ib-blue-500)]/70' : 'border-[#3c4043]'
      }`}
    >
      {isLocal
        ? <LocalTile stream={localStream} isVideoOff={isVideoOff} name={name} bgMode={bgMode} />
        : <RemoteTile peer={peer!} videoWithheld={videoWithheld} />}

      <div
        className={`absolute bg-[#111]/70 backdrop-blur-sm rounded-md md:rounded-lg font-semibold text-white truncate shadow-sm flex items-center gap-1 ${
          compact
            ? 'bottom-1 left-1 px-1.5 py-0.5 text-[9px] max-w-[85%]'
            : 'bottom-2 left-2 md:bottom-3 md:left-3 px-2 py-1 md:px-3 md:py-1.5 text-[10px] md:text-xs max-w-[80%]'
        }`}
      >
        {isPresenting && <ScreenShare className={`${compact ? 'w-2.5 h-2.5' : 'w-3 h-3'} text-[#8ab4f8] shrink-0`} />}
        {isLocal && isMuted && <MicOff className={`${compact ? 'w-2.5 h-2.5' : 'w-3 h-3'} text-[#f28b82] shrink-0`} />}
        <span className="truncate">{name}</span>
        {!isLocal && <QualityBadge quality={quality} relayed={relayed} />}
      </div>

      {/* A raised hand has to be visible on the tile, not only in the roster — in a
          call big enough for someone to need the button, nobody has the People panel
          open. Positioned left so it never collides with the pin control. */}
      {handRaised && (
        <div
          className={`absolute rounded-lg bg-[var(--ib-warn-dot)] text-[var(--ib-gray-900)] shadow-lg flex items-center justify-center ${
            compact ? 'top-1 left-1 w-5 h-5' : 'top-1.5 left-1.5 md:top-2 md:left-2 w-7 h-7'
          }`}
          title={`${name} has their hand raised`}
          aria-label={`${name} has their hand raised`}
          role="img"
        >
          <Hand className={compact ? 'w-3 h-3' : 'w-4 h-4'} />
        </div>
      )}

      {/* Pin/unpin. Keyboard-reachable always; revealed on hover for pointer users. */}
      <button
        onClick={onToggleFocus}
        aria-label={isFocused ? `Unpin ${name}` : `Pin ${name}`}
        title={isFocused ? 'Unpin' : 'Pin to main view'}
        className={`absolute top-1.5 right-1.5 md:top-2 md:right-2 p-1.5 rounded-lg bg-[#202124]/85 backdrop-blur-sm border border-[#5f6368]/50 text-white shadow-lg cursor-pointer transition-opacity hover:bg-[#3c4043] focus-visible:opacity-100 ${
          isFocused ? 'opacity-100 text-[var(--ib-blue-500)]' : 'opacity-0 group-hover:opacity-100'
        }`}
      >
        {isFocused
          ? <PinOff className={compact ? 'w-3 h-3' : 'w-3.5 h-3.5'} />
          : <Pin className={compact ? 'w-3 h-3' : 'w-3.5 h-3.5'} />}
      </button>
    </div>
  );
}

// ─── Settings Panel ──────────────────────────────────────────────────────────

const BG_OPTIONS: { mode: BgMode; label: string; icon: string }[] = [
  { mode: 'none',        label: 'None',       icon: '⬛' },
  { mode: 'blur',        label: 'Blur',       icon: '🌫️' },
  { mode: 'blur-heavy',  label: 'Heavy',      icon: '💨' },
  { mode: 'color-dark',  label: 'Dark',       icon: '🌑' },
  { mode: 'color-space', label: 'Space',      icon: '🌌' },
];

function DeviceSelect({ label, Icon, devices, selected, onChange }: {
  label: string; Icon: React.FC<{ className?: string }>;
  devices: MediaDeviceInfo[]; selected: string; onChange: (id: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-[var(--ib-gray-600)]">
        <Icon className="w-3 h-3" />{label}
      </div>
      <div className="relative">
        <select
          value={selected}
          onChange={(e) => onChange(e.target.value)}
          className="w-full bg-[var(--ib-gray-50)] border border-[var(--ib-gray-200)] rounded-lg px-3 py-2 text-xs text-[var(--ib-gray-900)] outline-none appearance-none cursor-pointer focus:border-[var(--ib-blue-500)]"
        >
          {devices.length === 0 && <option value="">No devices found</option>}
          {devices.map(d => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label || `Device ${d.deviceId.slice(0, 8)}`}
            </option>
          ))}
        </select>
        <ChevronDown className="w-3 h-3 text-[var(--ib-gray-600)] absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
      </div>
    </div>
  );
}

function SettingsPanel({
  bgMode, onBgChange, videoDevices, audioDevices, outputDevices,
  selectedCamera, selectedMic, selectedSpeaker, speakerSelectable,
  onCameraChange, onMicChange, onSpeakerChange, onClose,
}: {
  bgMode: BgMode; onBgChange: (m: BgMode) => void;
  videoDevices: MediaDeviceInfo[]; audioDevices: MediaDeviceInfo[]; outputDevices: MediaDeviceInfo[];
  selectedCamera: string; selectedMic: string; selectedSpeaker: string;
  speakerSelectable: boolean;
  onCameraChange: (id: string) => void; onMicChange: (id: string) => void; onSpeakerChange: (id: string) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<'bg' | 'devices' | 'keys'>('bg');
  return (
    <div className="absolute bottom-20 right-4 w-[90vw] md:w-72 max-w-sm bg-white border border-[var(--ib-gray-100)] rounded-2xl shadow-[var(--ib-shadow-lg)] z-30 overflow-hidden">
      {/* gap-1 -> gap-0.5, px-3 -> px-2: pre-existing tightness, not
          introduced by this retheme (only colors changed elsewhere in this
          panel) -- three tab labels plus the outer panel's overflow-hidden
          was clipping "Shortcuts" to "Shortcu", caught while screenshotting
          this sub-unit at 1280px. */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--ib-gray-100)]">
        <div className="flex gap-0.5">
          {(['bg', 'devices', 'keys'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)} className={`px-2 py-1 rounded-lg text-xs font-semibold transition-colors ${tab === t ? 'bg-[var(--ib-blue-50)] text-[var(--ib-blue-500)]' : 'text-[var(--ib-gray-600)] hover:text-[var(--ib-gray-900)]'}`}>
              {t === 'bg' ? 'Backgrounds' : t === 'devices' ? 'Devices' : 'Shortcuts'}
            </button>
          ))}
        </div>
        <button onClick={onClose} className="text-[var(--ib-gray-600)] hover:text-[var(--ib-gray-900)] cursor-pointer"><X className="w-4 h-4" /></button>
      </div>
      <div className="p-4">
        {tab === 'bg' && (
          <div className="flex flex-col gap-3">
            <p className="text-[10px] text-[var(--ib-gray-600)] uppercase font-bold tracking-wider">Virtual Background</p>
            <div className="grid grid-cols-5 gap-2">
              {BG_OPTIONS.map(opt => (
                <button
                  key={opt.mode}
                  onClick={() => onBgChange(opt.mode)}
                  className={`flex flex-col items-center gap-1 p-2 rounded-xl text-[10px] font-semibold cursor-pointer transition-all ${bgMode === opt.mode ? 'bg-[var(--ib-blue-50)] text-[var(--ib-blue-500)] border border-[var(--ib-blue-100)]' : 'bg-[var(--ib-gray-50)] text-[var(--ib-gray-600)] hover:bg-[var(--ib-gray-100)] border border-transparent'}`}
                >
                  <span className="text-base md:text-xl">{opt.icon}</span>
                  <span className="hidden md:inline">{opt.label}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        {tab === 'devices' && (
          <div className="flex flex-col gap-4">
            <DeviceSelect label="Camera"   Icon={Video}   devices={videoDevices}  selected={selectedCamera}  onChange={onCameraChange} />
            <DeviceSelect label="Mic"      Icon={Mic}     devices={audioDevices}  selected={selectedMic}     onChange={onMicChange} />
            {/* Safari has no setSinkId and Firefox only shipped it recently. Hiding the
                control is the honest fallback — leaving it visible and inert is exactly
                the bug this replaced. */}
            {speakerSelectable ? (
              <DeviceSelect label="Speaker" Icon={Volume2} devices={outputDevices} selected={selectedSpeaker} onChange={onSpeakerChange} />
            ) : (
              <div className="flex flex-col gap-1">
                <span className="text-[10px] text-[var(--ib-gray-600)] uppercase font-bold tracking-wider">Speaker</span>
                <p className="text-[11px] text-[var(--ib-gray-600)] leading-snug">
                  This browser can't choose an output device. Pick your speaker in the operating system's sound settings.
                </p>
              </div>
            )}
          </div>
        )}
        {tab === 'keys' && (
          <div className="flex flex-col gap-2">
            {SHORTCUT_HINTS.map((s) => (
              <div key={s.keys} className="flex items-center justify-between gap-3">
                <span className="text-xs text-[var(--ib-gray-900)]">{s.action}</span>
                <kbd className="px-2 py-0.5 rounded-md bg-[var(--ib-gray-100)] border border-[var(--ib-gray-200)] text-[10px] font-mono text-[var(--ib-gray-600)] whitespace-nowrap">{s.keys}</kbd>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}


// ─── Right panel (Chat + People + Mobile Transcript) ─────────────────────────

function SummarySection({ icon: Icon, title, tone, items }: { icon: React.ElementType; title: string; tone: string; items: string[] }) {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-black/10 p-2.5">
      <p className={`mb-2 flex items-center gap-1.5 text-[9px] font-bold uppercase tracking-[.12em] ${tone}`}>
        <Icon className="h-3 w-3" />{title}
      </p>
      <div className="space-y-2">
        {items.map((item, index) => (
          <div key={index} className="flex gap-2 text-[10px] leading-4 text-[#dce1e8]">
            <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-current opacity-70" />
            <span>{item}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function RightPanel({
  tab, onTabChange, chatMessages, onSend, peers, userName, isMuted, onClose,
  links, raisedHands, isHandRaised,
  transcribing, captionsSupported, captionsUnavailable, transcriptLines, keyPoints, transcriptEndRef,
  myCaptionLang, onCaptionLangChange, captionSize, onCaptionSizeChange, onStartCaptions, onStopCaptions,
  roomId,
}: {
  tab: 'chat' | 'people' | 'captions'; onTabChange: (t: 'chat' | 'people' | 'captions') => void;
  chatMessages: { id: string; fromId: string; fromName: string; text: string; time: string; isSelf: boolean }[];
  onSend: (text: string) => void; peers: PeerInfo[]; userName: string; isMuted: boolean; onClose: () => void;
  links: ReadonlyMap<string, PeerLink>; raisedHands: ReadonlySet<string>; isHandRaised: boolean;
  transcribing: boolean; captionsSupported: boolean; captionsUnavailable: string | null;
  transcriptLines: TranscriptLine[]; keyPoints: KeyPoint[]; transcriptEndRef: React.RefObject<HTMLDivElement>;
  myCaptionLang: string | null; onCaptionLangChange: (lang: string | null) => void;
  captionSize: CaptionSize; onCaptionSizeChange: (size: CaptionSize) => void;
  onStartCaptions: () => void; onStopCaptions: () => void;
  roomId: string | null;
}) {
  const [input, setInput] = useState('');
  const chatEndRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (tab === 'chat') chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [chatMessages, tab]);
  useEffect(() => { if (tab === 'captions') transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [transcriptLines, tab, transcriptEndRef]);

  const send = () => { if (!input.trim()) return; onSend(input.trim()); setInput(''); };

  // ── Meeting transcript file + MOM summary (server/meeting_transcripts.go) ──
  // The server saves every FINAL caption line as it's spoken, independent of
  // whether anyone has this panel open — transcriptLines here is only this
  // client's own local log (capped at 50, gone on refresh), so both actions
  // below fetch the real, complete, durable record from the server rather
  // than exporting/summarizing whatever happens to still be in memory here.
  const [isDownloading, setIsDownloading] = useState(false);
  const [isSummarizing, setIsSummarizing] = useState(false);
  const [summary, setSummary] = useState<MeetingSummary | null>(null);
  const [transcriptError, setTranscriptError] = useState<string | null>(null);
  const [summaryCopied, setSummaryCopied] = useState(false);

  const handleDownloadTranscript = async () => {
    if (!roomId || isDownloading) return;
    setIsDownloading(true);
    setTranscriptError(null);
    try {
      const { lines } = await api.getMeetingTranscript(roomId);
      if (lines.length === 0) { setTranscriptError('No transcript saved yet — turn captions on and speak first.'); return; }
      const text = lines.map((l) => `[${new Date(l.createdAt).toLocaleTimeString()}] ${l.speakerName}: ${l.text}`).join('\n');
      const blob = new Blob([text], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `transcript-${roomId}.txt`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setTranscriptError(err instanceof Error ? err.message : 'Could not download the transcript');
    } finally {
      setIsDownloading(false);
    }
  };

  const handleGenerateSummary = async () => {
    if (!roomId || isSummarizing) return;
    setIsSummarizing(true);
    setTranscriptError(null);
    try {
      setSummary(await api.getMeetingSummary(roomId));
    } catch (err) {
      setTranscriptError(err instanceof Error ? err.message : 'Could not generate a summary');
    } finally {
      setIsSummarizing(false);
    }
  };

  const handleCopySummary = async () => {
    if (!summary) return;
    const lines = [
      'Meeting summary', summary.summary,
      summary.attendees.length ? `Attendees: ${summary.attendees.join(', ')}` : '',
      summary.keyPoints.length ? `Key points\n${summary.keyPoints.map(item => `• ${item}`).join('\n')}` : '',
      summary.decisions.length ? `Decisions\n${summary.decisions.map(item => `• ${item}`).join('\n')}` : '',
      summary.actionItems.length ? `Action items\n${summary.actionItems.map(item => `• ${item.description}${item.owner && item.owner.toLowerCase() !== 'unclear' ? ` — ${item.owner}` : ''}`).join('\n')}` : '',
    ].filter(Boolean).join('\n\n');
    try {
      await navigator.clipboard.writeText(lines);
      setSummaryCopied(true);
      window.setTimeout(() => setSummaryCopied(false), 1800);
    } catch {
      setTranscriptError('Could not copy the summary. You can still select and copy its text.');
    }
  };

  return (
    <div className="w-full h-full flex flex-col bg-[#202124] overflow-hidden">
      <div className="flex items-center border-b border-[#3c4043] px-1 pt-1 md:px-2 md:pt-2 bg-[#1a1b1e] shrink-0">
        {(captionsSupported ? (['chat', 'people', 'captions'] as const) : (['chat', 'people'] as const)).map(t => (
          <button
            key={t} onClick={() => onTabChange(t)}
            className={`flex-1 py-2.5 text-[10px] md:text-xs font-semibold border-b-2 transition-colors ${tab === t ? 'border-[#8ab4f8] text-[#8ab4f8]' : 'border-transparent text-[#9aa0a6] hover:text-[#e8eaed]'}`}
          >
            <div className="flex items-center justify-center gap-1 md:gap-1.5">
              {t === 'chat' && <><MessageSquare className="w-3.5 h-3.5" /><span className="hidden sm:inline">Chat</span></>}
              {t === 'people' && <><Users className="w-3.5 h-3.5" /><span className="hidden sm:inline">People</span></>}
              {t === 'captions' && <><Captions className="w-3.5 h-3.5" /><span className="hidden sm:inline">Live Captions</span></>}
            </div>
          </button>
        ))}
      </div>

      {tab === 'chat' && (
        <div className="flex-1 flex flex-col min-h-0">
          <div className="flex-1 overflow-y-auto p-3 space-y-3 scrollbar-hide">
            {chatMessages.length === 0 && <p className="text-[11px] text-[#5f6368] text-center mt-10">No messages yet. Say hello!</p>}
            {chatMessages.map((msg) => (
              <div key={msg.id} className={`flex flex-col gap-0.5 ${msg.isSelf ? 'items-end' : 'items-start'}`}>
                <span className="text-[9px] text-[#5f6368]">{msg.fromName} · {msg.time}</span>
                <div className={`px-3 py-2 rounded-2xl text-xs max-w-[90%] leading-relaxed shadow-sm ${msg.isSelf ? 'bg-[#8ab4f8] text-[#202124] rounded-br-sm' : 'bg-[#3c4043] text-[#e8eaed] rounded-bl-sm'}`}>
                  {msg.text}
                </div>
              </div>
            ))}
            <div ref={chatEndRef} />
          </div>
          <div className="p-2 border-t border-[#3c4043] bg-[#202124] shrink-0">
            <div className="flex items-center gap-2 bg-[#3c4043] rounded-full px-3 py-1.5 border border-[#5f6368]/30">
              <input
                value={input} onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
                placeholder="Message…"
                className="flex-1 bg-transparent text-xs text-[#e8eaed] placeholder-[#9aa0a6] outline-none min-w-0"
              />
              <button onClick={send} disabled={!input.trim()} className="text-[#8ab4f8] hover:text-[#aecbfa] disabled:opacity-30 cursor-pointer shrink-0">
                <Send className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </div>
      )}

      {tab === 'people' && (
        <div className="flex-1 overflow-y-auto p-3 space-y-1.5 scrollbar-hide min-h-0">
          <div className="flex items-center gap-3 p-2 md:p-2.5 rounded-xl hover:bg-[#3c4043] transition-colors">
            <div className="w-8 h-8 md:w-9 md:h-9 rounded-full bg-[#8ab4f8]/20 flex items-center justify-center shrink-0 border border-[#8ab4f8]/30">
              <span className="text-xs md:text-sm font-bold text-[#8ab4f8]">{userName.charAt(0).toUpperCase()}</span>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[11px] md:text-xs font-semibold text-[#e8eaed] truncate">{userName} <span className="text-[9px] text-[#8ab4f8]">(you)</span></p>
            </div>
            {isHandRaised && <Hand className="w-3 h-3 text-[#fdd663] shrink-0" aria-label="Your hand is raised" />}
            {isMuted && <MicOff className="w-3 h-3 text-[#f28b82] shrink-0" />}
          </div>
          {peers.map((peer) => {
            const link = links.get(peer.id);
            return (
            <div key={peer.id} className="flex items-center gap-3 p-2 md:p-2.5 rounded-xl hover:bg-[#3c4043] transition-colors">
              <div className="w-8 h-8 md:w-9 md:h-9 rounded-full bg-[#81c995]/10 flex items-center justify-center shrink-0 border border-[#81c995]/20">
                <span className="text-xs md:text-sm font-bold text-[#81c995]">{peer.name.charAt(0).toUpperCase()}</span>
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-[11px] md:text-xs font-semibold text-[#e8eaed] truncate">{peer.name}</p>
                {/* The roster is where a connection problem should be diagnosable, so
                    unlike the tile badge this spells out the path rather than only
                    grading it — "relayed" is the answer to "why is this call bad on
                    the college wifi but fine at home". */}
                <p className="text-[9px] text-[#81c995]">
                  {peer.stream ? 'Connected' : 'Connecting…'}
                  {link?.stats?.rttMs !== undefined && <span className="text-[#9aa0a6]"> · {link.stats.rttMs} ms</span>}
                  {link?.stats?.relayed && <span className="text-[#9aa0a6]"> · relayed</span>}
                </p>
              </div>
              {raisedHands.has(peer.id) && <Hand className="w-3 h-3 text-[#fdd663] shrink-0" aria-label={`${peer.name} has their hand raised`} />}
              {link && <QualityBadge quality={link.quality} relayed={!!link.stats?.relayed} />}
            </div>
            );
          })}
        </div>
      )}

      {captionsSupported && tab === 'captions' && (
        <div className="flex-1 flex flex-col overflow-hidden min-h-0 bg-[#202124]">
          {/* Settings: on/off, language, size — everything captions-related lives
              here now, next to Chat/People, instead of scattered across a
              separate always-open desktop sidebar and a floating picker on the
              on-screen caption bar itself. */}
          <div className="p-3 border-b border-[#3c4043] flex flex-col gap-2.5 shrink-0">
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-[#9aa0a6] font-bold uppercase tracking-wider">Live Captions</span>
              <button
                onClick={() => (transcribing ? onStopCaptions() : onStartCaptions())}
                className={`px-2.5 py-1 rounded-full text-[9px] font-bold cursor-pointer transition-colors ${
                  transcribing ? 'bg-[#8ab4f8]/20 text-[#8ab4f8]' : 'bg-[#3c4043] text-[#9aa0a6] hover:text-[#e8eaed]'
                }`}
              >
                {transcribing ? 'On' : 'Off'}
              </button>
            </div>

            <div className="flex flex-col gap-1.5">
              {/* Speech recognition itself is English-only now (the GPU VM
                  only runs nemotron — see gpu/ASR_CONTRACT.md's 2026-09
                  update), so this is deliberately a plain ON/OFF toggle for
                  translating that English into one other language, not a
                  "pick your caption language from many" picker the way it
                  used to be — captions are always English unless this is on. */}
              <label className="flex items-center justify-between cursor-pointer select-none">
                <span className="text-[9px] text-[#9aa0a6] font-semibold">Translate from English</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={myCaptionLang !== null}
                  aria-label="Translate captions from English"
                  onClick={() => onCaptionLangChange(myCaptionLang !== null ? null : (CAPTION_TARGET_LANGUAGES[0]?.code ?? null))}
                  className={`relative shrink-0 w-8 h-[18px] rounded-full transition-colors ${myCaptionLang !== null ? 'bg-[#8ab4f8]' : 'bg-[#3c4043]'}`}
                >
                  <span className={`absolute top-0.5 w-[14px] h-[14px] rounded-full bg-white transition-transform ${myCaptionLang !== null ? 'translate-x-[17px]' : 'translate-x-0.5'}`} />
                </button>
              </label>
              {myCaptionLang !== null && (
                <select
                  value={myCaptionLang} onChange={(e) => onCaptionLangChange(e.target.value)}
                  className="bg-[#3c4043] text-[#e8eaed] text-[10px] rounded-lg px-2 py-1.5 border border-[#5f6368]/30 cursor-pointer"
                  title="Translate captions into"
                >
                  {CAPTION_TARGET_LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
                </select>
              )}
            </div>

            <div className="flex flex-col gap-1">
              <span className="text-[9px] text-[#9aa0a6] font-semibold">Caption size</span>
              <div className="flex gap-1 bg-[#3c4043] rounded-lg p-0.5">
                {CAPTION_SIZES.map((s) => (
                  <button
                    key={s.value}
                    onClick={() => onCaptionSizeChange(s.value)}
                    className={`flex-1 py-1 rounded-md text-[9px] font-bold cursor-pointer transition-colors ${
                      captionSize === s.value ? 'bg-[#8ab4f8] text-[#202124]' : 'text-[#9aa0a6] hover:text-[#e8eaed]'
                    }`}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {captionsUnavailable && (
            <p className="text-[10px] text-[#f28b82] px-3 pt-2 shrink-0">
              {captionsUnavailable === 'not_configured' ? "Captions aren't set up yet."
                : captionsUnavailable === 'loading' ? 'Captions are starting up — try again shortly.'
                : 'Captions are temporarily unavailable.'}
            </p>
          )}

          {/* The server saves every final caption line as it's spoken,
              independent of this panel even being open — these two actions
              pull that durable record, not this client's own local log. */}
          <div className="px-3 pt-3 shrink-0 flex flex-col gap-2.5">
            <div className="flex gap-2">
              <button
                onClick={handleDownloadTranscript}
                disabled={!roomId || isDownloading}
                className="flex-1 flex items-center justify-center gap-1.5 border border-white/[0.08] bg-white/[0.045] hover:bg-white/[0.08] disabled:opacity-40 text-[#d9dce2] text-[10px] font-semibold py-2 rounded-xl transition-all cursor-pointer"
              >
                {isDownloading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />}
                Transcript
              </button>
              <button
                onClick={handleGenerateSummary}
                disabled={!roomId || isSummarizing}
                className="group flex-1 flex items-center justify-center gap-1.5 border border-[#8ab4f8]/25 bg-[#8ab4f8]/10 hover:border-[#8ab4f8]/45 hover:bg-[#8ab4f8]/15 disabled:opacity-40 text-[#aecbfa] text-[10px] font-semibold py-2 rounded-xl transition-all cursor-pointer"
              >
                {isSummarizing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3 transition-transform group-hover:rotate-12" />}
                {isSummarizing ? 'Creating…' : summary ? 'Regenerate' : 'AI summary'}
              </button>
            </div>
            {transcriptError && (
              <div className="flex items-start gap-2 rounded-xl border border-[#f28b82]/20 bg-[#f28b82]/[0.07] px-3 py-2.5">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#f28b82]" />
                <p className="min-w-0 flex-1 text-[10px] leading-4 text-[#f6bbb5]">{transcriptError}</p>
                <button onClick={handleGenerateSummary} disabled={isSummarizing} className="shrink-0 text-[#f6bbb5] hover:text-white" title="Try summary again"><RotateCcw className="h-3.5 w-3.5" /></button>
              </div>
            )}
            {isSummarizing && (
              <div className="overflow-hidden rounded-xl border border-[#8ab4f8]/15 bg-[#8ab4f8]/[0.055] px-3 py-2.5">
                <div className="flex items-center gap-2"><span className="relative flex h-2 w-2"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#8ab4f8] opacity-60" /><span className="relative inline-flex h-2 w-2 rounded-full bg-[#8ab4f8]" /></span><p className="text-[10px] font-semibold text-[#c6dafc]">AIPA is reviewing the transcript</p></div>
                <p className="mt-1 pl-4 text-[9px] leading-4 text-[#8e98a8]">Extracting topics, decisions, and follow-ups. You can keep using the meeting while this runs.</p>
              </div>
            )}
          </div>

          {summary && (
            <div className="mx-3 mb-1 mt-3 max-h-[22rem] shrink-0 overflow-y-auto rounded-2xl border border-[#8ab4f8]/20 bg-gradient-to-b from-[#252b38] to-[#1b1f27] shadow-[0_12px_36px_rgba(0,0,0,.22)] scrollbar-hide">
              <div className="sticky top-0 z-10 flex items-center justify-between border-b border-white/[0.07] bg-[#222833]/95 px-3 py-2.5 backdrop-blur-md">
                <div className="flex items-center gap-2">
                  <span className="grid h-7 w-7 place-items-center rounded-lg bg-[#8ab4f8]/15 text-[#aecbfa]"><FileText className="h-3.5 w-3.5" /></span>
                  <div><p className="text-[10px] font-bold text-[#eef2f8]">Meeting intelligence</p><p className="text-[8px] text-[#8893a5]">Generated from the saved transcript</p></div>
                </div>
                <div className="flex items-center gap-1">
                  <button onClick={handleCopySummary} className="grid h-7 w-7 place-items-center rounded-lg text-[#9aa4b4] transition hover:bg-white/[0.07] hover:text-white" title="Copy summary">{summaryCopied ? <Check className="h-3.5 w-3.5 text-[#81c995]" /> : <Copy className="h-3.5 w-3.5" />}</button>
                  <button onClick={() => setSummary(null)} className="grid h-7 w-7 place-items-center rounded-lg text-[#9aa4b4] transition hover:bg-white/[0.07] hover:text-white" title="Close summary"><X className="h-3.5 w-3.5" /></button>
                </div>
              </div>
              <div className="flex flex-col gap-3 p-3">
                <p className="text-[11px] leading-[1.65] text-[#e3e7ed]">{summary.summary}</p>
                {summary.attendees.length > 0 && <div className="flex flex-wrap gap-1.5">{summary.attendees.map(name => <span key={name} className="rounded-full border border-white/[0.07] bg-white/[0.045] px-2 py-1 text-[9px] text-[#b8c0cd]">{name}</span>)}</div>}
                {summary.keyPoints.length > 0 && <SummarySection icon={Lightbulb} title="Key points" tone="text-[#fdd663]" items={summary.keyPoints} />}
                {summary.decisions.length > 0 && <SummarySection icon={CheckCircle2} title="Decisions" tone="text-[#81c995]" items={summary.decisions} />}
                {summary.actionItems.length > 0 && (
                  <div className="rounded-xl border border-white/[0.06] bg-black/10 p-2.5">
                    <p className="mb-2 flex items-center gap-1.5 text-[9px] font-bold uppercase tracking-[.12em] text-[#aecbfa]"><ListChecks className="h-3 w-3" /> Action items</p>
                    <div className="space-y-2">{summary.actionItems.map((item, index) => <div key={index} className="flex gap-2 text-[10px] leading-4 text-[#dce1e8]"><span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-[#8ab4f8]" /><span>{item.description}{item.owner && item.owner.toLowerCase() !== 'unclear' && <span className="ml-1 text-[#8f99aa]">— {item.owner}</span>}</span></div>)}</div>
                  </div>
                )}
                <p className="border-t border-white/[0.06] pt-2 text-[8px] leading-3 text-[#737e90]">AI-generated notes can miss context. Review important decisions and assignments before sharing.</p>
              </div>
            </div>
          )}

          {keyPoints.length > 0 && (
            <div className="border-b border-[#3c4043] p-3 shrink-0">
              <p className="text-[9px] font-bold uppercase tracking-wider text-[#9aa0a6] mb-2 flex items-center gap-1">
                <Lightbulb className="w-3 h-3 text-[#fdd663]" />Key Points
              </p>
              <div className="space-y-1.5 max-h-32 overflow-y-auto scrollbar-hide">
                {keyPoints.slice(-8).map((kp) => {
                  const Icon = KP_ICONS[kp.type] ?? Tag;
                  const cc = KP_COLORS[kp.type] ?? '';
                  return (
                    <div key={kp.id} className={`flex items-start gap-1.5 px-2 py-1.5 rounded-lg border text-[10px] ${cc}`}>
                      <Icon className="w-3 h-3 mt-0.5 shrink-0" />
                      <span className="leading-relaxed font-medium">{kp.text}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div className="flex-1 overflow-y-auto p-3 space-y-2 scrollbar-hide">
            {!transcribing && transcriptLines.length === 0 && <p className="text-[10px] text-[#9aa0a6]">Turn on captions above to start.</p>}
            {transcribing && transcriptLines.length === 0 && <p className="text-[10px] text-[#9aa0a6] animate-pulse">Listening for speech…</p>}
            {transcriptLines.map((line) => (
              <div key={line.id} className="flex flex-col gap-0.5">
                <div className="flex items-center gap-1.5">
                  <span className="text-[9px] font-bold text-[#8ab4f8]">{line.speaker}</span>
                  <span className="text-[9px] text-[#5f6368]">{line.timestamp}</span>
                </div>
                <p className="text-[11px] text-[#e8eaed] leading-relaxed bg-[#3c4043]/40 rounded-lg px-2 py-1.5 border border-[#5f6368]/20">
                  {resolveCaptionText(line, myCaptionLang)}
                </p>
              </div>
            ))}
            <div ref={transcriptEndRef} />
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main ────────────────────────────────────────────────────────────────────

const KP_ICONS: Record<string, React.FC<{ className?: string }>> = { action: Zap, decision: Check, question: HelpCircle, number: Hash, name: Tag };
const KP_COLORS: Record<string, string> = {
  action: 'text-[#8ab4f8] bg-[#8ab4f8]/10 border-[#8ab4f8]/20', decision: 'text-[#81c995] bg-[#81c995]/10 border-[#81c995]/20',
  question: 'text-[#fdd663] bg-[#fdd663]/10 border-[#fdd663]/20', number: 'text-[#c58af9] bg-[#c58af9]/10 border-[#c58af9]/20',
  name: 'text-[#f8a97d] bg-[#f8a97d]/10 border-[#f8a97d]/20',
};

export default function ActiveMeetingView({ onLeaveMeeting, onMinimize }: Props) {
  const { user, roomId, localStream, peers, isMuted, isVideoOff, isScreenSharing, screenStream, screenPeers, toggleMic, setMicMuted, toggleCamera, toggleScreenShare, switchCamera, switchMic, leaveMeeting, chatMessages, sendChatMessage, showInviteDialog, dismissInviteDialog, evictedNotice, dismissEvictedNotice, mediaNotice, dismissMediaNotice, linkQuality, activeSpeakerIds, setVisiblePeerIds, reactions, sendReaction, raisedHands, isHandRaised, toggleHand, liveCaptions, captionLog, captionKeyPoints, myCaptionLang, setCaptionLang } = useMeeting();

  // Per-peer link grades — LiveKit's own SFU-computed participant.connectionQuality,
  // pushed via events (see useWebRTC.ts), not polled here. `links` keeps its
  // original name since every render call site below already expects a
  // ReadonlyMap<string, PeerLink> and doesn't need to know where it came from.
  const links = linkQuality;

  // Only watch for a dead microphone while the user believes it is live — a muted
  // track is legitimately silent and warning about it would be nonsense.
  const silentMic = useSilentMic(localStream, !isMuted);

  // Whether holding space actually opened the mic. Without this, pressing space while
  // *already* unmuted is a no-op on the way down but still mutes on the way up — so
  // the shortcut would silently mute people who were mid-sentence.
  const pttEngagedRef = useRef(false);

  useCallShortcuts({
    toggleMic,
    toggleCamera: () => { void toggleCamera(); },
    toggleHand,
    setPushToTalk: (talking) => {
      if (talking) {
        if (!isMuted) return;
        pttEngagedRef.current = true;
        setMicMuted(false);
      } else {
        if (!pttEngagedRef.current) return;
        pttEngagedRef.current = false;
        setMicMuted(true);
      }
    },
  }, true);
  const { currentUser } = useAuth();
  const displayName = currentUser?.displayName ?? user.name;

  const { isActive: transcribing, unavailableReason: captionsUnavailable, start: startTranscription, stop: stopTranscription } = useLiveCaptions(roomId, user.id, displayName);
  const transcriptLines = captionLog;
  const keyPoints = captionKeyPoints;

  // Personal display preference, not room state — persisted the same way
  // device choices are (captions.ts mirrors devicePrefs.ts's pattern).
  const [captionSize, setCaptionSizeState] = useState<CaptionSize>(loadCaptionSize);
  const setCaptionSize = useCallback((size: CaptionSize) => { setCaptionSizeState(size); saveCaptionSize(size); }, []);

  const [bgMode, setBgMode] = useState<BgMode>('none');
  const [rightTab, setRightTab] = useState<'chat' | 'people' | 'captions'>('people');
  // Meet-style default: the stage starts full-width with no panel open, same as joining
  // a real Meet call — People/Chat/Live Captions are opt-in via the toolbar, not on by default.
  // (Previously defaulted open on any viewport >768px, which stole ~300px+ from the grid
  // on every desktop call and was part of why 2-3 person layouts looked cramped/stacked.)
  const [rightOpen, setRightOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [reactionBarOpen, setReactionBarOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [codeCopied, setCodeCopied] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);

  // Device list used to be fetched once, lazily, only when the settings sheet opened,
  // and nothing listened for `devicechange` — so plugging in a headset mid-call did
  // nothing until you reopened settings, and unplugging one left a dead entry showing
  // as selected. Subscribe for the whole call instead.
  const [devices, setDevices] = useState<DeviceSnapshot>(EMPTY_SNAPSHOT);
  useEffect(() => watchDevices(setDevices), []);

  // Selections start from what this browser used last time rather than from whatever
  // happens to be first in the enumeration order.
  const [savedPrefs] = useState(loadDevicePrefs);
  const [selectedCamera, setSelectedCamera] = useState(savedPrefs.cameraId);
  const [selectedMic, setSelectedMic] = useState(savedPrefs.micId);
  const [selectedSpeaker, setSelectedSpeaker] = useState(savedPrefs.speakerId);

  // A saved id that is no longer present must not be rendered as the current value:
  // the <select> would silently display its first option while the app still believed
  // the saved device was in use, so the label and the actual routing would disagree.
  const shownCamera = resolveSelection(selectedCamera, devices.videoDevices);
  const shownMic = resolveSelection(selectedMic, devices.audioDevices);
  const shownSpeaker = resolveSelection(selectedSpeaker, devices.outputDevices);

  const speakerSelectable = useMemo(isSpeakerSelectionSupported, []);
  const screenShareSupported = useMemo(isScreenShareSupported, []);
  const captionsSupported = useMemo(isLiveCaptionsSupported, []);

  const transcriptEndRef = useRef<HTMLDivElement>(null);

  const handleLeave = useCallback(() => {
    stopTranscription(); leaveMeeting();
    onLeaveMeeting();
  }, [stopTranscription, leaveMeeting, onLeaveMeeting]);

  // No dedicated participant-invite picker exists in the app yet — the closest
  // real equivalent is surfacing the People panel (roster + this same share link).
  const handleAddPeople = useCallback(() => {
    dismissInviteDialog();
    setRightTab('people');
    setRightOpen(true);
  }, [dismissInviteDialog]);

  // ── Control bar composition ────────────────────────────────────────────────
  //
  // Adding raise-hand and reactions pushed the bar past the width of a phone: at
  // 390px the last buttons ended up outside the viewport, scrollable in principle
  // but unreachable in practice. Rather than branch on breakpoints inside one long
  // block of JSX, the secondary actions are declared once as data and rendered two
  // ways — inline on desktop, inside a labelled sheet behind "More" on mobile.
  // This is the split suitenumerique/meet makes with DesktopControlBar and
  // MobileControlBar, and it is why their equivalent file is a third of the size.
  const secondaryActions = useMemo(() => {
    const actions: {
      key: string; label: string; Icon: React.FC<{ className?: string }>;
      onClick: () => void; active?: boolean; badge?: boolean;
    }[] = [
      // Hidden rather than shown-and-broken where getDisplayMedia doesn't exist —
      // mainly iOS Safari, which has never exposed screen capture to web content, and
      // unreliably elsewhere on mobile. See src/lib/screenShare.ts.
      ...(screenShareSupported ? [{
        key: 'screen', label: isScreenSharing ? 'Stop sharing' : 'Share screen',
        Icon: isScreenSharing ? ScreenShareOff : ScreenShare,
        onClick: () => { void toggleScreenShare(); }, active: isScreenSharing,
      }] : []),
      // The toolbar toggle starts/stops streaming this participant's mic to
      // the captions relay — the on-screen bar (CaptionBar) shows itself
      // whenever `transcribing` is true, no separate flag to keep in sync.
      // The Live Captions side panel is a pure view of the resulting log
      // (captionLog, via context) plus its settings, and has no separate
      // start/stop of its own beyond the toggle mirrored there too.
      ...(captionsSupported ? [{
        key: 'captions', label: transcribing ? 'Turn off captions' : 'Turn on captions', Icon: Captions,
        onClick: () => { if (transcribing) stopTranscription(); else void startTranscription(); },
        active: transcribing,
      }] : []),
      {
        key: 'hand', label: isHandRaised ? 'Lower hand' : 'Raise hand', Icon: Hand,
        onClick: toggleHand, active: isHandRaised,
      },
      {
        key: 'reactions', label: 'Send a reaction', Icon: Smile,
        onClick: () => { setReactionBarOpen((v) => !v); setSettingsOpen(false); }, active: reactionBarOpen,
      },
      {
        key: 'chat', label: 'Chat', Icon: MessageSquare,
        onClick: () => { setRightTab('chat'); setRightOpen((v) => !v); },
        active: rightOpen && rightTab === 'chat',
        badge: chatMessages.length > 0 && !(rightOpen && rightTab === 'chat'),
      },
      {
        key: 'people', label: 'People', Icon: Users,
        onClick: () => { setRightTab('people'); setRightOpen((v) => !v); },
        active: rightOpen && rightTab === 'people',
      },
    ];
    if (captionsSupported) {
      actions.push({
        key: 'captions-panel', label: 'Live Captions', Icon: Activity,
        onClick: () => { setRightTab('captions'); setRightOpen((v) => !v); },
        active: rightOpen && rightTab === 'captions',
      });
    }
    if (onMinimize) {
      actions.push({ key: 'minimise', label: 'Minimise call', Icon: Minimize2, onClick: onMinimize });
    }
    actions.push({
      key: 'settings', label: 'Settings', Icon: MoreVertical,
      onClick: () => { setSettingsOpen((v) => !v); setReactionBarOpen(false); }, active: settingsOpen,
    });
    return actions;
  }, [screenShareSupported, isScreenSharing, toggleScreenShare, captionsSupported, transcribing,
      startTranscription, stopTranscription, isHandRaised, toggleHand, reactionBarOpen,
      rightOpen, rightTab, chatMessages.length, onMinimize, settingsOpen]);

  const copyCode = useCallback(() => {
    if (!roomId) return;
    navigator.clipboard.writeText(roomId).then(() => {
      setCodeCopied(true); setTimeout(() => setCodeCopied(false), 2000);
    });
  }, [roomId]);

  const copyLink = useCallback(() => {
    if (!roomId) return;
    navigator.clipboard.writeText(`${window.location.origin}/${roomId}`).then(() => {
      setLinkCopied(true); setTimeout(() => setLinkCopied(false), 2500);
    });
  }, [roomId]);

  // Memoised: `useTileOrder` keys off this array, so a fresh identity every render
  // would recompute the ordering constantly and defeat its own stability pass.
  const tiles = useMemo<MeetingTile[]>(
    () => [...peers, { id: user.id, name: displayName, isLocal: true as const }],
    [peers, user.id, displayName],
  );

  // Screen shares render in a dedicated spotlight area (object-contain, never cropped)
  // instead of replacing anyone's camera tile — camera keeps streaming the whole time.
  const activeScreens: { id: string; name: string; stream: MediaStream | null }[] = [
    ...(isScreenSharing ? [{ id: 'local-screen', name: 'You', stream: screenStream }] : []),
    ...screenPeers.map((p) => ({ id: p.id, name: p.name, stream: p.stream })),
  ];
  const sharingPeerIds = new Set(screenPeers.map((p) => p.id));

  // Active-speaker detection is server-computed by the SFU (RoomEvent.ActiveSpeakersChanged,
  // see useWebRTC.ts) — replaces the old client-side Web Audio AnalyserNode polling loop.
  // Feeds the highlight ring AND the tile ordering below; it covers every peer, not only
  // the rendered ones (LiveKit pushes it regardless of subscription state), which is what
  // makes ranking off-page speakers possible.
  const speakingIds = activeSpeakerIds;

  // Container-size + orientation aware grid (see src/lib/gridLayout.ts), replacing the old
  // tile-count-only breakpoint table — a wide desktop window and a narrow phone no longer
  // get forced into the same rows/cols just because they both have e.g. 4 tiles.
  const { ref: gridRef, layout: gridLayout, size: gridSize } = useGridLayout(tiles.length);
  const gridGap = gridSize.width >= 768 ? 12 : 8;
  const tileSize = computeTileSize(gridSize, gridLayout, gridGap);

  // ── Who gets a visible slot ────────────────────────────────────────────────
  //
  // Tile order used to be `[...peers, local]` — signalling arrival order — so in any
  // call big enough to paginate, whether you could see someone came down to when they
  // joined, and a person speaking on page 2 was invisible. `useTileOrder` ranks by
  // presenting / speaking / recently spoke and swaps hidden speakers into the page you
  // are looking at, keeping every already-visible tile where it is. See src/lib/tileOrder.ts
  // for why the naive "just sort by who is talking" is worse than doing nothing.
  //
  // The page number is read from a ref rather than straight from `gridPagination`,
  // because pagination consumes the ordered list and would otherwise be a cycle. One
  // render of lag after a manual page change is invisible: paging is a user action and
  // the order settles on the very next render.
  const pageRef = useRef(0);
  const orderable = useMemo(
    () => tiles.map((t) => ({
      id: t.id,
      isLocal: 'isLocal' in t,
      isPresenting: 'isLocal' in t ? isScreenSharing : sharingPeerIds.has(t.id),
      hasVideo: 'isLocal' in t ? !isVideoOff : !!(t as PeerInfo).stream?.getVideoTracks().length,
    })),
    [tiles, isScreenSharing, sharingPeerIds, isVideoOff],
  );
  const orderedIds = useTileOrder(orderable, speakingIds, gridLayout.maxTiles, pageRef.current);
  const orderedTiles = useMemo<MeetingTile[]>(() => {
    // Explicit generic: with a union element type TS will not infer the [K, V] tuple
    // from `.map`, and the Map silently degrades to Map<unknown, unknown> — which then
    // makes every tile downstream `unknown`.
    const byId = new Map<string, MeetingTile>(tiles.map((t) => [t.id, t]));
    // Anything the ordering did not place (it cannot happen, but a dropped tile would
    // be an invisible participant) is appended rather than lost.
    const placed: MeetingTile[] = [];
    for (const id of orderedIds) {
      const t = byId.get(id);
      if (t) placed.push(t);
    }
    const seen = new Set(placed.map((t) => t.id));
    return [...placed, ...tiles.filter((t) => !seen.has(t.id))];
  }, [orderedIds, tiles]);

  // A layout picked for a small/cramped container can have maxTiles < tiles.length (e.g. a
  // narrow phone stepping down to a 2-tile layout for a 4-person call) — paginate instead of
  // silently dropping tiles that have nowhere to render. Same fix Meet's own <GridLayout>
  // applies on top of `selectGridLayout` (see src/hooks/usePagination.ts).
  const gridPagination: Pagination<MeetingTile> = usePagination(gridLayout.maxTiles, orderedTiles);
  useEffect(() => { pageRef.current = gridPagination.currentPage; }, [gridPagination.currentPage]);

  // ── Focus (spotlight) state ────────────────────────────────────────────────
  // Mirrors LiveKit Meet's FocusLayout: at most one thing occupies the main stage
  // and everyone else drops into a carousel beside it. A screen share claims focus
  // automatically, but an explicit pin always wins so you can keep watching a
  // person while someone else presents.
  const [pinned, setPinned] = useState<{ kind: 'screen' | 'participant'; id: string } | null>(null);

  const focus = useMemo(() => {
    if (pinned) {
      const stillThere = pinned.kind === 'screen'
        ? activeScreens.some((s) => s.id === pinned.id)
        : tiles.some((t) => t.id === pinned.id);
      if (stillThere) return pinned;
    }
    // Somebody else's share outranks your own — you already know what is on
    // your screen. Your own share can still take the stage when it is the only
    // one, which is what tells you you are presenting. Neither case renders a
    // video of your own display: 'local-screen' draws a PresentingCard in every
    // position, so there is no mirror tunnel to guard against here.
    const remoteScreen = activeScreens.find((sc) => sc.id !== 'local-screen');
    if (remoteScreen) return { kind: 'screen' as const, id: remoteScreen.id };
    const own = activeScreens.find((sc) => sc.id === 'local-screen');
    if (own) return { kind: 'screen' as const, id: own.id };
    return null;
  }, [pinned, activeScreens, tiles]);

  // A pin pointing at someone who has since left would otherwise wedge the stage
  // on a dead id and silently suppress an incoming screen share.
  useEffect(() => {
    if (!pinned) return;
    const stillThere = pinned.kind === 'screen'
      ? activeScreens.some((s) => s.id === pinned.id)
      : tiles.some((t) => t.id === pinned.id);
    if (!stillThere) setPinned(null);
  }, [pinned, activeScreens, tiles]);

  const toggleFocus = useCallback((kind: 'screen' | 'participant', id: string) => {
    setPinned((prev) => (prev && prev.kind === kind && prev.id === id ? null : { kind, id }));
  }, []);

  const focusedScreen = focus?.kind === 'screen' ? activeScreens.find((s) => s.id === focus.id) : undefined;
  const focusedTile = focus?.kind === 'participant' ? tiles.find((t) => t.id === focus.id) : undefined;

  // Everything not on the main stage. Other people's screen shares stay visible in
  // the carousel rather than disappearing when a second person starts presenting.
  const carouselScreens = activeScreens.filter((s) => s.id !== focusedScreen?.id);
  const carouselTiles = orderedTiles.filter((t) => t.id !== focusedTile?.id);

  // Which remote peers currently have a mounted tile — in focus mode that's the
  // focused participant plus everyone in the carousel (nobody is paginated away
  // there), in grid mode it's exactly the current page. Tells useWebRTC which
  // peers' camera video to keep subscribed (see setVisiblePeerIds's own comment
  // in MeetingContext/useWebRTC) — audio is unaffected, PeerAudio below stays
  // mounted for every peer regardless of this set.
  const visiblePeerIds = useMemo(() => {
    if (focus) {
      const ids = new Set<string>();
      if (focusedTile) ids.add(focusedTile.id);
      carouselTiles.forEach((t) => ids.add(t.id));
      return ids;
    }
    return new Set(gridPagination.tiles.map((t) => t.id));
  }, [focus, focusedTile, carouselTiles, gridPagination.tiles]);
  // The stage tile keeps its full-resolution layer; grid tiles are capped to
  // 640x360 (see GRID_MAX_DIMS in useWebRTC).
  const stagePeerId = focusedTile && !('isLocal' in focusedTile) ? focusedTile.id : null;

  // ── Subscription tiers (see TIER_THRESHOLD above) ─────────────────────────
  //
  // orderedIds is every participant ranked by useTileOrder: presenting first,
  // then currently speaking, then most recently spoken, then has-video, then
  // join order. That ranking already exists and already covers EVERYONE, not
  // just the current page — which is what makes both caps cheap to build and
  // is why an off-page speaker is promoted onto page 1 today.
  const rankOf = useMemo(() => new Map(orderedIds.map((id, i) => [id, i])), [orderedIds]);

  // Video: of the tiles actually mounted, subscribe only the top VIDEO_TIER_CAP.
  // The rest still render — as avatars, via videoWithheld — so the layout and
  // the pager are untouched. The local tile is always kept: it is your own
  // camera and costs no bandwidth.
  const videoPeerIds = useMemo(() => {
    if (tiles.length <= VIDEO_TIER_THRESHOLD) return visiblePeerIds;
    const mounted = [...visiblePeerIds];
    const ranked = mounted
      .filter((id) => id !== user.id)
      .sort((a, b) => (rankOf.get(a) ?? Number.MAX_SAFE_INTEGER) - (rankOf.get(b) ?? Number.MAX_SAFE_INTEGER))
      .slice(0, VIDEO_TIER_CAP);
    return new Set([...ranked, ...(visiblePeerIds.has(user.id) ? [user.id] : [])]);
  }, [tiles.length, visiblePeerIds, rankOf, user.id]);

  // Audio: independent of tiles entirely — you hear people you cannot see, and
  // that stays true. undefined means "no cap", which is what small calls get.
  const audioPeerIds = useMemo(() => {
    if (tiles.length <= AUDIO_TIER_THRESHOLD) return undefined;
    return orderedIds.filter((id) => id !== user.id).slice(0, AUDIO_TIER_CAP);
  }, [tiles.length, orderedIds, user.id]);

  useEffect(() => {
    setVisiblePeerIds(videoPeerIds, stagePeerId, audioPeerIds);
  }, [videoPeerIds, stagePeerId, audioPeerIds, setVisiblePeerIds]);

  const meetingContent = (
    <div className="fixed inset-0 z-[9999] flex flex-col lg:flex-row bg-[#111] overflow-hidden select-none text-[#e8eaed]">

      {/* Remote audio for EVERY peer, independent of what the stage is showing.
          Must stay outside the focus/grid ternary below — that ternary swaps two
          separate subtrees, so anything inside it is unmounted and remounted
          whenever somebody starts or stops a screen share. */}
      {peers.map((p) => (
        <div key={`audio-${p.id}`}>{p.stream ? <PeerAudio peer={p} /> : null}</div>
      ))}

      {/* This tab lost its seat to the same account connecting elsewhere (see
          EVICTED_CODE in signalingSocket.ts) — the socket has deliberately stopped
          reconnecting, so nothing on this screen will update again. Above mediaNotice
          (a worse, whole-connection-dead state deserves priority) and the only way to
          clear it is to actually leave — dismissing without leaving would just hide the
          message while this tab sits there uselessly with the camera/mic still live. */}
      {evictedNotice && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-[10002] max-w-[92vw] sm:max-w-md flex items-start gap-3 bg-[#3c2b28] border border-[#f28b82]/50 text-[#f6d5d2] rounded-xl px-4 py-3 shadow-2xl">
          <AlertTriangle className="w-4 h-4 text-[#f28b82] shrink-0 mt-0.5" />
          <p className="text-xs leading-relaxed flex-1">{evictedNotice}</p>
          <button
            onClick={() => { dismissEvictedNotice(); leaveMeeting(); }}
            className="shrink-0 text-xs font-semibold px-2.5 py-1 -mt-0.5 -mr-1 rounded-lg bg-white/10 hover:bg-white/20 transition-colors cursor-pointer"
          >
            Leave
          </button>
        </div>
      )}

      {/* Non-fatal media problems. Without this a failed camera re-acquire (permission
          revoked mid-call, or another app grabbed the device) left the button looking
          simply dead, with the reason only in the console. */}
      {mediaNotice && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-[10001] max-w-[92vw] sm:max-w-md flex items-start gap-3 bg-[#3c2b28] border border-[#f28b82]/50 text-[#f6d5d2] rounded-xl px-4 py-3 shadow-2xl">
          <AlertTriangle className="w-4 h-4 text-[#f28b82] shrink-0 mt-0.5" />
          <p className="text-xs leading-relaxed flex-1">{mediaNotice}</p>
          <button
            onClick={dismissMediaNotice}
            aria-label="Dismiss"
            className="shrink-0 w-7 h-7 -mt-0.5 -mr-1 rounded-lg flex items-center justify-center text-[#f6d5d2]/70 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Silent microphone.
          Sits below mediaNotice rather than replacing it: a media *error* and a mic
          that opened but produces nothing are different problems with different fixes,
          and it is entirely possible to have both. This one is deliberately not
          styled as an error — nothing has failed as far as the browser is concerned,
          which is exactly why the user needs telling. */}
      {silentMic.status === 'silent' && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-[10000] max-w-[92vw] sm:max-w-md flex items-start gap-3 bg-[#3d3323] border border-[#fdd663]/50 text-[#f8e7bd] rounded-xl px-4 py-3 shadow-2xl" style={{ top: mediaNotice ? '5.25rem' : '0.75rem' }}>
          <MicOff className="w-4 h-4 text-[#fdd663] shrink-0 mt-0.5" />
          <p className="text-xs leading-relaxed flex-1">
            Your microphone isn't picking up any sound. Check that it isn't muted in your
            system settings or by a switch on your headset, then try selecting a different
            microphone in Settings.
          </p>
          <button
            onClick={silentMic.dismiss}
            aria-label="Dismiss microphone warning"
            className="shrink-0 w-7 h-7 -mt-0.5 -mr-1 rounded-lg flex items-center justify-center text-[#f8e7bd]/70 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Knock-to-join requests render globally in App.tsx (JoinRequestBanner),
          not here — this call screen can be minimized to a floating window
          while browsing the rest of the app, and a knock still needs to be
          answerable during that time, not only while ActiveMeetingView is
          actually mounted full-screen. */}

      {showInviteDialog && (
        <MeetingInviteDialog onClose={dismissInviteDialog} onAddPeople={handleAddPeople} />
      )}

      {/* Live Captions used to have its own always-open desktop-only left
           sidebar here (gated on the same captionsSupported feature check,
           duplicating the room-code widget and a second copy of this exact
           settings+log UI). It's been folded into the Live Captions tab in
           the right panel instead, next to Chat/People, so captions settings
           live in exactly one place regardless of viewport width — see
           RightPanel below. Room code / copy-link controls live solely in
           the floating badge over the stage now. */}

      {/* ── Center/Right Wrapper ──────────────────────────────────────────────── */}
      <section className="flex-1 flex flex-col md:flex-row min-w-0 min-h-0 relative h-full">

        {/* VIDEO GRID & CONTROLS */}
        <div className="flex-1 flex flex-col relative min-w-0 min-h-0 bg-[#111]">

          <div className="absolute top-2 left-2 z-10 flex items-center gap-2 max-w-[92%]">
          {/* The toolbar's minimise glyph is one unlabelled circle among seven — nobody
              found it. This is the discoverable way back: a real labelled back button,
              top-left, where a back control is actually looked for. Both do the same thing. */}
          {onMinimize && (
            <button
              onClick={onMinimize}
              title="Back to IB Connect" aria-label="Back to IB Connect"
              className="flex items-center gap-1.5 shrink-0 bg-[#202124]/85 backdrop-blur-md border border-[#3c4043] hover:bg-[#3c4043] active:scale-95 text-[#e8eaed] rounded-lg px-2.5 py-1.5 text-[10px] md:text-xs font-semibold shadow-sm transition-all cursor-pointer"
            >
              <ArrowLeft className="w-3.5 h-3.5 shrink-0" />
              <span className="whitespace-nowrap">IB Connect</span>
            </button>
          )}
          <div className="bg-[#202124]/80 backdrop-blur-md px-3 py-1.5 rounded-lg border border-[#3c4043] flex items-center gap-2 shadow-sm min-w-0">
            <span className="text-[9px] md:text-[10px] text-[#9aa0a6] font-semibold truncate">Code: <span className="text-[#8ab4f8] font-mono ml-1">{roomId}</span></span>
            <button
              onClick={copyCode} title="Copy room code" aria-label="Copy room code"
              className="w-7 h-7 shrink-0 flex items-center justify-center rounded-md bg-[#3c4043] text-[#e8eaed] hover:bg-[#4a4d51] active:scale-90 cursor-pointer transition-all"
            >
              {codeCopied ? <Check className="w-3.5 h-3.5 text-[#81c995]" /> : <Copy className="w-3.5 h-3.5" />}
            </button>
            <button
              onClick={copyLink} title="Copy join link" aria-label="Copy join link"
              className="w-7 h-7 shrink-0 flex items-center justify-center rounded-md bg-[#3c4043] text-[#e8eaed] hover:bg-[#4a4d51] active:scale-90 cursor-pointer transition-all"
            >
              {linkCopied ? <Check className="w-3.5 h-3.5 text-[#81c995]" /> : <Link className="w-3.5 h-3.5" />}
            </button>
          </div>
          </div>

          {focus ? (
            /* ── Focus layout: one big stage + a carousel of everyone else ──────
               Carousel sits to the right on wide screens and below on narrow /
               portrait ones, so the stage always keeps the larger dimension. */
            <div className="flex-1 min-h-0 p-2 md:p-4 pb-20 md:pb-24 flex flex-col xl:flex-row gap-2 md:gap-3">
              <div className="flex-1 min-w-0 min-h-0">
                {focusedScreen ? (
                  focusedScreen.id === 'local-screen' ? (
                    <PresentingCard
                      onStop={() => { void toggleScreenShare(); }}
                      onToggleFocus={() => toggleFocus('screen', focusedScreen.id)}
                    />
                  ) : (
                    <ScreenTile
                      stream={focusedScreen.stream}
                      label={`${focusedScreen.name}'s screen`}
                      isPinned={pinned?.kind === 'screen' && pinned.id === focusedScreen.id}
                      onToggleFocus={() => toggleFocus('screen', focusedScreen.id)}
                    />
                  )
                ) : focusedTile ? (
                  <ParticipantTile
                    id={focusedTile.id}
                    name={focusedTile.name}
                    isLocal={'isLocal' in focusedTile}
                    peer={focusedTile as PeerInfo}
                    localStream={localStream}
                    isVideoOff={isVideoOff}
                    isMuted={isMuted}
                    bgMode={bgMode}
                    isSpeaking={speakingIds.has(focusedTile.id)}
                    isPresenting={'isLocal' in focusedTile ? isScreenSharing : sharingPeerIds.has(focusedTile.id)}
                    videoWithheld={!videoPeerIds.has(focusedTile.id)}
                    isFocused
                    onToggleFocus={() => toggleFocus('participant', focusedTile.id)}
                    quality={links.get(focusedTile.id)?.quality}
                    relayed={links.get(focusedTile.id)?.stats?.relayed}
                    handRaised={raisedHands.has(focusedTile.id)}
                  />
                ) : null}
              </div>

              {(carouselTiles.length > 0 || carouselScreens.length > 0) && (
                <div className="shrink-0 flex xl:flex-col gap-2 md:gap-3 overflow-x-auto xl:overflow-x-hidden xl:overflow-y-auto scrollbar-hide h-24 md:h-32 xl:h-auto xl:w-52 2xl:w-64">
                  {carouselScreens.map((s) => (
                    <div key={s.id} className="aspect-video h-full xl:h-auto xl:w-full shrink-0">
                      {s.id === 'local-screen' ? (
                        <PresentingCard compact onToggleFocus={() => toggleFocus('screen', s.id)} />
                      ) : (
                        <ScreenTile
                          stream={s.stream}
                          label={`${s.name}'s screen`}
                          compact
                          isPinned={false}
                          onToggleFocus={() => toggleFocus('screen', s.id)}
                        />
                      )}
                    </div>
                  ))}
                  {carouselTiles.map((tile) => {
                    const isLocal = 'isLocal' in tile;
                    return (
                      <div key={tile.id} className="aspect-video h-full xl:h-auto xl:w-full shrink-0">
                        <ParticipantTile
                          id={tile.id}
                          name={tile.name}
                          isLocal={isLocal}
                          peer={tile as PeerInfo}
                          localStream={localStream}
                          isVideoOff={isVideoOff}
                          isMuted={isMuted}
                          bgMode={bgMode}
                          isSpeaking={speakingIds.has(tile.id)}
                          isPresenting={isLocal ? isScreenSharing : sharingPeerIds.has(tile.id)}
                          videoWithheld={!videoPeerIds.has(tile.id)}
                          isFocused={false}
                          onToggleFocus={() => toggleFocus('participant', tile.id)}
                          quality={links.get(tile.id)?.quality}
                          relayed={links.get(tile.id)?.stats?.relayed}
                          handRaised={raisedHands.has(tile.id)}
                          compact
                        />
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ) : (
            <div className="flex-1 min-h-0 p-2 md:p-4 pb-20 md:pb-24 flex items-center justify-center relative">
              {/* The wrapper div explicitly limits height to 100% so rows don't push past the screen */}
              <div
                ref={gridRef}
                className="w-full h-full max-h-full flex flex-wrap items-center justify-center content-center"
                style={{ gap: `${gridGap}px` }}
              >
                {gridPagination.tiles.map((tile) => {
                  const isLocal = 'isLocal' in tile;
                  return (
                    <div
                      key={tile.id}
                      className="min-w-0 min-h-0"
                      style={tileSize
                        ? { width: `${tileSize.width}px`, height: `${tileSize.height}px` }
                        : { width: '100%', height: '100%' }}
                    >
                      <ParticipantTile
                        id={tile.id}
                        name={tile.name}
                        isLocal={isLocal}
                        peer={tile as PeerInfo}
                        localStream={localStream}
                        isVideoOff={isVideoOff}
                        isMuted={isMuted}
                        bgMode={bgMode}
                        isSpeaking={speakingIds.has(tile.id)}
                        isPresenting={isLocal ? isScreenSharing : sharingPeerIds.has(tile.id)}
                        videoWithheld={!videoPeerIds.has(tile.id)}
                        isFocused={false}
                        onToggleFocus={() => toggleFocus('participant', tile.id)}
                        quality={links.get(tile.id)?.quality}
                        relayed={links.get(tile.id)?.stats?.relayed}
                        handRaised={raisedHands.has(tile.id)}
                      />
                    </div>
                  );
                })}
              </div>

              {gridPagination.totalPageCount > 1 && (
                <>
                  <button
                    onClick={gridPagination.prevPage}
                    disabled={gridPagination.currentPage === 0}
                    aria-label="Previous participants"
                    className="absolute left-1 md:left-3 top-1/2 -translate-y-1/2 bg-[#202124]/80 backdrop-blur-sm border border-[#5f6368]/40 rounded-full p-1.5 md:p-2 text-white shadow-lg disabled:opacity-30 disabled:cursor-not-allowed hover:bg-[#202124] transition-colors z-10"
                  >
                    <ChevronLeft className="w-4 h-4 md:w-5 md:h-5" />
                  </button>
                  <button
                    onClick={gridPagination.nextPage}
                    disabled={gridPagination.currentPage === gridPagination.totalPageCount - 1}
                    aria-label="Next participants"
                    className="absolute right-1 md:right-3 top-1/2 -translate-y-1/2 bg-[#202124]/80 backdrop-blur-sm border border-[#5f6368]/40 rounded-full p-1.5 md:p-2 text-white shadow-lg disabled:opacity-30 disabled:cursor-not-allowed hover:bg-[#202124] transition-colors z-10"
                  >
                    <ChevronRight className="w-4 h-4 md:w-5 md:h-5" />
                  </button>
                  <div className="absolute top-2 left-1/2 -translate-x-1/2 flex items-center gap-1.5 bg-[#202124]/80 backdrop-blur-sm border border-[#5f6368]/40 rounded-full px-2.5 py-1 shadow-lg z-10">
                    {Array.from({ length: gridPagination.totalPageCount }).map((_, i) => (
                      <span key={i} className={`w-1.5 h-1.5 rounded-full transition-colors ${i === gridPagination.currentPage ? 'bg-[#8ab4f8]' : 'bg-[#5f6368]'}`} />
                    ))}
                  </div>
                </>
              )}
            </div>
          )}

          {/* Reactions float over the whole stage, not over a tile — the sender's tile
              may be on another page of the grid. */}
          <ReactionOverlay reactions={reactions} />

          {reactionBarOpen && (
            <ReactionBar onPick={sendReaction} onClose={() => setReactionBarOpen(false)} />
          )}

          {/* Room-wide, not gated on this participant's OWN `transcribing` toggle —
              that flag only means "my mic is being captured for ASR", a per-speaker
              privacy choice. Whether to DISPLAY captions is a separate question:
              `liveCaptions` already arrives over the signalling socket's broadcast
              path for every participant regardless of their own toggle (see
              MeetingContext's "caption" handler), so gating the bar on `transcribing`
              meant only the person who turned captions on ever saw the on-screen
              subtitle bar — everyone else in the room saw nothing, even while that
              speaker's captions were actively being broadcast to them. CaptionBar
              already renders null when there's nothing current to show, so this is
              safe to mount unconditionally: it appears for everyone the moment
              anyone's speech produces a caption, and disappears again on its own. */}
          <CaptionBar liveCaptions={liveCaptions} myLang={myCaptionLang} size={captionSize} />

          {/* FLOATING CONTROLS -- white pill, two-layer shadow (theme brief D).
              bottom offset adds env(safe-area-inset-bottom) on mobile so the
              bar clears a home indicator (viewport-fit=cover already set in
              index.html) -- unaffected on desktop, no notch to clear there. */}
          <div className="absolute bottom-[calc(0.75rem+env(safe-area-inset-bottom))] md:bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-1.5 md:gap-2 bg-white/95 backdrop-blur-xl border border-[var(--ib-gray-100)] rounded-2xl p-1.5 md:p-2 shadow-[var(--ib-shadow-lg)] z-20 w-[max-content] max-w-[95vw] overflow-x-auto scrollbar-hide">
            <CtrlBtn onClick={toggleMic} danger={isMuted} title={isMuted ? 'Unmute' : 'Mute'}>
              {isMuted ? <MicOff className="w-4 h-4 md:w-5 md:h-5" /> : <Mic className="w-4 h-4 md:w-5 md:h-5" />}
            </CtrlBtn>
            <CtrlBtn onClick={toggleCamera} danger={isVideoOff} title={isVideoOff ? 'Turn camera on' : 'Turn camera off'}>
              {isVideoOff ? <VideoOff className="w-4 h-4 md:w-5 md:h-5" /> : <Video className="w-4 h-4 md:w-5 md:h-5" />}
            </CtrlBtn>
            {/* Desktop: every secondary action inline, as before. */}
            <div className="hidden md:flex items-center gap-2">
              <div className="w-px h-8 bg-[var(--ib-gray-200)] mx-1 shrink-0" />
              {/* Keyed wrapper, not a key on CtrlBtn: React 19's bundled types reject
                  `key` on a custom component inside .map() (see CLAUDE.md). */}
              {secondaryActions.map(({ key, label, Icon, onClick, active, badge }) => (
                <div key={key} className="contents">
                  <CtrlBtn onClick={onClick} highlight={active} title={label}>
                    <Icon className="w-5 h-5" />
                    {badge && <span className="absolute top-1 right-1 w-2 h-2 rounded-full bg-[var(--ib-bad-dot)] border-2 border-white" />}
                  </CtrlBtn>
                </div>
              ))}
            </div>

            {/* Mobile: one More button. Mic, camera and Leave stay reachable without
                scrolling, which is the whole point. */}
            <div className="md:hidden flex items-center gap-1.5">
              <CtrlBtn onClick={() => setMoreOpen((v) => !v)} highlight={moreOpen} title="More options">
                <MoreVertical className="w-4 h-4" />
                {secondaryActions.some((x) => x.badge) && !moreOpen && (
                  <span className="absolute top-1 right-1 w-2 h-2 rounded-full bg-[var(--ib-bad-dot)] border-2 border-white" />
                )}
              </CtrlBtn>
            </div>

            <div className="w-px h-6 md:h-8 bg-[var(--ib-gray-200)] mx-0.5 md:mx-1 shrink-0" />
            {/* Leave: the one place a solid, saturated bad-dot fill is correct --
                everywhere else danger states use the soft fill+dot pairing, but
                this is a terminal action that should read as unambiguously final. */}
            <button onClick={handleLeave} className="px-3 md:px-5 h-9 md:h-11 flex items-center gap-1.5 rounded-xl bg-[var(--ib-bad-dot)] text-white hover:bg-[var(--ib-bad-text)] active:scale-95 font-bold text-[10px] md:text-xs cursor-pointer transition-all shadow-sm shrink-0">
              <PhoneOff className="w-3.5 h-3.5 md:w-4 md:h-4" /><span className="hidden sm:inline">Leave</span>
            </button>
          </div>

          {/* Mobile secondary actions. Labelled rows rather than icons: there is room
              for words here, and an icon-only grid is guesswork. */}
          {moreOpen && (
            <>
              <button
                className="md:hidden fixed inset-0 z-20 cursor-default"
                aria-label="Close options"
                onClick={() => setMoreOpen(false)}
              />
              <div className="md:hidden absolute bottom-20 left-1/2 -translate-x-1/2 w-[min(88vw,20rem)] bg-white border border-[var(--ib-gray-100)] rounded-2xl shadow-[var(--ib-shadow-lg)] z-30 overflow-hidden">
                {secondaryActions.map(({ key, label, Icon, onClick, active, badge }) => (
                  <button
                    key={key}
                    onClick={() => { onClick(); setMoreOpen(false); }}
                    className={`w-full flex items-center gap-3 px-4 py-3 text-left border-b border-[var(--ib-gray-100)] last:border-b-0 active:bg-[var(--ib-gray-50)] cursor-pointer transition-colors ${
                      active ? 'text-[var(--ib-blue-500)]' : 'text-[var(--ib-gray-800)]'
                    }`}
                  >
                    <Icon className="w-4 h-4 shrink-0" />
                    <span className="text-xs font-medium flex-1">{label}</span>
                    {badge && <span className="w-2 h-2 rounded-full bg-[var(--ib-bad-dot)] shrink-0" />}
                  </button>
                ))}
              </div>
            </>
          )}

          {/* Settings overlay */}
          {settingsOpen && (
            <SettingsPanel
              bgMode={bgMode} onBgChange={setBgMode}
              videoDevices={devices.videoDevices} audioDevices={devices.audioDevices} outputDevices={devices.outputDevices}
              selectedCamera={shownCamera} selectedMic={shownMic} selectedSpeaker={shownSpeaker}
              speakerSelectable={speakerSelectable}
              onCameraChange={(id) => { setSelectedCamera(id); switchCamera(id); }}
              onMicChange={(id) => { setSelectedMic(id); switchMic(id); }}
              // Actually routes the audio now: setPreferredSpeaker calls setSinkId on
              // every registered element. This used to be `setSelectedSpeaker` alone,
              // which changed the label in the dropdown and nothing else.
              onSpeakerChange={(id) => { setSelectedSpeaker(id); void setPreferredSpeaker(id); }}
              onClose={() => setSettingsOpen(false)}
            />
          )}
        </div>

        {/* ── FIX: MOBILE CHAT OVERLAY ───────────────── */}
        {rightOpen && (
          <div className="fixed inset-0 z-40 lg:static lg:w-80 lg:h-full lg:shrink-0 lg:border-l border-[#3c4043] bg-[#202124] flex flex-col shadow-2xl transition-transform transform translate-y-0 lg:translate-y-0">
            {/* Mobile Header overlay to close it clearly */}
            <div className="lg:hidden flex items-center justify-between p-3 bg-[#1a1b1e] border-b border-[#3c4043]">
              <span className="text-xs font-bold text-[#e8eaed]">Meeting Details</span>
              <button onClick={() => setRightOpen(false)} className="p-1 rounded-md bg-[#3c4043] text-[#e8eaed]"><X className="w-4 h-4" /></button>
            </div>
            <RightPanel
              tab={rightTab} onTabChange={setRightTab}
              chatMessages={chatMessages} onSend={sendChatMessage}
              peers={peers} userName={displayName} isMuted={isMuted}
              onClose={() => setRightOpen(false)}
              links={links} raisedHands={raisedHands} isHandRaised={isHandRaised}
              transcribing={transcribing} captionsSupported={captionsSupported} captionsUnavailable={captionsUnavailable}
              transcriptLines={transcriptLines} keyPoints={keyPoints}
              transcriptEndRef={transcriptEndRef}
              myCaptionLang={myCaptionLang} onCaptionLangChange={setCaptionLang}
              captionSize={captionSize} onCaptionSizeChange={setCaptionSize}
              onStartCaptions={() => void startTranscription()} onStopCaptions={stopTranscription}
              roomId={roomId}
            />
          </div>
        )}
      </section>
    </div>
  );

  return createPortal(meetingContent, document.body);
}

function CtrlBtn({ onClick, children, danger, highlight, title }: { onClick: () => void; children: React.ReactNode; danger?: boolean; highlight?: boolean; title?: string; }) {
  // Light redesign, 2026-09-18: the bar itself inverted from a dark pill with
  // light icons to a white pill with dark icons (theme brief D) -- every
  // state here follows. highlight mirrors Sidebar's own active-nav pairing
  // (--ib-blue-50 fill, --ib-blue-500 icon) for the same "this is on" meaning
  // in both places. danger (muted mic / camera off -- NOT the Leave button,
  // that's separate below) uses the same fill/dot pairing Badge uses.
  const cls = danger ? 'bg-[var(--ib-bad-fill)] text-[var(--ib-bad-dot)] hover:bg-[var(--ib-bad-fill)] hover:brightness-95' : highlight ? 'bg-[var(--ib-blue-50)] text-[var(--ib-blue-500)]' : 'bg-[var(--ib-gray-100)] text-[var(--ib-gray-800)] hover:bg-[var(--ib-gray-200)]';
  return (
    // Tooltips don't exist on touch, so `title` alone leaves every call control
    // unnamed for screen readers and on phones — mirror it into aria-label.
    // 48px on mobile (was 36px, under the 44px tap-target floor), 44px desktop
    // -- theme brief D's explicit sizing, touch needs more room than a pointer.
    <button onClick={onClick} title={title} aria-label={title} className={`relative w-12 h-12 md:w-11 md:h-11 flex items-center justify-center rounded-xl transition-all active:scale-90 cursor-pointer shrink-0 ${cls}`}>
      {children}
    </button>
  );
}
