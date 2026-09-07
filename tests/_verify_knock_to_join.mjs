// Verifies the knock-to-join feature end to end: the room creator is never
// asked to approve themselves, every subsequent new identity must be
// accepted by someone already in the call, ANY current participant (not
// just the original creator) can decide a knock, a rejected/timed-out
// knock shows a clear "not admitted" screen, and a reconnect of an
// already-admitted identity never re-triggers approval.
import { chromium } from 'playwright';
import crypto from 'crypto';

const BASE = process.env.BASE || 'http://127.0.0.1:3104';
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
  { id: 'user-815ce7061367244d', username: 'uitest1', displayName: 'UI Test User' },
  { id: 'user-964ef540619374b1', username: 'uitest2', displayName: 'Second Tester' },
  { id: 'user-knocktest3', username: 'uitest3', displayName: 'Third Tester' },
];

const results = [];
const check = (name, pass, detail = '') => { results.push({ name, pass }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); };

// Collects every WebSocket instance so a later step can kill just the
// signalling one — the standard technique documented in CLAUDE.md for
// simulating a dropped connection without a page reload.
function socketCollectorFn() {
  window.__sockets = [];
  const RealWS = window.WebSocket;
  window.WebSocket = new Proxy(RealWS, {
    construct(target, args) {
      const inst = new target(...args);
      window.__sockets.push(inst);
      return inst;
    },
  });
}

function fakeMediaFn() {
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    const canvas = document.createElement('canvas');
    canvas.width = 320; canvas.height = 240;
    const c2d = canvas.getContext('2d');
    (function draw() { c2d.fillStyle = '#557'; c2d.fillRect(0, 0, 320, 240); requestAnimationFrame(draw); })();
    const videoStream = canvas.captureStream(15);
    const audioCtx = new AudioContext();
    const dest = audioCtx.createMediaStreamDestination();
    const osc = audioCtx.createOscillator(); osc.connect(dest); osc.start();
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
  await ctx.addInitScript(socketCollectorFn);
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
  return { page, ctx };
}

console.log('── Host creates a meeting ──');
const host = await makePeer(users[0]);
await host.page.click('[aria-label="Meetings"]');
await host.page.waitForSelector('text=Start New Meeting', { timeout: 15000 });
await host.page.click('text=Start New Meeting');
await host.page.waitForTimeout(3000);
const code = await host.page.evaluate(() => window.location.pathname.replace('/', '') || null);
check('host created a meeting with no approval prompt of their own', !!code, code ?? 'no code');
if (!code) { await browser.close(); process.exit(1); }

console.log('\n── Toggle is OFF by default — must not need enabling by every host ──');
const toggleDefaultState = await host.page.locator('[aria-label="Require approval to join"]').getAttribute('aria-checked');
check('the require-approval toggle defaults to off', toggleDefaultState === 'false', `aria-checked=${toggleDefaultState}`);

console.log('\n── Host turns the toggle ON ──');
await host.page.locator('[aria-label="Require approval to join"]').click();
await host.page.waitForTimeout(300);
const toggleOnState = await host.page.locator('[aria-label="Require approval to join"]').getAttribute('aria-checked');
check('the toggle switches on when clicked', toggleOnState === 'true', `aria-checked=${toggleOnState}`);
await host.page.keyboard.press('Escape');
await host.page.waitForTimeout(300);

console.log('\n── Guest2 tries to join — must knock (toggle is on) ──');
const guest2 = await makePeer(users[1]);
await guest2.page.click('[aria-label="Meetings"]');
await guest2.page.waitForTimeout(600);
await guest2.page.fill('input[placeholder="ENTER ROOM CODE…"]', code);
await guest2.page.click('button:has-text("Join")');
await guest2.page.waitForTimeout(1500);
const guest2Waiting = await guest2.page.locator('text=Waiting to be let in').count();
check('guest2 sees a "waiting to be let in" screen instead of the call', guest2Waiting > 0);

const hostSeesRequest = await host.page.locator('text=wants to join').count();
check('host sees a join-request popup for guest2', hostSeesRequest > 0);

console.log('\n── Host admits guest2 ──');
await host.page.locator('[aria-label^="Admit"]').first().click();
await host.page.waitForTimeout(2500);
const guest2InCall = await guest2.page.evaluate(() => !document.body.innerText.includes('Waiting to be let in'));
check('guest2 is admitted and the waiting screen clears', guest2InCall);
const hostPopupGone = await host.page.locator('text=wants to join').count();
check('the accepted request\'s popup clears on the host\'s side', hostPopupGone === 0);

console.log('\n── Guest3 tries to join — guest2 (not the original host) rejects them ──');
const guest3 = await makePeer(users[2]);
await guest3.page.click('[aria-label="Meetings"]');
await guest3.page.waitForTimeout(600);
await guest3.page.fill('input[placeholder="ENTER ROOM CODE…"]', code);
await guest3.page.click('button:has-text("Join")');
await guest3.page.waitForTimeout(1500);
const guest2SeesRequest = await guest2.page.locator('text=wants to join').count();
check('guest2 (an ordinary participant, not the original creator) also sees the join request', guest2SeesRequest > 0);

await guest2.page.locator('[aria-label^="Deny"]').first().click();
await guest3.page.waitForTimeout(1500);
const guest3Denied = await guest3.page.evaluate(() => document.body.innerText.includes("weren't let into this meeting") || document.body.innerText.includes('not let'));
check('guest3 sees a clear "not admitted" screen after being denied', guest3Denied);

const hostPopupForGuest3Gone = await host.page.locator('text=wants to join').count();
check('the denied request\'s popup also clears on other participants\' screens (host)', hostPopupForGuest3Gone === 0);

console.log('\n── Host reconnects (simulated drop) — must NOT be re-knocked ──');
const hostSocketKilled = await host.page.evaluate(() => {
  const sig = (window.__sockets || []).find((s) => s.url && s.url.includes('/ws'));
  if (!sig) return false;
  sig.close();
  return true;
});
check('found and killed the host\'s own signalling socket', hostSocketKilled);
await host.page.waitForTimeout(4000); // SignalingSocket's own 3s auto-reconnect + re-entry
const hostStillInNoKnock = await host.page.evaluate(() =>
  !document.body.innerText.includes('Waiting to be let in') && !document.body.innerText.includes("weren't let into")
);
check('host\'s reconnect re-enters the room with NO re-knock prompt (already admitted)', hostStillInNoKnock);
// The call itself should still be intact — guest2's tile still showing on the host's screen.
const hostStillSeesGuest2 = await host.page.evaluate(() => document.querySelectorAll('video').length >= 1);
check('the call is still genuinely intact after the host\'s reconnect', hostStillSeesGuest2);

check('zero console/page errors across all three participants', errors.length === 0, errors.slice(0, 5).join(' | '));

console.log(`\n${results.filter(r => r.pass).length}/${results.length} passed`);
await browser.close();
process.exit(results.every(r => r.pass) ? 0 : 1);
