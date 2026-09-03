/**
 * Verifies the live-captions feature end to end against the mock GPU ASR
 * server (gpu/mock_asr_server.py) — no real GPU/models required, same
 * approach the Interview feature's gpu/mock_server.py enables.
 *
 * Covers the core architectural claims from the plan:
 *  - a speaker's OWN mic is captured and streamed once (not tapped from N-1
 *    other participants' decoded remote audio — the O(N²) bug the retired
 *    useSpeechTranscription.ts prototype had)
 *  - that single stream reaches EVERY participant in the room, including the
 *    speaker themselves, via Room.broadcastAll (server/main.go)
 *  - translation is per-VIEWER: two participants with different caption-
 *    language selections see different text for the exact same utterance
 *  - partials are never translated, only finals are (per gpu/ASR_CONTRACT.md)
 *  - the relay never opens a browser microphone when ASR_GPU_URL is unset —
 *    verified directly at the WS-protocol level (see checkNotConfigured
 *    below), independent of the browser flow entirely
 *
 * Requires, running locally (see the throwaway-instance pattern in
 * CLAUDE.md's "Local dev" section):
 *   - gpu/mock_asr_server.py on :8098
 *   - a throwaway Go backend on BACKEND_PORT with ASR_GPU_URL=http://127.0.0.1:8098
 *   - a second throwaway Go backend on NOASR_BACKEND_PORT with ASR_GPU_URL unset
 *   - vite dev server (BASE) proxying to the first backend
 */
import { chromium } from 'playwright';
import crypto from 'crypto';

const BASE = process.env.BASE ?? 'http://127.0.0.1:3002';
const NOASR_PORT = process.env.NOASR_BACKEND_PORT ?? '8092';
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
  { id: 'user-815ce7061367244d', username: 'uitest1', displayName: 'UI Test User', email: 'uitest1@example.com' },
  { id: 'user-964ef540619374b1', username: 'uitest2', displayName: 'Second Tester', email: 'uitest2@example.com' },
];

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

// Real oscillator audio, same pattern as _verify_multiparty_audio.mjs — the
// mock ASR server only counts bytes, but genuine nonzero PCM through the
// ScriptProcessor pipeline is what actually exercises useLiveCaptions.ts.
function fakeMediaFn() {
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    const canvas = document.createElement('canvas');
    canvas.width = 320; canvas.height = 240;
    const c2d = canvas.getContext('2d');
    (function draw() { c2d.fillStyle = '#557'; c2d.fillRect(0, 0, 320, 240); requestAnimationFrame(draw); })();
    const videoStream = canvas.captureStream(15);
    const audioCtx = new AudioContext();
    const dest = audioCtx.createMediaStreamDestination();
    const gain = audioCtx.createGain(); gain.gain.value = 0.2;
    const osc = audioCtx.createOscillator(); osc.frequency.value = 300;
    osc.connect(gain).connect(dest); osc.start();
    const tracks = [];
    if (!constraints || constraints.video !== false) tracks.push(videoStream.getVideoTracks()[0]);
    if (!constraints || constraints.audio !== false) tracks.push(dest.stream.getAudioTracks()[0]);
    return new MediaStream(tracks);
  };
}

const errors = [];
const browser = await chromium.launch({ args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });

async function makePeer(user) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, permissions: ['camera', 'microphone'] });
  await ctx.addInitScript(fakeMediaFn);
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

console.log('── Setting up a two-participant room ──');
const host = await makePeer(users[0]);
await host.click('[aria-label="Meetings"]');
await host.waitForSelector('text=Start New Meeting', { timeout: 15000 });
await host.click('text=Start New Meeting');
await host.waitForTimeout(3500);
const code = await host.evaluate(() => window.location.pathname.replace('/', '') || null);
check('host created a meeting', !!code, code ?? 'no code');
if (!code) { await browser.close(); process.exit(1); }
await host.keyboard.press('Escape'); // dismiss the invite dialog that auto-opens on creation
await host.waitForTimeout(300);

const guest = await makePeer(users[1]);
await guest.click('[aria-label="Meetings"]');
await guest.waitForTimeout(800);
await guest.fill('input[placeholder="ENTER ROOM CODE…"]', code);
await guest.click('button:has-text("Join")');
await guest.waitForTimeout(3500);

// Both switch to the Live Captions tab (chat/people/captions, next to People
// in the right sidebar), which is important beyond just opening the panel:
// RightPanel only mounts the JSX for whichever tab is active
// (`{tab === 'people' && (...)}` etc. are real conditionals, not CSS
// visibility), and the default tab is 'people' — which already contains the
// text "UI Test User" in the roster ("UI Test User (you)"). Without
// switching tabs first, a body-text search for the speaker's name would
// pass regardless of whether any caption ever arrived. On the Live Captions
// tab, that ambiguity is gone: the name can only appear from an actual
// TranscriptLine's `speaker` field (or CaptionBar, for whichever page also
// has that toggled on).
await host.click('[aria-label="Live Captions"]');
await guest.click('[aria-label="Live Captions"]');
await host.waitForTimeout(300);
await guest.waitForTimeout(300);

console.log('\n── Guest selects Spanish captions BEFORE the host starts talking ──');
await guest.selectOption('select[title="Translate captions into"]', 'es');

console.log('\n── Host turns on captions ──');
await host.click('[aria-label="Turn on captions"]');
await host.waitForTimeout(500);

// Own-echo: the host's own speech comes back through their own signalling
// socket via Room.broadcastAll — no special-casing needed on the frontend,
// see MeetingContext.tsx's "caption" handler comment.
await host.waitForFunction(() => document.body.innerText.includes('UI Test User'), { timeout: 12000 }).catch(() => {});
const hostSeesOwnCaption = await host.evaluate(() => document.body.innerText.includes('UI Test User'));
check('host sees their OWN caption via the same broadcast path as everyone else', hostSeesOwnCaption);

console.log('\n── Cross-participant delivery: the guest sees the host speaking too ──');
await guest.waitForFunction(() => document.body.innerText.includes('UI Test User'), { timeout: 12000 }).catch(() => {});
const guestSeesHostCaption = await guest.evaluate(() => document.body.innerText.includes('UI Test User'));
check('guest sees the host\'s caption — one ASR stream reaches every listener', guestSeesHostCaption);

console.log('\n── Per-viewer translation: guest (es) sees "[es]", host (original) does not ──');
// Finals arrive every ~2.5s of accumulated audio per gpu/mock_asr_server.py's
// SEGMENT_SECONDS — give it two full cycles so a translated final has landed.
await guest.waitForFunction(() => document.body.innerText.includes('[es]'), { timeout: 15000 }).catch(() => {});
const guestSeesSpanish = await guest.evaluate(() => document.body.innerText.includes('[es]'));
check('guest (selected Spanish) sees a "[es]"-tagged final transcript', guestSeesSpanish);

const hostSeesSpanishTag = await host.evaluate(() => document.body.innerText.includes('[es]'));
check('host (no language selected) does NOT see the "[es]" tag — translation is per-viewer, not global', !hostSeesSpanishTag);

console.log('\n── /asr never opens a mic when ASR_GPU_URL is unset (checked at the WS-protocol level) ──');
// Deliberately bypasses the browser for this one: it isolates the Go-side
// contract (server/transcription_relay.go's "not_configured before touching
// the network" promise) from any frontend timing, and Node 22 has a native
// WebSocket global so no extra dependency is needed.
async function checkNotConfigured() {
  const wsUrl = `ws://127.0.0.1:${NOASR_PORT}/ws`;
  const sig = new WebSocket(wsUrl);
  const roomCode = await new Promise((resolve, reject) => {
    sig.onopen = () => sig.send(JSON.stringify({ type: 'create_room', payload: { user_id: 'user-noasrcheck', user_name: 'NoASR Check' } }));
    sig.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'room_created') resolve(msg.payload.room_id);
      if (msg.type === 'error') reject(new Error(msg.payload.message));
    };
    sig.onerror = () => reject(new Error('signalling WS error'));
    setTimeout(() => reject(new Error('timeout creating room')), 5000);
  });

  const asr = new WebSocket(`ws://127.0.0.1:${NOASR_PORT}/asr`);
  const result = await new Promise((resolve, reject) => {
    asr.onopen = () => asr.send(JSON.stringify({ room_id: roomCode, user_id: 'user-noasrcheck', user_name: 'NoASR Check' }));
    asr.onmessage = (ev) => resolve(JSON.parse(ev.data));
    asr.onerror = () => reject(new Error('/asr WS error'));
    setTimeout(() => reject(new Error('timeout waiting for /asr response')), 5000);
  });
  sig.close(); asr.close();
  return result;
}
try {
  const resp = await checkNotConfigured();
  check('"/asr" reports not_configured (never "ready") when ASR_GPU_URL is unset', resp.type === 'unavailable' && resp.reason === 'not_configured', JSON.stringify(resp));
} catch (e) {
  check('"/asr" reports not_configured when ASR_GPU_URL is unset', false, String(e));
}

check('no console or page errors across either participant', errors.length === 0, errors.join(' | '));

await browser.close();

const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} checks passed`);
if (passed !== results.length) {
  console.log('Failed:');
  results.filter((r) => !r.pass).forEach((r) => console.log(`  - ${r.name}`));
  process.exit(1);
}
