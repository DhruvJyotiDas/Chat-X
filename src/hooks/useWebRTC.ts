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

const getFallbackName = (id: string) => {
  const cleanId = id.replace('user-', '').replace('tmp-', '');
  return `Guest (${cleanId.slice(0, 4).toUpperCase()})`;
};

export function useWebRTC(socket: SignalingSocket | null) {
  const socketRef = useRef<SignalingSocket | null>(null);
  useEffect(() => { socketRef.current = socket; }, [socket]);

  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [peers, setPeers] = useState<PeerInfo[]>([]);
  const [isMuted, setIsMuted] = useState(false);
  const [isVideoOff, setIsVideoOff] = useState(false);
  const [isScreenSharing, setIsScreenSharing] = useState(false);

  const pcsRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  
  const peerNamesRef = useRef<Map<string, string>>(new Map());
  const iceQueueRef = useRef<Map<string, RTCIceCandidateInit[]>>(new Map());

  // ─── NAME REGISTRY FIX ──────────────────────────────────────────────────
  const registerPeerName = useCallback((peerId: string, peerName: string) => {
    if (!peerName || !peerName.trim()) return;
    peerNamesRef.current.set(peerId, peerName);
    setPeers((prev) => {
      const existing = prev.find((p) => p.id === peerId);
      if (existing && existing.name !== peerName) {
        return prev.map((p) => (p.id === peerId ? { ...p, name: peerName } : p));
      }
      return prev;
    });
  }, []);

  const initMedia = useCallback(async (): Promise<MediaStream | null> => {
    if (cameraStreamRef.current) {
      setLocalStream(cameraStreamRef.current);
      return cameraStreamRef.current;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      cameraStreamRef.current = stream;
      setLocalStream(stream);
      return stream;
    } catch {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        cameraStreamRef.current = stream;
        setLocalStream(stream);
        setIsVideoOff(true);
        return stream;
      } catch {
        return null;
      }
    }
  }, []);

  const drainIceCandidates = useCallback(async (peerId: string, pc: RTCPeerConnection) => {
    const queue = iceQueueRef.current.get(peerId) ?? [];
    iceQueueRef.current.delete(peerId);
    for (const candidate of queue) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (err) {}
    }
  }, []);

  const attachTracksToConnection = useCallback((pc: RTCPeerConnection) => {
    const streamToShare = screenStreamRef.current || cameraStreamRef.current;
    if (!streamToShare) return;

    streamToShare.getTracks().forEach((track) => {
      const alreadyAttached = pc.getSenders().find((s) => s.track?.id === track.id);
      if (!alreadyAttached) {
        try { pc.addTrack(track, streamToShare); } catch (e) {}
      }
    });
  }, []);

  const getOrCreatePeerConnection = useCallback((peerId: string): RTCPeerConnection => {
    let pc = pcsRef.current.get(peerId);
    if (pc) return pc;

    pc = new RTCPeerConnection(ICE_SERVERS);
    pcsRef.current.set(peerId, pc);

    attachTracksToConnection(pc);

    pc.ontrack = (event) => {
      const remoteStream = event.streams[0];
      if (!remoteStream) return;

      remoteStream.getTracks().forEach(t => t.enabled = true);

      const resolvedName = peerNamesRef.current.get(peerId) || getFallbackName(peerId);

      setPeers((prev) => {
        const existing = prev.find((p) => p.id === peerId);
        if (existing) {
          return prev.map((p) => (p.id === peerId ? { ...p, stream: remoteStream, name: resolvedName } : p));
        }
        return [...prev, { id: peerId, name: resolvedName, stream: remoteStream }];
      });
    };

    pc.onicecandidate = (event) => {
      if (event.candidate && socketRef.current) {
        socketRef.current.send('ice_candidate', { to: peerId, candidate: event.candidate });
      }
    };

    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'failed') pc.restartIce();
    };

    return pc;
  }, [attachTracksToConnection]);

  const createOfferFor = useCallback(async (peerId: string) => {
    if (!cameraStreamRef.current) await initMedia();
    const pc = getOrCreatePeerConnection(peerId);
    attachTracksToConnection(pc);
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socketRef.current?.send('offer', { to: peerId, sdp: pc.localDescription });
    } catch (err) {}
  }, [getOrCreatePeerConnection, initMedia, attachTracksToConnection]);

  const handleOffer = useCallback(async (fromId: string, sdp: RTCSessionDescriptionInit) => {
    if (!cameraStreamRef.current) await initMedia();
    const pc = getOrCreatePeerConnection(fromId);
    attachTracksToConnection(pc);
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      await drainIceCandidates(fromId, pc);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socketRef.current?.send('answer', { to: fromId, sdp: pc.localDescription });
    } catch (err) {}
  }, [getOrCreatePeerConnection, initMedia, drainIceCandidates, attachTracksToConnection]);

  const handleAnswer = useCallback(async (fromId: string, sdp: RTCSessionDescriptionInit) => {
    const pc = getOrCreatePeerConnection(fromId);
    try {
      if (pc.signalingState === 'have-local-offer') {
        await pc.setRemoteDescription(new RTCSessionDescription(sdp));
        await drainIceCandidates(fromId, pc);
      }
    } catch (err) {}
  }, [getOrCreatePeerConnection, drainIceCandidates]);

  const handleIceCandidate = useCallback(async (fromId: string, candidate: RTCIceCandidateInit) => {
    const pc = getOrCreatePeerConnection(fromId);
    if (!pc.remoteDescription) {
      const queue = iceQueueRef.current.get(fromId) ?? [];
      queue.push(candidate);
      iceQueueRef.current.set(fromId, queue);
      return;
    }
    try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch (err) {}
  }, [getOrCreatePeerConnection]);

  useEffect(() => {
    if (!socket) return;
    const unsubs = [
      socket.on('peer_joined', (payload) => {
        const { peer_id, peer_name } = payload as { peer_id: string; peer_name: string };
        const validName = peer_name?.trim() ? peer_name : getFallbackName(peer_id);
        peerNamesRef.current.set(peer_id, validName);

        setPeers((prev) => {
          if (prev.find((p) => p.id === peer_id)) {
            return prev.map(p => p.id === peer_id ? { ...p, name: validName } : p);
          }
          return [...prev, { id: peer_id, name: validName, stream: null }];
        });
      }),
      socket.on('peer_left', (payload) => {
        const { peer_id } = payload as { peer_id: string };
        const pc = pcsRef.current.get(peer_id);
        if (pc) { pc.close(); pcsRef.current.delete(peer_id); }
        iceQueueRef.current.delete(peer_id);
        peerNamesRef.current.delete(peer_id);
        setPeers((prev) => prev.filter((p) => p.id !== peer_id));
      }),
      socket.on('offer', (payload) => {
        const { from, from_name, sdp } = payload as { from: string; from_name?: string; sdp: RTCSessionDescriptionInit };
        const validName = from_name?.trim() ? from_name : peerNamesRef.current.get(from) || getFallbackName(from);
        peerNamesRef.current.set(from, validName);

        setPeers((prev) => {
          if (prev.find((p) => p.id === from)) {
            return prev.map(p => p.id === from ? { ...p, name: validName } : p);
          }
          return [...prev, { id: from, name: validName, stream: null }];
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
    if (!cameraStreamRef.current) return;
    cameraStreamRef.current.getAudioTracks().forEach((t) => { t.enabled = !t.enabled; });
    setIsMuted((prev) => !prev);
  }, []);

  const toggleCamera = useCallback(() => {
    if (!cameraStreamRef.current) return;
    const tracks = cameraStreamRef.current.getVideoTracks();
    if (tracks.length === 0) return;
    tracks.forEach((t) => { t.enabled = !t.enabled; });
    setIsVideoOff(!tracks[0].enabled);
  }, []);

  const toggleScreenShare = useCallback(async () => {
    if (isScreenSharing) {
      screenStreamRef.current?.getTracks().forEach((t) => t.stop());
      screenStreamRef.current = null;
      setIsScreenSharing(false);
      setLocalStream(cameraStreamRef.current);
      const camTrack = cameraStreamRef.current?.getVideoTracks()[0];
      if (camTrack) {
        await Promise.all([...pcsRef.current.values()].map((pc) => {
          const sender = pc.getSenders().find((s) => s.track?.kind === 'video');
          return sender ? sender.replaceTrack(camTrack) : Promise.resolve();
        }));
      }
    } else {
      try {
        const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: false });
        screenStreamRef.current = screenStream;
        const screenTrack = screenStream.getVideoTracks()[0];
        await Promise.all([...pcsRef.current.values()].map((pc) => {
          const sender = pc.getSenders().find((s) => s.track?.kind === 'video');
          return sender ? sender.replaceTrack(screenTrack) : Promise.resolve();
        }));
        setLocalStream(screenStream);
        setIsScreenSharing(true);
        screenTrack.onended = async () => {
          screenStreamRef.current = null;
          setIsScreenSharing(false);
          setLocalStream(cameraStreamRef.current);
          const camTrack2 = cameraStreamRef.current?.getVideoTracks()[0];
          if (camTrack2) {
            await Promise.all([...pcsRef.current.values()].map((pc) => {
              const sender = pc.getSenders().find((s) => s.track?.kind === 'video');
              return sender ? sender.replaceTrack(camTrack2) : Promise.resolve();
            }));
          }
        };
      } catch (err) {}
    }
  }, [isScreenSharing]);

  const cleanup = useCallback(() => {
    pcsRef.current.forEach((pc) => pc.close());
    pcsRef.current.clear();
    iceQueueRef.current.clear();
    peerNamesRef.current.clear();
    cameraStreamRef.current?.getTracks().forEach((t) => t.stop());
    screenStreamRef.current?.getTracks().forEach((t) => t.stop());
    cameraStreamRef.current = null;
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
    registerPeerName, // <--- EXPORTED FIX
  };
}
