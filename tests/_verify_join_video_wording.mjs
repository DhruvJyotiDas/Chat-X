/**
 * Regression suite for: "when I join it repeatedly turns off camera and turns on camera
 * for people." Root cause: `useHasVideo` treated a video track that hasn't attached yet
 * the same as one that was live and then explicitly stopped — both showed "Camera off".
 * A brand-new peer connection's video can be absent or muted for the first few seconds
 * (audio and video negotiate as separate transceivers that don't necessarily complete
 * together, and a track that does exist starts `muted: true` per spec until the first
 * frame decodes) — normal WebRTC behaviour, not a fault, and it happens on every OTHER
 * existing participant's connection every time anyone joins. On a real connection
 * (slower than this dev box) that window can be visible and can flicker through
 * mute/unmute more than once before settling — read by a user as a camera "repeatedly
 * turning off and on" right around a join.
 *
 * Fix: `useHasVideo` now reports `stillConnecting` — true while a stream that has never
 * once shown live video is within a `GRACE_MS` (6s) window since it first appeared.
 * `RemoteTile` shows "Connecting…" during that window instead of "Camera off", and
 * still correctly settles to "Camera off" once the grace period elapses for a peer who
 * genuinely has no camera (join-with-camera-off must NOT show "Connecting…" forever —
 * that's the regression risk this suite exists to catch).
 *
 * A second, independent bug was found and fixed alongside this: `applyCameraBudgets`
 * (which reapplies bitrate/scale to every existing camera connection whenever the
 * participant count changes — i.e. on every join or leave) called `setParameters()`
 * directly, unserialized against `createOfferFor`/`handleOffer`'s own calls to the same
 * function on the same sender. It's now routed through the same per-peer `serialize`
 * queue negotiation already uses. See `useWebRTC.ts` for the full reasoning.
 *
 * GOTCHA THAT COST REAL TIME while building this suite, worth documenting so it isn't
 * repeated: an earlier version's fake-camera stub was `(color, video) => (c) => {...}`
 * passed to `ctx.addInitScript(stub(color, video))` — i.e. relying on `video` as a
 * closed-over variable. Playwright's `addInitScript(fn)` serializes the function via
 * `fn.toString()` and re-evaluates the SOURCE TEXT fresh in the browser context — it
 * does NOT preserve JavaScript closures over the calling (Node.js) scope. Referencing
 * `video` inside the reconstructed function threw `ReferenceError: video is not
 * defined` INSIDE the stubbed `getUserMedia`, silently rejecting every video request —
 * which manufactured an extremely convincing but entirely fake "video track never
 * attaches, persists forever" symptom (confirmed by reproducing the bare ReferenceError
 * directly). A single-parameter version of the same pattern accidentally "worked" only
 * because its inner function's own parameter happened to shadow the outer one. The fix,
 * used below: pass data to `addInitScript` via its second `arg` parameter (which IS
 * properly serialized and bound as a real function parameter, not a closure), never via
 * a closure over Node-side variables.
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

const HOST = { id: 'user-815ce7061367244d', displayName: 'UI Test User' };

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

// No closures over Node-side variables — see the file header. `arg` is the only data
// that crosses into the browser context, via addInitScript's own serialization.
function stub({ color, video }) {
  navigator.mediaDevices.getUserMedia = async (constraints = {}) => {
    const t = [];
    if (constraints.video && video) {
      const cv = document.createElement('canvas'); cv.width = 320; cv.height = 240;
      const g = cv.getContext('2d');
      (function d(){ g.fillStyle = color; g.fillRect(0, 0, 320, 240); requestAnimationFrame(d); })();
      t.push(cv.captureStream(15).getVideoTracks()[0]);
    }
    if (constraints.audio) {
      const a = new AudioContext(), dst = a.createMediaStreamDestination(), o = a.createOscillator();
      o.connect(dst); o.start(); t.push(dst.stream.getAudioTracks()[0]);
    }
    return new MediaStream(t);
  };
}

const browser = await chromium.launch({
  args: ['--no-sandbox','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream','--autoplay-policy=no-user-gesture-required'],
});
const errors = [];
const mk = async (label, color, video = true) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ['camera','microphone'] });
  await ctx.addInitScript(stub, { color, video });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${label}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (/Failed to load resource|favicon|ERR_ABORTED/.test(t)) return;
    errors.push(`${label}: ${t}`);
  });
  return { ctx, page, label };
};

console.log('── Setup: host + camera-on watcher ──');
const host = await mk('host', '#c0392b');
await host.page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
await host.page.evaluate(({ t }) => { localStorage.clear(); localStorage.setItem('ibconnect_jwt', t); }, { t: sign({ userId: HOST.id, exp }) });
await host.page.reload({ waitUntil: 'domcontentloaded' });
await host.page.waitForTimeout(3000);
await host.page.click('[aria-label="Meetings"]');
await host.page.waitForTimeout(1200);
await host.page.click('text=/Instant start/i');
await host.page.waitForTimeout(5000);
await host.page.keyboard.press('Escape');
await host.page.waitForTimeout(500);
const room = await host.page.evaluate(() => location.pathname.replace('/', ''));
check('room created', !!room, room);

const watcher = await mk('watcher', '#27ae60', true);
await watcher.page.goto(`${BASE}/${room}`, { waitUntil: 'domcontentloaded' });
await watcher.page.waitForTimeout(1500);
await watcher.page.locator('input[aria-label="Your name"]').fill('Camera On Watcher');
await watcher.page.click('button:has-text("Join now")');
await watcher.page.waitForTimeout(9000); // comfortably past GRACE_MS (6s)

const cameraOffShown = () => watcher.page.evaluate(() => /Camera off/i.test(document.body.innerText));
const connectingShown = () => watcher.page.evaluate(() => /Connecting/i.test(document.body.innerText));

console.log('\n── A healthy join settles to video, never mislabelled "Camera off" ──');
check('the host\'s tile does not show "Camera off" once settled', !(await cameraOffShown()));
check('the host\'s tile is not stuck on "Connecting…" once settled', !(await connectingShown()));

console.log('\n── A second peer joins — same check from the new peer\'s perspective ──');
const second = await mk('second', '#2980b9', true);
await second.page.goto(`${BASE}/${room}`, { waitUntil: 'domcontentloaded' });
await second.page.waitForTimeout(1500);
await second.page.locator('input[aria-label="Your name"]').fill('Second Watcher');
await second.page.click('button:has-text("Join now")');
await second.page.waitForTimeout(9000); // comfortably past GRACE_MS (6s)
const secondCameraOff = await second.page.evaluate(() => /Camera off/i.test(document.body.innerText));
const secondConnecting = await second.page.evaluate(() => /Connecting/i.test(document.body.innerText));
check('the new joiner sees both existing camera-on peers settled, not "Camera off"', !secondCameraOff);
check('the new joiner is not stuck on "Connecting…" once settled', !secondConnecting);

console.log('\n── Camera-off joiner still shows off (after the grace period, not "Connecting" forever) ──');
const shy = await mk('shy', '#8e44ad', false);
await shy.page.goto(`${BASE}/${room}`, { waitUntil: 'domcontentloaded' });
await shy.page.waitForTimeout(1500);
await shy.page.locator('input[aria-label="Your name"]').fill('Camera Off Joiner');
await shy.page.click('button:has-text("Join now")');
await host.page.waitForTimeout(8000); // past GRACE_MS (6s)

const hostView = await host.page.evaluate(() => {
  const el = [...document.querySelectorAll('*')].find((e) =>
    e.children.length === 0 && /Camera off/i.test(e.textContent || ''));
  return { cameraOffPresent: !!el };
});
check('a peer who joins with the camera off settles to "Camera off" (not "Connecting" forever)',
  hostView.cameraOffPresent);

check('no console or page errors', errors.length === 0, errors.join(' | '));

await browser.close();

const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} checks passed`);
if (passed !== results.length) {
  console.log('Failed:');
  results.filter((r) => !r.pass).forEach((r) => console.log(`  - ${r.name}`));
  process.exit(1);
}
