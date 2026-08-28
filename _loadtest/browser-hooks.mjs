// Functions injected into each simulated participant's page via Playwright's
// addInitScript()/evaluate(). Each must be self-contained (Playwright
// serializes them via toString() — no closing over anything outside the
// function body; arguments are passed explicitly at call time).
//
// Deliberately app-agnostic: this reaches nothing app-specific (no pcsRef, no
// LiveKit Room object) and requires zero production code changes. Camera and
// mic both eventually go through `new RTCPeerConnection(...)` in the browser
// regardless of whether the app's own code is the mesh implementation or
// LiveKit's SDK, so intercepting that one global constructor sees both,
// uniformly, with the identical aggregation logic on the other end.

/** Continuous-motion fake camera + tone fake mic. NOT a static color fill —
 *  static content lets VP8 collapse to near-zero bitrate via temporal
 *  redundancy detection, which would badly understate real encode cost. */
export function installFakeMedia(seed) {
  const hue = seed % 360;
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    const canvas = document.createElement('canvas');
    canvas.width = 640; canvas.height = 480;
    const ctx = canvas.getContext('2d');
    let t = 0;
    (function draw() {
      t += 1;
      // A moving gradient + a bouncing block + a per-frame counter — enough
      // continuous, non-repeating pixel change that no reasonable encoder
      // heuristic mistakes this for a static scene.
      const grad = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
      grad.addColorStop(0, `hsl(${(hue + t) % 360}, 70%, 45%)`);
      grad.addColorStop(1, `hsl(${(hue + t + 120) % 360}, 70%, 25%)`);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      const bx = (Math.sin(t / 17) * 0.5 + 0.5) * (canvas.width - 60);
      const by = (Math.cos(t / 23) * 0.5 + 0.5) * (canvas.height - 60);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(bx, by, 60, 60);
      ctx.fillStyle = '#000000';
      ctx.font = '16px monospace';
      ctx.fillText(String(t), 10, 20);
      requestAnimationFrame(draw);
    })();
    const videoStream = canvas.captureStream(24);

    const audioCtx = new AudioContext();
    const dest = audioCtx.createMediaStreamDestination();
    const gain = audioCtx.createGain(); gain.gain.value = 0.03;
    const osc = audioCtx.createOscillator();
    osc.frequency.value = 200 + (seed % 400); // distinct-ish per participant, not that it matters for load
    osc.connect(gain).connect(dest);
    osc.start();

    const tracks = [];
    if (!constraints || constraints.video !== false) tracks.push(videoStream.getVideoTracks()[0]);
    if (!constraints || constraints.audio !== false) tracks.push(dest.stream.getAudioTracks()[0]);
    return new MediaStream(tracks);
  };
  navigator.mediaDevices.getDisplayMedia = async () => {
    throw new Error('screen share not exercised in this load test');
  };
}

/** Tracks every RTCPeerConnection this page creates, open or closed, so
 *  stats can be pulled uniformly regardless of whether the app underneath is
 *  mesh (many PCs, one per remote peer) or LiveKit (typically ~2 PCs total —
 *  one publisher, one subscriber, multiplexing every remote track) — this
 *  code does not need to know or care which. */
export function installPCTracker() {
  window.__loadtestPCs = new Set();
  const OrigPC = window.RTCPeerConnection;
  window.RTCPeerConnection = function (...args) {
    const pc = new OrigPC(...args);
    window.__loadtestPCs.add(pc);
    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'closed') window.__loadtestPCs.delete(pc);
    });
    return pc;
  };
  window.RTCPeerConnection.prototype = OrigPC.prototype;
  Object.assign(window.RTCPeerConnection, OrigPC);
  window.__loadtestReady = true;
}

/** Called via page.evaluate() during the steady-state window. Returns a
 *  plain-data snapshot (no live objects — this crosses the CDP boundary back
 *  to Node) of every intercepted PC's connection state plus aggregated
 *  byte/freeze/drop counters across all of them. */
export async function collectStats() {
  const pcs = Array.from(window.__loadtestPCs || []);
  let bytesSent = 0, bytesReceived = 0;
  let framesDropped = 0, freezeCount = 0, totalFreezesDuration = 0;
  let inboundVideoStreamCount = 0;
  const connectionStates = [];

  for (const pc of pcs) {
    connectionStates.push(pc.connectionState);
    let report;
    try { report = await pc.getStats(); } catch { continue; }
    report.forEach((s) => {
      if (s.type === 'outbound-rtp' && typeof s.bytesSent === 'number') {
        bytesSent += s.bytesSent;
      }
      if (s.type === 'inbound-rtp') {
        if (typeof s.bytesReceived === 'number') bytesReceived += s.bytesReceived;
        if (s.kind === 'video') {
          inboundVideoStreamCount += 1;
          if (typeof s.framesDropped === 'number') framesDropped += s.framesDropped;
          if (typeof s.freezeCount === 'number') freezeCount += s.freezeCount;
          if (typeof s.totalFreezesDuration === 'number') totalFreezesDuration += s.totalFreezesDuration;
        }
      }
    });
  }

  return {
    pcCount: pcs.length,
    connectionStates,
    bytesSent, bytesReceived,
    framesDropped, freezeCount, totalFreezesDuration,
    inboundVideoStreamCount,
    timestamp: Date.now(),
  };
}

/** Per-stream (not aggregated) freeze/drop snapshot, for the rung-level
 *  "what fraction of streams are individually degraded" check — collectStats
 *  above deliberately aggregates for the bandwidth numbers, but a single
 *  badly-frozen stream averaged in with several healthy ones would be
 *  invisible in an aggregate, which is exactly the failure mode being
 *  checked for. */
export async function collectPerStreamVideoStats() {
  const pcs = Array.from(window.__loadtestPCs || []);
  const streams = [];
  for (const pc of pcs) {
    let report;
    try { report = await pc.getStats(); } catch { continue; }
    report.forEach((s) => {
      if (s.type === 'inbound-rtp' && s.kind === 'video') {
        streams.push({
          id: s.id,
          framesDropped: s.framesDropped ?? 0,
          freezeCount: s.freezeCount ?? 0,
          totalFreezesDuration: s.totalFreezesDuration ?? 0,
          framesPerSecond: s.framesPerSecond ?? null,
          framesDecoded: s.framesDecoded ?? 0,
        });
      }
    });
  }
  return streams;
}
