/**
 * Real verification of the screen-share rebuild: two participants, one
 * shares, confirm the OTHER side sees real decoded screen video as its own
 * tile, confirm the presenter's own camera is unaffected, confirm stopping
 * clears it on both sides, confirm zero console errors throughout.
 */
import { chromium } from 'playwright';
import crypto from 'crypto';

const BASE = process.env.BASE ?? 'http://127.0.0.1:3009';
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

function fakeMediaFn({ camColor, screenColor }) {
  function motionStream(color, w, h) {
    const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    let t = 0;
    (function draw() {
      t += 1;
      ctx.fillStyle = color; ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#ffffff'; ctx.fillRect((t * 3) % w, (t * 2) % h, 40, 40);
      requestAnimationFrame(draw);
    })();
    return canvas.captureStream(15);
  }
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    const videoStream = motionStream(camColor, 320, 240);
    const audioCtx = new AudioContext();
    const dest = audioCtx.createMediaStreamDestination();
    const osc = audioCtx.createOscillator(); const g = audioCtx.createGain(); g.gain.value = 0.02;
    osc.connect(g).connect(dest); osc.start();
    const tracks = [];
    if (!constraints || constraints.video !== false) tracks.push(videoStream.getVideoTracks()[0]);
    if (!constraints || constraints.audio !== false) tracks.push(dest.stream.getAudioTracks()[0]);
    return new MediaStream(tracks);
  };
  navigator.mediaDevices.getDisplayMedia = async () => {
    const screenStream = motionStream(screenColor, 640, 400);
    return new MediaStream([screenStream.getVideoTracks()[0]]);
  };
}

const errors = [];
const browser = await chromium.launch({ args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });

async function makePeer(user, camColor, screenColor) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, permissions: ['camera', 'microphone'] });
  await ctx.addInitScript(fakeMediaFn, { camColor, screenColor });
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

async function tileColor(page) {
  return page.evaluate(() => {
    const videos = Array.from(document.querySelectorAll('video'));
    const colors = [];
    for (const v of videos) {
      if (v.videoWidth === 0) continue;
      const canvas = document.createElement('canvas');
      canvas.width = v.videoWidth; canvas.height = v.videoHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(v, 0, 0);
      const [r, g, b] = ctx.getImageData(5, 5, 1, 1).data;
      colors.push([r, g, b]);
    }
    return colors;
  });
}
// Lossy VP8 compression shifts exact RGB values slightly — real video, not a
// bug — so this checks "close to" the expected color, not an exact hex match.
function hasApproxColor(colors, [er, eg, eb], tolerance = 20) {
  return colors.some(([r, g, b]) => Math.abs(r - er) <= tolerance && Math.abs(g - eg) <= tolerance && Math.abs(b - eb) <= tolerance);
}

console.log('── Host creates a meeting, guest joins ──');
const host = await makePeer({ id: 'user-ss-host', username: 'sshost', displayName: 'SS Host', email: 'a@a.com' }, '#8b0000', '#00274d');
await host.click('[aria-label="Meetings"]');
await host.waitForSelector('text=Start New Meeting', { timeout: 15000 });
await host.click('text=Start New Meeting');
await host.waitForTimeout(4000);
const code = await host.evaluate(() => window.location.pathname.replace('/', '') || null);
check('host created a meeting', !!code, code ?? 'no code');
await host.keyboard.press('Escape').catch(() => {});
await host.waitForTimeout(300);

const guest = await makePeer({ id: 'user-ss-guest', username: 'ssguest', displayName: 'SS Guest', email: 'b@b.com' }, '#1a5d1a', '#4d1a4d');
await guest.click('[aria-label="Meetings"]');
await guest.waitForTimeout(800);
await guest.fill('input[placeholder="ENTER ROOM CODE…"]', code);
await guest.click('button:has-text("Join")');
await guest.waitForTimeout(4000);

const guestVideosBefore = await host.evaluate(() => document.querySelectorAll('video').length);
check('both connected before screen share (2 videos on host side)', guestVideosBefore >= 2, `count=${guestVideosBefore}`);

console.log('\n── Host starts screen share ──');
await host.locator('[aria-label="Share screen"]').first().click();
await host.waitForTimeout(2500);

// title/aria-label are attributes, not visible text — innerText won't see
// them; check the real accessible name instead of guessing at visible copy.
const hostIsSharing = (await host.locator('[aria-label="Stop sharing"]').count()) > 0;
check('host UI reflects isScreenSharing (control\'s accessible name is now "Stop sharing")', hostIsSharing);

console.log('\n── Guest should now see a real decoded screen-share tile ──');
await guest.waitForTimeout(1500);
const guestVideoCountDuring = await guest.evaluate(() => document.querySelectorAll('video').length);
check('guest now has 3 <video> elements (own cam + host cam + host screen)', guestVideoCountDuring >= 3, `count=${guestVideoCountDuring}`);
const guestColors = await tileColor(guest);
const seesScreenColor = hasApproxColor(guestColors, [0x00, 0x27, 0x4d]);
check('guest decodes the REAL screen-share color (~#00274d), not a stale/black frame', seesScreenColor, JSON.stringify(guestColors));
const stillSeesHostCam = hasApproxColor(guestColors, [0x8b, 0x00, 0x00]);
check('guest\'s view of the host\'s CAMERA is unaffected — still decodes ~#8b0000 too', stillSeesHostCam, JSON.stringify(guestColors));

console.log('\n── Host stops screen share ──');
await host.locator('[aria-label="Stop sharing"]').first().click();
await host.waitForTimeout(2000);
const hostStoppedSharing = (await host.locator('[aria-label="Share screen"]').count()) > 0
  && (await host.locator('[aria-label="Stop sharing"]').count()) === 0;
check('host UI reflects stop (control\'s accessible name is "Share screen" again)', hostStoppedSharing);

// Poll rather than a single fixed wait — distinguishes "transient re-render
// lag" from "genuinely stuck" instead of guessing at one timeout value.
let guestVideoCountAfter = null;
for (let i = 0; i < 10; i++) {
  await guest.waitForTimeout(1000);
  guestVideoCountAfter = await guest.evaluate(() => document.querySelectorAll('video').length);
  if (guestVideoCountAfter === guestVideosBefore) break;
}
check(`guest's screen-share tile is gone after host stops (polled up to 10s, back to ${guestVideosBefore} videos)`, guestVideoCountAfter === guestVideosBefore, `count=${guestVideoCountAfter}`);
if (guestVideoCountAfter !== guestVideosBefore) {
  const debug = await guest.evaluate(() => {
    const videos = Array.from(document.querySelectorAll('video'));
    return videos.map((v) => {
      const rect = v.getBoundingClientRect();
      return {
        srcObjectActive: v.srcObject ? v.srcObject.active : null,
        tracks: v.srcObject ? v.srcObject.getTracks().map(t => ({ kind: t.kind, readyState: t.readyState, muted: t.muted, enabled: t.enabled })) : null,
        w: v.videoWidth, h: v.videoHeight,
        rectW: rect.width, rectH: rect.height, visible: rect.width > 0 && rect.height > 0,
        classes: v.className, parentClasses: v.parentElement ? v.parentElement.className : null,
        ancestorHTML: v.closest('[class*="hidden"]') ? 'INSIDE a hidden-class ancestor' : 'no hidden ancestor found',
      };
    });
  });
  console.log('  debug (stale-tile investigation):', JSON.stringify(debug, null, 2));
}

check('no console or page errors across either participant', errors.length === 0, errors.slice(0, 6).join(' | '));

await browser.close();
const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} checks passed`);
if (passed !== results.length) {
  console.log('Failed:');
  results.filter((r) => !r.pass).forEach((r) => console.log(`  - ${r.name}`));
}
