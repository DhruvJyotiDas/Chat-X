import React, { useEffect, useRef, useState } from 'react';
import { Mic, MicOff, Video, VideoOff, Loader2, Activity, AlertTriangle, X } from 'lucide-react';
import BrandMark from '../BrandMark';
import { describeMediaError } from '../../lib/mediaErrors';
import { loadDevicePrefs, deviceConstraint, restoreSpeaker } from '../../lib/devicePrefs';
import { useSilentMic } from '../../hooks/useSilentMic';
import ConnectionTestPanel from './ConnectionTestPanel';

interface Props {
  roomCode: string;
  /** Prefilled when we already know who this is (signed-in user rejoining a link). */
  initialName?: string;
  /** Hide the name field entirely for signed-in users — they can't rename themselves here. */
  nameEditable?: boolean;
  error?: string | null;
  onJoin: (name: string, opts: { muted: boolean; videoOff: boolean }) => void;
  onSignIn?: () => void;
}

/**
 * Meet-style lobby shown before entering a room. Its real job is letting someone
 * with nothing but a share link get into the call by typing a name — no account,
 * no OIDC round trip. It also doubles as the confirm step for signed-in users
 * arriving via a link, which is why the name field can be locked.
 *
 * The camera preview is deliberately its own getUserMedia call, torn down on
 * unmount: the meeting's own stream is acquired later by useWebRTC.initMedia(),
 * and holding two live camera handles at once makes some webcams fail to open.
 */
export default function PreJoinScreen({ roomCode, initialName, nameEditable = true, error, onJoin, onSignIn }: Props) {
  const [name, setName] = useState(initialName ?? '');
  const [muted, setMuted] = useState(false);
  const [videoOff, setVideoOff] = useState(false);
  const [joining, setJoining] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [testOpen, setTestOpen] = useState(false);
  // Held in state as well as the ref so the silent-mic hook re-runs when it arrives.
  const [previewStream, setPreviewStream] = useState<MediaStream | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  // Catching a dead microphone here rather than mid-call is the whole value of a
  // lobby: the user is already looking at their own preview and expecting to adjust
  // something, so a warning now costs them nothing.
  const silentMic = useSilentMic(previewStream, !muted);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Request BOTH devices here, not just the camera. The lobby used to ask
        // for video only, so the microphone was first prompted for by
        // initMedia() *after* the user pressed Join — a second permission
        // dialog appearing once they thought they were already in the call.
        // Settling both up front is what Meet and Zoom do.
        // Open the devices this browser used last time, so the preview shows the
        // headset the user expects rather than whatever enumerated first. `ideal`
        // rather than `exact` — see deviceConstraint.
        const saved = loadDevicePrefs();
        void restoreSpeaker();
        const stream = await navigator.mediaDevices.getUserMedia({
          video: deviceConstraint(saved.cameraId),
          audio: deviceConstraint(saved.micId),
        });
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        setPreviewStream(stream);
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.play().catch(() => {});
        }
      } catch (err) {
        // Fall back to audio-only so a blocked camera still gets the mic
        // permission settled here rather than mid-join.
        try {
          const audioOnly = await navigator.mediaDevices.getUserMedia({ audio: deviceConstraint(loadDevicePrefs().micId) });
          if (cancelled) { audioOnly.getTracks().forEach((t) => t.stop()); return; }
          streamRef.current = audioOnly;
          setPreviewStream(audioOnly);
          if (!cancelled) setPreviewError(describeMediaError(err, 'camera'));
        } catch {
          if (!cancelled) setPreviewError(`${describeMediaError(err, 'camera and microphone')} You can still join.`);
        }
      }
    })();
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      setPreviewStream(null);
    };
  }, []);

  // Mirror the toggles onto the preview so the buttons visibly do something.
  useEffect(() => {
    streamRef.current?.getVideoTracks().forEach((t) => { t.enabled = !videoOff; });
  }, [videoOff]);

  // The preview stream now carries audio too (see above), so the mute button has
  // something real to act on. The <video> is muted, so this never causes feedback.
  useEffect(() => {
    streamRef.current?.getAudioTracks().forEach((t) => { t.enabled = !muted; });
  }, [muted]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || joining) return;
    setJoining(true);
    // Release the preview camera before the meeting grabs its own handle.
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setPreviewStream(null);
    onJoin(trimmed, { muted, videoOff });
  };

  return (
    <div className="min-h-screen bg-[#111] text-[#e8eaed] flex flex-col items-center justify-center p-4 gap-6">
      <div className="flex items-center gap-2.5">
        <div className="w-9 h-9 rounded-xl bg-[#0066FF] flex items-center justify-center shadow-[0_0_24px_rgba(0,102,255,0.35)]">
          <BrandMark className="w-5 h-5" />
        </div>
        <span className="font-bold text-lg">IB Connect</span>
      </div>

      <div className="w-full max-w-4xl grid md:grid-cols-[1.4fr_1fr] gap-6 items-center">
        {/* Camera preview */}
        <div className="relative rounded-2xl overflow-hidden bg-[#202124] border border-[#3c4043] aspect-video shadow-2xl">
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className={`w-full h-full object-cover transition-opacity ${videoOff ? 'opacity-0' : 'opacity-100'}`}
          />
          {(videoOff || previewError) && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
              <div className="w-16 h-16 rounded-full bg-[#8ab4f8]/15 border border-[#8ab4f8]/30 flex items-center justify-center">
                <span className="text-2xl font-bold text-[#8ab4f8]">
                  {(name.trim() || '?').charAt(0).toUpperCase()}
                </span>
              </div>
              <span className="text-xs text-[#9aa0a6]">{previewError ?? 'Camera is off'}</span>
            </div>
          )}

          <div className="absolute bottom-3 left-1/2 -translate-x-1/2 flex items-center gap-2">
            <button
              type="button"
              onClick={() => setMuted((m) => !m)}
              aria-label={muted ? 'Unmute microphone' : 'Mute microphone'}
              className={`w-11 h-11 rounded-full flex items-center justify-center transition-colors cursor-pointer shadow-lg ${muted ? 'bg-[#f28b82] text-[#202124]' : 'bg-[#202124]/90 text-white border border-[#5f6368]/50 hover:bg-[#3c4043]'}`}
            >
              {muted ? <MicOff className="w-5 h-5" /> : <Mic className="w-5 h-5" />}
            </button>
            <button
              type="button"
              onClick={() => setVideoOff((v) => !v)}
              aria-label={videoOff ? 'Turn camera on' : 'Turn camera off'}
              className={`w-11 h-11 rounded-full flex items-center justify-center transition-colors cursor-pointer shadow-lg ${videoOff ? 'bg-[#f28b82] text-[#202124]' : 'bg-[#202124]/90 text-white border border-[#5f6368]/50 hover:bg-[#3c4043]'}`}
            >
              {videoOff ? <VideoOff className="w-5 h-5" /> : <Video className="w-5 h-5" />}
            </button>
          </div>
        </div>

        {/* Join panel */}
        <form onSubmit={submit} className="flex flex-col gap-4 text-center md:text-left">
          <div>
            <h1 className="text-2xl font-semibold">Ready to join?</h1>
            <p className="text-xs text-[#9aa0a6] mt-1.5">
              Meeting code <span className="font-mono font-bold text-[#8ab4f8]">{roomCode}</span>
            </p>
          </div>

          {nameEditable && (
            <input
              autoFocus
              type="text"
              value={name}
              maxLength={32}
              onChange={(e) => setName(e.target.value)}
              placeholder="Your name"
              aria-label="Your name"
              className="w-full px-4 py-3 bg-[#202124] border border-[#5f6368] rounded-xl text-sm text-[#e8eaed] placeholder-[#9aa0a6]/60 focus:border-[#8ab4f8] focus:ring-1 focus:ring-[#8ab4f8] outline-none transition-all"
            />
          )}

          {error && (
            <p className="text-xs text-[#f28b82] bg-[#f28b82]/10 border border-[#f28b82]/30 rounded-lg px-3 py-2">
              {error}
            </p>
          )}

          {/* Not styled as an error: nothing has failed as far as the browser is
              concerned, which is precisely why it needs saying out loud. */}
          {silentMic.status === 'silent' && (
            <div className="flex items-start gap-2 text-left text-[11px] text-[#f8e7bd] bg-[#fdd663]/10 border border-[#fdd663]/30 rounded-lg px-3 py-2">
              <AlertTriangle className="w-3.5 h-3.5 text-[#fdd663] shrink-0 mt-0.5" />
              <span className="flex-1 leading-relaxed">
                Your microphone isn't picking up any sound. Check it isn't muted by a switch on
                your headset or in your system settings.
              </span>
              <button
                type="button"
                onClick={silentMic.dismiss}
                className="shrink-0 text-[#f8e7bd]/60 hover:text-white cursor-pointer"
                aria-label="Dismiss microphone warning"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          )}

          <button
            type="submit"
            disabled={!name.trim() || joining}
            className="w-full py-3 bg-[#8ab4f8] text-[#202124] rounded-xl text-sm font-bold hover:bg-[#aecbfa] disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-colors flex items-center justify-center gap-2"
          >
            {joining && <Loader2 className="w-4 h-4 animate-spin" />}
            {joining ? 'Joining…' : 'Join now'}
          </button>

          <button
            type="button"
            onClick={() => setTestOpen(true)}
            className="flex items-center justify-center gap-1.5 text-[11px] text-[#9aa0a6] hover:text-[#8ab4f8] cursor-pointer transition-colors"
          >
            <Activity className="w-3.5 h-3.5" />
            Having trouble? Test your connection
          </button>

          {onSignIn && (
            <p className="text-[11px] text-[#9aa0a6]">
              Have an IB account?{' '}
              <button type="button" onClick={onSignIn} className="text-[#8ab4f8] hover:underline cursor-pointer font-semibold">
                Sign in instead
              </button>
            </p>
          )}
        </form>
      </div>

      {testOpen && <ConnectionTestPanel onClose={() => setTestOpen(false)} />}
    </div>
  );
}
