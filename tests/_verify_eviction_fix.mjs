/**
 * Regression suite for: "my video keeps coming and going" — reported while the user had
 * the same account open on two devices at once (Android Chrome + Windows Firefox, per
 * the client-side diagnostics they pasted in). Root cause: `enterRoom` (server/main.go)
 * evicts a previous same-user-id connection with a bare `conn.Close()` — no close frame,
 * so the evicted browser sees code 1006 ("abnormal"), which its resilience logic
 * classifies as a transient network failure and reconnects from. Reconnecting evicts the
 * OTHER tab in turn, which reconnects, which evicts this one again — an unbounded fight
 * over one seat, each round tearing down and rebuilding every WebRTC connection in the
 * room. 107 evictions were logged for one account in 20 minutes before this fix.
 *
 * Fix: the server now sends a real close frame with an application-defined code (4001)
 * and reason before closing the evicted socket. The client recognises 4001 and does NOT
 * reconnect — breaking the loop — and surfaces a clear "connected elsewhere" notice
 * instead of silently going dark.
 *
 * This suite opens two signalling connections as the SAME user id in the same room (the
 * exact two-tab/two-device scenario) and asserts: the second connection evicts the
 * first with code 4001 specifically (not 1006), the evicted side makes zero reconnect
 * attempts, and the surviving connection is unaffected.
 *
 * BASE selects the target.
 */
import { chromium } from 'playwright';
import crypto from 'crypto';

const BASE = process.env.BASE ?? 'http://127.0.0.1:3101';
const SECRET = process.env.IBCONNECT_JWT_SECRET;
if (!SECRET) { console.error('IBCONNECT_JWT_SECRET must be set.'); process.exit(2); }

const exp = Math.floor(Date.now() / 1000) + 3600 * 6;
const b64 = (i) => Buffer.from(i).toString('base64').replace(/=+$/,'').replace(/\+/g,'-').replace(/\//g,'_');
const sign = (p) => { const h=b64(JSON.stringify({alg:'HS256',typ:'JWT'})),y=b64(JSON.stringify(p));
  return `${h}.${y}.`+crypto.createHmac('sha256',SECRET).update(`${h}.${y}`).digest('base64').replace(/=+$/,'').replace(/\+/g,'-').replace(/\//g,'_'); };

// Same seeded account other suites use.
const USER = { id: 'user-815ce7061367244d', displayName: 'UI Test User' };

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

function stub() {
  navigator.mediaDevices.getUserMedia = async (constraints = {}) => {
    const t = [];
    if (constraints.video) {
      const cv = document.createElement('canvas'); cv.width = 320; cv.height = 240;
      const g = cv.getContext('2d');
      (function d(){ g.fillStyle = '#c0392b'; g.fillRect(0, 0, 320, 240); requestAnimationFrame(d); })();
      t.push(cv.captureStream(15).getVideoTracks()[0]);
    }
    if (constraints.audio) {
      const a = new AudioContext(), dst = a.createMediaStreamDestination(), o = a.createOscillator();
      o.connect(dst); o.start(); t.push(dst.stream.getAudioTracks()[0]);
    }
    return new MediaStream(t);
  };
}

// Records every WebSocket close code/reason seen on /ws, and whether a reconnect attempt
// (a fresh WebSocket to /ws) happens after each close.
function spy() {
  window.__wsEvents = [];
  const OrigWS = window.WebSocket;
  window.WebSocket = new Proxy(OrigWS, {
    construct(target, args) {
      const url = args[0];
      const isSignaling = typeof url === 'string' && url.includes('/ws');
      const ws = new target(...args);
      if (isSignaling) {
        window.__wsEvents.push({ t: Date.now(), ev: 'open-attempt' });
        ws.addEventListener('close', (e) => {
          window.__wsEvents.push({ t: Date.now(), ev: 'close', code: e.code, reason: e.reason });
        });
      }
      return ws;
    },
  });
}

const browser = await chromium.launch({
  args: ['--no-sandbox','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream','--autoplay-policy=no-user-gesture-required'],
});
const errors = [];
const mk = async (label) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ['camera','microphone'] });
  await ctx.addInitScript(stub);
  await ctx.addInitScript(spy);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${label}: ${e.message}`));
  return { ctx, page, label };
};

console.log('── Device 1: sign in and create a room ──');
const device1 = await mk('device1');
await device1.page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
await device1.page.evaluate(({ t }) => { localStorage.clear(); localStorage.setItem('ibconnect_jwt', t); }, { t: sign({ userId: USER.id, exp }) });
await device1.page.reload({ waitUntil: 'domcontentloaded' });
await device1.page.waitForTimeout(3000);
await device1.page.click('[aria-label="Meetings"]');
await device1.page.waitForTimeout(1200);
await device1.page.click('text=/Instant start/i');
await device1.page.waitForTimeout(5000);
await device1.page.keyboard.press('Escape');
await device1.page.waitForTimeout(500);
const room = await device1.page.evaluate(() => location.pathname.replace('/', ''));
check('room created', !!room, room);
await device1.page.waitForTimeout(1500);

console.log('\n── Device 2: same account, same meeting — the two-tabs-at-once scenario ──');
const device2 = await mk('device2');
await device2.page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
await device2.page.evaluate(({ t }) => { localStorage.clear(); localStorage.setItem('ibconnect_jwt', t); }, { t: sign({ userId: USER.id, exp }) });
await device2.page.reload({ waitUntil: 'domcontentloaded' });
await device2.page.waitForTimeout(3000);
await device2.page.goto(`${BASE}/${room}`, { waitUntil: 'domcontentloaded' });
await device2.page.waitForTimeout(4000);

console.log('\n── Checking device 1 (the evicted side) ──');
const d1Events = await device1.page.evaluate(() => window.__wsEvents);
const d1Closes = d1Events.filter((e) => e.ev === 'close');
const d1Opens = d1Events.filter((e) => e.ev === 'open-attempt');
check('device 1 was closed at least once (evicted by device 2)', d1Closes.length >= 1,
  JSON.stringify(d1Closes));
check('the eviction close used code 4001, not the old uninformative 1006',
  d1Closes.some((c) => c.code === 4001), JSON.stringify(d1Closes.map((c) => c.code)));
// Exactly one open attempt (the original connection) — no reconnect attempt after the
// 4001 close. Before the fix this would keep climbing every ~1-3s forever.
check('device 1 made no reconnect attempt after being evicted (the loop is broken)',
  d1Opens.length === 1, `${d1Opens.length} total open attempt(s)`);
const d1Notice = await device1.page.evaluate(() => document.body.innerText.includes('another device or tab'));
check('device 1 shows a clear "connected elsewhere" notice instead of going silently dark',
  d1Notice);

console.log('\n── Checking device 2 (the survivor) ──');
const d2Closes = await device2.page.evaluate(() => window.__wsEvents.filter((e) => e.ev === 'close'));
check('device 2 (the newer connection) was never evicted itself', d2Closes.length === 0,
  JSON.stringify(d2Closes));
const d2InCall = await device2.page.evaluate(() => document.querySelector('video') !== null);
check('device 2 is in the call normally, unaffected', d2InCall);

check('no console or page errors', errors.length === 0, errors.join(' | '));

await browser.close();

const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} checks passed`);
if (passed !== results.length) {
  console.log('Failed:');
  results.filter((r) => !r.pass).forEach((r) => console.log(`  - ${r.name}`));
  process.exit(1);
}
