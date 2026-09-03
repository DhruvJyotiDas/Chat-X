// Pre-join network check.
//
// Answers the question that used to be unanswerable from inside the app: "will a call
// actually work on this network?" Restrictive networks — university and corporate wifi,
// hotel captive portals, mobile carriers doing CGNAT — fail in ways that are invisible
// from the UI. The signalling WebSocket connects, the room is joined, tiles appear, and
// then no media ever arrives, because UDP is blocked outbound and nothing told anyone.
//
// Shaped after suitenumerique/meet's features/diagnostics. Their runner is built on
// livekit-client's ConnectionCheck/Checker classes, which do not exist here, so the
// step sequencing below is ours; what is genuinely borrowed is reading the *selected
// candidate pair* out of getStats() to find out how media actually travelled, which
// lives in connectionStats.ts.
//
// The relay step is the one that matters. It runs a real loopback call between two
// local RTCPeerConnections with iceTransportPolicy: 'relay', so both ends must allocate
// on the TURN server and exchange media through it. If that passes, a relayed call to
// a real peer will work; if it fails while direct gathering succeeded, the network is
// blocking the relay specifically.

import { readPeerStats, describePath, type PeerStats } from './connectionStats';
import { config } from '../config';

export type StepId = 'devices' | 'media' | 'signaling' | 'turnCredentials' | 'gathering' | 'relay';
export type StepStatus = 'pending' | 'running' | 'pass' | 'warn' | 'fail' | 'skipped';

export interface Step {
  id: StepId;
  label: string;
  status: StepStatus;
  /** Shown under the label. One sentence, written for the person running the test. */
  detail?: string;
}

export const INITIAL_STEPS: Step[] = [
  { id: 'devices', label: 'Camera and microphone found', status: 'pending' },
  { id: 'media', label: 'Camera and microphone can be opened', status: 'pending' },
  { id: 'signaling', label: 'Meeting server reachable', status: 'pending' },
  { id: 'turnCredentials', label: 'Relay credentials issued', status: 'pending' },
  { id: 'gathering', label: 'Direct connection possible', status: 'pending' },
  { id: 'relay', label: 'Relayed call works', status: 'pending' },
];

export interface TestOutcome {
  steps: Step[];
  /** Plain-language verdict, the only part most people will read. */
  verdict: 'ok' | 'relay-only' | 'blocked' | 'no-devices';
  summary: string;
  /** How the loopback call actually travelled, when it connected. */
  path?: string;
}

const GATHER_TIMEOUT_MS = 8000;
const CONNECT_TIMEOUT_MS = 15000;
const SIGNALING_TIMEOUT_MS = 8000;

function wsUrl(): string {
  return config.wsUrl;
}

/** Collect ICE candidates until gathering completes or the timeout fires. */
function gatherCandidates(pc: RTCPeerConnection, timeoutMs: number): Promise<RTCIceCandidate[]> {
  return new Promise((resolve) => {
    const found: RTCIceCandidate[] = [];
    const finish = () => { clearTimeout(timer); resolve(found); };
    const timer = setTimeout(finish, timeoutMs);

    pc.onicecandidate = (e) => {
      // A null candidate is the end-of-gathering sentinel, not a candidate.
      if (!e.candidate) { finish(); return; }
      found.push(e.candidate);
    };
    pc.onicegatheringstatechange = () => {
      if (pc.iceGatheringState === 'complete') finish();
    };
  });
}

async function fetchIceServers(): Promise<{ servers: RTCIceServer[]; hasTurn: boolean }> {
  const res = await fetch('/api/turn-credentials');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json() as { iceServers?: RTCIceServer[] };
  const servers = body.iceServers ?? [];
  const hasTurn = servers.some((s) => {
    const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
    return urls.some((u) => typeof u === 'string' && u.startsWith('turn'));
  });
  return { servers, hasTurn };
}

/**
 * Run a real call between two peer connections in this tab.
 *
 * `policy: 'relay'` forces both ends onto TURN, which is what makes this a genuine
 * test of the relay path rather than of localhost. Resolves with the stats of the
 * connected pair, or null if it never connected.
 */
async function loopbackCall(
  servers: RTCIceServer[],
  policy: RTCIceTransportPolicy,
  track: MediaStreamTrack | null,
): Promise<PeerStats | null> {
  const config: RTCConfiguration = { iceServers: servers, iceTransportPolicy: policy };
  const a = new RTCPeerConnection(config);
  const b = new RTCPeerConnection(config);

  try {
    a.onicecandidate = (e) => { if (e.candidate) void b.addIceCandidate(e.candidate).catch(() => {}); };
    b.onicecandidate = (e) => { if (e.candidate) void a.addIceCandidate(e.candidate).catch(() => {}); };

    // Something has to be negotiated or there is nothing for ICE to connect for.
    // A real track is better than a dummy transceiver: it exercises the same
    // encode-and-send path a call uses, so a network that permits signalling but
    // drops media still fails here rather than passing a hollow check.
    if (track) a.addTrack(track);
    else a.addTransceiver('audio', { direction: 'sendonly' });
    b.addTransceiver('audio', { direction: 'recvonly' });

    const offer = await a.createOffer();
    await a.setLocalDescription(offer);
    await b.setRemoteDescription(offer);
    const answer = await b.createAnswer();
    await b.setLocalDescription(answer);
    await a.setRemoteDescription(answer);

    const connected = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), CONNECT_TIMEOUT_MS);
      const check = () => {
        if (a.iceConnectionState === 'connected' || a.iceConnectionState === 'completed') {
          clearTimeout(timer); resolve(true);
        } else if (a.iceConnectionState === 'failed') {
          clearTimeout(timer); resolve(false);
        }
      };
      a.oniceconnectionstatechange = check;
      check();
    });

    if (!connected) return null;

    // Stats need a moment after connecting before a selected pair appears.
    await new Promise((r) => setTimeout(r, 1200));
    return await readPeerStats(a);
  } finally {
    a.close();
    b.close();
  }
}

/**
 * Run the full check, reporting each step as it resolves so the UI can fill in
 * progressively rather than sitting blank for twenty seconds.
 */
export async function runConnectionTest(onUpdate: (steps: Step[]) => void): Promise<TestOutcome> {
  const steps: Step[] = INITIAL_STEPS.map((s) => ({ ...s }));
  const set = (id: StepId, status: StepStatus, detail?: string) => {
    const step = steps.find((s) => s.id === id);
    if (step) { step.status = status; step.detail = detail; }
    onUpdate(steps.map((s) => ({ ...s })));
  };

  // Tracks acquired here are stopped in the finally block — a test that leaves the
  // camera light on is worse than no test.
  let stream: MediaStream | null = null;

  try {
    // ── Devices present ────────────────────────────────────────────────────────
    set('devices', 'running');
    let hasCamera = false;
    let hasMic = false;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      hasCamera = devices.some((d) => d.kind === 'videoinput');
      hasMic = devices.some((d) => d.kind === 'audioinput');
    } catch { /* treated as absent below */ }

    if (!hasMic) {
      set('devices', 'fail', 'No microphone detected. A call needs at least a microphone.');
    } else if (!hasCamera) {
      set('devices', 'warn', 'No camera detected. You can still join with audio only.');
    } else {
      set('devices', 'pass');
    }

    // ── Media opens ────────────────────────────────────────────────────────────
    set('media', 'running');
    if (!navigator.mediaDevices?.getUserMedia) {
      set('media', 'fail', 'This browser will not grant camera access. The page must be served over HTTPS.');
    } else if (!hasMic) {
      set('media', 'skipped', 'No microphone to open.');
    } else {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: hasCamera });
        const gotVideo = stream.getVideoTracks().length > 0;
        set('media', gotVideo || !hasCamera ? 'pass' : 'warn',
          gotVideo || !hasCamera ? undefined : 'Microphone opened but the camera did not.');
      } catch (err) {
        const name = (err as { name?: string })?.name;
        set('media', 'fail', name === 'NotAllowedError'
          ? 'Permission was denied. Allow camera and microphone access for this site and run the test again.'
          : `Could not open your devices (${name ?? 'unknown error'}). Another app may be using them.`);
      }
    }

    // ── Signalling reachable ───────────────────────────────────────────────────
    //
    // The WebSocket API deliberately hides the HTTP handshake result from JavaScript,
    // so a rejected upgrade and a blocked port are indistinguishable here. The most
    // that can honestly be reported is whether the socket opened.
    set('signaling', 'running');
    const signalingOk = await new Promise<boolean>((resolve) => {
      let settled = false;
      const done = (ok: boolean) => { if (!settled) { settled = true; resolve(ok); } };
      let ws: WebSocket;
      try {
        ws = new WebSocket(wsUrl());
      } catch {
        done(false);
        return;
      }
      const timer = setTimeout(() => { done(false); ws.close(); }, SIGNALING_TIMEOUT_MS);
      ws.onopen = () => { clearTimeout(timer); done(true); ws.close(); };
      ws.onerror = () => { clearTimeout(timer); done(false); };
      ws.onclose = () => { clearTimeout(timer); done(false); };
    });
    set('signaling', signalingOk ? 'pass' : 'fail', signalingOk
      ? undefined
      : 'Could not reach the meeting server. A firewall or proxy is likely blocking WebSocket connections.');

    // ── TURN credentials ───────────────────────────────────────────────────────
    set('turnCredentials', 'running');
    let servers: RTCIceServer[] = [];
    let hasTurn = false;
    try {
      const result = await fetchIceServers();
      servers = result.servers;
      hasTurn = result.hasTurn;
      set('turnCredentials', hasTurn ? 'pass' : 'warn', hasTurn
        ? undefined
        : 'The server issued no relay, only STUN. Calls will fail on networks that block direct connections.');
    } catch (err) {
      set('turnCredentials', 'fail', `Could not fetch relay credentials (${(err as Error).message}). Calls needing a relay will not connect.`);
    }

    // ── Direct connection possible ─────────────────────────────────────────────
    //
    // A server-reflexive candidate proves outbound UDP reached a STUN server and came
    // back, which is the precondition for any direct peer-to-peer connection.
    set('gathering', 'running');
    let sawSrflx = false;
    let sawRelayCandidate = false;
    {
      const pc = new RTCPeerConnection({ iceServers: servers.length ? servers : [{ urls: 'stun:stun.l.google.com:19302' }] });
      try {
        pc.addTransceiver('audio', { direction: 'sendonly' });
        await pc.setLocalDescription(await pc.createOffer());
        const candidates = await gatherCandidates(pc, GATHER_TIMEOUT_MS);
        sawSrflx = candidates.some((c) => c.type === 'srflx');
        sawRelayCandidate = candidates.some((c) => c.type === 'relay');
      } finally {
        pc.close();
      }
    }
    set('gathering', sawSrflx ? 'pass' : 'warn', sawSrflx
      ? undefined
      : 'No direct route out. This network blocks peer-to-peer connections, so every call has to be relayed.');

    // ── Relayed call ───────────────────────────────────────────────────────────
    set('relay', 'running');
    let path: string | undefined;
    let relayOk = false;
    if (!hasTurn) {
      set('relay', 'skipped', 'No relay server configured to test.');
    } else if (!sawRelayCandidate) {
      set('relay', 'fail', 'Could not allocate on the relay server. Its ports are blocked from this network.');
    } else {
      try {
        const audioTrack = stream?.getAudioTracks()[0] ?? null;
        // Clone: handing the live preview track to a peer connection that is about to
        // be closed would stop the caller's track along with it.
        const stats = await loopbackCall(servers, 'relay', audioTrack ? audioTrack.clone() : null);
        relayOk = stats !== null;
        path = stats ? describePath(stats) : undefined;
        set('relay', relayOk ? 'pass' : 'fail', relayOk
          ? undefined
          : 'Media could not travel through the relay. Calls on this network will connect but nobody will see or hear you.');
      } catch (err) {
        set('relay', 'fail', `The relay test could not run (${(err as Error).message}).`);
      }
    }

    // ── Verdict ────────────────────────────────────────────────────────────────
    const failed = (id: StepId) => steps.find((s) => s.id === id)?.status === 'fail';

    let verdict: TestOutcome['verdict'];
    let summary: string;

    if (failed('devices') || failed('media')) {
      verdict = 'no-devices';
      summary = 'Your camera or microphone is unavailable, so nobody would be able to see or hear you. Fix the device or permission problem below, then run the test again.';
    } else if (failed('signaling') || (!sawSrflx && !relayOk)) {
      verdict = 'blocked';
      summary = 'This network is blocking video calls. Try a different network or a mobile hotspot — on university and office wifi this is usually a firewall rule that only an administrator can change.';
    } else if (!sawSrflx && relayOk) {
      verdict = 'relay-only';
      summary = 'Calls will work, but every one has to go through the relay server because this network blocks direct connections. Expect slightly higher delay, and quality may suffer in large calls.';
    } else {
      verdict = 'ok';
      summary = 'Everything checks out. Calls should work normally on this network.';
    }

    return { steps: steps.map((s) => ({ ...s })), verdict, summary, path };
  } finally {
    stream?.getTracks().forEach((t) => t.stop());
  }
}
