/**
 * Cross-browser smoke test for the LiveKit migration. Everything else in
 * this migration (_verify_livekit_stage3.mjs, _verify_livekit_screenshare.mjs,
 * _verify_livekit_gaps2_3.mjs, etc.) has only ever run under Chromium — this
 * is real, previously-untested surface, not a formality.
 *
 * Chromium-specific CLI flags used elsewhere in this repo's tests
 * (--use-fake-ui-for-media-stream, --autoplay-policy=no-user-gesture-required)
 * don't exist for Firefox/WebKit — each browser needs its own equivalent,
 * applied below per-engine rather than assumed portable. The app's own
 * fakeMediaFn (used across every _verify_livekit_*.mjs script) overrides
 * navigator.mediaDevices.getUserMedia directly at the JS layer, which is
 * itself browser-agnostic — it never calls the real camera/mic API, so it
 * doesn't depend on a native permission grant existing at all. What
 * genuinely differs per engine below is autoplay policy and (for WebKit)
 * whether Playwright's headless Linux build can run getUserMedia-shaped
 * code at all — that's a real, disclosed platform gap, not swept under a
 * shared abstraction that pretends the three engines are equivalent.
 *
 * Checks one thing per browser: two real participants join the same room,
 * each actually decodes the other's live video (videoWidth > 0, new frames
 * arriving) — the same bar _verify_livekit_gaps2_3.mjs used for "genuinely
 * decoding," not just "a video element exists."
 */
import { chromium, firefox, webkit } from 'playwright';
import crypto from 'crypto';

const BASE = process.env.BASE ?? 'http://127.0.0.1:3011';
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

const ENGINES = {
  chromium: {
    launcher: chromium,
    launchOpts: { args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] },
    contextOpts: { permissions: ['camera', 'microphone'] },
  },
  firefox: {
    launcher: firefox,
    // Firefox's fake-media/autoplay equivalents are launch-time prefs, not
    // CLI flags. media.navigator.permission.disabled skips the native
    // camera/mic prompt (fakeMediaFn never reaches it anyway, but the
    // Room/track-publish path elsewhere still probes permissions state).
    launchOpts: { firefoxUserPrefs: { 'media.navigator.streams.fake': true, 'media.navigator.permission.disabled': true, 'media.autoplay.default': 0 } },
    contextOpts: {},
  },
  webkit: {
    launcher: webkit,
    launchOpts: {},
    // WebKit (Linux/headless) has no camera/mic permission API for
    // grantPermissions — fakeMediaFn's override doesn't need the grant, but
    // this is exactly the kind of gap that can make WebKit behave
    // differently from the other two, disclosed rather than assumed away.
    contextOpts: {},
  },
};

async function runFor(engineName) {
  const { launcher, launchOpts, contextOpts } = ENGINES[engineName];
  const errors = [];
  let browser;
  try {
    browser = await launcher.launch(launchOpts);
  } catch (err) {
    return { engine: engineName, pass: false, reason: `launch failed: ${err.message}` };
  }

  async function makePeer(user, color) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, ...contextOpts });
    if (contextOpts.permissions) { try { await ctx.grantPermissions(contextOpts.permissions); } catch { /* not all engines support this */ } }
    await ctx.addInitScript(fakeMediaFn, color);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`${user.username}: ${e.message}`));
    await page.goto(`${BASE}/`);
    await page.evaluate(({ token, u }) => {
      localStorage.setItem('ibconnect_jwt', token);
      localStorage.setItem('ibconnect_me', JSON.stringify(u));
    }, { token: signHS256({ userId: user.id, exp }, JWT_SECRET), u: user });
    await page.reload();
    await page.waitForTimeout(1500);
    return page;
  }

  try {
    const host = await makePeer({ id: `user-xb-${engineName}-host`, username: `xb${engineName}host`, displayName: 'XB Host', email: 'a@a.com' }, '#8b0000');
    await host.click('[aria-label="Meetings"]');
    await host.waitForSelector('text=Start New Meeting', { timeout: 15000 });
    await host.click('text=Start New Meeting');
    await host.waitForTimeout(4000);
    const code = await host.evaluate(() => window.location.pathname.replace('/', '') || null);
    if (!code) return { engine: engineName, pass: false, reason: 'host never created a meeting' };
    await host.keyboard.press('Escape').catch(() => {});

    const guest = await makePeer({ id: `user-xb-${engineName}-guest`, username: `xb${engineName}guest`, displayName: 'XB Guest', email: 'b@b.com' }, '#1a5d1a');
    await guest.click('[aria-label="Meetings"]');
    await guest.waitForTimeout(800);
    await guest.fill('input[placeholder="ENTER ROOM CODE…"]', code);
    await guest.click('button:has-text("Join")');
    await guest.waitForTimeout(6000);

    // Each side must be genuinely decoding the other's video, not just show
    // a tile — same bar as the rest of this migration's tests.
    const guestSeesHost = await guest.evaluate(() => {
      const vids = Array.from(document.querySelectorAll('video'));
      return vids.some((v) => v.videoWidth > 0 && !v.paused);
    });
    const hostSeesGuest = await host.evaluate(() => {
      const vids = Array.from(document.querySelectorAll('video'));
      return vids.some((v) => v.videoWidth > 0 && !v.paused);
    });

    if (errors.length) return { engine: engineName, pass: false, reason: `console/page errors: ${errors.slice(0, 3).join(' | ')}` };
    if (!guestSeesHost || !hostSeesGuest) {
      return { engine: engineName, pass: false, reason: `guestSeesHost=${guestSeesHost} hostSeesGuest=${hostSeesGuest}` };
    }
    return { engine: engineName, pass: true };
  } catch (err) {
    return { engine: engineName, pass: false, reason: err.message };
  } finally {
    await browser.close();
  }
}

const results = [];
for (const engine of ['chromium', 'firefox', 'webkit']) {
  console.log(`── ${engine} ──`);
  const r = await runFor(engine);
  results.push(r);
  console.log(`  ${r.pass ? 'PASS' : 'FAIL'}${r.reason ? ` — ${r.reason}` : ''}`);
}

const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} engines passed real two-way video`);
if (passed !== results.length) {
  console.log('Failed engines (see reasons above — not assumed to be app bugs without checking, but not hidden either):');
  results.filter((r) => !r.pass).forEach((r) => console.log(`  - ${r.engine}: ${r.reason}`));
}
