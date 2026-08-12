import React, { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import {
  Mic, MicOff, Video, VideoOff, ScreenShare, ScreenShareOff,
  PhoneOff, MessageSquare, Send, X, Users, Copy, Check,
  MoreVertical, Volume2, Lightbulb, Tag, Hash, HelpCircle,
  Activity, Zap, Mic2, ChevronDown, Link, ChevronLeft, ChevronRight,
  Pin, PinOff, Minimize2, ArrowLeft, AlertTriangle,
} from 'lucide-react';
import { useMeeting } from '../../context/MeetingContext';
import { PeerInfo } from '../../hooks/useWebRTC';
import { useSpeechTranscription } from '../../hooks/useSpeechTranscription';
import { useAuth } from '../../context/AuthContext';
import { useGridLayout, computeTileSize } from '../../hooks/useGridLayout';
import { useAudioLevels } from '../../hooks/useAudioLevels';
import { usePagination } from '../../hooks/usePagination';
import MeetingInviteDialog from './MeetingInviteDialog';
import { TRANSCRIPTION_ENABLED } from '../../lib/features';

export type BgMode = 'none' | 'blur' | 'blur-heavy' | 'color-dark' | 'color-space';

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
// most 11 of the other participants, and paging changed *which* 11. The streams
// were arriving the whole time: `useAudioLevels` runs an analyser over every
// peer, so the app was measuring audio it never routed to an output.
//
// `RemoteTile`'s <video> is therefore `muted` now. If you ever un-mute it, every
// on-screen peer will play twice (here and there) — which sounds like an echo,
// not like a duplicate, so it is easy to misdiagnose.
function PeerAudio({ peer }: { peer: PeerInfo }) {
  const ref = useRef<HTMLAudioElement>(null);

  const attach = useCallback((el: HTMLAudioElement | null) => {
    ref.current = el;
    if (!el || !peer.stream) return;
    if (el.srcObject !== peer.stream) el.srcObject = peer.stream;
    playWhenAllowed(el);
  }, [peer.stream]);

  useEffect(() => { attach(ref.current); }, [attach]);

  const ensurePlaying = () => {
    const el = ref.current;
    if (el && el.paused) playWhenAllowed(el);
  };

  return (
    <audio
      ref={attach}
      autoPlay
      // eslint-disable-next-line jsx-a11y/media-has-caption
      onCanPlay={ensurePlaying}
      onPause={ensurePlaying}
      style={{ display: 'none' }}
    />
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
          <div className="w-14 h-14 md:w-16 md:h-16 rounded-full bg-[#568dff]/20 flex items-center justify-center mb-2 shadow-lg border border-[#568dff]/30">
            <span className="text-xl md:text-2xl font-bold text-[#b0c6ff]">{name.charAt(0).toUpperCase()}</span>
          </div>
          <span className="text-xs text-[#9aa0a6] font-medium tracking-wide truncate max-w-[90%]">{name}</span>
        </div>
      )}
    </div>
  );
}

// ─── Remote tile ─────────────────────────────────────────────────────────────

function RemoteTile({ peer }: { peer: PeerInfo }) {
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
  const attach = useCallback((vid: HTMLVideoElement | null) => {
    ref.current = vid;
    if (!vid || !peer.stream) return;
    if (vid.srcObject !== peer.stream) vid.srcObject = peer.stream;
    playWhenAllowed(vid);
  }, [peer.stream]);

  useEffect(() => { attach(ref.current); }, [attach]);

  const ensurePlaying = () => {
    const vid = ref.current;
    if (vid && vid.paused) playWhenAllowed(vid);
  };

  if (!peer.stream) {
    return (
      <div className="w-full h-full flex flex-col items-center justify-center bg-[#202124]">
        <div className="w-14 h-14 md:w-16 md:h-16 rounded-full bg-[#c0c1ff]/10 flex items-center justify-center mb-2 animate-pulse border border-[#c0c1ff]/20">
          <span className="text-xl md:text-2xl font-bold text-[#c0c1ff]">{peer.name.charAt(0).toUpperCase()}</span>
        </div>
        <span className="text-xs font-medium text-[#e8eaed] truncate max-w-[90%]">{peer.name}</span>
        <span className="text-[9px] md:text-[10px] text-[#8ab4f8] mt-1 animate-pulse">Connecting…</span>
      </div>
    );
  }

  return (
    <video
      ref={attach}
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
      className="w-full h-full object-cover"
    />
  );
}

// ─── Screen-share spotlight tile ───────────────────────────────────────────────
// Uses object-contain (not object-cover) so shared screens are never cropped —
// unlike camera tiles, a screen's content (text, slides, code) is unusable if
// half of it gets clipped off to fill a square-ish grid cell.

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
}

function ParticipantTile({
  name, isLocal, localStream, peer, isVideoOff, isMuted, bgMode,
  isSpeaking, isPresenting, isFocused, onToggleFocus, compact = false,
}: ParticipantTileProps) {
  return (
    <div
      className={`group relative w-full h-full rounded-xl md:rounded-2xl overflow-hidden bg-[#202124] border shadow-lg transition-colors ${
        isSpeaking ? 'border-[#8ab4f8] ring-2 ring-[#8ab4f8]/70' : 'border-[#3c4043]'
      }`}
    >
      {isLocal
        ? <LocalTile stream={localStream} isVideoOff={isVideoOff} name={name} bgMode={bgMode} />
        : <RemoteTile peer={peer!} />}

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
      </div>

      {/* Pin/unpin. Keyboard-reachable always; revealed on hover for pointer users. */}
      <button
        onClick={onToggleFocus}
        aria-label={isFocused ? `Unpin ${name}` : `Pin ${name}`}
        title={isFocused ? 'Unpin' : 'Pin to main view'}
        className={`absolute top-1.5 right-1.5 md:top-2 md:right-2 p-1.5 rounded-lg bg-[#202124]/85 backdrop-blur-sm border border-[#5f6368]/50 text-white shadow-lg cursor-pointer transition-opacity hover:bg-[#3c4043] focus-visible:opacity-100 ${
          isFocused ? 'opacity-100 text-[#8ab4f8]' : 'opacity-0 group-hover:opacity-100'
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
      <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-[#9aa0a6]">
        <Icon className="w-3 h-3" />{label}
      </div>
      <div className="relative">
        <select
          value={selected}
          onChange={(e) => onChange(e.target.value)}
          className="w-full bg-[#3c4043] border border-[#5f6368] rounded-lg px-3 py-2 text-xs text-[#e8eaed] outline-none appearance-none cursor-pointer"
        >
          {devices.length === 0 && <option value="">No devices found</option>}
          {devices.map(d => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label || `Device ${d.deviceId.slice(0, 8)}`}
            </option>
          ))}
        </select>
        <ChevronDown className="w-3 h-3 text-[#9aa0a6] absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
      </div>
    </div>
  );
}

function SettingsPanel({
  bgMode, onBgChange, videoDevices, audioDevices, outputDevices,
  selectedCamera, selectedMic, selectedSpeaker,
  onCameraChange, onMicChange, onSpeakerChange, onClose,
}: {
  bgMode: BgMode; onBgChange: (m: BgMode) => void;
  videoDevices: MediaDeviceInfo[]; audioDevices: MediaDeviceInfo[]; outputDevices: MediaDeviceInfo[];
  selectedCamera: string; selectedMic: string; selectedSpeaker: string;
  onCameraChange: (id: string) => void; onMicChange: (id: string) => void; onSpeakerChange: (id: string) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<'bg' | 'devices'>('bg');
  return (
    <div className="absolute bottom-20 right-4 w-[90vw] md:w-72 max-w-sm bg-[#202124] border border-[#5f6368] rounded-2xl shadow-2xl z-30 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-[#3c4043]">
        <div className="flex gap-1">
          {(['bg', 'devices'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)} className={`px-3 py-1 rounded-lg text-xs font-semibold transition-colors ${tab === t ? 'bg-[#8ab4f8]/20 text-[#8ab4f8]' : 'text-[#9aa0a6] hover:text-[#e8eaed]'}`}>
              {t === 'bg' ? 'Backgrounds' : 'Devices'}
            </button>
          ))}
        </div>
        <button onClick={onClose} className="text-[#9aa0a6] hover:text-[#e8eaed] cursor-pointer"><X className="w-4 h-4" /></button>
      </div>
      <div className="p-4">
        {tab === 'bg' && (
          <div className="flex flex-col gap-3">
            <p className="text-[10px] text-[#9aa0a6] uppercase font-bold tracking-wider">Virtual Background</p>
            <div className="grid grid-cols-5 gap-2">
              {BG_OPTIONS.map(opt => (
                <button
                  key={opt.mode}
                  onClick={() => onBgChange(opt.mode)}
                  className={`flex flex-col items-center gap-1 p-2 rounded-xl text-[10px] font-semibold cursor-pointer transition-all ${bgMode === opt.mode ? 'bg-[#8ab4f8]/20 text-[#8ab4f8] border border-[#8ab4f8]/50' : 'bg-[#3c4043] text-[#9aa0a6] hover:bg-[#4a4d51] border border-transparent'}`}
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
            <DeviceSelect label="Speaker"  Icon={Volume2} devices={outputDevices} selected={selectedSpeaker} onChange={onSpeakerChange} />
          </div>
        )}
      </div>
    </div>
  );
}


// ─── Right panel (Chat + People + Mobile Transcript) ─────────────────────────

function RightPanel({
  tab, onTabChange, chatMessages, onSend, peers, userName, isMuted, onClose,
  transcribing, speechSupported, startTranscription, stopTranscription, transcriptLines, keyPoints, transcriptEndRef
}: {
  tab: 'chat' | 'people' | 'transcript'; onTabChange: (t: 'chat' | 'people' | 'transcript') => void;
  chatMessages: { id: string; fromId: string; fromName: string; text: string; time: string; isSelf: boolean }[];
  onSend: (text: string) => void; peers: PeerInfo[]; userName: string; isMuted: boolean; onClose: () => void;
  transcribing: boolean; speechSupported: boolean; startTranscription: () => void; stopTranscription: () => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  transcriptLines: any[]; keyPoints: any[]; transcriptEndRef: React.RefObject<HTMLDivElement>;
}) {
  const [input, setInput] = useState('');
  const chatEndRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (tab === 'chat') chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [chatMessages, tab]);
  useEffect(() => { if (tab === 'transcript') transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [transcriptLines, tab, transcriptEndRef]);

  const send = () => { if (!input.trim()) return; onSend(input.trim()); setInput(''); };

  return (
    <div className="w-full h-full flex flex-col bg-[#202124] overflow-hidden">
      <div className="flex items-center border-b border-[#3c4043] px-1 pt-1 md:px-2 md:pt-2 bg-[#1a1b1e] shrink-0">
        {(TRANSCRIPTION_ENABLED ? (['chat', 'people', 'transcript'] as const) : (['chat', 'people'] as const)).map(t => (
          <button
            key={t} onClick={() => onTabChange(t)}
            className={`flex-1 py-2.5 text-[10px] md:text-xs font-semibold border-b-2 transition-colors ${t === 'transcript' ? 'lg:hidden ' : ''} ${tab === t ? 'border-[#8ab4f8] text-[#8ab4f8]' : 'border-transparent text-[#9aa0a6] hover:text-[#e8eaed]'}`}
          >
            <div className="flex items-center justify-center gap-1 md:gap-1.5">
              {t === 'chat' && <><MessageSquare className="w-3.5 h-3.5" /><span className="hidden sm:inline">Chat</span></>}
              {t === 'people' && <><Users className="w-3.5 h-3.5" /><span className="hidden sm:inline">People</span></>}
              {t === 'transcript' && <><Activity className="w-3.5 h-3.5" /><span className="hidden sm:inline">Transcript</span></>}
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
            {isMuted && <MicOff className="w-3 h-3 text-[#f28b82] shrink-0" />}
          </div>
          {peers.map((peer) => (
            <div key={peer.id} className="flex items-center gap-3 p-2 md:p-2.5 rounded-xl hover:bg-[#3c4043] transition-colors">
              <div className="w-8 h-8 md:w-9 md:h-9 rounded-full bg-[#81c995]/10 flex items-center justify-center shrink-0 border border-[#81c995]/20">
                <span className="text-xs md:text-sm font-bold text-[#81c995]">{peer.name.charAt(0).toUpperCase()}</span>
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-[11px] md:text-xs font-semibold text-[#e8eaed] truncate">{peer.name}</p>
                <p className="text-[9px] text-[#81c995]">{peer.stream ? 'Connected' : 'Connecting…'}</p>
              </div>
            </div>
          ))}
        </div>
      )}

      {TRANSCRIPTION_ENABLED && tab === 'transcript' && (
        <div className="flex-1 flex flex-col overflow-hidden min-h-0 bg-[#202124]">
          <div className="p-3 border-b border-[#3c4043] flex justify-between items-center shrink-0">
            <span className="text-[10px] text-[#9aa0a6] font-bold uppercase tracking-wider">Intelligence</span>
            <button
              onClick={transcribing ? stopTranscription : startTranscription}
              className={`flex items-center gap-1 px-2 py-1 rounded border text-[9px] font-bold ${transcribing ? 'bg-[#f28b82]/10 text-[#f28b82] border-[#f28b82]/30' : 'bg-[#8ab4f8]/10 text-[#8ab4f8] border-[#8ab4f8]/30'}`}
            >
              <Mic2 className="w-3 h-3" /> {transcribing ? 'Stop' : 'Transcribe'}
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-3 space-y-2 scrollbar-hide">
            {transcribing && transcriptLines.length === 0 && <p className="text-[10px] text-[#9aa0a6] animate-pulse">Listening for speech…</p>}
            {transcriptLines.map((line) => (
              <div key={line.id} className={`flex flex-col gap-0.5 ${line.isFinal ? '' : 'opacity-70'}`}>
                <div className="flex items-center gap-1.5">
                  <span className="text-[9px] font-bold text-[#8ab4f8]">{line.speaker}</span>
                  <span className="text-[9px] text-[#5f6368]">{line.timestamp}</span>
                </div>
                <p className="text-[11px] text-[#e8eaed] leading-relaxed bg-[#3c4043]/40 rounded-lg px-2 py-1.5 border border-[#5f6368]/20">{line.text}</p>
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
  const { user, roomId, localStream, peers, isMuted, isVideoOff, isScreenSharing, screenStream, screenPeers, toggleMic, toggleCamera, toggleScreenShare, switchCamera, switchMic, leaveMeeting, chatMessages, sendChatMessage, showInviteDialog, dismissInviteDialog, mediaNotice, dismissMediaNotice } = useMeeting();
  const { currentUser } = useAuth();
  const displayName = currentUser?.displayName ?? user.name;

  const { isActive: transcribing, isSupported: speechSupported, lines: transcriptLines, keyPoints, start: startTranscription, stop: stopTranscription } = useSpeechTranscription(displayName, peers);

  const [bgMode, setBgMode] = useState<BgMode>('none');
  const [rightTab, setRightTab] = useState<'chat' | 'people' | 'transcript'>('people');
  // Meet-style default: the stage starts full-width with no panel open, same as joining
  // a real Meet call — People/Chat/Transcript are opt-in via the toolbar, not on by default.
  // (Previously defaulted open on any viewport >768px, which stole ~300px+ from the grid
  // on every desktop call and was part of why 2-3 person layouts looked cramped/stacked.)
  const [rightOpen, setRightOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [codeCopied, setCodeCopied] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);

  const [videoDevices, setVideoDevices] = useState<MediaDeviceInfo[]>([]);
  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([]);
  const [outputDevices, setOutputDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedCamera, setSelectedCamera] = useState('');
  const [selectedMic, setSelectedMic] = useState('');
  const [selectedSpeaker, setSelectedSpeaker] = useState('');

  useEffect(() => {
    if (!settingsOpen) return;
    navigator.mediaDevices.enumerateDevices().then((devices) => {
      const vid = devices.filter(d => d.kind === 'videoinput');
      const aud = devices.filter(d => d.kind === 'audioinput');
      const out = devices.filter(d => d.kind === 'audiooutput');
      setVideoDevices(vid);
      setAudioDevices(aud);
      setOutputDevices(out);
      if (!selectedCamera && vid[0]) setSelectedCamera(vid[0].deviceId);
      if (!selectedMic && aud[0]) setSelectedMic(aud[0].deviceId);
      if (!selectedSpeaker && out[0]) setSelectedSpeaker(out[0].deviceId);
    }).catch(() => {});
  }, [settingsOpen, selectedCamera, selectedMic, selectedSpeaker]);

  const transcriptEndRef = useRef<HTMLDivElement>(null);
  const transcriptEndDesktopRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    transcriptEndDesktopRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [transcriptLines]);

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

  const tiles = [...peers, { id: user.id, name: displayName, isLocal: true as const }];

  // Screen shares render in a dedicated spotlight area (object-contain, never cropped)
  // instead of replacing anyone's camera tile — camera keeps streaming the whole time.
  const activeScreens: { id: string; name: string; stream: MediaStream | null }[] = [
    ...(isScreenSharing ? [{ id: 'local-screen', name: 'You', stream: screenStream }] : []),
    ...screenPeers.map((p) => ({ id: p.id, name: p.name, stream: p.stream })),
  ];
  const sharingPeerIds = new Set(screenPeers.map((p) => p.id));

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
    if (activeScreens.length > 0) return { kind: 'screen' as const, id: activeScreens[0].id };
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
  const carouselTiles = tiles.filter((t) => t.id !== focusedTile?.id);

  // Container-size + orientation aware grid (see src/lib/gridLayout.ts), replacing the old
  // tile-count-only breakpoint table — a wide desktop window and a narrow phone no longer
  // get forced into the same rows/cols just because they both have e.g. 4 tiles.
  const { ref: gridRef, layout: gridLayout, size: gridSize } = useGridLayout(tiles.length);
  const gridGap = gridSize.width >= 768 ? 12 : 8;
  const tileSize = computeTileSize(gridSize, gridLayout, gridGap);

  // A layout picked for a small/cramped container can have maxTiles < tiles.length (e.g. a
  // narrow phone stepping down to a 2-tile layout for a 4-person call) — paginate instead of
  // silently dropping tiles that have nowhere to render. Same fix Meet's own <GridLayout>
  // applies on top of `selectGridLayout` (see src/hooks/usePagination.ts).
  const gridPagination = usePagination(gridLayout.maxTiles, tiles);

  // Client-side active-speaker detection (mesh WebRTC has no SFU to compute this for us —
  // see src/hooks/useAudioLevels.ts). Feeds a highlight ring on whoever is currently talking.
  const audioLevelSources = useMemo(
    () => [
      { id: user.id, stream: localStream },
      ...peers.map((p) => ({ id: p.id, stream: p.stream })),
    ],
    [user.id, localStream, peers],
  );
  const speakingIds = useAudioLevels(audioLevelSources);

  const meetingContent = (
    <div className="fixed inset-0 z-[9999] flex flex-col lg:flex-row bg-[#111] overflow-hidden select-none text-[#e8eaed]">

      {/* Remote audio for EVERY peer, independent of what the stage is showing.
          Must stay outside the focus/grid ternary below — that ternary swaps two
          separate subtrees, so anything inside it is unmounted and remounted
          whenever somebody starts or stops a screen share. */}
      {peers.map((p) => (
        <div key={`audio-${p.id}`}>{p.stream ? <PeerAudio peer={p} /> : null}</div>
      ))}

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

      {showInviteDialog && (
        <MeetingInviteDialog onClose={dismissInviteDialog} onAddPeople={handleAddPeople} />
      )}

      {/* ── Left Sidebar (Desktop Transcripts) ───────────────────────────────────
           Off with the transcription feature (src/lib/features.ts): the panel is a
           transcript panel first and foremost, and leaving a near-empty 288px column
           in place would only squeeze the video grid (see the tiling notes in CLAUDE.md).
           The room code / copy-link controls it also carried move to the floating badge
           over the stage, which becomes visible at all widths when this is hidden. */}
      {TRANSCRIPTION_ENABLED && (
      <section className="hidden lg:flex w-72 shrink-0 flex-col border-r border-[#3c4043] bg-[#202124] h-full">
        <div className="px-4 py-3 border-b border-[#3c4043] flex items-center justify-between shrink-0">
          <span className="text-xs font-semibold text-[#e8eaed] flex items-center gap-1.5">
            <Activity className="w-3.5 h-3.5 text-[#8ab4f8]" />Live Transcript
            <span className="text-[9px] text-[#9aa0a6] font-normal">• Hindi2Hinglish ASR</span>
          </span>
          <button
            onClick={transcribing ? stopTranscription : startTranscription}
            className={`flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] font-bold cursor-pointer transition-all ${transcribing ? 'bg-[#f28b82]/15 text-[#f28b82] border border-[#f28b82]/30' : 'bg-[#8ab4f8]/10 text-[#8ab4f8] border border-[#8ab4f8]/30 hover:bg-[#8ab4f8]/20'}`}
          >
            <Mic2 className="w-3 h-3" /> {transcribing ? 'Stop' : (speechSupported ? 'Transcribe' : 'No mic')}
          </button>
        </div>

        {roomId && (
          <div className="mx-3 mt-3 bg-[#3c4043] rounded-xl p-3 flex flex-col gap-2 border border-[#5f6368]/30 shadow-inner">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-[9px] text-[#9aa0a6] uppercase font-bold tracking-wider">Room Code</p>
                <p className="font-mono font-bold text-[#8ab4f8] text-sm">{roomId}</p>
              </div>
              <button onClick={copyCode} className="flex items-center gap-1 bg-[#4a4d51] text-[#e8eaed] hover:bg-[#5f6368] px-2 py-1 rounded-lg text-[10px] font-bold cursor-pointer transition-colors">
                {codeCopied ? <Check className="w-3 h-3 text-[#81c995]" /> : <Copy className="w-3 h-3" />}
                {codeCopied ? 'Copied' : 'Code'}
              </button>
            </div>
            <button onClick={copyLink} className="flex items-center gap-1.5 text-[10px] text-[#9aa0a6] hover:text-[#8ab4f8] cursor-pointer font-semibold transition-colors mt-1">
              <Link className="w-3 h-3" /> {linkCopied ? '✓ Link copied!' : 'Copy join link'}
            </button>
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-3 space-y-2 scrollbar-hide min-h-0">
          {transcribing && transcriptLines.length === 0 && <p className="text-[11px] text-[#9aa0a6] text-center mt-4 animate-pulse">Listening…</p>}
          {!transcribing && transcriptLines.length === 0 && <p className="text-[11px] text-[#5f6368] text-center mt-4">Click Transcribe to begin</p>}
          {transcriptLines.map((line) => (
            <div key={line.id} className={`flex flex-col gap-0.5 ${line.isFinal ? '' : 'opacity-70'}`}>
              <div className="flex items-center gap-1.5">
                <span className="text-[9px] font-bold text-[#8ab4f8]">{line.speaker}</span>
                <span className="text-[9px] text-[#5f6368]">{line.timestamp}</span>
              </div>
              <p className="text-[11px] text-[#e8eaed] leading-relaxed bg-[#3c4043]/40 rounded-lg px-2.5 py-2">{line.text}</p>
            </div>
          ))}
          <div ref={transcriptEndDesktopRef} />
        </div>

        {keyPoints.length > 0 && (
          <div className="border-t border-[#3c4043] p-3 bg-[#1a1b1e]">
            <p className="text-[9px] font-bold uppercase tracking-wider text-[#9aa0a6] mb-2 flex items-center gap-1">
              <Lightbulb className="w-3 h-3 text-[#fdd663]" />Key Points
            </p>
            <div className="space-y-1.5 max-h-40 overflow-y-auto scrollbar-hide">
              {keyPoints.slice(-8).map((kp) => {
                const Icon = KP_ICONS[kp.type] ?? Tag;
                const cc   = KP_COLORS[kp.type] ?? '';
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
      </section>
      )}

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
          <div className={`bg-[#202124]/80 backdrop-blur-md px-3 py-1.5 rounded-lg border border-[#3c4043] flex items-center gap-2 shadow-sm min-w-0 ${TRANSCRIPTION_ENABLED ? 'lg:hidden' : ''}`}>
            <span className="text-[9px] md:text-[10px] text-[#9aa0a6] font-semibold truncate">Code: <span className="text-[#8ab4f8] font-mono ml-1">{roomId}</span></span>
            {!TRANSCRIPTION_ENABLED && (
              <>
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
              </>
            )}
          </div>
          </div>

          {focus ? (
            /* ── Focus layout: one big stage + a carousel of everyone else ──────
               Carousel sits to the right on wide screens and below on narrow /
               portrait ones, so the stage always keeps the larger dimension. */
            <div className="flex-1 min-h-0 p-2 md:p-4 pb-20 md:pb-24 flex flex-col xl:flex-row gap-2 md:gap-3">
              <div className="flex-1 min-w-0 min-h-0">
                {focusedScreen ? (
                  <ScreenTile
                    stream={focusedScreen.stream}
                    label={focusedScreen.id === 'local-screen' ? 'Your screen' : `${focusedScreen.name}'s screen`}
                    isPinned={pinned?.kind === 'screen' && pinned.id === focusedScreen.id}
                    onToggleFocus={() => toggleFocus('screen', focusedScreen.id)}
                  />
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
                    isFocused
                    onToggleFocus={() => toggleFocus('participant', focusedTile.id)}
                  />
                ) : null}
              </div>

              {(carouselTiles.length > 0 || carouselScreens.length > 0) && (
                <div className="shrink-0 flex xl:flex-col gap-2 md:gap-3 overflow-x-auto xl:overflow-x-hidden xl:overflow-y-auto scrollbar-hide h-24 md:h-32 xl:h-auto xl:w-52 2xl:w-64">
                  {carouselScreens.map((s) => (
                    <div key={s.id} className="aspect-video h-full xl:h-auto xl:w-full shrink-0">
                      <ScreenTile
                        stream={s.stream}
                        label={s.id === 'local-screen' ? 'Your screen' : `${s.name}'s screen`}
                        compact
                        isPinned={false}
                        onToggleFocus={() => toggleFocus('screen', s.id)}
                      />
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
                          isFocused={false}
                          onToggleFocus={() => toggleFocus('participant', tile.id)}
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
                        isFocused={false}
                        onToggleFocus={() => toggleFocus('participant', tile.id)}
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

          {/* FLOATING CONTROLS */}
          <div className="absolute bottom-3 md:bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-1.5 md:gap-2 bg-[#202124]/90 backdrop-blur-xl border border-[#5f6368]/40 rounded-2xl p-1.5 md:p-2 shadow-2xl z-20 w-[max-content] max-w-[95vw] overflow-x-auto scrollbar-hide">
            <CtrlBtn onClick={toggleMic} danger={isMuted} title={isMuted ? 'Unmute' : 'Mute'}>
              {isMuted ? <MicOff className="w-4 h-4 md:w-5 md:h-5" /> : <Mic className="w-4 h-4 md:w-5 md:h-5" />}
            </CtrlBtn>
            <CtrlBtn onClick={toggleCamera} danger={isVideoOff} title={isVideoOff ? 'Turn camera on' : 'Turn camera off'}>
              {isVideoOff ? <VideoOff className="w-4 h-4 md:w-5 md:h-5" /> : <Video className="w-4 h-4 md:w-5 md:h-5" />}
            </CtrlBtn>
            <CtrlBtn onClick={() => toggleScreenShare()} highlight={isScreenSharing} title="Share screen">
              {isScreenSharing ? <ScreenShareOff className="w-4 h-4 md:w-5 md:h-5" /> : <ScreenShare className="w-4 h-4 md:w-5 md:h-5" />}
            </CtrlBtn>
            <div className="w-px h-6 md:h-8 bg-[#5f6368]/50 mx-0.5 md:mx-1 shrink-0" />
            <CtrlBtn onClick={() => { setRightTab('chat'); setRightOpen((v) => !v); }} highlight={rightOpen && rightTab === 'chat'} title="Chat">
              <MessageSquare className="w-4 h-4 md:w-5 md:h-5" />
              {chatMessages.length > 0 && !(rightOpen && rightTab === 'chat') && <span className="absolute top-1 right-1 w-2 h-2 rounded-full bg-[#f28b82] border-2 border-[#202124]" />}
            </CtrlBtn>
            <CtrlBtn onClick={() => { setRightTab('people'); setRightOpen((v) => !v); }} highlight={rightOpen && rightTab === 'people'} title="People">
              <Users className="w-4 h-4 md:w-5 md:h-5" />
            </CtrlBtn>
            {TRANSCRIPTION_ENABLED && (
              <div className="lg:hidden shrink-0">
                <CtrlBtn onClick={() => { setRightTab('transcript'); setRightOpen((v) => !v); }} highlight={rightOpen && rightTab === 'transcript'} title="Transcript">
                   <Activity className="w-4 h-4 md:w-5 md:h-5" />
                </CtrlBtn>
              </div>
            )}
            {onMinimize && (
              <CtrlBtn onClick={onMinimize} title="Minimise call">
                <Minimize2 className="w-4 h-4 md:w-5 md:h-5" />
              </CtrlBtn>
            )}
            <CtrlBtn onClick={() => setSettingsOpen((v) => !v)} highlight={settingsOpen} title="Settings">
              <MoreVertical className="w-4 h-4 md:w-5 md:h-5" />
            </CtrlBtn>
            <div className="w-px h-6 md:h-8 bg-[#5f6368]/50 mx-0.5 md:mx-1 shrink-0" />
            <button onClick={handleLeave} className="px-3 md:px-5 h-9 md:h-11 flex items-center gap-1.5 rounded-xl bg-[#f28b82] text-[#202124] hover:bg-[#f06e62] active:scale-95 font-bold text-[10px] md:text-xs cursor-pointer transition-all shadow-sm shrink-0">
              <PhoneOff className="w-3.5 h-3.5 md:w-4 md:h-4" /><span className="hidden sm:inline">Leave</span>
            </button>
          </div>

          {/* Settings overlay */}
          {settingsOpen && (
            <SettingsPanel
              bgMode={bgMode} onBgChange={setBgMode}
              videoDevices={videoDevices} audioDevices={audioDevices} outputDevices={outputDevices}
              selectedCamera={selectedCamera} selectedMic={selectedMic} selectedSpeaker={selectedSpeaker}
              onCameraChange={(id) => { setSelectedCamera(id); switchCamera(id); }}
              onMicChange={(id) => { setSelectedMic(id); switchMic(id); }}
              onSpeakerChange={setSelectedSpeaker}
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
              transcribing={transcribing} speechSupported={speechSupported}
              startTranscription={startTranscription} stopTranscription={stopTranscription}
              transcriptLines={transcriptLines} keyPoints={keyPoints}
              transcriptEndRef={transcriptEndRef}
            />
          </div>
        )}
      </section>
    </div>
  );

  return createPortal(meetingContent, document.body);
}

function CtrlBtn({ onClick, children, danger, highlight, title }: { onClick: () => void; children: React.ReactNode; danger?: boolean; highlight?: boolean; title?: string; }) {
  const cls = danger ? 'bg-[#f28b82]/15 text-[#f28b82] hover:bg-[#f28b82]/25' : highlight ? 'bg-[#8ab4f8]/20 text-[#8ab4f8]' : 'bg-[#3c4043] text-[#e8eaed] hover:bg-[#4a4d51]';
  return (
    // Tooltips don't exist on touch, so `title` alone leaves every call control
    // unnamed for screen readers and on phones — mirror it into aria-label.
    <button onClick={onClick} title={title} aria-label={title} className={`relative w-9 h-9 md:w-11 md:h-11 flex items-center justify-center rounded-xl transition-all active:scale-90 cursor-pointer shrink-0 ${cls}`}>
      {children}
    </button>
  );
}
