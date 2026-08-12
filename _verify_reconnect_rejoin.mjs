// Repro 2: guest's signaling WS drops (phone sleeps / network switch), then the
// host reloads. Does the guest get orphaned from the server-side room?
import { chromium } from 'playwright';
import crypto from 'crypto';

const BASE = process.env.BASE ?? 'http://127.0.0.1:3100';
const b64url = (i) => Buffer.from(i).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
function signHS256(payload, secret) {
  const h = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest('base64')
    .replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${h}.${p}.${sig}`;
}
const SECRET = (process.env.IBCONNECT_JWT_SECRET
  ?? 'ibconnect_jwt_secret_prod_2024_change_me')  // legacy fallback: the backend now requires IBCONNECT_JWT_SECRET, so export it to test a deployed build;
const exp = Math.floor(Date.now() / 1000) + 3600 * 6;
const T1 = signHS256({ userId: 'user-815ce7061367244d', exp }, SECRET);
const U1 = JSON.stringify({ id: 'user-815ce7061367244d', username: 'uitest1', displayName: 'UI Test User', email: 'uitest1@example.com' });

function boot({ color }) {
  // keep a handle on every websocket the app opens so the test can kill one
  const Native = window.WebSocket;
  window.__sockets = [];
  window.WebSocket = function (...args) {
    const ws = new Native(...args);
    window.__sockets.push(ws);
    return ws;
  };
  window.WebSocket.prototype = Native.prototype;
  Object.assign(window.WebSocket, Native);

  const mk = (w, h, fill, label) => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    (function draw() {
      ctx.fillStyle = fill; ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#fff'; ctx.font = '24px sans-serif';
      ctx.fillText(label + ' ' + new Date().toISOString().slice(17, 19), 15, 35);
      requestAnimationFrame(draw);
    })();
    return c.captureStream(15);
  };
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    const v = mk(320, 240, color, 'CAM');
    const ac = new AudioContext();
    const dest = ac.createMediaStreamDestination();
    const g = ac.createGain(); g.gain.value = 0.0001;
    const o = ac.createOscillator(); o.connect(g).connect(dest); o.start();
    const tracks = [];
    if (!constraints || constraints.video !== false) tracks.push(v.getVideoTracks()[0]);
    if (!constraints || constraints.audio !== false) tracks.push(dest.stream.getAudioTracks()[0]);
    return new MediaStream(tracks);
  };
  navigator.mediaDevices.getDisplayMedia = async () =>
    new MediaStream([mk(1280, 720, '#2a9d8f', 'SCREEN').getVideoTracks()[0]]);
}

const browser = await chromium.launch({ args: ['--no-sandbox', '--use-fake-ui-for-media-stream'] });
async function makeCtx({ color, token, user, viewport = { width: 1400, height: 900 } }) {
  const ctx = await browser.newContext({ viewport });
  await ctx.addInitScript(boot, { color });
  const page = await ctx.newPage();
  const logs = [];
  page.on('console', (m) => logs.push(`[${m.type()}] ` + m.text()));
  await page.goto(BASE + '/');
  if (token) {
    await page.evaluate(({ t, u }) => {
      localStorage.setItem('ibconnect_jwt', t);
      localStorage.setItem('ibconnect_me', u);
    }, { t: token, u: user });
    await page.reload();
  }
  await page.waitForTimeout(1200);
  return { ctx, page, logs };
}
const state = async (page, who) => {
  const n = await page.locator('video').count();
  const l = await page.evaluate(() =>
    Array.from(document.querySelectorAll('video')).map((v) => (v.closest('div.group')?.innerText ?? '').trim().replace(/\n/g, ' ')));
  console.log(`  ${who}: ${n} tile(s) ${JSON.stringify(l)}`);
};

const A = await makeCtx({ color: '#e63946', token: T1, user: U1 });
await A.page.click('[aria-label="Meetings"]');
await A.page.waitForSelector('text=Start New Meeting', { timeout: 15000 });
await A.page.click('text=Start New Meeting');
await A.page.waitForTimeout(3500);
await A.page.keyboard.press('Escape');
const room = await A.page.evaluate(() => location.pathname.replace('/', ''));
console.log('Room:', room);

const G = await makeCtx({ color: '#f4a261', viewport: { width: 390, height: 800 } });
await G.page.goto(`${BASE}/${room}`);
await G.page.waitForTimeout(2500);
await G.page.fill('input[aria-label="Your name"]', 'Phone Guest');
await G.page.click('button:has-text("Join now")');
await G.page.waitForTimeout(6000);
console.log('\n== both in the call ==');
await state(A.page, 'host ');
await state(G.page, 'guest');

// Simulate the phone's signaling socket dying (sleep / carrier NAT / wifi switch).
console.log('\n== guest signaling WS drops ==');
G.logs.length = 0;
await G.page.evaluate(() => {
  const sig = window.__sockets.filter((w) => w.url.includes('/ws'));
  sig.forEach((w) => w.close());
  return sig.length;
});
await G.page.waitForTimeout(7000); // client auto-reconnects after 3s
console.log('  guest console:', JSON.stringify(G.logs.filter((l) => l.includes('Signaling'))));
await state(A.page, 'host ');
await state(G.page, 'guest');

console.log('\n== host reloads ==');
await A.page.reload();
await A.page.waitForTimeout(9000);
await state(A.page, 'host ');
await state(G.page, 'guest');
console.log('  host name on own tile:', await A.page.evaluate(() =>
  Array.from(document.querySelectorAll('video')).map((v) => (v.closest('div.group')?.innerText ?? '').trim())));

console.log('\n== guest reloads too ==');
await G.page.reload();
await G.page.waitForTimeout(9000);
await state(A.page, 'host ');
await state(G.page, 'guest');

// Tiles being present isn't enough — prove the media is actually decoding.
const live = async (page, who) => {
  const t0 = await page.evaluate(() => Array.from(document.querySelectorAll('video')).map((v) => v.currentTime));
  await page.waitForTimeout(2000);
  const t1 = await page.evaluate(() => Array.from(document.querySelectorAll('video')).map((v) => v.currentTime));
  const advanced = t0.map((t, i) => +(t1[i] - t).toFixed(2));
  console.log(`  ${who}: currentTime advanced by ${JSON.stringify(advanced)} — ${advanced.every((d) => d > 0.3) ? 'ALL PLAYING' : 'SOME FROZEN'}`);
};
console.log('\n== media liveness (no interaction since reload) ==');
await live(A.page, 'host ');
await live(G.page, 'guest');

console.log('\n== media liveness after a single tap ==');
await G.page.mouse.click(200, 400);
await A.page.mouse.click(700, 450);
await G.page.waitForTimeout(800);
await live(A.page, 'host ');
await live(G.page, 'guest');

await browser.close();
