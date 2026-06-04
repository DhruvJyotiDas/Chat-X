import React, { useRef, useEffect, useState } from 'react';
import {
  Mic,
  MicOff,
  Video,
  VideoOff,
  ScreenShare,
  ScreenShareOff,
  PhoneOff,
  Sparkles,
  Volume2,
  AlertTriangle,
  Lightbulb,
  MessageSquare,
  Send,
  X,
  Users,
  Copy,
  Check,
} from 'lucide-react';
import { useMeeting } from '../../context/MeetingContext';
import { PeerInfo } from '../../hooks/useWebRTC';

interface Props {
  onLeaveMeeting: () => void;
}

function LocalVideo({ stream, isVideoOff }: { stream: MediaStream | null; isVideoOff: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current && stream) {
      ref.current.srcObject = stream;
    }
  }, [stream]);

  if (!stream || isVideoOff) {
    return (
      <div className="w-full h-full flex flex-col items-center justify-center bg-[#131313] text-[#8c90a1]">
        <VideoOff className="w-10 h-10 mb-2 stroke-[1.5]" />
        <span className="text-xs font-semibold">Camera Disabled</span>
      </div>
    );
  }
  return <video ref={ref} autoPlay playsInline muted className="w-full h-full object-cover" />;
}

function RemoteVideo({ peer }: { peer: PeerInfo }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current && peer.stream) {
      ref.current.srcObject = peer.stream;
    }
  }, [peer.stream]);

  if (!peer.stream) {
    return (
      <div className="w-full h-full flex flex-col items-center justify-center bg-[#201f1f] text-[#8c90a1]">
        <div className="w-16 h-16 rounded-full bg-[#568dff]/10 flex items-center justify-center mb-2">
          <span className="text-2xl font-bold text-[#b0c6ff]">
            {peer.name.charAt(0).toUpperCase()}
          </span>
        </div>
        <span className="text-xs font-semibold">{peer.name}</span>
        <span className="text-[10px] text-[#8c90a1] mt-1">Connecting...</span>
      </div>
    );
  }
  return <video ref={ref} autoPlay playsInline className="w-full h-full object-cover" />;
}

export default function ActiveMeetingView({ onLeaveMeeting }: Props) {
  const {
    user,
    roomId,
    localStream,
    peers,
    isMuted,
    isVideoOff,
    isScreenSharing,
    toggleMic,
    toggleCamera,
    toggleScreenShare,
    leaveMeeting,
    chatMessages,
    sendChatMessage,
  } = useMeeting();

  const [chatOpen, setChatOpen] = useState(false);
  const [participantsOpen, setParticipantsOpen] = useState(false);
  const [chatInput, setChatInput] = useState('');
  const [codeCopied, setCodeCopied] = useState(false);
  const [langTranslation, setLangTranslation] = useState('EN -> FR');
  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages]);

  const handleLeave = () => {
    leaveMeeting();
    onLeaveMeeting();
  };

  const handleSendChat = () => {
    if (!chatInput.trim()) return;
    sendChatMessage(chatInput.trim());
    setChatInput('');
  };

  const handleChatKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendChat();
    }
  };

  const copyRoomCode = () => {
    if (!roomId) return;
    navigator.clipboard.writeText(roomId).then(() => {
      setCodeCopied(true);
      setTimeout(() => setCodeCopied(false), 2000);
    });
  };

  // Build tile list: remote peers + local user
  const allTiles = [
    ...peers,
    { id: user.id, name: `You (${user.name})`, isLocal: true as const },
  ];

  return (
    <div className="flex-1 flex overflow-hidden h-full bg-[#0e0e0e] select-none">

      {/* Left Pane: Live Transcript */}
      <section className="w-80 flex-shrink-0 flex flex-col border-r border-[#424655] bg-[#131313]/55 backdrop-blur-md">
        <div className="p-4 border-b border-[#424655]/50 flex justify-between items-center bg-[#1c1b1b]/50">
          <h2 className="font-semibold text-xs text-[#e5e2e1] uppercase tracking-wider">Live Transcript</h2>
          <select
            className="text-[10px] bg-[#201f1f] border border-[#424655] rounded px-1.5 py-0.5 text-[#b0c6ff] outline-none font-bold"
            value={langTranslation}
            onChange={(e) => setLangTranslation(e.target.value)}
          >
            <option>EN -{'>'} FR</option>
            <option>EN -{'>'} ES</option>
            <option>EN -{'>'} DE</option>
          </select>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4 text-xs">
          {roomId && (
            <div className="bg-[#201f1f] border border-[#424655]/60 rounded-xl p-3 flex items-center justify-between gap-2">
              <div>
                <p className="text-[9px] text-[#8c90a1] uppercase font-bold tracking-wider mb-0.5">Meeting Code</p>
                <p className="font-mono font-bold text-[#b0c6ff] text-xs">{roomId}</p>
              </div>
              <button
                onClick={copyRoomCode}
                className="flex items-center gap-1 bg-[#568dff]/10 text-[#b0c6ff] border border-[#568dff]/30 px-2 py-1 rounded-lg text-[10px] font-bold hover:bg-[#568dff]/20 cursor-pointer transition-colors"
              >
                {codeCopied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                {codeCopied ? 'Copied' : 'Copy'}
              </button>
            </div>
          )}

          <div className="flex flex-col gap-1.5 relative pl-3 border-l-2 border-[#8083ff]">
            <span className="text-[10px] font-black tracking-widest text-[#c0c1ff] flex items-center gap-1">
              <Sparkles className="w-3.5 h-3.5 animate-pulse" />
              INTELLIGENCE AGENT
            </span>
            <div className="bg-[#201f1f] border border-[#424655]/65 p-3 rounded-r-xl rounded-bl-xl text-[#c2c6d8] leading-relaxed">
              {peers.length === 0
                ? 'Waiting for participants to join. Share the meeting code above.'
                : `${peers.length + 1} participant${peers.length > 0 ? 's' : ''} in this session. AI transcript active.`}
            </div>
          </div>

          {chatMessages.length > 0 && (
            <div className="space-y-3">
              <p className="text-[9px] font-bold uppercase tracking-widest text-[#8c90a1]">Recent Messages</p>
              {chatMessages.slice(-3).map((msg) => (
                <div key={msg.id} className="flex gap-2">
                  <div className="w-6 h-6 rounded-full bg-[#568dff]/20 flex items-center justify-center shrink-0 mt-0.5">
                    <span className="text-[9px] font-bold text-[#b0c6ff]">
                      {msg.fromName.charAt(0).toUpperCase()}
                    </span>
                  </div>
                  <div>
                    <span className="font-semibold text-[#e5e2e1]">{msg.fromName}</span>
                    <span className="text-[#8c90a1] ml-1 text-[9px]">{msg.time}</span>
                    <div className="bg-[#2a2a2a] p-2 rounded-r-xl rounded-bl-xl text-[#e5e2e1] leading-relaxed mt-0.5">
                      {msg.text}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* Center: Video Grid */}
      <section className="flex-1 flex flex-col relative bg-[#131313]/10">

        {/* Dynamic video grid */}
        <div
          className={`flex-1 p-4 grid gap-4 pb-24 ${
            allTiles.length <= 1
              ? 'grid-cols-1'
              : allTiles.length <= 2
              ? 'grid-cols-2'
              : allTiles.length <= 4
              ? 'grid-cols-2 grid-rows-2'
              : 'grid-cols-3'
          }`}
        >
          {allTiles.map((tile) => {
            const isLocal = 'isLocal' in tile;
            return (
              <div
                key={tile.id}
                className="relative rounded-xl overflow-hidden bg-[#201f1f] border border-[#424655] shadow-md"
              >
                {isLocal ? (
                  <LocalVideo stream={localStream} isVideoOff={isVideoOff} />
                ) : (
                  <RemoteVideo peer={tile as PeerInfo} />
                )}

                <div className="absolute top-3 left-3 bg-[#131313]/85 backdrop-blur-md px-2.5 py-1.5 rounded-lg flex items-center gap-2 border border-[#424655]/50">
                  <span className="text-xs font-semibold text-[#e5e2e1]">{tile.name}</span>
                </div>

                {isLocal && isMuted && (
                  <div className="absolute bottom-3 right-3 bg-[#131313]/85 backdrop-blur-md p-1.5 rounded-lg border border-[#ffb4ab]/30">
                    <MicOff className="w-3.5 h-3.5 text-[#ffb4ab]" />
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Floating Controls Bar */}
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 bg-[#131313]/90 backdrop-blur-xl border border-[#424655] p-2.5 rounded-2xl shadow-xl flex items-center gap-2 z-10">
          <button
            onClick={toggleMic}
            title={isMuted ? 'Unmute' : 'Mute'}
            className={`w-12 h-12 flex items-center justify-center rounded-xl transition-colors cursor-pointer ${
              !isMuted
                ? 'bg-[#1c1b1b] text-[#e5e2e1] hover:bg-[#201f1f]'
                : 'bg-[#93000a]/20 text-[#ffb4ab] border border-[#ffb4ab]/20'
            }`}
          >
            {!isMuted ? <Mic className="w-5 h-5" /> : <MicOff className="w-5 h-5" />}
          </button>

          <button
            onClick={toggleCamera}
            title={isVideoOff ? 'Start camera' : 'Stop camera'}
            className={`w-12 h-12 flex items-center justify-center rounded-xl transition-colors cursor-pointer ${
              !isVideoOff
                ? 'bg-[#1c1b1b] text-[#e5e2e1] hover:bg-[#201f1f]'
                : 'bg-[#93000a]/20 text-[#ffb4ab] border border-[#ffb4ab]/20'
            }`}
          >
            {!isVideoOff ? <Video className="w-5 h-5" /> : <VideoOff className="w-5 h-5" />}
          </button>

          <button
            onClick={() => toggleScreenShare()}
            title={isScreenSharing ? 'Stop sharing' : 'Share screen'}
            className={`w-12 h-12 flex items-center justify-center rounded-xl transition-colors cursor-pointer ${
              isScreenSharing
                ? 'bg-[#568dff]/20 text-[#b0c6ff] border border-[#568dff]/30'
                : 'bg-[#1c1b1b] text-[#e5e2e1] hover:bg-[#201f1f]'
            }`}
          >
            {isScreenSharing ? <ScreenShareOff className="w-5 h-5" /> : <ScreenShare className="w-5 h-5" />}
          </button>

          <div className="w-[1px] h-8 bg-[#424655] mx-1" />

          <button
            onClick={() => { setChatOpen((v) => !v); setParticipantsOpen(false); }}
            title="Chat"
            className={`w-12 h-12 flex items-center justify-center rounded-xl transition-colors cursor-pointer relative ${
              chatOpen ? 'bg-[#568dff]/20 text-[#b0c6ff] border border-[#568dff]/30' : 'bg-[#1c1b1b] text-[#e5e2e1] hover:bg-[#201f1f]'
            }`}
          >
            <MessageSquare className="w-5 h-5" />
            {chatMessages.length > 0 && !chatOpen && (
              <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-[#ffb4ab]" />
            )}
          </button>

          <button
            onClick={() => { setParticipantsOpen((v) => !v); setChatOpen(false); }}
            title="Participants"
            className={`w-12 h-12 flex items-center justify-center rounded-xl transition-colors cursor-pointer ${
              participantsOpen ? 'bg-[#568dff]/20 text-[#b0c6ff] border border-[#568dff]/30' : 'bg-[#1c1b1b] text-[#e5e2e1] hover:bg-[#201f1f]'
            }`}
          >
            <Users className="w-5 h-5" />
          </button>

          <div className="w-[1px] h-8 bg-[#424655] mx-1" />

          <button
            onClick={handleLeave}
            title="Leave call"
            className="px-5 h-12 flex items-center justify-center rounded-xl bg-[#ffb4ab]/15 text-[#ffb4ab] hover:bg-[#ffb4ab]/25 hover:text-white transition-colors font-bold text-xs gap-1.5 cursor-pointer border border-[#ffb4ab]/25"
          >
            <PhoneOff className="w-4 h-4" />
            <span>Leave</span>
          </button>
        </div>

        {/* Chat Sidebar */}
        {chatOpen && (
          <div className="absolute bottom-24 right-4 w-80 bg-[#131313]/95 backdrop-blur-xl border border-[#424655] rounded-2xl shadow-2xl flex flex-col z-20 overflow-hidden" style={{ height: 420 }}>
            <div className="p-3 border-b border-[#424655]/50 flex justify-between items-center">
              <span className="font-semibold text-xs text-[#e5e2e1]">In-Meeting Chat</span>
              <button onClick={() => setChatOpen(false)} className="text-[#8c90a1] hover:text-[#ffb4ab] cursor-pointer">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-3 space-y-3">
              {chatMessages.length === 0 && (
                <p className="text-[11px] text-[#8c90a1] text-center mt-8">No messages yet. Say hello!</p>
              )}
              {chatMessages.map((msg) => (
                <div key={msg.id} className={`flex flex-col gap-0.5 ${msg.isSelf ? 'items-end' : 'items-start'}`}>
                  <span className="text-[9px] text-[#8c90a1]">{msg.fromName} · {msg.time}</span>
                  <div className={`px-3 py-2 rounded-xl text-xs max-w-[85%] ${
                    msg.isSelf
                      ? 'bg-[#568dff] text-[#002661] rounded-tr-sm'
                      : 'bg-[#201f1f] text-[#e5e2e1] border border-[#424655]/40 rounded-tl-sm'
                  }`}>
                    {msg.text}
                  </div>
                </div>
              ))}
              <div ref={chatEndRef} />
            </div>
            <div className="p-3 border-t border-[#424655]/40 flex gap-2">
              <input
                type="text"
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={handleChatKey}
                placeholder="Message..."
                className="flex-1 bg-[#201f1f] border border-[#424655] rounded-lg px-3 py-2 text-xs text-[#e5e2e1] placeholder-[#8c90a1]/60 focus:border-[#568dff] outline-none"
              />
              <button
                onClick={handleSendChat}
                className="w-8 h-8 bg-[#568dff] text-[#002661] rounded-lg flex items-center justify-center hover:bg-[#568dff]/90 cursor-pointer"
              >
                <Send className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        )}

        {/* Participants Sidebar */}
        {participantsOpen && (
          <div className="absolute bottom-24 right-4 w-72 bg-[#131313]/95 backdrop-blur-xl border border-[#424655] rounded-2xl shadow-2xl flex flex-col z-20 overflow-hidden">
            <div className="p-3 border-b border-[#424655]/50 flex justify-between items-center">
              <span className="font-semibold text-xs text-[#e5e2e1]">
                Participants ({peers.length + 1})
              </span>
              <button onClick={() => setParticipantsOpen(false)} className="text-[#8c90a1] hover:text-[#ffb4ab] cursor-pointer">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-3 space-y-2">
              {/* Local user */}
              <div className="flex items-center gap-3 p-2 rounded-lg bg-[#201f1f]/50">
                <div className="w-8 h-8 rounded-full bg-[#568dff]/20 flex items-center justify-center">
                  <span className="text-xs font-bold text-[#b0c6ff]">
                    {user.name.charAt(0).toUpperCase()}
                  </span>
                </div>
                <div className="flex-1">
                  <p className="text-xs font-semibold text-[#e5e2e1]">You ({user.name})</p>
                  <p className="text-[10px] text-[#70ffba]">Host</p>
                </div>
                {isMuted && <MicOff className="w-3.5 h-3.5 text-[#ffb4ab]" />}
              </div>
              {/* Remote peers */}
              {peers.map((peer) => (
                <div key={peer.id} className="flex items-center gap-3 p-2 rounded-lg hover:bg-[#201f1f]/50">
                  <div className="w-8 h-8 rounded-full bg-[#c0c1ff]/10 flex items-center justify-center">
                    <span className="text-xs font-bold text-[#c0c1ff]">
                      {peer.name.charAt(0).toUpperCase()}
                    </span>
                  </div>
                  <div className="flex-1">
                    <p className="text-xs font-semibold text-[#e5e2e1]">{peer.name}</p>
                    <p className="text-[10px] text-[#8c90a1]">
                      {peer.stream ? 'Connected' : 'Connecting...'}
                    </p>
                  </div>
                </div>
              ))}
              {peers.length === 0 && (
                <p className="text-[11px] text-[#8c90a1] text-center py-4">
                  Share the meeting code to invite others.
                </p>
              )}
            </div>
          </div>
        )}
      </section>

      {/* Right Pane: Intelligence Panel */}
      <section className="w-80 flex-shrink-0 flex flex-col border-l border-[#424655] bg-[#1c1b1b]">
        <div className="p-4 border-b border-[#424655]/50 flex justify-between items-center bg-[#1c1b1b]/50">
          <h2 className="font-semibold text-xs text-[#e5e2e1] uppercase tracking-wider">Active Intelligence</h2>
          <Sparkles className="w-4 h-4 text-[#b0c6ff]" />
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          <div className="text-[10px] font-bold tracking-wider text-[#8c90a1] uppercase">Session Info</div>

          <div className="bg-[#131313] border border-[#424655]/60 rounded-xl p-4">
            <div className="flex justify-between items-center mb-2">
              <span className="text-[10px] font-bold text-[#8c90a1] uppercase tracking-wider">Status</span>
              <span className="text-[10px] bg-[#00e598]/10 text-[#70ffba] border border-[#00e296]/20 px-2 py-0.5 rounded font-black tracking-wider animate-pulse">
                LIVE
              </span>
            </div>
            <p className="text-xs text-[#c2c6d8]">
              {peers.length === 0
                ? 'You are alone. Share the code to invite participants.'
                : `${peers.length + 1} participants connected via WebRTC mesh.`}
            </p>
          </div>

          <div className="bg-[#201f1f]/50 p-4 border border-[#424655]/30 rounded-xl flex items-start gap-2.5">
            <Lightbulb className="w-4 h-4 text-[#70ffba] shrink-0 mt-0.5" />
            <div className="flex flex-col gap-0.5">
              <span className="text-[10px] font-black uppercase text-[#70ffba] tracking-wider">AI Insight</span>
              <p className="text-[11px] text-[#c2c6d8] leading-relaxed">
                {isScreenSharing
                  ? 'Screen sharing active. Participants can see your screen.'
                  : isMuted
                  ? 'Your microphone is muted. Click the mic button to unmute.'
                  : 'End-to-end encrypted WebRTC session. Audio and video are peer-to-peer.'}
              </p>
            </div>
          </div>

          {/* Volume indicator */}
          <div className="bg-[#131313] border border-[#424655]/60 rounded-xl p-4">
            <div className="flex items-center gap-2 mb-2">
              <Volume2 className="w-3.5 h-3.5 text-[#b0c6ff]" />
              <span className="text-[10px] font-bold text-[#8c90a1] uppercase tracking-wider">Mic Status</span>
            </div>
            <div className="flex items-center gap-2">
              <div className={`w-2 h-2 rounded-full ${isMuted ? 'bg-[#ffb4ab]' : 'bg-[#70ffba] animate-pulse'}`} />
              <span className="text-xs text-[#c2c6d8]">{isMuted ? 'Muted' : 'Live — microphone active'}</span>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
