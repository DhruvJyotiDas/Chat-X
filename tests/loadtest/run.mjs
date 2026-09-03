#!/usr/bin/env node
// Load-test orchestrator — one rung (one participant count, one condition)
// per invocation. Identical code for both mesh and LiveKit; only which
// backend/frontend build it's pointed at differs, per the Stage 1 plan's
// "one harness, two conditions" requirement.
//
// Usage:
//   node run.mjs --mode=mesh|livekit --n=<count> --base=<url>
//     [--server-pid=<pid>] [--livekit-pid=<pid>]
//     [--settle-timeout-ms=N] [--window-ms=N] [--sample-interval-ms=N]
//     [--out=<path.json>]
//
// IBCONNECT_JWT_SECRET must be set in the environment (never passed as a
// CLI arg — that would put it in `ps aux` output on a shared host).

import { LoadTestClient } from './client.mjs';
import { treeCpuSecondsNow, cpuSecondsFor, rssMbFor, systemCpuSnapshot, systemCpuFraction, CPU_COUNT } from './proc.mjs';
import { writeFileSync, mkdirSync } from 'fs';
import { dirname, resolve } from 'path';

function arg(name, def) {
  const m = process.argv.find((a) => a.startsWith(`--${name}=`));
  return m ? m.slice(name.length + 3) : def;
}

const MODE = arg('mode');
const N = parseInt(arg('n', '0'), 10);
const BASE = arg('base');
const SERVER_PID = arg('server-pid') ? parseInt(arg('server-pid'), 10) : null;
const LIVEKIT_PID = arg('livekit-pid') ? parseInt(arg('livekit-pid'), 10) : null;
const SETTLE_TIMEOUT_MS = parseInt(arg('settle-timeout-ms', String(15000 + N * 3000)), 10); // grows with N — mesh negotiation genuinely takes longer at higher N, this isn't padding to hide a problem
const WINDOW_MS = parseInt(arg('window-ms', '30000'), 10);
const SAMPLE_INTERVAL_MS = parseInt(arg('sample-interval-ms', '3000'), 10);
const OUT = arg('out', null);
const JWT_SECRET = process.env.IBCONNECT_JWT_SECRET;

if (!['mesh', 'livekit'].includes(MODE)) { console.error('--mode=mesh|livekit is required'); process.exit(2); }
if (!N || N < 1) { console.error('--n=<count> is required'); process.exit(2); }
if (!BASE) { console.error('--base=<url> is required'); process.exit(2); }
if (!JWT_SECRET) { console.error('IBCONNECT_JWT_SECRET must be set in the environment'); process.exit(2); }

const EXPECTED_INBOUND_VIDEO_STREAMS = N * (N - 1); // every client receives every other client's video, in EITHER architecture — same target regardless of mode, which is exactly why this is a valid mode-agnostic settle/health signal

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

console.log(`\n=== Rung: mode=${MODE} N=${N} ===`);
console.log(`host: ${CPU_COUNT} cores. settle timeout ${SETTLE_TIMEOUT_MS}ms, window ${WINDOW_MS}ms, sampling every ${SAMPLE_INTERVAL_MS}ms.\n`);

const clients = [];
for (let i = 0; i < N; i++) clients.push(new LoadTestClient({ index: i, base: BASE, jwtSecret: JWT_SECRET }));

console.log('launching browsers...');
await Promise.all(clients.map((c) => c.launch()));
console.log('pids:', clients.map((c) => c.pid).join(', '));

for (const c of clients) await c.signIn();

console.log('host creating room...');
const code = await clients[0].createRoom();
if (!code) { console.error('FATAL: host failed to create a room — aborting this rung.'); await Promise.all(clients.map((c) => c.close())); process.exit(1); }
console.log('room code:', code);

console.log('guests joining (staggered)...');
for (let i = 1; i < N; i++) {
  await clients[i].joinRoom(code);
  await sleep(400); // realistic join cadence, and avoids a thundering herd at the signaling layer that isn't representative of how rooms actually fill
}

// ── Settle: wait for the room to actually be in the state being measured ──
console.log('waiting for settle...');
const settleStart = Date.now();
// N=1 (the optional idle-baseline rung) has zero expected peer connections
// by construction — 0 connectionStates is the correct, fully-settled state
// there, not a failure to reach 0.85 of something that was never going to
// exist. Without this, N=1 would spin for the entire settle timeout and
// falsely report TIMED OUT on a trivially valid scenario.
let settled = EXPECTED_INBOUND_VIDEO_STREAMS === 0;
let lastSeenInbound = 0;
let lastSeenConnectedFraction = settled ? 1 : 0;
while (!settled && Date.now() - settleStart < SETTLE_TIMEOUT_MS) {
  const samples = await Promise.all(clients.map((c) => c.sampleStats().catch(() => null)));
  const valid = samples.filter(Boolean);
  const totalInbound = valid.reduce((a, s) => a + s.inboundVideoStreamCount, 0);
  const allStates = valid.flatMap((s) => s.connectionStates);
  const connectedFraction = allStates.length ? allStates.filter((s) => s === 'connected').length / allStates.length : 0;
  lastSeenInbound = totalInbound;
  lastSeenConnectedFraction = connectedFraction;
  if (totalInbound >= EXPECTED_INBOUND_VIDEO_STREAMS * 0.85 && connectedFraction >= 0.85) { settled = true; break; }
  await sleep(1000);
}
console.log(`settle result: ${settled ? 'OK' : 'TIMED OUT'} — inbound video streams ${lastSeenInbound}/${EXPECTED_INBOUND_VIDEO_STREAMS}, connected-state fraction ${(lastSeenConnectedFraction * 100).toFixed(1)}%`);

// ── Steady-state measurement window ──────────────────────────────────────
console.log(`measuring for ${WINDOW_MS / 1000}s...`);
const windowStart = Date.now();
const cpuBefore = new Map(clients.map((c) => [c.index, c.cpuSecondsNow()]));
const serverCpuBefore = SERVER_PID ? cpuSecondsFor(SERVER_PID) : null;
const livekitCpuBefore = LIVEKIT_PID ? treeCpuSecondsNow(LIVEKIT_PID) : null;
const sysBefore = systemCpuSnapshot();

const statSamples = []; // [{t, samples: [ {index, bytesSent, bytesReceived, ...} | null ]}]
while (Date.now() - windowStart < WINDOW_MS) {
  const t = Date.now() - windowStart;
  // On failure this must become null outright, not a partial object spread
  // with a bare {index} — a truthy-but-incomplete entry would silently
  // survive a plain `.filter(Boolean)` downstream and corrupt whichever
  // bandwidth calculation treats it as real data.
  const samples = await Promise.all(clients.map(async (c) => {
    const s = await c.sampleStats().catch(() => null);
    return s ? { index: c.index, ...s } : null;
  }));
  statSamples.push({ t, samples });
  await sleep(SAMPLE_INTERVAL_MS);
}

const wallElapsed = (Date.now() - windowStart) / 1000;
const cpuAfter = new Map(clients.map((c) => [c.index, c.cpuSecondsNow()]));
const serverCpuAfter = SERVER_PID ? cpuSecondsFor(SERVER_PID) : null;
const livekitCpuAfter = LIVEKIT_PID ? treeCpuSecondsNow(LIVEKIT_PID) : null;
const sysAfter = systemCpuSnapshot();

// Per-stream freeze/drop detail at the end of the window (cumulative
// counters, so end-of-window values already reflect the whole window).
const perStreamSamples = await Promise.all(clients.map((c) => c.samplePerStreamVideoStats().catch(() => [])));

// ── Compute per-client bandwidth from first/last sample in the window ────
const perClient = clients.map((c) => {
  const seriesForClient = statSamples.map((s) => s.samples.find((x) => x && x.index === c.index)).filter(Boolean);
  const first = seriesForClient[0];
  const last = seriesForClient[seriesForClient.length - 1];
  const dtSec = first && last ? (last.timestamp - first.timestamp) / 1000 : null;
  const uploadKbps = first && last && dtSec > 0 ? ((last.bytesSent - first.bytesSent) * 8 / 1000) / dtSec : null;
  const downloadKbps = first && last && dtSec > 0 ? ((last.bytesReceived - first.bytesReceived) * 8 / 1000) / dtSec : null;
  const cpuCores = ((cpuAfter.get(c.index) ?? 0) - (cpuBefore.get(c.index) ?? 0)) / wallElapsed;
  return { index: c.index, uploadKbps, downloadKbps, cpuCores, pcCount: last?.pcCount ?? null, errors: c.errors };
});

// ── Watchability: per-stream freeze/drop degradation ─────────────────────
const FREEZE_DURATION_FRACTION_THRESHOLD = 0.10; // >10% of the window spent frozen
const FREEZE_COUNT_PER_10S_THRESHOLD = 1;
const FRAMES_DROPPED_FRACTION_THRESHOLD = 0.10; // >10% of expected frames at a nominal 24fps capture

let totalStreams = 0, degradedStreams = 0;
for (const streams of perStreamSamples) {
  for (const s of streams) {
    totalStreams += 1;
    const expectedFrames = 24 * (WINDOW_MS / 1000);
    const freezeFraction = s.totalFreezesDuration / (WINDOW_MS / 1000);
    const freezeRate = s.freezeCount / (WINDOW_MS / 1000 / 10);
    const dropFraction = expectedFrames > 0 ? s.framesDropped / expectedFrames : 0;
    if (freezeFraction > FREEZE_DURATION_FRACTION_THRESHOLD
      || freezeRate > FREEZE_COUNT_PER_10S_THRESHOLD
      || dropFraction > FRAMES_DROPPED_FRACTION_THRESHOLD) {
      degradedStreams += 1;
    }
  }
}
const degradedStreamFraction = totalStreams > 0 ? degradedStreams / totalStreams : 0;

// ── Final connection-health read (post-window, for the ICE-failure gate) ──
const finalStates = statSamples[statSamples.length - 1]?.samples.flatMap((s) => s?.connectionStates ?? []) ?? [];
// Same class of bug already fixed for the settle check, missed here on the
// first pass and caught by actually running N=1: zero total connections
// (N=1 — nothing to connect to, by design) is a vacuous pass, not "0%
// connected" -> 100% failure. Only compute a real failure fraction when
// there was something to actually fail.
const finalConnectedFraction = finalStates.length ? finalStates.filter((s) => s === 'connected').length / finalStates.length : 1;
const iceFailureFraction = finalStates.length ? 1 - finalConnectedFraction : 0;

// Which criterion actually GATED the verdict, not just which numbers happen
// to be over threshold, reported side by side for the reader to notice. The
// three checks are evaluated in the order the harness would genuinely learn
// about each one: settle timeout is known before the measurement window
// ever starts; ICE-failure fraction comes from the final connection-state
// read; stream-degradation is only knowable once the whole window's
// per-stream stats are in. Whichever of these is true FIRST in that order is
// the gating reason; anything else that's ALSO true is reported separately
// as a secondary finding, never blended into one list the reader has to
// disentangle themselves.
let gatingReason = null;
const secondaryReasons = [];
const noteReason = (msg) => { if (!gatingReason) gatingReason = msg; else secondaryReasons.push(msg); };

if (!settled) noteReason(`settle timed out (${lastSeenInbound}/${EXPECTED_INBOUND_VIDEO_STREAMS} inbound video streams, ${(lastSeenConnectedFraction * 100).toFixed(0)}% connected)`);
if (iceFailureFraction > 0.15) noteReason(`${(iceFailureFraction * 100).toFixed(1)}% of connections not in 'connected' state (>15% threshold) [ICE-failure]`);
if (degradedStreamFraction > 0.15) noteReason(`${(degradedStreamFraction * 100).toFixed(1)}% of video streams show sustained freezing/drops (>15% threshold) [stream-degradation]`);

const verdict = gatingReason ? 'DEGRADED/UNUSABLE' : 'OK';

const sysCpuFraction = systemCpuFraction(sysBefore, sysAfter);
const hostSaturated = sysCpuFraction > 0.85;

const allErrors = clients.flatMap((c) => c.errors);

const report = {
  mode: MODE, n: N, roomCode: code, timestamp: new Date().toISOString(),
  hardware: { cpuCount: CPU_COUNT, softwareEncodeOnly: true },
  settle: { settled, inboundVideoStreams: lastSeenInbound, expectedInboundVideoStreams: EXPECTED_INBOUND_VIDEO_STREAMS, connectedFraction: lastSeenConnectedFraction, timeoutMs: SETTLE_TIMEOUT_MS },
  windowSeconds: wallElapsed,
  perClient,
  aggregate: {
    avgUploadKbps: avg(perClient.map((p) => p.uploadKbps)),
    avgDownloadKbps: avg(perClient.map((p) => p.downloadKbps)),
    avgCpuCores: avg(perClient.map((p) => p.cpuCores)),
  },
  server: {
    backendCpuCores: serverCpuBefore !== null ? (serverCpuAfter - serverCpuBefore) / wallElapsed : null,
    livekitCpuCores: livekitCpuBefore !== null ? (livekitCpuAfter - livekitCpuBefore) / wallElapsed : null,
    livekitRssMb: LIVEKIT_PID ? rssMbFor(LIVEKIT_PID) : null,
  },
  hostSaturation: { systemCpuFraction: sysCpuFraction, cpuCount: CPU_COUNT, saturated: hostSaturated },
  watchability: { totalStreams, degradedStreams, degradedStreamFraction, iceFailureFraction },
  verdict, gatingReason, secondaryReasons,
  errors: allErrors,
};

function avg(arr) { const v = arr.filter((x) => typeof x === 'number' && !Number.isNaN(x)); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; }

console.log('\n--- Result ---');
console.log(`verdict: ${verdict}`);
if (gatingReason) {
  console.log(`  gated by: ${gatingReason}`);
  if (secondaryReasons.length) console.log(`  also failing: ${secondaryReasons.join('; ')}`);
}
console.log(`avg per-client upload: ${fmt(report.aggregate.avgUploadKbps)} kbps, download: ${fmt(report.aggregate.avgDownloadKbps)} kbps, CPU: ${fmt(report.aggregate.avgCpuCores)} cores`);
if (report.server.livekitCpuCores !== null) console.log(`LiveKit process: ${fmt(report.server.livekitCpuCores)} cores, ${report.server.livekitRssMb} MB RSS`);
if (report.server.backendCpuCores !== null) console.log(`Go backend: ${fmt(report.server.backendCpuCores)} cores`);
console.log(`system-wide CPU: ${(sysCpuFraction * 100).toFixed(1)}% of ${CPU_COUNT} cores${hostSaturated ? '  ⚠ HOST SATURATED — numbers below this point are contention artifacts, not clean' : ''}`);
console.log(`watchability: ${degradedStreams}/${totalStreams} streams degraded (${(degradedStreamFraction * 100).toFixed(1)}%)`);
if (allErrors.length) console.log(`console/page errors: ${allErrors.length} (see report JSON)`);

function fmt(n) { return n === null || n === undefined ? 'n/a' : n.toFixed(2); }

if (OUT) {
  const outPath = resolve(OUT);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\nfull report written to ${outPath}`);
}

console.log('\ntearing down...');
await Promise.all(clients.map((c) => c.close()));
console.log('done.');
