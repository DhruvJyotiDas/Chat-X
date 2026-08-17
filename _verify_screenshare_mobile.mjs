/**
 * Regression suite for: "for mobile phone screenshare doesn't work."
 *
 * iOS Safari has never shipped `getDisplayMedia` for web content — Apple only exposes
 * screen capture to native apps via ReplayKit — and most other mobile browsers either
 * lack it too or support it too inconsistently to rely on. The "Share screen" button
 * was shown unconditionally and called `getDisplayMedia` directly: on a device without
 * it, the call throws a bare `TypeError` (the method doesn't exist, so there's no
 * `DOMException.name` to branch on), which the catch block only ever sent to
 * `console.warn` — invisible on a phone. Tapping the button did nothing the user could
 * see, indistinguishable from a broken app.
 *
 * Fix: `isScreenShareSupported()` (src/lib/screenShare.ts) feature-detects the API —
 * same pattern as `isSpeakerSelectionSupported` for `setSinkId` — and the button is
 * hidden entirely (not shown-and-broken) where it's absent, in both the desktop inline
 * control strip and the mobile "More" sheet, since both render from the same
 * `secondaryActions` data. `toggleScreenShare` also gained a defense-in-depth guard and
 * surfaces a real `mediaNotice` on failure instead of silent `console.warn`, in case
 * anything ever calls it despite the hidden button.
 *
 * This suite simulates a browser without the capability (the iOS Safari case) by
 * deleting `getDisplayMedia` before the app loads, and asserts the button is nowhere
 * to be found — then confirms a normal (desktop-class) browser still shows and can use
 * it, as a regression guard against hiding it everywhere by mistake.
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

const HOST = { id: 'user-815ce7061367244d' };

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

// Simulates iOS Safari: getDisplayMedia simply does not exist on mediaDevices.
// It lives on the MediaDevices prototype, not the navigator.mediaDevices instance —
// deleting the instance property (which doesn't exist) is a no-op that leaves the
// inherited method fully visible, so the prototype is what actually has to change.
function stripScreenShare() {
  delete MediaDevices.prototype.getDisplayMedia;
}

const browser = await chromium.launch({
  args: ['--no-sandbox','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream','--autoplay-policy=no-user-gesture-required'],
});
const errors = [];
const mk = async (label, { mobile = false } = {}) => {
  // Always start at desktop size — the sidebar is an off-canvas drawer below `md`
  // (see CLAUDE.md's Responsive section), so a 390px viewport can't reach the
  // "Instant start" flow at all. Resize to mobile only once the room exists, right
  // before checking the in-call control bar, which is the thing actually under test.
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ['camera','microphone'] });
  await ctx.addInitScript(stub);
  if (mobile) await ctx.addInitScript(stripScreenShare);
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

const joinAsHost = async (page) => {
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(({ t }) => { localStorage.clear(); localStorage.setItem('ibconnect_jwt', t); }, { t: sign({ userId: HOST.id, exp }) });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  await page.click('[aria-label="Meetings"]');
  await page.waitForTimeout(1200);
  await page.click('text=/Instant start/i');
  await page.waitForTimeout(5000);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
};

console.log('── Simulated iOS Safari (no getDisplayMedia at all), mobile viewport ──');
const mobile = await mk('mobile', { mobile: true });
await joinAsHost(mobile.page);
const hasApiOnMobile = await mobile.page.evaluate(() => typeof navigator.mediaDevices.getDisplayMedia === 'function');
check('the stub really did remove getDisplayMedia (sanity check on the simulation itself)', !hasApiOnMobile);

await mobile.page.setViewportSize({ width: 390, height: 844 });
await mobile.page.waitForTimeout(500);

// Desktop control strip is hidden below lg, so open the "More" sheet mobile actually uses.
const moreBtn = mobile.page.locator('[aria-label="More"], button:has-text("More")').first();
if (await moreBtn.isVisible().catch(() => false)) await moreBtn.click();
await mobile.page.waitForTimeout(500);
const shareVisibleInSheet = await mobile.page.locator('text=/Share screen/i').isVisible().catch(() => false);
check('"Share screen" is not offered anywhere in the mobile sheet', !shareVisibleInSheet);
const shareVisibleAnywhere = await mobile.page.locator('[aria-label="Share screen"], [title="Share screen"]').count();
check('"Share screen" is not present anywhere in the DOM (not just visually hidden)', shareVisibleAnywhere === 0,
  `${shareVisibleAnywhere} match(es)`);

console.log('\n── Regression guard: a normal (desktop-class) browser still offers it ──');
const desktop = await mk('desktop', { mobile: false });
await joinAsHost(desktop.page);
const hasApiOnDesktop = await desktop.page.evaluate(() => typeof navigator.mediaDevices.getDisplayMedia === 'function');
check('the desktop context genuinely has getDisplayMedia (sanity check)', hasApiOnDesktop);
const shareVisibleDesktop = await desktop.page.locator('[aria-label="Share screen"], [title="Share screen"]').count();
check('"Share screen" IS offered when the capability genuinely exists', shareVisibleDesktop > 0,
  `${shareVisibleDesktop} match(es)`);

check('no console or page errors', errors.length === 0, errors.join(' | '));

await browser.close();

const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} checks passed`);
if (passed !== results.length) {
  console.log('Failed:');
  results.filter((r) => !r.pass).forEach((r) => console.log(`  - ${r.name}`));
  process.exit(1);
}
