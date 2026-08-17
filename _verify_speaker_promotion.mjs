/**
 * Proves the speaker-ranked tile ordering is actually wired into the grid, with three
 * real peers in three real browsers.
 *
 * The gap being closed: tile order used to be signalling arrival order, so in a call
 * big enough to paginate you saw whoever happened to join first and a person speaking
 * on page 2 was invisible. This is how Zoom and Meet behave — they rank by who is
 * talking — except they get the ranking from an SFU and this derives it locally from
 * `useAudioLevels`, which already analyses every peer including unrendered ones.
 *
 * The observer is squeezed to 320px so `selectGridLayout` picks a 2-tile layout and
 * three participants genuinely paginate. Each peer's microphone gain is controllable at
 * runtime (`window.__setMicGain`) so "who is speaking" can be flipped mid-test.
 *
 * BASE selects the target.
 */
import { chromium } from 'playwright';
import crypto from 'crypto';

const BASE = process.env.BASE ?? 'http://127.0.0.1:3100';
const SECRET = process.env.IBCONNECT_JWT_SECRET;
if (!SECRET) {
  console.error('IBCONNECT_JWT_SECRET must be set (source /etc/ibconnect/env).');
  process.exit(2);
}

const exp = Math.floor(Date.now() / 1000) + 3600 * 6;
const b64 = (i) => Buffer.from(i).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const sign = (p) => {
  const h = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' })), y = b64(JSON.stringify(p));
  return `${h}.${y}.` + crypto.createHmac('sha256', SECRET).update(`${h}.${y}`)
    .digest('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
};

// Real rows in `users` — the server's display_name wins over seeded localStorage.
const OBSERVER = { id: 'user-815ce7061367244d', displayName: 'UI Test User' };
const QUIET    = { id: 'user-964ef540619374b1', displayName: 'Second Tester' };
const TALKER   = { id: 'user-c6e3c1eea384f6f3', displayName: 'UI Smoke Tester' };

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

/** Media stub whose mic level can be changed at runtime. */
const stub = (initialGain) => {
  const g = initialGain;
  navigator.mediaDevices.getUserMedia = async (c = {}) => {
    const tracks = [];
    if (c.video) {
      const cv = document.createElement('canvas'); cv.width = 320; cv.height = 240;
      const ctx2d = cv.getContext('2d');
      (function draw() { ctx2d.fillStyle = '#2a9d8f'; ctx2d.fillRect(0, 0, 320, 240); requestAnimationFrame(draw); })();
      tracks.push(cv.captureStream(10).getVideoTracks()[0]);
    }
    if (c.audio) {
      const actx = new AudioContext();
      const dest = actx.createMediaStreamDestination();
      const gain = actx.createGain();
      gain.gain.value = g;
      const osc = actx.createOscillator();
      osc.frequency.value = 220;
      osc.connect(gain).connect(dest);
      osc.start();
      // Exposed so the test can make this peer start or stop "talking" on demand.
      window.__setMicGain = (v) => { gain.gain.value = v; };
      tracks.push(dest.stream.getAudioTracks()[0]);
    }
    return new MediaStream(tracks);
  };
};

const browser = await chromium.launch({
  args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
         '--autoplay-policy=no-user-gesture-required'],
});

const errors = [];
async function makeClient(user, gain, viewport) {
  const ctx = await browser.newContext({ viewport, permissions: ['camera', 'microphone'] });
  await ctx.addInitScript(stub, gain);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${user.displayName}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (/Failed to load resource|favicon|ERR_ABORTED/.test(t)) return;
    errors.push(`${user.displayName}: ${t}`);
  });
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(({ t, u }) => {
    localStorage.setItem('ibconnect_jwt', t);
    localStorage.setItem('ibconnect_me', JSON.stringify(u));
  }, { t: sign({ userId: user.id, exp }), u: user });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1800);
  return { ctx, page };
}

/** Names currently rendered as grid tiles on this page. */
const visibleNames = (page) => page.evaluate(() => {
  const grid = document.querySelector('.flex-wrap.items-center.justify-center.content-center');
  if (!grid) return [];
  return [...grid.querySelectorAll('.absolute.bg-\\[\\#111\\]\\/70')]
    .map((el) => el.textContent?.trim())
    .filter(Boolean);
});

// ── Setup ────────────────────────────────────────────────────────────────────
console.log('\n── Setup ──');

// Observer starts wide, because the sidebar route to Meetings is unreachable at 320px.
const observer = await makeClient(OBSERVER, 0.3, { width: 1280, height: 900 });
await observer.page.click('[aria-label="Meetings"]');
await observer.page.waitForTimeout(1200);
await observer.page.click('text=/Instant start/i');
await observer.page.waitForTimeout(5000);
await observer.page.keyboard.press('Escape');
await observer.page.waitForTimeout(700);
const room = await observer.page.evaluate(() => location.pathname.replace('/', ''));
check('room created', !!room, room);

// The quiet peer joins first, so arrival order alone would put it on page 1.
const quiet = await makeClient(QUIET, 0, { width: 1024, height: 768 });
await quiet.page.goto(`${BASE}/${room}`, { waitUntil: 'domcontentloaded' });
await quiet.page.waitForTimeout(4500);

const talker = await makeClient(TALKER, 0.3, { width: 1024, height: 768 });
await talker.page.goto(`${BASE}/${room}`, { waitUntil: 'domcontentloaded' });
await talker.page.waitForTimeout(5000);

const seen = await visibleNames(observer.page);
check('all three participants are in the call',
  seen.some((n) => n.includes('Second')) && seen.some((n) => n.includes('Smoke')),
  seen.join(' | '));

// ── Force pagination ─────────────────────────────────────────────────────────
console.log('\n── Pagination at 320px ──');
await observer.page.setViewportSize({ width: 320, height: 740 });
await observer.page.waitForTimeout(3000);

// Asserted from the DOM rather than by importing src/lib/gridLayout.ts: a dynamic
// import of a .ts module only resolves against the Vite dev server, so doing it that
// way made this suite unrunnable against production — which is the one target where it
// matters most.
const layout = await observer.page.evaluate(() => {
  const grid = document.querySelector('.flex-wrap.items-center.justify-center.content-center');
  const r = grid.getBoundingClientRect();
  const badges = grid.querySelectorAll('.absolute.bg-\\[\\#111\\]\\/70');
  return { w: Math.round(r.width), h: Math.round(r.height), rendered: badges.length };
});
check('a 320px viewport really does force a 2-tile layout', layout.rendered === 2,
  JSON.stringify(layout));

const paged = await observer.page.locator('[aria-label="Next participants"]').isVisible().catch(() => false);
check('the pager is shown, so somebody is off-screen', paged);

// ── The actual fix ───────────────────────────────────────────────────────────
console.log('\n── Speaker occupies the visible page ──');
await observer.page.waitForTimeout(3000);
const page1 = await visibleNames(observer.page);

check('your own tile is on the visible page', page1.some((n) => n.includes('UI Test User')),
  page1.join(' | '));
check('the talking peer is on the visible page', page1.some((n) => n.includes('Smoke')),
  page1.join(' | '));
check('the silent peer has been paged off', !page1.some((n) => n.includes('Second')),
  page1.join(' | '));
check('exactly two tiles are rendered', page1.length === 2, `${page1.length}: ${page1.join(' | ')}`);

// ── Stability: silence must not churn the grid ───────────────────────────────
console.log('\n── Stability while nobody talks ──');
await talker.page.evaluate(() => window.__setMicGain?.(0));
await observer.page.waitForTimeout(7000);   // past the 5s hold
const settled = await visibleNames(observer.page);
const samples = [];
for (let i = 0; i < 4; i++) {
  await observer.page.waitForTimeout(1200);
  samples.push((await visibleNames(observer.page)).join(','));
}
check('the grid does not churn when everyone is silent',
  new Set(samples).size === 1, samples.join(' -> '));
check('the last speaker keeps their slot rather than being dropped',
  settled.some((n) => n.includes('Smoke')), settled.join(' | '));

// ── The swap goes both ways ──────────────────────────────────────────────────
console.log('\n── Promotion follows whoever is talking ──');
await quiet.page.evaluate(() => window.__setMicGain?.(0.3));
await observer.page.waitForTimeout(9000);   // speech detection + hold expiry

const after = await visibleNames(observer.page);
check('the peer who started talking is promoted onto the visible page',
  after.some((n) => n.includes('Second')), after.join(' | '));
check('the peer who stopped talking is paged off',
  !after.some((n) => n.includes('Smoke')), after.join(' | '));
check('your own tile is never displaced by a promotion',
  after.some((n) => n.includes('UI Test User')), after.join(' | '));

// ── Audio is unaffected by paging (regression guard) ─────────────────────────
console.log('\n── Audio independent of pagination ──');
const audio = await observer.page.evaluate(() => {
  const els = [...document.querySelectorAll('audio')];
  return { count: els.length, muted: els.map((e) => e.muted), attached: els.map((e) => !!e.srcObject) };
});
check('both remote peers still have an audio element while only one is rendered',
  audio.count === 2 && audio.attached.every(Boolean) && audio.muted.every((m) => !m),
  JSON.stringify(audio));

check('no console or page errors', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) console.log('Failed:\n' + failed.map((f) => `  - ${f.name}`).join('\n'));
process.exit(failed.length ? 1 : 0);
