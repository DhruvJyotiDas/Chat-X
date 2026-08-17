/**
 * Verifies the multi-party call fixes, above all finding A: remote audio must be
 * routed for EVERY peer, not just the ones whose tile happens to be on the
 * current page of the paginated grid.
 *
 * The trick to reproducing that cheaply is the same one _verify_tiling_pagination
 * uses — a narrow viewport makes selectGridLayout pick a layout whose maxTiles is
 * smaller than the participant count, so pagination kicks in with only 3 peers
 * instead of needing 13+. Before the fix, the off-page peer had no media element
 * at all and was silent; after it, a hidden <audio> exists and plays regardless
 * of which page the grid is showing.
 *
 * BASE env var selects the target (default the throwaway :3100 pair).
 */
import { chromium } from 'playwright';
import crypto from 'crypto';

const BASE = process.env.BASE ?? 'http://127.0.0.1:3100';
const JWT_SECRET = (process.env.IBCONNECT_JWT_SECRET
  ?? 'ibconnect_jwt_secret_prod_2024_change_me')  // legacy fallback: the backend now requires IBCONNECT_JWT_SECRET, so export it to test a deployed build;
const exp = Math.floor(Date.now() / 1000) + 3600 * 6;

function b64url(i) { return Buffer.from(i).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_'); }
function signHS256(payload, secret) {
  const h = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64url(JSON.stringify(payload));
  const s = crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest('base64')
    .replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${h}.${p}.${s}`;
}

const users = [
  { id: 'user-815ce7061367244d', username: 'uitest1', displayName: 'UI Test User', email: 'uitest1@example.com', color: '#e63946' },
  { id: 'user-964ef540619374b1', username: 'uitest2', displayName: 'Second Tester', email: 'uitest2@example.com', color: '#457b9d' },
  { id: 'user-c6e3c1eea384f6f3', username: 'uitest3', displayName: 'Third Tester', email: 'uitest3@example.com', color: '#2a9d8f' },
];

// A real oscillator per peer, at an audible gain, so "is this element actually
// producing sound" is a question we can answer rather than assume.
function fakeMediaFn({ color, freq }) {
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    const canvas = document.createElement('canvas');
    canvas.width = 320; canvas.height = 240;
    const ctx = canvas.getContext('2d');
    (function draw() { ctx.fillStyle = color; ctx.fillRect(0, 0, 320, 240); requestAnimationFrame(draw); })();
    const videoStream = canvas.captureStream(15);
    const audioCtx = new AudioContext();
    const dest = audioCtx.createMediaStreamDestination();
    const gain = audioCtx.createGain(); gain.gain.value = 0.25;
    const osc = audioCtx.createOscillator(); osc.frequency.value = freq;
    osc.connect(gain).connect(dest); osc.start();
    const tracks = [];
    if (!constraints || constraints.video !== false) tracks.push(videoStream.getVideoTracks()[0]);
    if (!constraints || constraints.audio !== false) tracks.push(dest.stream.getAudioTracks()[0]);
    return new MediaStream(tracks);
  };
}

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? '  PASS' : '  FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const errors = [];
const browser = await chromium.launch({ args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });

async function makePeer(user, freq, viewport) {
  const ctx = await browser.newContext({ viewport });
  await ctx.addInitScript(fakeMediaFn, { color: user.color, freq });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${user.username}: ${e.message}`));
  // Record the URL for failed requests. A bare "Failed to load resource: 404"
  // from the console is undiagnosable; the URL is the whole diagnosis.
  // Third-party assets are out of scope: index.html and src/index.css pull webfonts
  // from fonts.googleapis.com / fonts.gstatic.com, which this sandbox cannot reach,
  // and an aborted font fetch says nothing about the call. Same-origin failures are
  // exactly what we DO want to catch, so only external hosts are filtered.
  const sameOrigin = (u) => { try { return new URL(u).origin === new URL(BASE).origin; } catch { return true; } };
  page.on('response', (r) => {
    if (r.status() >= 400 && sameOrigin(r.url())) errors.push(`${user.username}: HTTP ${r.status()} ${r.url()}`);
  });
  page.on('requestfailed', (r) => {
    if (sameOrigin(r.url())) errors.push(`${user.username}: REQFAIL ${r.url()} (${r.failure()?.errorText})`);
  });
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    // Skip the generic companion message; the response handler above has the URL.
    if (/Failed to load resource/.test(m.text())) return;
    errors.push(`${user.username}: ${m.text()}`);
  });
  await page.goto(`${BASE}/`);
  await page.evaluate(({ token, u }) => {
    localStorage.setItem('ibconnect_jwt', token);
    localStorage.setItem('ibconnect_me', JSON.stringify(u));
  }, { token: signHS256({ userId: user.id, exp }, JWT_SECRET), u: user });
  await page.reload();
  await page.waitForTimeout(1200);
  return page;
}

// Host starts WIDE (the sidebar is an off-canvas drawer below md, so nav is
// unreachable at phone widths), then narrows once everyone is in.
const host = await makePeer(users[0], 440, { width: 1280, height: 860 });
console.log('\nHost starting meeting…');
await host.click('[aria-label="Meetings"]');
await host.waitForSelector('text=Start New Meeting', { timeout: 15000 });
await host.click('text=Start New Meeting');
await host.waitForTimeout(3500);

const code = await host.evaluate(() => window.location.pathname.replace('/', '') || null);
check('host created a meeting and a room code is visible', !!code, code ?? 'no code found');
if (!code) { await browser.close(); process.exit(1); }

// ── Two more participants join ────────────────────────────────────────────────
const guests = [];
for (let i = 1; i < 3; i++) {
  const p = await makePeer(users[i], 440 + i * 110, { width: 1280, height: 820 });
  await p.click('[aria-label="Meetings"]');
  await p.waitForTimeout(800);
  await p.fill('input[placeholder="ENTER ROOM CODE…"]', code);
  await p.click('button:has-text("Join")');
  await p.waitForTimeout(3500);
  guests.push(p);
}
console.log('Waiting for media to settle…');
await host.waitForTimeout(7000);

// Narrow the host so selectGridLayout drops to a 2-tile layout and the third
// participant is pushed onto page 2 — the exact condition that used to silence them.
console.log('Narrowing host viewport to force pagination…');
// 320px, not 400. `selectGridLayout` used to fall back to a 2-tile layout at 400px
// wide, but that was the non-monotonic bug fixed on 2026-08-17 — a 374px container now
// correctly fits 6 tiles, so 3 participants no longer paginate there and this suite's
// precondition silently stopped reproducing. 320px gives a 304px container, below the
// 340px minimum for 2x3, so it genuinely lands on a 2-tile layout.
await host.setViewportSize({ width: 320, height: 740 });
await host.waitForTimeout(2500);

// ── The measurements ──────────────────────────────────────────────────────────
const probe = async (page) => page.evaluate(() => {
  const audios = [...document.querySelectorAll('audio')];
  const videos = [...document.querySelectorAll('video')];
  return {
    audioCount: audios.length,
    audios: audios.map((a) => ({
      hasStream: !!a.srcObject,
      tracks: a.srcObject ? a.srcObject.getAudioTracks().length : 0,
      muted: a.muted,
      paused: a.paused,
      t: a.currentTime,
    })),
    videoCount: videos.length,
    unmutedVideos: videos.filter((v) => !v.muted).length,
    renderedTiles: videos.length,
    hasPager: !!document.querySelector('[aria-label="Next participants"]'),
  };
});

const before = await probe(host);
await host.waitForTimeout(2500);
const after = await probe(host);

console.log('\n── Host (narrow viewport, pagination active) ──');
console.log(JSON.stringify(after, null, 2));

check('pagination is active (fewer tiles rendered than participants)',
  after.hasPager, after.hasPager ? 'pager controls present' : 'no pager — test did not reproduce the condition');

check('one <audio> element exists per remote peer',
  after.audioCount === 2, `found ${after.audioCount}, expected 2`);

check('every remote <audio> has a stream attached',
  after.audios.length > 0 && after.audios.every((a) => a.hasStream && a.tracks > 0),
  JSON.stringify(after.audios.map((a) => `${a.hasStream ? 'stream' : 'NO-STREAM'}/${a.tracks}trk`)));

check('no remote <audio> is muted',
  after.audios.every((a) => !a.muted), JSON.stringify(after.audios.map((a) => a.muted)));

check('no remote <audio> is paused',
  after.audios.every((a) => !a.paused), JSON.stringify(after.audios.map((a) => a.paused)));

const advanced = after.audios.map((a, i) => a.t > (before.audios[i]?.t ?? 0));
check('every remote <audio> currentTime is advancing (really playing)',
  advanced.length > 0 && advanced.every(Boolean),
  before.audios.map((a, i) => `${a.t.toFixed(2)}→${after.audios[i]?.t.toFixed(2)}`).join(', '));

check('all <video> elements are muted (audio comes only from <audio>, no double-play)',
  after.unmutedVideos === 0, `${after.unmutedVideos} unmuted video(s) found`);

// The core regression: strictly more peers are audible than are on screen.
check('audible peers exceed on-screen remote tiles (the finding-A fix)',
  after.audioCount > Math.max(0, after.renderedTiles - 1),
  `${after.audioCount} audible vs ${Math.max(0, after.renderedTiles - 1)} remote tiles rendered`);

// ── TURN credentials are no longer in the bundle ──────────────────────────────
const bundleHasSecret = await host.evaluate(async () => {
  const src = [...document.querySelectorAll('script[src]')].map((s) => s.src);
  for (const u of src) {
    try { if ((await (await fetch(u)).text()).includes('webrtc123')) return true; } catch {}
  }
  return false;
});
check('TURN password is not present in the served JS', !bundleHasSecret);

const iceOk = await host.evaluate(async () => {
  const r = await fetch('/api/turn-credentials');
  const j = await r.json();
  return r.ok && Array.isArray(j.iceServers) && j.iceServers.length >= 2;
});
check('/api/turn-credentials serves a usable ICE config', iceOk);

check('no console errors or page errors across all peers',
  errors.length === 0, errors.slice(0, 5).join(' | '));

await browser.close();

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
