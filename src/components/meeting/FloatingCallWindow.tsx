import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Mic, MicOff, Video, VideoOff, PhoneOff, Maximize2 } from 'lucide-react';
import { useMeeting } from '../../context/MeetingContext';
import { PeerInfo } from '../../hooks/useWebRTC';

const MARGIN = 12;

/**
 * Remote audio has to keep playing while the call is minimised, and it can't ride on the
 * one visible tile: only a single peer is shown, so everyone else would go silent. The
 * full call screen gets audio from its per-peer <video> elements, and those unmount when
 * ActiveMeetingView does — so the floating window carries one hidden <audio> per peer and
 * keeps the visible tile muted. Without this, minimising a 3-way call mutes two people.
 */
function PeerAudio({ peer }: { peer: PeerInfo }) {
  const ref = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !peer.stream) return;
    if (el.srcObject !== peer.stream) el.srcObject = peer.stream;
    const tryPlay = () => el.play().catch(() => {});
    tryPlay();
    // A rejected autoplay leaves this silently paused; retry on the next interaction.
    window.addEventListener('pointerdown', tryPlay, { once: true });
    return () => window.removeEventListener('pointerdown', tryPlay);
  }, [peer.stream]);
  return <audio ref={ref} autoPlay playsInline className="hidden" />;
}

export default function FloatingCallWindow({ onExpand }: { onExpand: () => void }) {
  const {
    localStream, peers, isMuted, isVideoOff, toggleMic, toggleCamera, leaveMeeting, roomId,
  } = useMeeting();

  const boxRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const dragRef = useRef<{ dx: number; dy: number; moved: boolean } | null>(null);
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.innerWidth < 640);

  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < 640);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const width = narrow ? 150 : 232;

  // Show a remote peer if we have one — seeing only yourself in the corner tells you
  // nothing about the call. Falls back to the local preview when you're alone.
  const remote = peers.find(p => p.stream);
  const shown = remote?.stream ?? localStream;
  const shownName = remote?.name ?? 'You';

  useEffect(() => {
    const el = videoRef.current;
    if (!el || !shown) return;
    if (el.srcObject !== shown) el.srcObject = shown;
    const tryPlay = () => el.play().catch(() => {});
    tryPlay();
    window.addEventListener('pointerdown', tryPlay, { once: true });
    return () => window.removeEventListener('pointerdown', tryPlay);
  }, [shown]);

  const clamp = useCallback((x: number, y: number) => {
    const box = boxRef.current;
    const w = box?.offsetWidth ?? width;
    const h = box?.offsetHeight ?? 160;
    return {
      x: Math.min(Math.max(MARGIN, x), Math.max(MARGIN, window.innerWidth - w - MARGIN)),
      y: Math.min(Math.max(MARGIN, y), Math.max(MARGIN, window.innerHeight - h - MARGIN)),
    };
  }, [width]);

  // Start bottom-right, out of the way of the sidebar rail and most page content.
  useLayoutEffect(() => {
    if (pos) return;
    const box = boxRef.current;
    if (!box) return;
    setPos({
      x: window.innerWidth - box.offsetWidth - MARGIN,
      y: window.innerHeight - box.offsetHeight - MARGIN,
    });
  }, [pos]);

  // Rotating a phone or resizing a window must not strand the box off-screen.
  useEffect(() => {
    const onResize = () => setPos(p => (p ? clamp(p.x, p.y) : p));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [clamp]);

  const onPointerDown = (e: React.PointerEvent) => {
    // Let the control buttons handle their own clicks.
    if ((e.target as HTMLElement).closest('button')) return;
    const box = boxRef.current;
    if (!box) return;
    const rect = box.getBoundingClientRect();
    dragRef.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top, moved: false };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const next = clamp(e.clientX - d.dx, e.clientY - d.dy);
    // A few pixels of slop so a slightly shaky tap still counts as a tap, not a drag.
    if (Math.abs(e.movementX) + Math.abs(e.movementY) > 0) d.moved = true;
    setPos(next);
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const d = dragRef.current;
    dragRef.current = null;
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* already released */ }
    if (d && !d.moved) onExpand(); // tap the window to go back to the call
  };

  const participantCount = peers.length + 1;

  const content = (
    <div
      ref={boxRef}
      role="complementary"
      aria-label="Ongoing call — minimised"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      className="fixed z-[95] rounded-2xl overflow-hidden bg-[#202124] border border-[#5f6368]/50 shadow-2xl select-none touch-none cursor-grab active:cursor-grabbing"
      style={{
        width,
        left: pos?.x ?? -9999,
        top: pos?.y ?? -9999,
        visibility: pos ? 'visible' : 'hidden',
      }}
    >
      <div className="relative bg-[#111]" style={{ height: Math.round((width * 9) / 16) }}>
        <video
          ref={videoRef}
          autoPlay playsInline muted
          className="w-full h-full object-cover"
        />
        {(!shown || (!remote && isVideoOff)) && (
          <div className="absolute inset-0 flex items-center justify-center bg-[#3c4043]">
            <span className="text-sm font-bold text-[#8ab4f8]">{shownName.charAt(0).toUpperCase()}</span>
          </div>
        )}
        <div className="absolute top-1 left-1 right-1 flex items-center justify-between gap-1">
          <span className="max-w-[60%] truncate bg-[#000]/60 backdrop-blur-sm text-[9px] text-[#e8eaed] font-semibold px-1.5 py-0.5 rounded">
            {shownName}
          </span>
          <span className="bg-[#000]/60 backdrop-blur-sm text-[9px] text-[#e8eaed] font-semibold px-1.5 py-0.5 rounded" title={roomId ? `Room ${roomId}` : undefined}>
            {participantCount}
          </span>
        </div>
        <button
          onClick={onExpand}
          aria-label="Return to call"
          title="Return to call"
          className="absolute bottom-1 right-1 w-6 h-6 flex items-center justify-center rounded-md bg-[#000]/60 backdrop-blur-sm text-[#e8eaed] hover:bg-[#000]/80 transition-colors"
        >
          <Maximize2 className="w-3 h-3" />
        </button>
      </div>

      <div className="flex items-center justify-center gap-1.5 p-1.5 bg-[#202124]">
        <button
          onClick={toggleMic}
          aria-label={isMuted ? 'Unmute' : 'Mute'} title={isMuted ? 'Unmute' : 'Mute'}
          className={`w-7 h-7 flex items-center justify-center rounded-lg transition-colors ${isMuted ? 'bg-[#f28b82]/20 text-[#f28b82]' : 'bg-[#3c4043] text-[#e8eaed] hover:bg-[#4a4d51]'}`}
        >
          {isMuted ? <MicOff className="w-3.5 h-3.5" /> : <Mic className="w-3.5 h-3.5" />}
        </button>
        <button
          onClick={toggleCamera}
          aria-label={isVideoOff ? 'Turn camera on' : 'Turn camera off'} title={isVideoOff ? 'Turn camera on' : 'Turn camera off'}
          className={`w-7 h-7 flex items-center justify-center rounded-lg transition-colors ${isVideoOff ? 'bg-[#f28b82]/20 text-[#f28b82]' : 'bg-[#3c4043] text-[#e8eaed] hover:bg-[#4a4d51]'}`}
        >
          {isVideoOff ? <VideoOff className="w-3.5 h-3.5" /> : <Video className="w-3.5 h-3.5" />}
        </button>
        <button
          onClick={leaveMeeting}
          aria-label="Leave call" title="Leave call"
          className="w-7 h-7 flex items-center justify-center rounded-lg bg-[#f28b82] text-[#202124] hover:bg-[#f06e62] transition-colors"
        >
          <PhoneOff className="w-3.5 h-3.5" />
        </button>
      </div>

      {peers.map(p => (
        <div key={p.id}>{p.stream ? <PeerAudio peer={p} /> : null}</div>
      ))}
    </div>
  );

  return createPortal(content, document.body);
}
