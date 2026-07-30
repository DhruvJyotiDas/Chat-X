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

  // Screen sharing runs over its own dedicated peer connections, entirely
  // separate from the camera connections below, so starting/stopping a share
  // never touches (or interrupts) the camera track that's already flowing.
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [screenStream, setScreenStream] = useState<MediaStream | null>(null);
  const [screenPeers, setScreenPeers] = useState<PeerInfo[]>([]);

  const pcsRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);

  const peerNamesRef = useRef<Map<string, string>>(new Map());
  const iceQueueRef = useRef<Map<string, RTCIceCandidateInit[]>>(new Map());
  const peersRef = useRef<PeerInfo[]>([]);
  useEffect(() => { peersRef.current = peers; }, [peers]);

  // Watchdog timers keyed the same way as the ICE queues (`cam:id` / `in:id` / `out:id`).
  // A peer that vanishes uncleanly (laptop closed, network dies, browser force-quit) never
  // sends the app-level "I'm leaving"/"I stopped sharing" message, so without this a remote
  // tile just freezes on its last frame forever. ICE itself still notices — connectivity
  // checks fail independently of our signaling socket — so once a connection has been
  // 'failed' for a few seconds with no recovery, we tear it down ourselves.
  const iceCleanupTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const clearIceCleanupTimer = useCallback((key: string) => {
    const t = iceCleanupTimersRef.current.get(key);
    if (t) { clearTimeout(t); iceCleanupTimersRef.current.delete(key); }
  }, []);

  // outgoing (we're sharing our screen to a peer) / incoming (a peer is sharing to us)
  const outScreenPcsRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const inScreenPcsRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const screenIceQueueRef = useRef<Map<string, RTCIceCandidateInit[]>>(new Map());

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
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Camera/microphone access is not available. The site must be opened over HTTPS. Please use https:// in the address bar.');
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      cameraStreamRef.current = stream;
      setLocalStream(stream);
      return stream;
    } catch (err: any) {
      if (err?.name === 'NotAllowedError' || err?.name === 'PermissionDeniedError') {
        throw new Error('Camera/microphone permission denied. Please allow access in your browser settings and try again.');
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        cameraStreamRef.current = stream;
        setLocalStream(stream);
        setIsVideoOff(true);
        return stream;
      } catch (audioErr: any) {
        if (audioErr?.name === 'NotAllowedError' || audioErr?.name === 'PermissionDeniedError') {
          throw new Error('Microphone permission denied. Please allow access in your browser settings and try again.');
        }
        throw new Error('No camera or microphone found. Please connect a device and try again.');
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
    // Always the camera stream — screen sharing lives on its own peer connections
    // (see below) and must never hijack this one.
    const streamToShare = cameraStreamRef.current;
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
      const state = pc.iceConnectionState;
      if (state === 'connected' || state === 'completed') {
        clearIceCleanupTimer(`cam:${peerId}`);
        return;
      }
      if (state !== 'failed') return;
      pc.restartIce();
      if (iceCleanupTimersRef.current.has(`cam:${peerId}`)) return;
      const timer = setTimeout(() => {
        iceCleanupTimersRef.current.delete(`cam:${peerId}`);
        if (pcsRef.current.get(peerId) !== pc) return; // already replaced/torn down elsewhere
        if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') return;
        pc.close();
        pcsRef.current.delete(peerId);
        setPeers((prev) => prev.filter((p) => p.id !== peerId));
      }, 8000);
      iceCleanupTimersRef.current.set(`cam:${peerId}`, timer);
    };

    return pc;
  }, [attachTracksToConnection, clearIceCleanupTimer]);

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

  // ─── Screen-share signaling (separate connections, tagged kind:"screen") ──

  const makeScreenPc = useCallback((peerId: string, direction: 'in' | 'out'): RTCPeerConnection => {
    const pc = new RTCPeerConnection(ICE_SERVERS);
    const timerKey = `${direction}:${peerId}`;
    pc.onicecandidate = (event) => {
      if (event.candidate && socketRef.current) {
        socketRef.current.send('ice_candidate', { to: peerId, candidate: event.candidate, kind: 'screen' });
      }
    };
    pc.oniceconnectionstatechange = () => {
      const state = pc.iceConnectionState;
      if (state === 'connected' || state === 'completed') {
        clearIceCleanupTimer(timerKey);
        return;
      }
      if (state !== 'failed') return;
      pc.restartIce();
      if (iceCleanupTimersRef.current.has(timerKey)) return;
      const timer = setTimeout(() => {
        iceCleanupTimersRef.current.delete(timerKey);
        const map = direction === 'in' ? inScreenPcsRef.current : outScreenPcsRef.current;
        if (map.get(peerId) !== pc) return; // already replaced/torn down elsewhere
        if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') return;
        pc.close();
        map.delete(peerId);
        if (direction === 'in') setScreenPeers((prev) => prev.filter((p) => p.id !== peerId));
      }, 8000);
      iceCleanupTimersRef.current.set(timerKey, timer);
    };
    if (direction === 'in') {
      pc.ontrack = (event) => {
        const remoteStream = event.streams[0];
        if (!remoteStream) return;
        const resolvedName = peerNamesRef.current.get(peerId) || getFallbackName(peerId);
        setScreenPeers((prev) => {
          const existing = prev.find((p) => p.id === peerId);
          if (existing) return prev.map((p) => (p.id === peerId ? { ...p, stream: remoteStream, name: resolvedName } : p));
          return [...prev, { id: peerId, name: resolvedName, stream: remoteStream }];
        });
      };
    }
    return pc;
  }, [clearIceCleanupTimer]);

  const drainScreenIce = useCallback(async (key: string, pc: RTCPeerConnection) => {
    const queue = screenIceQueueRef.current.get(key) ?? [];
    screenIceQueueRef.current.delete(key);
    for (const candidate of queue) {
      try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch (err) {}
    }
  }, []);

  const createScreenOfferFor = useCallback(async (peerId: string) => {
    if (!screenStreamRef.current) return;
    let pc = outScreenPcsRef.current.get(peerId);
    if (!pc) { pc = makeScreenPc(peerId, 'out'); outScreenPcsRef.current.set(peerId, pc); }
    screenStreamRef.current.getTracks().forEach((track) => {
      if (!pc!.getSenders().find((s) => s.track?.id === track.id)) {
        try { pc!.addTrack(track, screenStreamRef.current!); } catch (e) {}
      }
    });
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socketRef.current?.send('offer', { to: peerId, sdp: pc.localDescription, kind: 'screen' });
    } catch (err) {}
  }, [makeScreenPc]);

  const handleScreenOffer = useCallback(async (fromId: string, sdp: RTCSessionDescriptionInit) => {
    let pc = inScreenPcsRef.current.get(fromId);
    if (!pc) { pc = makeScreenPc(fromId, 'in'); inScreenPcsRef.current.set(fromId, pc); }
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      await drainScreenIce(`in:${fromId}`, pc);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socketRef.current?.send('answer', { to: fromId, sdp: pc.localDescription, kind: 'screen' });
    } catch (err) {}
  }, [makeScreenPc, drainScreenIce]);

  const handleScreenAnswer = useCallback(async (fromId: string, sdp: RTCSessionDescriptionInit) => {
    const pc = outScreenPcsRef.current.get(fromId);
    if (!pc) return;
    try {
      if (pc.signalingState === 'have-local-offer') {
        await pc.setRemoteDescription(new RTCSessionDescription(sdp));
        await drainScreenIce(`out:${fromId}`, pc);
      }
    } catch (err) {}
  }, [drainScreenIce]);

  const handleScreenIce = useCallback(async (fromId: string, candidate: RTCIceCandidateInit) => {
    const targets: [string, RTCPeerConnection | undefined][] = [
      [`in:${fromId}`, inScreenPcsRef.current.get(fromId)],
      [`out:${fromId}`, outScreenPcsRef.current.get(fromId)],
    ];
    for (const [key, pc] of targets) {
      if (!pc) continue;
      if (!pc.remoteDescription) {
        const queue = screenIceQueueRef.current.get(key) ?? [];
        queue.push(candidate);
        screenIceQueueRef.current.set(key, queue);
        continue;
      }
      try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch (err) {}
    }
  }, []);

  const closeInboundScreen = useCallback((peerId: string) => {
    const pc = inScreenPcsRef.current.get(peerId);
    if (pc) { pc.close(); inScreenPcsRef.current.delete(peerId); }
    screenIceQueueRef.current.delete(`in:${peerId}`);
    clearIceCleanupTimer(`in:${peerId}`);
    setScreenPeers((prev) => prev.filter((p) => p.id !== peerId));
  }, [clearIceCleanupTimer]);

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

        if (screenStreamRef.current) createScreenOfferFor(peer_id);
      }),
      socket.on('peer_left', (payload) => {
        const { peer_id } = payload as { peer_id: string };
        const pc = pcsRef.current.get(peer_id);
        if (pc) { pc.close(); pcsRef.current.delete(peer_id); }
        iceQueueRef.current.delete(peer_id);
        peerNamesRef.current.delete(peer_id);
        clearIceCleanupTimer(`cam:${peer_id}`);
        setPeers((prev) => prev.filter((p) => p.id !== peer_id));

        const outPc = outScreenPcsRef.current.get(peer_id);
        if (outPc) { outPc.close(); outScreenPcsRef.current.delete(peer_id); }
        screenIceQueueRef.current.delete(`out:${peer_id}`);
        clearIceCleanupTimer(`out:${peer_id}`);
        closeInboundScreen(peer_id);
      }),
      socket.on('offer', (payload) => {
        const { from, from_name, sdp, kind } = payload as { from: string; from_name?: string; sdp: RTCSessionDescriptionInit; kind?: string };
        const validName = from_name?.trim() ? from_name : peerNamesRef.current.get(from) || getFallbackName(from);
        peerNamesRef.current.set(from, validName);

        if (kind === 'screen') {
          handleScreenOffer(from, sdp);
          return;
        }

        setPeers((prev) => {
          if (prev.find((p) => p.id === from)) {
            return prev.map(p => p.id === from ? { ...p, name: validName } : p);
          }
          return [...prev, { id: from, name: validName, stream: null }];
        });
        handleOffer(from, sdp);
      }),
      socket.on('answer', (payload) => {
        const { from, sdp, kind } = payload as { from: string; sdp: RTCSessionDescriptionInit; kind?: string };
        if (kind === 'screen') { handleScreenAnswer(from, sdp); return; }
        handleAnswer(from, sdp);
      }),
      socket.on('ice_candidate', (payload) => {
        const { from, candidate, kind } = payload as { from: string; candidate: RTCIceCandidateInit; kind?: string };
        if (kind === 'screen') { handleScreenIce(from, candidate); return; }
        handleIceCandidate(from, candidate);
      }),
      socket.on('screen_share_state', (payload) => {
        const { peer_id, sharing } = payload as { peer_id: string; sharing: boolean };
        if (!sharing) closeInboundScreen(peer_id);
      }),
    ];
    return () => unsubs.forEach((u) => u());
  }, [socket, handleOffer, handleAnswer, handleIceCandidate, handleScreenOffer, handleScreenAnswer, handleScreenIce, createScreenOfferFor, closeInboundScreen, clearIceCleanupTimer]);

  const toggleMic = useCallback(() => {
    if (!cameraStreamRef.current) return;
    cameraStreamRef.current.getAudioTracks().forEach((t) => { t.enabled = !t.enabled; });
    setIsMuted((prev) => !prev);
  }, []);

  // Renegotiates every live camera connection so a peer connection actually reflects
  // whether we currently have a video track to send — used any time toggleCamera
  // adds or removes the local video track (renegotiation, not replaceTrack, because
  // switchCamera/switchMic already own the "keep the same track slot alive" case).
  const renegotiateCamera = useCallback(async () => {
    await Promise.all([...pcsRef.current.entries()].map(async ([peerId, pc]) => {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socketRef.current?.send('offer', { to: peerId, sdp: pc.localDescription });
      } catch (err) {}
    }));
  }, []);

  const toggleCamera = useCallback(async () => {
    if (!cameraStreamRef.current) return;

    if (!isVideoOff) {
      // Turning OFF: fully stop the hardware track (not just `enabled = false`) so the
      // OS camera indicator actually turns off, and remove the sender + renegotiate so
      // remote peers' video element cleanly empties instead of freezing mid-stream.
      const tracks = cameraStreamRef.current.getVideoTracks();
      if (tracks.length === 0) return;
      tracks.forEach((track) => {
        pcsRef.current.forEach((pc) => {
          const sender = pc.getSenders().find((s) => s.track === track);
          if (sender) { try { pc.removeTrack(sender); } catch (err) {} }
        });
        track.stop();
        cameraStreamRef.current!.removeTrack(track);
      });
      setIsVideoOff(true);
      setLocalStream(cameraStreamRef.current);
      await renegotiateCamera();
      return;
    }

    // Turning ON: the previous track was fully released above, so re-acquire fresh
    // hardware access rather than just re-enabling a dead track.
    try {
      const newStream = await navigator.mediaDevices.getUserMedia({ video: true });
      const newTrack = newStream.getVideoTracks()[0];
      if (!newTrack) return;
      cameraStreamRef.current.addTrack(newTrack);
      pcsRef.current.forEach((pc) => { try { pc.addTrack(newTrack, cameraStreamRef.current!); } catch (err) {} });
      setIsVideoOff(false);
      setLocalStream(cameraStreamRef.current);
      await renegotiateCamera();
    } catch (err) {
      console.error('[toggleCamera] failed to re-acquire camera', err);
    }
  }, [isVideoOff, renegotiateCamera]);

  const stopScreenShare = useCallback(() => {
    screenStreamRef.current?.getTracks().forEach((t) => t.stop());
    screenStreamRef.current = null;
    setScreenStream(null);
    setIsScreenSharing(false);
    outScreenPcsRef.current.forEach((pc, peerId) => { pc.close(); clearIceCleanupTimer(`out:${peerId}`); });
    outScreenPcsRef.current.clear();
    socketRef.current?.send('screen_share_state', { sharing: false });
  }, [clearIceCleanupTimer]);

  const toggleScreenShare = useCallback(async () => {
    if (isScreenSharing) {
      stopScreenShare();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: false });
      screenStreamRef.current = stream;
      setScreenStream(stream);
      setIsScreenSharing(true);
      socketRef.current?.send('screen_share_state', { sharing: true });
      await Promise.all(peersRef.current.map((p) => createScreenOfferFor(p.id)));
      const track = stream.getVideoTracks()[0];
      if (track) track.onended = () => stopScreenShare();
    } catch (err) {}
  }, [isScreenSharing, createScreenOfferFor, stopScreenShare]);

  const switchCamera = useCallback(async (deviceId: string) => {
    try {
      const newStream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: deviceId } }, audio: false });
      const newTrack = newStream.getVideoTracks()[0];
      if (!newTrack) return;
      // Replace track in all peer connections
      await Promise.all([...pcsRef.current.values()].map(pc => {
        const sender = pc.getSenders().find(s => s.track?.kind === 'video');
        return sender ? sender.replaceTrack(newTrack) : Promise.resolve();
      }));
      // Swap track in local camera stream
      if (cameraStreamRef.current) {
        cameraStreamRef.current.getVideoTracks().forEach(t => { t.stop(); cameraStreamRef.current!.removeTrack(t); });
        cameraStreamRef.current.addTrack(newTrack);
      } else {
        cameraStreamRef.current = newStream;
      }
      setLocalStream(cameraStreamRef.current);
    } catch (err) { console.error('[switchCamera]', err); }
  }, []);

  const switchMic = useCallback(async (deviceId: string) => {
    try {
      const newStream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: deviceId } }, video: false });
      const newTrack = newStream.getAudioTracks()[0];
      if (!newTrack) return;
      await Promise.all([...pcsRef.current.values()].map(pc => {
        const sender = pc.getSenders().find(s => s.track?.kind === 'audio');
        return sender ? sender.replaceTrack(newTrack) : Promise.resolve();
      }));
      if (cameraStreamRef.current) {
        cameraStreamRef.current.getAudioTracks().forEach(t => { t.stop(); cameraStreamRef.current!.removeTrack(t); });
        cameraStreamRef.current.addTrack(newTrack);
      }
    } catch (err) { console.error('[switchMic]', err); }
  }, []);

  const cleanup = useCallback(() => {
    pcsRef.current.forEach((pc) => pc.close());
    pcsRef.current.clear();
    iceQueueRef.current.clear();
    peerNamesRef.current.clear();
    outScreenPcsRef.current.forEach((pc) => pc.close());
    outScreenPcsRef.current.clear();
    inScreenPcsRef.current.forEach((pc) => pc.close());
    inScreenPcsRef.current.clear();
    screenIceQueueRef.current.clear();
    iceCleanupTimersRef.current.forEach((t) => clearTimeout(t));
    iceCleanupTimersRef.current.clear();
    cameraStreamRef.current?.getTracks().forEach((t) => t.stop());
    screenStreamRef.current?.getTracks().forEach((t) => t.stop());
    cameraStreamRef.current = null;
    screenStreamRef.current = null;
    setLocalStream(null);
    setScreenStream(null);
    setPeers([]);
    setScreenPeers([]);
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
    screenStream,
    screenPeers,
    initMedia,
    createOfferFor,
    toggleMic,
    toggleCamera,
    toggleScreenShare,
    switchCamera,
    switchMic,
    cleanup,
    registerPeerName,
  };
}
