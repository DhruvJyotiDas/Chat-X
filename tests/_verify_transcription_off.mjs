// Verifies the transcription feature is fully off in the in-call UI:
// no desktop transcript sidebar, no Transcript tab/toolbar button, no /asr socket,
// and the room code + copy-link controls survived the sidebar removal.
import { chromium } from 'playwright';
import crypto from 'crypto';

const BASE = process.env.BASE || 'http://127.0.0.1:3100';
const SHOTS = '/tmp/claude-1001/-home-ubuntu/52e9ddae-f949-4872-a25e-a5501ee7cb94/scratchpad';

function b64url(i) { return Buffer.from(i).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_'); }
function signHS256(payload, secret) {
  const h = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${h}.${p}.${sig}`;
}
const JWT_SECRET = (process.env.IBCONNECT_JWT_SECRET
  ?? 'ibconnect_jwt_secret_prod_2024_change_me')  // legacy fallback: the backend now requires IBCONNECT_JWT_SECRET, so export it to test a deployed build;
const exp = Math.floor(Date.now() / 1000) + 3600;
const t1 = signHS256({ userId: 'user-815ce7061367244d', exp }, JWT_SECRET);
const USER1 = JSON.stringify({ id: 'user-815ce7061367244d', username: 'uitest1', displayName: 'UI Test User', email: 'uitest1@example.com' });

function fakeMedia() {
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    const canvas = document.createElement('canvas');
    canvas.width = 320; canvas.height = 240;
    const ctx = canvas.getContext('2d');
    (function draw() { ctx.fillStyle = '#e63946'; ctx.fillRect(0, 0, 320, 240); requestAnimationFrame(draw); })();
    const v = canvas.captureStream(15);
    const ac = new AudioContext();
    const dest = ac.createMediaStreamDestination();
    const osc = ac.createOscillator(); const g = ac.createGain(); g.gain.value = 0.0001;
    osc.connect(g).connect(dest); osc.start();
    const tracks = [];
    if (!constraints || constraints.video !== false) tracks.push(v.getVideoTracks()[0]);
    if (!constraints || constraints.audio !== false) tracks.push(dest.stream.getAudioTracks()[0]);
    return new MediaStream(tracks);
  };
  // Record every WebSocket URL the page opens so we can prove /asr is never touched.
  window.__wsUrls = [];
  const OrigWS = window.WebSocket;
  window.WebSocket = function (url, protocols) { window.__wsUrls.push(String(url)); return new OrigWS(url, protocols); };
  window.WebSocket.prototype = OrigWS.prototype;
  Object.assign(window.WebSocket, OrigWS);
}

const results = [];
const check = (name, pass, detail = '') => { results.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); };

const browser = await chromium.launch({ args: ['--no-sandbox', '--use-fake-ui-for-media-stream'] });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
await ctx.addInitScript(fakeMedia);
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

await page.goto(BASE + '/');
await page.evaluate(({ token, user }) => {
  localStorage.setItem('ibconnect_jwt', token);
  localStorage.setItem('ibconnect_me', user);
}, { token: t1, user: USER1 });
await page.reload();
await page.waitForTimeout(1500);

await page.click('[aria-label="Meetings"]');
await page.waitForSelector('text=Start New Meeting', { timeout: 15000 });
await page.click('text=Start New Meeting');
await page.waitForTimeout(5000);

const roomId = await page.evaluate(() => window.location.pathname.replace('/', ''));
if (!roomId) throw new Error('no room code — meeting did not start');
console.log('Room code:', roomId);

// Dismiss the host invite dialog so it doesn't cover the stage.
const closeBtn = page.locator('button:has-text("Got it"), button[aria-label="Close"]').first();
if (await closeBtn.count()) { await closeBtn.click().catch(() => {}); }
await page.keyboard.press('Escape').catch(() => {});
await page.waitForTimeout(800);

// ── Desktop (1400x900) ──────────────────────────────────────────────────────
await page.screenshot({ path: `${SHOTS}/off-desktop.png` });

check('no "Live Transcript" sidebar heading', await page.locator('text=Live Transcript').count() === 0);
check('no "Hindi2Hinglish ASR" label', await page.locator('text=Hindi2Hinglish').count() === 0);
check('no Transcribe button', await page.locator('button:has-text("Transcribe")').count() === 0);
check('no "Click Transcribe to begin" placeholder', await page.locator('text=Click Transcribe to begin').count() === 0);
check('no Transcript toolbar button', await page.locator('[title="Transcript"]').count() === 0);

// Room code + copy controls survived the sidebar removal
check('room code visible on desktop', (await page.locator(`text=${roomId}`).count()) > 0);
const copyCodeBtn = page.locator('[aria-label="Copy room code"]');
const copyLinkBtn = page.locator('[aria-label="Copy join link"]');
check('copy-room-code button present', await copyCodeBtn.count() === 1);
check('copy-join-link button present', await copyLinkBtn.count() === 1);
const cc = await copyCodeBtn.boundingBox();
const cl = await copyLinkBtn.boundingBox();
check('copy buttons are on-screen and non-zero', !!cc && !!cl && cc.width > 0 && cl.width > 0,
  cc && cl ? `code ${Math.round(cc.width)}x${Math.round(cc.height)} @${Math.round(cc.x)}, link @${Math.round(cl.x)}` : 'missing');

// The video stage should now start at the very left edge (no 288px sidebar eating it).
const stageLeft = await page.evaluate(() => {
  const vids = [...document.querySelectorAll('video')];
  if (!vids.length) return null;
  return Math.min(...vids.map(v => v.getBoundingClientRect().left));
});
check('video stage no longer offset by a 288px sidebar', stageLeft !== null && stageLeft < 288, `leftmost video x=${stageLeft}`);

// ── Right panel tabs ────────────────────────────────────────────────────────
await page.click('[title="People"]');
await page.waitForTimeout(600);
const tabTexts = await page.locator('button:has-text("Chat"), button:has-text("People")').count();
check('right panel opens', tabTexts > 0);
check('no Transcript tab in right panel', await page.locator('button:has-text("Transcript")').count() === 0);
await page.screenshot({ path: `${SHOTS}/off-desktop-panel.png` });
await page.click('[title="People"]');
await page.waitForTimeout(400);

// ── Mobile (390x844) ────────────────────────────────────────────────────────
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(1200);
await page.screenshot({ path: `${SHOTS}/off-mobile.png` });
check('mobile: no Transcript toolbar button', await page.locator('[title="Transcript"]').count() === 0);
check('mobile: room code still visible', (await page.locator(`text=${roomId}`).count()) > 0);
const noHScroll = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
check('mobile: no page horizontal scroll', noHScroll);
const badgeBox = await page.locator('[aria-label="Copy join link"]').boundingBox();
check('mobile: copy-link button inside viewport', !!badgeBox && badgeBox.x + badgeBox.width <= 390,
  badgeBox ? `right edge ${Math.round(badgeBox.x + badgeBox.width)}px` : 'missing');

// ── No ASR socket ever opened ───────────────────────────────────────────────
const wsUrls = await page.evaluate(() => window.__wsUrls || []);
check('no /asr WebSocket opened', !wsUrls.some(u => u.includes('/asr')), wsUrls.join(', ') || 'none');

check('no page/console errors', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
const failed = results.filter(r => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
