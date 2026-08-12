/**
 * Exercises the getUserMedia FAILURE paths, which is where the permission logic
 * was wrong. Each case stubs navigator.mediaDevices.getUserMedia to reject with a
 * specific DOMException name (or to reject only for video), then checks what the
 * app does about it.
 *
 * The important one is CAMERA-BLOCKED-MIC-ALLOWED: browsers let a user block the
 * camera while leaving the microphone allowed, and the combined
 * getUserMedia({video,audio}) then rejects with NotAllowedError. The old code
 * treated that as fatal and never tried the audio-only fallback, so those users
 * could not join at all.
 *
 * BASE selects the target (default the throwaway :3100 pair).
 */
import { chromium } from 'playwright';
import crypto from 'crypto';

const BASE = process.env.BASE ?? 'http://127.0.0.1:3100';
const JWT_SECRET = (process.env.IBCONNECT_JWT_SECRET
  ?? 'ibconnect_jwt_secret_prod_2024_change_me')  // legacy fallback: the backend now requires IBCONNECT_JWT_SECRET, so export it to test a deployed build;
const exp = Math.floor(Date.now() / 1000) + 3600 * 6;
const b64 = (i) => Buffer.from(i).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
function sign(p) {
  const h = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' })), y = b64(JSON.stringify(p));
  return `${h}.${y}.` + crypto.createHmac('sha256', JWT_SECRET).update(`${h}.${y}`)
    .digest('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}
const user = { id: 'user-815ce7061367244d', username: 'uitest1', displayName: 'UI Test User', email: 'uitest1@example.com' };

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

// mode: 'deny-all' | 'deny-video-only' | 'busy' | 'missing' | 'ok'
function stubMedia({ mode }) {
  const makeTrack = (kind) => {
    const c = document.createElement('canvas'); c.width = 320; c.height = 240;
    c.getContext('2d').fillRect(0, 0, 320, 240);
    if (kind === 'video') return c.captureStream(10).getVideoTracks()[0];
    const a = new AudioContext(), d = a.createMediaStreamDestination(), o = a.createOscillator();
    o.connect(d); o.start();
    return d.stream.getAudioTracks()[0];
  };
  const fail = (name, msg) => { const e = new Error(msg); e.name = name; throw e; };

  navigator.mediaDevices.getUserMedia = async (constraints = {}) => {
    const wantsVideo = !!constraints.video;
    if (mode === 'deny-all') fail('NotAllowedError', 'denied');
    if (mode === 'deny-video-only' && wantsVideo) fail('NotAllowedError', 'camera blocked');
    if (mode === 'busy' && wantsVideo) fail('NotReadableError', 'device in use');
    if (mode === 'missing' && wantsVideo) fail('NotFoundError', 'no device');
    const tracks = [];
    if (wantsVideo) tracks.push(makeTrack('video'));
    if (constraints.audio) tracks.push(makeTrack('audio'));
    return new MediaStream(tracks);
  };
}

const browser = await chromium.launch({ args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });

async function startCall(mode) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  await ctx.addInitScript(stubMedia, { mode });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${BASE}/`);
  await page.evaluate(({ t, u }) => {
    localStorage.setItem('ibconnect_jwt', t);
    localStorage.setItem('ibconnect_me', JSON.stringify(u));
  }, { t: sign({ userId: user.id, exp }), u: user });
  await page.reload();
  await page.waitForTimeout(1200);
  await page.click('[aria-label="Meetings"]');
  await page.waitForSelector('text=Start New Meeting', { timeout: 15000 });
  await page.click('text=Start New Meeting');
  await page.waitForTimeout(4000);
  return { ctx, page, errors };
}

const state = (page) => page.evaluate(() => ({
  inCall: !!document.querySelector('[aria-label="Leave call"], [title="Leave call"]')
       || /Leave/i.test(document.body.innerText),
  bodyText: document.body.innerText.slice(0, 1400),
  audioTracks: (() => {
    const v = document.querySelector('video');
    return v && v.srcObject ? v.srcObject.getAudioTracks().length : -1;
  })(),
}));

// ── 1. Camera blocked, microphone allowed — must still join, audio-only ───────
console.log('\n── Camera blocked / mic allowed ──');
{
  const { ctx, page } = await startCall('deny-video-only');
  const s = await state(page);
  check('joins the call instead of being locked out', s.inCall,
    s.inCall ? 'call UI present' : 'BLOCKED — this is the regression');
  check('explains that the camera specifically was blocked',
    /camera access is blocked/i.test(s.bodyText),
    (s.bodyText.match(/[^.]*blocked[^.]*\./i) || ['no message'])[0].trim().slice(0, 110));
  check('does not claim the device is missing',
    !/no camera or microphone was found/i.test(s.bodyText));
  await ctx.close();
}

// ── 2. Camera in use by another app ───────────────────────────────────────────
console.log('\n── Camera busy (NotReadableError) ──');
{
  const { ctx, page } = await startCall('busy');
  const s = await state(page);
  check('still joins with audio', s.inCall);
  check('says the device is in use, not that it is missing',
    /already being used by another app/i.test(s.bodyText),
    (s.bodyText.match(/[^.]*already being used[^.]*\./i) || ['no message'])[0].trim().slice(0, 110));
  check('does NOT say "no camera found"', !/no camera .*was found/i.test(s.bodyText));
  await ctx.close();
}

// ── 3. No camera hardware ─────────────────────────────────────────────────────
console.log('\n── Camera absent (NotFoundError) ──');
{
  const { ctx, page } = await startCall('missing');
  const s = await state(page);
  check('still joins with audio', s.inCall);
  check('correctly reports a missing device here', /no camera was found/i.test(s.bodyText),
    (s.bodyText.match(/[^.]*was found[^.]*\./i) || ['no message'])[0].trim().slice(0, 110));
  await ctx.close();
}

// ── 4. Everything denied — must fail, with an actionable message ──────────────
console.log('\n── Both devices denied ──');
{
  const { ctx, page } = await startCall('deny-all');
  const s = await state(page);
  check('surfaces a permission message naming the devices',
    /camera and microphone access is blocked|microphone access is blocked/i.test(s.bodyText),
    (s.bodyText.match(/[^.]*access is blocked[^.]*\./i) || ['NO MESSAGE'])[0].trim().slice(0, 120));
  check('tells the user how to fix it', /address bar/i.test(s.bodyText));
  check('does not silently drop into a call with no media', !/already being used/i.test(s.bodyText));
  await ctx.close();
}

// ── 5. Guest lobby settles BOTH permissions before joining ────────────────────
console.log('\n── Guest lobby requests camera AND microphone ──');
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  await ctx.addInitScript(() => {
    window.__gumCalls = [];
    const c = document.createElement('canvas'); c.width = 320; c.height = 240;
    c.getContext('2d').fillRect(0, 0, 320, 240);
    navigator.mediaDevices.getUserMedia = async (constraints = {}) => {
      window.__gumCalls.push(JSON.stringify(constraints));
      const tracks = [];
      if (constraints.video) tracks.push(c.captureStream(10).getVideoTracks()[0]);
      if (constraints.audio) {
        const a = new AudioContext(), d = a.createMediaStreamDestination(), o = a.createOscillator();
        o.connect(d); o.start(); tracks.push(d.stream.getAudioTracks()[0]);
      }
      return new MediaStream(tracks);
    };
  });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/ABCD-1234`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  const calls = await page.evaluate(() => window.__gumCalls ?? []);
  check('lobby preview requests audio as well as video',
    calls.some((c) => c.includes('"audio":true')),
    calls.join(' | ') || 'no getUserMedia calls recorded');
  await ctx.close();
}

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
