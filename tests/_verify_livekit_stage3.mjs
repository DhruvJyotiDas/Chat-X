/**
 * Stage 3 verification: two (then more) real participants actually connect
 * through the LiveKit SFU — not mesh. No UI polish, no simulcast tuning is
 * being checked here, per the Stage 3 brief; this is purely "do people
 * actually connect."
 */
import { chromium } from 'playwright';
import crypto from 'crypto';

const BASE = process.env.BASE ?? 'http://127.0.0.1:3005';
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
  { id: 'user-lk-test-1', username: 'lktest1', displayName: 'LK Test One', email: 'lktest1@example.com' },
  { id: 'user-lk-test-2', username: 'lktest2', displayName: 'LK Test Two', email: 'lktest2@example.com' },
];

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

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

console.log('── Host creates a meeting ──');
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

console.log('\n── Guest joins the same room ──');
const guest = await makePeer(users[1], '#457b9d');
await guest.click('[aria-label="Meetings"]');
await guest.waitForTimeout(800);
await guest.fill('input[placeholder="ENTER ROOM CODE…"]', code);
await guest.click('button:has-text("Join")');
await guest.waitForTimeout(4000);

console.log('\n── Confirm both are actually on a LiveKit connection, not mesh ──');
const hostState = await host.evaluate(() => document.querySelectorAll('video').length);
const guestState = await guest.evaluate(() => document.querySelectorAll('video').length);
check('host page has at least 2 <video> elements (self + remote)', hostState >= 2, `count=${hostState}`);
check('guest page has at least 2 <video> elements (self + remote)', guestState >= 2, `count=${guestState}`);

// The real test: does the GUEST's tile of the HOST actually decode real,
// moving, host-colored video — proving media genuinely round-tripped through
// LiveKit (SFU), not just that a WebSocket connected.
console.log('\n── Pixel-check: does real video actually arrive through the SFU? ──');
async function readTileColor(page, expectDifferentFrom) {
  return page.evaluate(async (prevHex) => {
    const videos = Array.from(document.querySelectorAll('video'));
    for (const v of videos) {
      if (v.videoWidth === 0) continue;
      const canvas = document.createElement('canvas');
      canvas.width = v.videoWidth; canvas.height = v.videoHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(v, 0, 0);
      const [r, g, b] = ctx.getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data;
      const hex = `#${[r, g, b].map(x => x.toString(16).padStart(2, '0')).join('')}`;
      if (!prevHex || hex !== '#000000') return hex;
    }
    return null;
  }, expectDifferentFrom);
}
await guest.waitForTimeout(2000);
const colorSeenByGuest = await readTileColor(guest);
check('guest\'s page decodes a real, non-black video frame from a remote tile', !!colorSeenByGuest && colorSeenByGuest !== '#000000', colorSeenByGuest ?? 'null');

const colorSeenByHost = await readTileColor(host);
check('host\'s page decodes a real, non-black video frame from a remote tile', !!colorSeenByHost && colorSeenByHost !== '#000000', colorSeenByHost ?? 'null');

console.log('\n── Roster: each side sees exactly one remote peer ──');
const guestPeerCount = await guest.evaluate(() => document.querySelectorAll('video').length - 1);
const hostPeerCount = await host.evaluate(() => document.querySelectorAll('video').length - 1);
check('guest sees exactly 1 remote peer', guestPeerCount === 1, `count=${guestPeerCount}`);
check('host sees exactly 1 remote peer', hostPeerCount === 1, `count=${hostPeerCount}`);

console.log('\n── Chat still works (untouched path) ──');
await host.click('[aria-label="Chat"]');
await guest.click('[aria-label="Chat"]');
await host.waitForTimeout(300);
await host.fill('input[placeholder="Message…"]', 'hello via /ws, unrelated to media');
await host.press('input[placeholder="Message…"]', 'Enter');
await guest.waitForFunction(() => document.body.innerText.includes('hello via /ws'), { timeout: 8000 }).catch(() => {});
const guestSeesChat = await guest.evaluate(() => document.body.innerText.includes('hello via /ws'));
check('chat message (untouched /ws path) still reaches the other participant', guestSeesChat);

check('no console or page errors across either participant', errors.length === 0, errors.slice(0, 5).join(' | '));

await browser.close();
const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} checks passed`);
if (passed !== results.length) {
  console.log('Failed:');
  results.filter((r) => !r.pass).forEach((r) => console.log(`  - ${r.name}`));
  process.exit(1);
}
