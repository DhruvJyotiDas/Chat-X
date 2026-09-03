// End-to-end checks for the meeting overhaul, run against a throwaway backend
// (PORT=8081) + dev server (:3100) so production calls are untouched.
//
//   1. reload mid-call rejoins the room instead of dumping you on the dashboard
//   2. creating a second room leaves the first (no ghost tile with your name)
//   3. a signed-out visitor can join from a share link by typing a name
//   4. focus/pin layout + carousel behave at desktop and mobile sizes
import { chromium } from 'playwright';
import crypto from 'crypto';
import { mkdirSync } from 'fs';

const BASE = process.env.BASE ?? 'http://127.0.0.1:3100';
const SHOT_DIR = '/tmp/claude-1001/-home-ubuntu/eeadc93f-5601-4dd3-873c-4d359b7ee755/scratchpad/meeting_shots';
mkdirSync(SHOT_DIR, { recursive: true });

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
const T2 = signHS256({ userId: 'user-964ef540619374b1', exp }, SECRET);
const U1 = JSON.stringify({ id: 'user-815ce7061367244d', username: 'uitest1', displayName: 'UI Test User', email: 'uitest1@example.com' });
const U2 = JSON.stringify({ id: 'user-964ef540619374b1', username: 'uitest2', displayName: 'Second Tester', email: 'uitest2@example.com' });

function fakeMedia({ color }) {
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

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

const browser = await chromium.launch({ args: ['--no-sandbox', '--use-fake-ui-for-media-stream'] });

async function makeCtx({ color, token, user, viewport = { width: 1400, height: 900 } }) {
  const ctx = await browser.newContext({ viewport });
  await ctx.addInitScript(fakeMedia, { color });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto(BASE + '/');
  if (token) {
    await page.evaluate(({ t, u }) => {
      localStorage.setItem('ibconnect_jwt', t);
      localStorage.setItem('ibconnect_me', u);
    }, { t: token, u: user });
    await page.reload();
  }
  await page.waitForTimeout(1200);
  return { ctx, page, errors };
}

const tileCount = (page) => page.locator('video').count();
const namesOnScreen = (page) => page.evaluate(() =>
  Array.from(document.querySelectorAll('video'))
    .map((v) => v.closest('div.group')?.innerText?.trim() ?? '')
    .filter(Boolean));

// ─── Host starts a meeting ───────────────────────────────────────────────────
const A = await makeCtx({ color: '#e63946', token: T1, user: U1 });
await A.page.click('[aria-label="Meetings"]');
await A.page.waitForSelector('text=Start New Meeting', { timeout: 15000 });
await A.page.click('text=Start New Meeting');
await A.page.waitForTimeout(3500);
await A.page.keyboard.press('Escape');
await A.page.waitForTimeout(400);

const room1 = await A.page.evaluate(() => location.pathname.replace('/', ''));
console.log('\nRoom 1:', room1);
check('host enters a room and URL reflects it', !!room1, room1);
await A.page.screenshot({ path: `${SHOT_DIR}/01-host-solo.png` });

// ─── TEST 1: reload rejoins ──────────────────────────────────────────────────
console.log('\n── Test 1: reload mid-call ──');
await A.page.reload();
await A.page.waitForTimeout(6000);
const afterReloadPath = await A.page.evaluate(() => location.pathname.replace('/', ''));
const stillInCall = await A.page.locator('button[title="Share screen"]').count();
check('reload stays in the meeting', stillInCall > 0 && afterReloadPath === room1,
  `path=${afterReloadPath} controlsVisible=${stillInCall > 0}`);
await A.page.screenshot({ path: `${SHOT_DIR}/02-after-reload.png` });

// ─── Second participant joins ────────────────────────────────────────────────
console.log('\n── Second participant joins ──');
const B = await makeCtx({ color: '#457b9d', token: T2, user: U2 });
await B.page.click('[aria-label="Meetings"]');
await B.page.waitForTimeout(600);
await B.page.fill('input[placeholder="ENTER ROOM CODE…"]', room1);
await B.page.click('button:has-text("Join")');
await B.page.waitForTimeout(5000);
const aTiles = await tileCount(A.page);
check('both participants see 2 tiles', aTiles === 2, `host sees ${aTiles} video(s)`);
await A.page.screenshot({ path: `${SHOT_DIR}/03-two-up.png` });

// ─── TEST 2: creating a second room leaves the first ─────────────────────────
console.log('\n── Test 2: host creates a second room ──');
await A.page.click('button:has-text("Leave")');
await A.page.waitForTimeout(1500);
await A.page.click('text=Start New Meeting');
await A.page.waitForTimeout(4000);
await A.page.keyboard.press('Escape');
await A.page.waitForTimeout(500);
const room2 = await A.page.evaluate(() => location.pathname.replace('/', ''));
console.log('Room 2:', room2);
const aTilesRoom2 = await tileCount(A.page);
check('new room shows only yourself (no ghost tile)', aTilesRoom2 === 1, `${aTilesRoom2} video(s) in new room`);
check('new room has a different code', room2 !== room1, `${room1} -> ${room2}`);

// B, still in room 1, must have seen A leave
const bNames = await namesOnScreen(B.page);
const bTiles = await tileCount(B.page);
check('peer in old room saw the host leave', bTiles === 1,
  `${bTiles} video(s) remain; labels=${JSON.stringify(bNames)}`);
await B.page.screenshot({ path: `${SHOT_DIR}/04-old-room-after-host-left.png` });
await A.page.screenshot({ path: `${SHOT_DIR}/05-new-room.png` });

// ─── TEST 3: guest join via share link ───────────────────────────────────────
console.log('\n── Test 3: guest joins room 2 by link ──');
const G = await makeCtx({ color: '#f4a261', viewport: { width: 1400, height: 900 } });
await G.page.goto(`${BASE}/${room2}`);
await G.page.waitForTimeout(2500);
const lobbyVisible = await G.page.locator('text=Ready to join?').count();
check('share link shows the guest lobby (not the login page)', lobbyVisible > 0);
await G.page.screenshot({ path: `${SHOT_DIR}/06-guest-lobby.png` });

if (lobbyVisible > 0) {
  await G.page.fill('input[aria-label="Your name"]', 'Dhruv Guest');
  await G.page.click('button:has-text("Join now")');
  await G.page.waitForTimeout(6000);
  const guestInCall = await G.page.locator('button[title="Share screen"]').count();
  check('guest gets into the call with no account', guestInCall > 0);
  const hostSees = await tileCount(A.page);
  check('host sees the guest arrive', hostSees === 2, `host now has ${hostSees} video(s)`);
  const hostLabels = await namesOnScreen(A.page);
  check('guest name propagates to the host', JSON.stringify(hostLabels).includes('Dhruv Guest'),
    JSON.stringify(hostLabels));
  await G.page.screenshot({ path: `${SHOT_DIR}/07-guest-in-call.png` });
  await A.page.screenshot({ path: `${SHOT_DIR}/08-host-sees-guest.png` });
}

// ─── TEST 3b: grid tiles keep a 16:9 shape ───────────────────────────────────
console.log('\n── Test 3b: grid tile geometry ──');
const tileGeom = async (page) => page.evaluate(() =>
  Array.from(document.querySelectorAll('video')).map((v) => {
    const r = v.closest('div.group').getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), ratio: +(r.width / r.height).toFixed(2) };
  }));

for (const [label, vp] of [
  ['1400x900 (2 people)', { width: 1400, height: 900 }],
  ['1024x768 (2 people)', { width: 1024, height: 768 }],
  ['390x800 portrait', { width: 390, height: 800 }],
]) {
  await A.page.setViewportSize(vp);
  await A.page.waitForTimeout(900);
  const g = await tileGeom(A.page);
  const allSixteenNine = g.length > 0 && g.every((t) => Math.abs(t.ratio - 16 / 9) < 0.06);
  check(`tiles are 16:9 at ${label}`, allSixteenNine, JSON.stringify(g));
  await A.page.screenshot({ path: `${SHOT_DIR}/grid-${vp.width}x${vp.height}.png` });
}
await A.page.setViewportSize({ width: 1400, height: 900 });
await A.page.waitForTimeout(800);

// ─── TEST 4: focus / pin layout ──────────────────────────────────────────────
console.log('\n── Test 4: pin + screen-share focus ──');
const pinBtns = await A.page.locator('button[aria-label^="Pin "]').count();
check('tiles expose a pin control', pinBtns > 0, `${pinBtns} pin button(s)`);
if (pinBtns > 0) {
  await A.page.locator('button[aria-label^="Pin "]').first().click({ force: true });
  await A.page.waitForTimeout(1200);
  const unpin = await A.page.locator('button[aria-label^="Unpin "]').count();
  check('pinning moves a participant to the focus stage', unpin > 0);
  await A.page.screenshot({ path: `${SHOT_DIR}/09-pinned-focus.png` });
  await A.page.locator('button[aria-label^="Unpin "]').first().click({ force: true });
  await A.page.waitForTimeout(800);
}

await A.page.click('button[title="Share screen"]');
await A.page.waitForTimeout(3000);
await A.page.screenshot({ path: `${SHOT_DIR}/10-screenshare-focus.png` });

const overlap = await A.page.evaluate(() => {
  const rs = Array.from(document.querySelectorAll('video')).map((v) => v.getBoundingClientRect());
  const hit = [];
  for (let i = 0; i < rs.length; i++)
    for (let j = i + 1; j < rs.length; j++)
      if (rs[i].left < rs[j].right && rs[i].right > rs[j].left && rs[i].top < rs[j].bottom && rs[i].bottom > rs[j].top)
        hit.push([i, j]);
  return hit;
});
check('screen share does not overlap camera tiles', overlap.length === 0, JSON.stringify(overlap));

await A.page.setViewportSize({ width: 390, height: 800 });
await A.page.waitForTimeout(1200);
await A.page.screenshot({ path: `${SHOT_DIR}/11-mobile-screenshare.png` });
const overlapMobile = await A.page.evaluate(() => {
  const rs = Array.from(document.querySelectorAll('video')).map((v) => v.getBoundingClientRect());
  const hit = [];
  for (let i = 0; i < rs.length; i++)
    for (let j = i + 1; j < rs.length; j++)
      if (rs[i].left < rs[j].right && rs[i].right > rs[j].left && rs[i].top < rs[j].bottom && rs[i].bottom > rs[j].top)
        hit.push([i, j]);
  return hit;
});
check('mobile focus layout does not overlap', overlapMobile.length === 0, JSON.stringify(overlapMobile));

// ─── Errors ──────────────────────────────────────────────────────────────────
const ignorable = (e) => /favicon|ResizeObserver loop|Download the React DevTools/i.test(e);
for (const [label, c] of [['host', A], ['peer', B], ['guest', G]]) {
  const real = c.errors.filter((e) => !ignorable(e));
  check(`${label} had no page errors`, real.length === 0, real.slice(0, 3).join(' | '));
}

console.log('\n──────── SUMMARY ────────');
const failed = results.filter((r) => !r.pass);
console.log(`${results.length - failed.length}/${results.length} passed`);
if (failed.length) { failed.forEach((f) => console.log('  FAILED: ' + f.name + ' — ' + f.detail)); }
await browser.close();
process.exit(failed.length ? 1 : 0);
