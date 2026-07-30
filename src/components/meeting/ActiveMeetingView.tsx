import React, { useRef, useEffect, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import {
  Mic, MicOff, Video, VideoOff, ScreenShare, ScreenShareOff,
  PhoneOff, MessageSquare, Send, X, Users, Copy, Check,
  MoreVertical, Volume2, Lightbulb, Tag, Hash, HelpCircle,
  Activity, Zap, Mic2, ChevronDown, Link,
} from 'lucide-react';
import { useMeeting } from '../../context/MeetingContext';
import { PeerInfo } from '../../hooks/useWebRTC';
import { useSpeechTranscription } from '../../hooks/useSpeechTranscription';
import { useAuth } from '../../context/AuthContext';
import MeetingInviteDialog from './MeetingInviteDialog';

export type BgMode = 'none' | 'blur' | 'blur-heavy' | 'color-dark' | 'color-space';

interface Props { onLeaveMeeting: () => void; }

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

  useEffect(() => {
    const vid = ref.current;
    if (!vid || !peer.stream) return;
    vid.srcObject = peer.stream;
    vid.play().catch(() => {});
  }, [peer.stream]);

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
      ref={ref}
      autoPlay
      playsInline
      style={{ willChange: 'transform' }}
      className="w-full h-full object-cover"
    />
  );
}

// ─── Screen-share spotlight tile ───────────────────────────────────────────────
// Uses object-contain (not object-cover) so shared screens are never cropped —
// unlike camera tiles, a screen's content (text, slides, code) is unusable if
// half of it gets clipped off to fill a square-ish grid cell.

function ScreenTile({ stream, label }: { stream: MediaStream | null; label: string }) {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const vid = ref.current;
    if (!vid || !stream) return;
    if (vid.srcObject !== stream) vid.srcObject = stream;
    vid.play().catch(() => {});
  }, [stream]);

  return (
    <div className="relative w-full h-full rounded-2xl overflow-hidden bg-black border border-[#3c4043] shadow-lg flex items-center justify-center">
      {stream ? (
        <video ref={ref} autoPlay playsInline muted className="w-full h-full object-contain" />
      ) : (
        <div className="flex flex-col items-center gap-2 text-[#9aa0a6]">
          <ScreenShare className="w-8 h-8 animate-pulse" />
          <span className="text-xs">Connecting…</span>
        </div>
      )}
      <div className="absolute bottom-2 left-2 md:bottom-3 md:left-3 bg-[#111]/80 backdrop-blur-sm px-2 py-1 md:px-3 md:py-1.5 rounded-lg text-[10px] md:text-xs font-semibold text-white flex items-center gap-1.5 shadow-sm">
        <ScreenShare className="w-3 h-3 shrink-0" />{label}
      </div>
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
        {(['chat', 'people', 'transcript'] as const).map(t => (
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

      {tab === 'transcript' && (
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

export default function ActiveMeetingView({ onLeaveMeeting }: Props) {
  const { user, roomId, localStream, peers, isMuted, isVideoOff, isScreenSharing, screenStream, screenPeers, toggleMic, toggleCamera, toggleScreenShare, switchCamera, switchMic, leaveMeeting, chatMessages, sendChatMessage, showInviteDialog, dismissInviteDialog } = useMeeting();
  const { currentUser } = useAuth();
  const displayName = currentUser?.displayName ?? user.name;

  const { isActive: transcribing, isSupported: speechSupported, lines: transcriptLines, keyPoints, start: startTranscription, stop: stopTranscription } = useSpeechTranscription(displayName, peers);

  const [bgMode, setBgMode] = useState<BgMode>('none');
  const [rightTab, setRightTab] = useState<'chat' | 'people' | 'transcript'>('people');
  const [rightOpen, setRightOpen] = useState(() => typeof window !== 'undefined' && window.innerWidth > 768);
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
    window.history.replaceState(null, '', '/'); onLeaveMeeting();
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

  // CRITICAL MOBILE GRID FIX:
  // Forces exactly 2 horizontal rows (50% height each) when 2 people are in the call on mobile.
  const getGridClass = (count: number) => {
    if (count === 1) return 'grid-cols-1 grid-rows-1';

    // For 2 users:
    // Mobile (<sm): 1 column, 2 rows (stacked vertically, each takes 50% height)
    // Desktop (sm+): 2 columns, 1 row (side-by-side)
    if (count === 2) return 'grid-cols-1 grid-rows-2 sm:grid-cols-2 sm:grid-rows-1';

    if (count <= 4) return 'grid-cols-2 grid-rows-2';
    if (count <= 6) return 'grid-cols-2 grid-rows-3 lg:grid-cols-3 lg:grid-rows-2';
    return 'grid-cols-3 grid-rows-auto lg:grid-cols-4 lg:grid-rows-auto';
  };
  const gridClass = getGridClass(tiles.length);

  const meetingContent = (
    <div className="fixed inset-0 z-[9999] flex flex-col lg:flex-row bg-[#111] overflow-hidden select-none text-[#e8eaed]">

      {showInviteDialog && (
        <MeetingInviteDialog onClose={dismissInviteDialog} onAddPeople={handleAddPeople} />
      )}

      {/* ── Left Sidebar (Desktop Transcripts) ─────────────────────────────────── */}
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

      {/* ── Center/Right Wrapper ──────────────────────────────────────────────── */}
      <section className="flex-1 flex flex-col md:flex-row min-w-0 min-h-0 relative h-full">

        {/* VIDEO GRID & CONTROLS */}
        <div className="flex-1 flex flex-col relative min-w-0 min-h-0 bg-[#111]">

          <div className="absolute top-2 left-2 z-10 bg-[#202124]/80 backdrop-blur-md px-3 py-1.5 rounded-lg border border-[#3c4043] flex lg:hidden items-center gap-2 shadow-sm max-w-[55%]">
            <span className="text-[9px] md:text-[10px] text-[#9aa0a6] font-semibold truncate">Code: <span className="text-[#8ab4f8] font-mono ml-1">{roomId}</span></span>
          </div>

          {activeScreens.length > 0 ? (
            <div className="flex-1 min-h-0 p-2 md:p-4 pb-20 md:pb-24 flex flex-col gap-2 md:gap-3">
              {/* Spotlight: the active screen share(s), letterboxed so nothing is cropped off */}
              <div className={`flex-1 min-h-0 grid gap-2 md:gap-3 ${activeScreens.length === 1 ? 'grid-cols-1' : 'grid-cols-2'}`}>
                {activeScreens.map((s) => (
                  <div key={s.id} className="w-full h-full">
                    <ScreenTile stream={s.stream} label={s.id === 'local-screen' ? 'Your screen' : `${s.name}'s screen`} />
                  </div>
                ))}
              </div>
              {/* Camera strip: everyone's camera keeps streaming, unaffected by screen sharing */}
              <div className="h-24 md:h-32 shrink-0 flex gap-2 md:gap-3 overflow-x-auto scrollbar-hide">
                {tiles.map((tile) => {
                  const isLocal = 'isLocal' in tile;
                  const isPresenting = isLocal ? isScreenSharing : sharingPeerIds.has(tile.id);
                  return (
                    <div key={tile.id} className="relative rounded-xl overflow-hidden bg-[#202124] border border-[#3c4043] shadow-lg aspect-video h-full shrink-0">
                      {isLocal ? (
                        <LocalTile stream={localStream} isVideoOff={isVideoOff} name={displayName} bgMode={bgMode} />
                      ) : (
                        <RemoteTile peer={tile as PeerInfo} />
                      )}
                      <div className="absolute bottom-1 left-1 md:bottom-1.5 md:left-1.5 bg-[#111]/70 backdrop-blur-sm px-1.5 py-0.5 rounded-md text-[9px] md:text-[10px] font-semibold text-white max-w-[85%] truncate shadow-sm flex items-center gap-1">
                        {isPresenting && <ScreenShare className="w-2.5 h-2.5 text-[#8ab4f8] shrink-0" />}
                        {tile.name}
                      </div>
                      {isLocal && isMuted && (
                        <div className="absolute top-1 right-1 md:top-1.5 md:right-1.5 bg-[#f28b82]/90 backdrop-blur-sm p-1 rounded-md shadow-sm">
                          <MicOff className="w-3 h-3 text-[#202124]" />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="flex-1 min-h-0 p-2 md:p-4 pb-20 md:pb-24 flex items-center justify-center">
              {/* The wrapper div explicitly limits height to 100% so rows don't push past the screen */}
              <div className={`w-full h-full max-h-full grid gap-2 md:gap-3 ${gridClass}`}>
                {tiles.map((tile) => {
                  const isLocal = 'isLocal' in tile;
                  return (
                    <div key={tile.id} className="relative rounded-2xl overflow-hidden bg-[#202124] border border-[#3c4043] shadow-lg transition-all duration-300 w-full h-full">
                      {isLocal ? (
                        <LocalTile stream={localStream} isVideoOff={isVideoOff} name={displayName} bgMode={bgMode} />
                      ) : (
                        <RemoteTile peer={tile as PeerInfo} />
                      )}
                      <div className="absolute bottom-2 left-2 md:bottom-3 md:left-3 bg-[#111]/70 backdrop-blur-sm px-2 py-1 md:px-3 md:py-1.5 rounded-lg text-[10px] md:text-xs font-semibold text-white max-w-[80%] truncate shadow-sm">
                        {tile.name}
                      </div>
                      {isLocal && isMuted && (
                        <div className="absolute top-2 right-2 md:top-3 md:right-3 bg-[#f28b82]/90 backdrop-blur-sm p-1 md:p-1.5 rounded-lg shadow-sm">
                          <MicOff className="w-3.5 h-3.5 md:w-4 md:h-4 text-[#202124]" />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
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
            <div className="lg:hidden shrink-0">
              <CtrlBtn onClick={() => { setRightTab('transcript'); setRightOpen((v) => !v); }} highlight={rightOpen && rightTab === 'transcript'} title="Transcript">
                 <Activity className="w-4 h-4 md:w-5 md:h-5" />
              </CtrlBtn>
            </div>
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
    <button onClick={onClick} title={title} className={`relative w-9 h-9 md:w-11 md:h-11 flex items-center justify-center rounded-xl transition-all active:scale-90 cursor-pointer shrink-0 ${cls}`}>
      {children}
    </button>
  );
}
