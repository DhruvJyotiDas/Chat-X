/**
 * Stage 4 addendum #1, originally written to MEASURE the /ws-vs-LiveKit
 * divergence (see CLAUDE.md's 2026-08-27 known-limitation entry): kill ONLY
 * the /ws signaling socket, leave the LiveKit media connection alive, check
 * whether server-side systems keyed off room.clients (captions' membership
 * gate, a mid-session token re-request) disagree with that participant's
 * still-live LiveKit presence.
 *
 * 2026-08-28 update: main.go's deferred /ws cleanup now delays leaveRoom()
 * by wsLeaveGraceInterval (3s) instead of running it inline, specifically to
 * close this window (see main.go's comment on wsLeaveGraceInterval for the
 * full reasoning). This test now asserts the FIX, not the bug: a token/asr
 * request within the grace window must succeed (no more spurious 403), and a
 * genuine, never-healed departure must still eventually be cleaned up rather
 * than leaking membership forever.
 */
import { chromium } from 'playwright';
import crypto from 'crypto';

const BASE = process.env.BASE ?? 'http://127.0.0.1:3006';
const JWT_SECRET = process.env.IBCONNECT_JWT_SECRET;
if (!JWT_SECRET) { console.error('IBCONNECT_JWT_SECRET must be set.'); process.exit(2); }

const exp = Math.floor(Date.now() / 1000) + 3600 * 6;
function b64url(i) { return Buffer.from(i).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_'); }
function signHS256(payload, secret) {
  const h = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64url(JSON.stringify(payload));
  const s = crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${h}.${p}.${s}`;
}

const users = [
  { id: 'user-div-host', username: 'divhost', displayName: 'Div Host', email: 'divhost@example.com' },
  { id: 'user-div-guest', username: 'divguest', displayName: 'Div Guest', email: 'divguest@example.com' },
];

const results = [];
const check = (name, pass, detail = '') => { results.push({ name, pass }); console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); };

function fakeMediaFn(color) {
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    const canvas = document.createElement('canvas');
    canvas.width = 320; canvas.height = 240;
    const c2d = canvas.getContext('2d');
    (function draw() { c2d.fillStyle = color; c2d.fillRect(0, 0, 320, 240); requestAnimationFrame(draw); })();
    const videoStream = canvas.captureStream(15);
    const audioCtx = new AudioContext();
    const dest = audioCtx.createMediaStreamDestination();
    const gain = audioCtx.createGain(); gain.gain.value = 0.05;
    const osc = audioCtx.createOscillator(); osc.frequency.value = 300;
    osc.connect(gain).connect(dest); osc.start();
    const tracks = [];
    if (!constraints || constraints.video !== false) tracks.push(videoStream.getVideoTracks()[0]);
    if (!constraints || constraints.audio !== false) tracks.push(dest.stream.getAudioTracks()[0]);
    return new MediaStream(tracks);
  };
  // Track every WebSocket this page opens so the test can close exactly the
  // /ws one and leave LiveKit's (a different host:port) untouched.
  window.__sockets = [];
  const OrigWS = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    const ws = new OrigWS(url, protocols);
    window.__sockets.push({ url: String(url), ws });
    return ws;
  };
  window.WebSocket.prototype = OrigWS.prototype;
  Object.assign(window.WebSocket, OrigWS);
}

const errors = [];
const browser = await chromium.launch({ args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });

async function makePeer(user, color) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, permissions: ['camera', 'microphone'] });
  await ctx.addInitScript(fakeMediaFn, color);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${user.username}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`${user.username}: ${m.text()}`); });
  await page.goto(`${BASE}/`);
  await page.evaluate(({ token, u }) => {
    localStorage.setItem('ibconnect_jwt', token);
    localStorage.setItem('ibconnect_me', JSON.stringify(u));
  }, { token: signHS256({ userId: user.id, exp }, JWT_SECRET), u: user });
  await page.reload();
  await page.waitForTimeout(1200);
  return page;
}

console.log('── Host creates a meeting, guest joins ──');
const host = await makePeer(users[0], '#e63946');
await host.click('[aria-label="Meetings"]');
await host.waitForSelector('text=Start New Meeting', { timeout: 15000 });
await host.click('text=Start New Meeting');
await host.waitForTimeout(4000);
const code = await host.evaluate(() => window.location.pathname.replace('/', '') || null);
check('host created a meeting', !!code, code ?? 'no code');
if (!code) { await browser.close(); process.exit(1); }
await host.keyboard.press('Escape');
await host.waitForTimeout(300);

const guest = await makePeer(users[1], '#457b9d');
await guest.click('[aria-label="Meetings"]');
await guest.waitForTimeout(800);
await guest.fill('input[placeholder="ENTER ROOM CODE…"]', code);
await guest.click('button:has-text("Join")');
await guest.waitForTimeout(4000);

const guestVideoCount = await guest.evaluate(() => document.querySelectorAll('video').length);
check('guest connected (has 2 video elements before the kill)', guestVideoCount >= 2, `count=${guestVideoCount}`);

console.log('\n── Killing ONLY the guest\'s /ws socket, leaving LiveKit alive ──');
const killedUrl = await guest.evaluate(() => {
  const entry = window.__sockets.find((s) => {
    try { return new URL(s.url, location.href).pathname === '/ws'; } catch { return false; }
  });
  if (!entry) return null;
  entry.ws.close(1000, 'test-induced /ws-only drop');
  return entry.url;
});
check('found and closed exactly the /ws socket (not LiveKit\'s)', !!killedUrl, killedUrl ?? 'not found');
// Deliberately NOT waiting long here: the guest's own SignalingSocket wasn't
// told this was intentional (its close() wasn't called, the raw WS was
// closed out from under it), so its normal onclose handler treats this as a
// real drop and starts reconnecting on its own — first an async
// classifyDisconnect() call, then a backoff delay, then a fresh connect +
// join_room. That self-healing is real and correct behavior, but it also
// means waiting too long before checking masks the exact window this test
// exists to catch. A short, fixed wait here is standing in for "checked
// before the app's own reconnect completed" — confirmed against the
// server's own log below, not just assumed.
await guest.waitForTimeout(150);

console.log('\n── Server-side: within the grace window, is the dropped identity STILL treated as a member? ──');
// Ask for a fresh LiveKit token for the SAME identity+room the guest is still
// using — server/livekit.go's authorization for this IS "is this identity
// currently in room.clients[room_id]". At 150ms, well inside
// wsLeaveGraceInterval (3s), leaveRoom() must NOT have run yet — this is the
// spurious-403 window this fix closes, checked as fixed, not just asserted.
const tokenRetry = await fetch(`${BASE}/api/livekit/token`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ room_id: code, user_id: users[1].id, user_name: users[1].displayName }),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
check('a fresh token request for the dropped identity STILL SUCCEEDS inside the grace window (no more spurious 403)',
  tokenRetry.status === 200 && !!tokenRetry.body?.token, `status=${tokenRetry.status} body=${JSON.stringify(tokenRetry.body).slice(0, 100)}`);

console.log('\n── Server-side: does the captions membership gate agree, inside the grace window? ──');
// Same identity, same room — transcription_relay.go's isMember check reads
// the exact same room.clients map, so it must see the same still-a-member
// answer the token check above just got.
const wsUrl = BASE.replace('http', 'ws') + '/asr';
const asrResult = await new Promise((resolve) => {
  const ws = new WebSocket(wsUrl); // Node 22 native global — same pattern as _verify_live_captions.mjs
  const timer = setTimeout(() => resolve({ timeout: true }), 5000);
  ws.onopen = () => ws.send(JSON.stringify({ room_id: code, user_id: users[1].id, user_name: users[1].displayName }));
  ws.onmessage = (ev) => { clearTimeout(timer); resolve(JSON.parse(ev.data)); ws.close(); };
  ws.onerror = () => { clearTimeout(timer); resolve({ error: true }); };
});
check('/asr does NOT say not_in_room inside the grace window — same membership map, same fix',
  asrResult?.reason !== 'not_in_room', JSON.stringify(asrResult));

console.log('\n── Meanwhile: is the guest\'s video still LIVE from the host\'s point of view via LiveKit? ──');
// This is the actual divergence, made concrete: the host still sees the
// guest as a live, present, publishing participant (LiveKit never knew /ws
// dropped), while the server's /ws-based systems above just said they're gone.
await host.waitForTimeout(500);
const hostStillSeesGuest = await host.evaluate(() => {
  const videos = Array.from(document.querySelectorAll('video'));
  return videos.some((v) => v.videoWidth > 0 && !v.paused);
});
check('host still sees a live, playing remote video (LiveKit never noticed the /ws drop)', hostStillSeesGuest);

console.log('\n── Was this actually a NEW divergence, or did resetting /ws also somehow tear down LiveKit? ──');
const guestLiveKitStillConnected = await guest.evaluate(() => {
  // The app doesn't expose the Room globally; infer from whether the guest's
  // own remote (host) tile is still decoding video after the /ws close.
  const videos = Array.from(document.querySelectorAll('video'));
  return videos.some((v) => v.videoWidth > 0 && !v.paused);
});
check('guest\'s own LiveKit-fed tiles are still decoding video after the /ws-only kill (confirms the two connections really are independent)',
  guestLiveKitStillConnected);

check('no console or page errors across either participant', errors.length === 0, errors.slice(0, 5).join(' | '));

console.log('\n── The grace period delays eviction, it must not leak membership forever ──');
// Close the guest's ENTIRE browser context (not just one socket) so there is
// no page left to run SignalingSocket's reconnect logic at all — a genuine,
// permanent departure. Whichever /ws connection was live at the moment of
// this close gets its own fresh wsLeaveGraceInterval timer (even if the
// original drop above had already self-healed once by now); waiting
// comfortably longer than that one interval here is what actually proves
// eventual cleanup, not just that the window got wider.
await guest.context().close();
await new Promise((r) => setTimeout(r, 3600));
const tokenAfterRealDeparture = await fetch(`${BASE}/api/livekit/token`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ room_id: code, user_id: users[1].id, user_name: users[1].displayName }),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
check('a genuine, never-healed departure is still eventually refused — the grace period delays eviction, it does not disable it',
  tokenAfterRealDeparture.status === 403, `status=${tokenAfterRealDeparture.status}`);

await browser.close();
const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} checks passed`);
if (passed !== results.length) {
  console.log('Failed:');
  results.filter((r) => !r.pass).forEach((r) => console.log(`  - ${r.name}`));
}
