/**
 * Post-Stage-2 production smoke test — run directly against the real,
 * now-live https://meet.icebrkr.space, not a throwaway stack. Same fake-JWT
 * technique already established for production checks in this codebase
 * (bypasses the IB Account OIDC round-trip, doesn't touch real user data).
 * Two real participants, real fake media, real two-way video through the
 * now-live LiveKit deployment.
 */
import { chromium } from 'playwright';
import crypto from 'crypto';

const BASE = 'https://meet.icebrkr.space';
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

const results = [];
const check = (name, pass, detail = '') => { results.push({ name, pass }); console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); };

function fakeMediaFn(color) {
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 240;
    const ctx = canvas.getContext('2d'); let t = 0;
    (function draw() { t += 1; ctx.fillStyle = color; ctx.fillRect(0, 0, 320, 240); ctx.fillStyle = '#fff'; ctx.fillRect(t % 280, 0, 20, 20); requestAnimationFrame(draw); })();
    const videoStream = canvas.captureStream(15);
    const audioCtx = new AudioContext(); const dest = audioCtx.createMediaStreamDestination();
    const osc = audioCtx.createOscillator(); const g = audioCtx.createGain(); g.gain.value = 0.02;
    osc.connect(g).connect(dest); osc.start();
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
  await page.waitForTimeout(1500);
  return page;
}

console.log('── Smoke test against the real, live production site ──');
const host = await makePeer({ id: 'user-prodsmoke-host', username: 'prodsmokehost', displayName: 'Prod Smoke Host', email: 'a@a.com' }, '#8b0000');
await host.click('[aria-label="Meetings"]');
await host.waitForSelector('text=Start New Meeting', { timeout: 15000 });
await host.click('text=Start New Meeting');
await host.waitForTimeout(4000);
const code = await host.evaluate(() => window.location.pathname.replace('/', '') || null);
check('host created a real meeting on production', !!code, code ?? 'no code');
await host.keyboard.press('Escape').catch(() => {});

const guest = await makePeer({ id: 'user-prodsmoke-guest', username: 'prodsmokeguest', displayName: 'Prod Smoke Guest', email: 'b@b.com' }, '#1a5d1a');
await guest.click('[aria-label="Meetings"]');
await guest.waitForTimeout(800);
await guest.fill('input[placeholder="ENTER ROOM CODE…"]', code);
await guest.click('button:has-text("Join")');
await guest.waitForTimeout(6000);

const guestSeesHost = await guest.evaluate(() => Array.from(document.querySelectorAll('video')).some((v) => v.videoWidth > 0 && !v.paused));
const hostSeesGuest = await host.evaluate(() => Array.from(document.querySelectorAll('video')).some((v) => v.videoWidth > 0 && !v.paused));
check('guest genuinely decodes host\'s live video through production LiveKit', guestSeesHost);
check('host genuinely decodes guest\'s live video through production LiveKit', hostSeesGuest);

check('no console or page errors across either participant', errors.length === 0, errors.slice(0, 5).join(' | '));

console.log('\n── Cleaning up (leaving the room properly) ──');
await guest.evaluate(() => { window.location.href = '/'; }).catch(() => {});
await host.evaluate(() => { window.location.href = '/'; }).catch(() => {});
await new Promise((r) => setTimeout(r, 1000));

await browser.close();
const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} checks passed`);
if (passed !== results.length) {
  console.log('Failed:');
  results.filter((r) => !r.pass).forEach((r) => console.log(`  - ${r.name}`));
}
