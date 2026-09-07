// Verifies the specific bug reported: the on-screen CaptionBar (movie-
// subtitle overlay) used to be gated on THIS participant's own `transcribing`
// toggle, so only the person who clicked "Turn on captions" ever saw it —
// everyone else in the room saw nothing on screen even though the caption
// data was already being broadcast to them. Fixed by rendering CaptionBar
// unconditionally (it already self-hides when there's nothing to show).
// This script checks the GUEST, who NEVER touches the captions toggle,
// still sees the on-screen bar once the HOST turns captions on and speaks.
import { chromium } from 'playwright';
import crypto from 'crypto';

const BASE = process.env.BASE ?? 'http://127.0.0.1:3102';
const JWT_SECRET = process.env.IBCONNECT_JWT_SECRET;

const exp = Math.floor(Date.now() / 1000) + 3600;
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
const check = (name, pass, detail = '') => { results.push({ name, pass }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); };

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

const host = await makePeer(users[0]);
await host.click('[aria-label="Meetings"]');
await host.waitForSelector('text=Start New Meeting', { timeout: 15000 });
await host.click('text=Start New Meeting');
await host.waitForTimeout(3500);
const code = await host.evaluate(() => window.location.pathname.replace('/', '') || null);
check('host created a meeting', !!code, code ?? 'no code');
if (!code) { await browser.close(); process.exit(1); }
await host.keyboard.press('Escape');
await host.waitForTimeout(300);

const guest = await makePeer(users[1]);
await guest.click('[aria-label="Meetings"]');
await guest.waitForTimeout(800);
await guest.fill('input[placeholder="ENTER ROOM CODE…"]', code);
await guest.click('button:has-text("Join")');
await guest.waitForTimeout(3500);

// Host turns captions on. GUEST NEVER TOUCHES THE CAPTIONS TOGGLE AT ALL —
// this is the whole point of the check.
await host.click('[aria-label="Turn on captions"]');
await host.waitForTimeout(500);

const guestNeverToggledCaptions = await guest.evaluate(() =>
  !document.body.innerText.includes('Turn off captions')
);
check('guest never turned their own captions on', guestNeverToggledCaptions);

// Wait for a real on-screen caption bubble (CaptionBar's own markup) to show
// up on the GUEST's screen — not just the sidebar transcript panel text.
await guest.waitForSelector('div.bg-black\\/80', { timeout: 20000 }).catch(() => {});
const guestCaptionBarCount = await guest.locator('div.bg-black\\/80').count();
check('guest sees the on-screen CaptionBar even though THEY never toggled captions on', guestCaptionBarCount > 0, `count=${guestCaptionBarCount}`);

const guestCaptionBarText = guestCaptionBarCount > 0 ? await guest.locator('div.bg-black\\/80').first().innerText() : '';
check('the guest\'s on-screen caption bar shows real speech text, not empty', guestCaptionBarText.trim().length > 3, JSON.stringify(guestCaptionBarText));

// Host, who DID turn captions on, should also see their own bar (sanity check
// this wasn't broken by removing the old gating).
await host.waitForSelector('div.bg-black\\/80', { timeout: 20000 }).catch(() => {});
const hostCaptionBarCount = await host.locator('div.bg-black\\/80').count();
check('host (who turned captions on) still sees their own on-screen CaptionBar', hostCaptionBarCount > 0, `count=${hostCaptionBarCount}`);

check('no console or page errors', errors.length === 0, errors.join(' | '));

console.log(`\n${results.filter(r => r.pass).length}/${results.length} passed`);
await browser.close();
process.exit(results.every(r => r.pass) ? 0 : 1);
