import { useState, useEffect, useRef, useCallback } from 'react';
import { SignalingSocket } from '../lib/signalingSocket';

const TURN_HOST = 'meet.icebrkr.space';
const TURN_USER = 'webrtc';
const TURN_PASS = 'webrtc123';

const ICE_SERVERS: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: `turn:${TURN_HOST}:3478`, username: TURN_USER, credential: TURN_PASS },
    { urls: `turn:${TURN_HOST}:3478?transport=tcp`, username: TURN_USER, credential: TURN_PASS },
    { urls: `turns:${TURN_HOST}:5349`, username: TURN_USER, credential: TURN_PASS },
  ],
};

export interface PeerInfo {
  id: string;
  name: string;
  stream: MediaStream | null;
}

export function useWebRTC(socket: SignalingSocket | null) {
  // Always-current ref — avoids stale-closure issues in async callbacks
  const socketRef = useRef<SignalingSocket | null>(null);
  useEffect(() => {
    socketRef.current = socket;
  }, [socket]);

  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [peers, setPeers] = useState<PeerInfo[]>([]);
  const [isMuted, setIsMuted] = useState(false);
  const [isVideoOff, setIsVideoOff] = useState(false);
  const [isScreenSharing, setIsScreenSharing] = useState(false);

  const pcsRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const localStreamRef = useRef<MediaStream | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);

  const initMedia = useCallback(async (): Promise<MediaStream | null> => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      localStreamRef.current = stream;
      setLocalStream(stream);
      return stream;
    } catch {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        localStreamRef.current = stream;
        setLocalStream(stream);
        setIsVideoOff(true);
        return stream;
      } catch {
        console.warn('[WebRTC] No media access — continuing without local stream');
        return null;
      }
    }
  }, []);

  const makePeerConnection = useCallback((peerId: string): RTCPeerConnection => {
    const pc = new RTCPeerConnection(ICE_SERVERS);

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => {
        pc.addTrack(track, localStreamRef.current!);
      });
    }

    pc.ontrack = (event) => {
      const remoteStream = event.streams[0];
      setPeers((prev) =>
        prev.map((p) => (p.id === peerId ? { ...p, stream: remoteStream } : p))
      );
    };

    pc.onicecandidate = (event) => {
      if (event.candidate && socketRef.current) {
        socketRef.current.send('ice_candidate', { to: peerId, candidate: event.candidate });
      }
    };

    pcsRef.current.set(peerId, pc);
    return pc;
  }, []);

  const createOfferFor = useCallback(async (peerId: string) => {
    const sock = socketRef.current;
    if (!sock) return;
    const pc = makePeerConnection(peerId);
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      sock.send('offer', { to: peerId, sdp: offer });
    } catch (err) {
      console.error('[WebRTC] createOffer error', err);
    }
  }, [makePeerConnection]);

  const handleOffer = useCallback(async (fromId: string, sdp: RTCSessionDescriptionInit) => {
    const sock = socketRef.current;
    if (!sock) return;
    let pc = pcsRef.current.get(fromId);
    if (!pc) pc = makePeerConnection(fromId);
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sock.send('answer', { to: fromId, sdp: answer });
    } catch (err) {
      console.error('[WebRTC] handleOffer error', err);
    }
  }, [makePeerConnection]);

  const handleAnswer = useCallback(async (fromId: string, sdp: RTCSessionDescriptionInit) => {
    const pc = pcsRef.current.get(fromId);
    if (!pc) return;
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    } catch (err) {
      console.error('[WebRTC] handleAnswer error', err);
    }
  }, []);

  const handleIceCandidate = useCallback(async (fromId: string, candidate: RTCIceCandidateInit) => {
    const pc = pcsRef.current.get(fromId);
    if (!pc) return;
    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
      console.error('[WebRTC] addIceCandidate error', err);
    }
  }, []);

  // Wire socket events
  useEffect(() => {
    if (!socket) return;

    const unsubs = [
      socket.on('peer_joined', (payload) => {
        const { peer_id, peer_name } = payload as { peer_id: string; peer_name: string };
        setPeers((prev) => {
          if (prev.find((p) => p.id === peer_id)) return prev;
          return [...prev, { id: peer_id, name: peer_name, stream: null }];
        });
      }),

      socket.on('peer_left', (payload) => {
        const { peer_id } = payload as { peer_id: string };
        const pc = pcsRef.current.get(peer_id);
        if (pc) { pc.close(); pcsRef.current.delete(peer_id); }
        setPeers((prev) => prev.filter((p) => p.id !== peer_id));
      }),

      socket.on('offer', (payload) => {
        const { from, sdp } = payload as { from: string; sdp: RTCSessionDescriptionInit };
        setPeers((prev) => {
          if (prev.find((p) => p.id === from)) return prev;
          return [...prev, { id: from, name: from, stream: null }];
        });
        handleOffer(from, sdp);
      }),

      socket.on('answer', (payload) => {
        const { from, sdp } = payload as { from: string; sdp: RTCSessionDescriptionInit };
        handleAnswer(from, sdp);
      }),

      socket.on('ice_candidate', (payload) => {
        const { from, candidate } = payload as { from: string; candidate: RTCIceCandidateInit };
        handleIceCandidate(from, candidate);
      }),
    ];

    return () => unsubs.forEach((u) => u());
  }, [socket, handleOffer, handleAnswer, handleIceCandidate]);

  const toggleMic = useCallback(() => {
    if (!localStreamRef.current) return;
    localStreamRef.current.getAudioTracks().forEach((t) => { t.enabled = !t.enabled; });
    setIsMuted((prev) => !prev);
  }, []);

  const toggleCamera = useCallback(() => {
    if (!localStreamRef.current) return;
    localStreamRef.current.getVideoTracks().forEach((t) => { t.enabled = !t.enabled; });
    setIsVideoOff((prev) => !prev);
  }, []);

  const toggleScreenShare = useCallback(async () => {
    if (isScreenSharing) {
      screenStreamRef.current?.getTracks().forEach((t) => t.stop());
      screenStreamRef.current = null;
      const camTrack = localStreamRef.current?.getVideoTracks()[0];
      if (camTrack) {
        pcsRef.current.forEach((pc) => {
          const sender = pc.getSenders().find((s) => s.track?.kind === 'video');
          sender?.replaceTrack(camTrack);
        });
      }
      setIsScreenSharing(false);
    } else {
      try {
        const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
        screenStreamRef.current = screenStream;
        const screenTrack = screenStream.getVideoTracks()[0];
        pcsRef.current.forEach((pc) => {
          const sender = pc.getSenders().find((s) => s.track?.kind === 'video');
          sender?.replaceTrack(screenTrack);
        });
        screenTrack.onended = () => {
          setIsScreenSharing(false);
          screenStreamRef.current = null;
          const camTrack = localStreamRef.current?.getVideoTracks()[0];
          if (camTrack) {
            pcsRef.current.forEach((pc) => {
              const sender = pc.getSenders().find((s) => s.track?.kind === 'video');
              sender?.replaceTrack(camTrack);
            });
          }
        };
        setIsScreenSharing(true);
      } catch (err) {
        console.error('[WebRTC] screen share error', err);
      }
    }
  }, [isScreenSharing]);

  const cleanup = useCallback(() => {
    pcsRef.current.forEach((pc) => pc.close());
    pcsRef.current.clear();
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    screenStreamRef.current?.getTracks().forEach((t) => t.stop());
    localStreamRef.current = null;
    screenStreamRef.current = null;
    setLocalStream(null);
    setPeers([]);
    setIsMuted(false);
    setIsVideoOff(false);
    setIsScreenSharing(false);
  }, []);

  return {
    localStream,
    peers,
    isMuted,
    isVideoOff,
    isScreenSharing,
    initMedia,
    createOfferFor,
    toggleMic,
    toggleCamera,
    toggleScreenShare,
    cleanup,
  };
}
