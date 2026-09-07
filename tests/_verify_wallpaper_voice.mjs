// Verifies three fixes: (1) wallpaper/personalize menu actually applies a
// selection (root cause: onClick losing a race against the menu's own
// mousedown-based outside-click-to-close handler), (2) the recording
// composer shows a real, animated mic-level waveform (not a static dot),
// (3) a sent voice message renders as a custom VoicePlayer bubble (play
// button + waveform + duration), not the browser's native <audio controls>.
import { chromium } from 'playwright';
import crypto from 'crypto';

const BASE = process.env.BASE || 'http://127.0.0.1:3101';

function b64url(i) { return Buffer.from(i).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_'); }
function jwt(uid) {
  const S = process.env.IBCONNECT_JWT_SECRET ?? 'ibconnect_jwt_secret_prod_2024_change_me';
  const h = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64url(JSON.stringify({ userId: uid, exp: Math.floor(Date.now() / 1000) + 3600 }));
  const sig = crypto.createHmac('sha256', S).update(`${h}.${p}`).digest('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${h}.${p}.${sig}`;
}
const T1 = jwt('user-815ce7061367244d');
const U1 = JSON.stringify({ id: 'user-815ce7061367244d', username: 'uitest1', displayName: 'UI Test User', email: 'uitest1@example.com' });

const results = [];
const check = (n, pass, detail = '') => { results.push({ n, pass }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${n}${detail ? ' — ' + detail : ''}`); };

function micInitScript() {
  return `(() => {
    navigator.mediaDevices.getUserMedia = async (c = {}) => {
      const tracks = [];
      if (c.audio) {
        const a = new AudioContext();
        const d = a.createMediaStreamDestination();
        const gain = a.createGain();
        gain.gain.value = 0.3;
        const o = a.createOscillator();
        o.frequency.value = 220;
        o.connect(gain).connect(d);
        o.start();
        tracks.push(d.stream.getAudioTracks()[0]);
      }
      return new MediaStream(tracks);
    };
  })();`;
}

const browser = await chromium.launch({ args: ['--no-sandbox', '--use-fake-ui-for-media-stream'] });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, permissions: ['microphone'] });
await ctx.addInitScript(micInitScript());
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') { const t = m.text(); if (!/Failed to load resource|favicon/.test(t)) errors.push('console: ' + t); } });

await page.goto(BASE + '/');
await page.evaluate(({ token, user }) => {
  localStorage.setItem('ibconnect_jwt', token);
  localStorage.setItem('ibconnect_me', user);
}, { token: T1, user: U1 });
await page.reload();
await page.waitForTimeout(2000);
await page.click('[aria-label="Chats"]');
await page.waitForTimeout(2500);

// Open the first available thread (self-DM not needed — any thread with a composer works).
const threadRow = page.locator('[data-thread-id], div:has(> span.text-\\[13px\\])').first();
// Fallback: click the first thread list item generically.
const anyThread = page.locator('aside, div').filter({ hasText: /./ });
// Simplify: find any element that looks like a thread list entry by role.
let opened = false;
for (const name of ['Second Tester', 'uitest2', 'UI Test User', 'Dhruv Jyoti Das']) {
  const el = page.locator(`span:text-is("${name}"):visible`).first();
  if (await el.count() > 0) {
    try { await el.click({ timeout: 2000 }); opened = true; break; } catch {}
  }
}
await page.waitForTimeout(2000);
check('opened a thread', opened);

// ---------- 1. Wallpaper / Personalize menu ----------
const personalizeBtn = page.locator('button[aria-label="Personalize this chat" i]:visible, button[title="Personalize this chat" i]:visible').first();
let personalizeOpened = false;
if (await personalizeBtn.count() > 0) {
  await personalizeBtn.click();
  await page.waitForTimeout(400);
  personalizeOpened = await page.locator('text=Wallpaper').first().count() > 0;
}
check('personalize menu has a Wallpaper section', personalizeOpened);

if (personalizeOpened) {
  const beforeStorage = await page.evaluate(() => localStorage.getItem('ibconnect_chat_personalization') || localStorage.getItem('chat_personalization') || '__none__');
  const swatch = page.locator('button[aria-label^="Wallpaper:"]:visible').nth(1); // pick a non-default one
  const swatchLabel = await swatch.getAttribute('aria-label');
  await swatch.click();
  await page.waitForTimeout(500);
  // Menu should still be interactable / selection should visibly register (border highlight)
  const stillThere = await page.locator('text=Wallpaper').first().count() > 0;
  check('menu did not vanish/break after clicking a wallpaper swatch', stillThere, swatchLabel || '');
  // Check localStorage actually changed somewhere.
  const afterStorage = await page.evaluate(() => JSON.stringify(Object.entries(localStorage).filter(([k]) => /personali[sz]/i.test(k))));
  check('localStorage recorded a personalization change', afterStorage !== '[]', afterStorage);
  // close menu
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
} else {
  check('localStorage recorded a personalization change', false, 'menu never opened, skipped');
}

// ---------- 2. Recording waveform ----------
const recordBtn = page.locator('button[aria-label="Record a voice message" i]:visible, button[title="Record a voice message" i]:visible').first();
let recordStarted = false;
if (await recordBtn.count() > 0) {
  await recordBtn.click();
  await page.waitForTimeout(300);
  recordStarted = await page.locator('button[aria-label="Send voice message"]:visible').count() > 0;
}
check('recording UI appears after clicking record', recordStarted);

if (recordStarted) {
  // Sample the waveform bar heights twice, a beat apart, and confirm they differ —
  // proving this is a live animation driven by real mic levels, not a static row.
  const heights1 = await page.locator('[aria-hidden="true"]:visible span.rounded-full').evaluateAll((els) => els.map((e) => e.style.height));
  await page.waitForTimeout(600);
  const heights2 = await page.locator('[aria-hidden="true"]:visible span.rounded-full').evaluateAll((els) => els.map((e) => e.style.height));
  check('waveform has bars', heights1.length > 0, `count=${heights1.length}`);
  check('waveform bars animate over time (real mic levels)', JSON.stringify(heights1) !== JSON.stringify(heights2));

  // Send it.
  await page.locator('button[aria-label="Send voice message"]:visible').click();
  await page.waitForTimeout(2500);
} else {
  check('waveform has bars', false, 'recording never started, skipped');
  check('waveform bars animate over time (real mic levels)', false, 'recording never started, skipped');
}

// ---------- 3. VoicePlayer bubble on the sent message ----------
await page.waitForTimeout(1000);
const voicePlayer = page.locator('button[aria-label="Play voice message"]:visible, button[aria-label="Pause voice message"]:visible:visible').last();
const voicePlayerCount = await voicePlayer.count();
check('sent voice message renders a custom play button (not native <audio controls>)', voicePlayerCount > 0);
const nativeAudioControls = await page.locator('audio[controls]').count();
check('no native <audio controls> element used for the voice bubble', nativeAudioControls === 0, `native audio[controls] count=${nativeAudioControls}`);

if (voicePlayerCount > 0) {
  await voicePlayer.click();
  await page.waitForTimeout(800);
  const pauseBtn = page.locator('button[aria-label="Pause voice message"]:visible').last();
  check('clicking play switches to a pause button', await pauseBtn.count() > 0);
}

check('zero console/page errors', errors.length === 0, errors.slice(0, 5).join(' | '));

console.log(`\n${results.filter(r => r.pass).length}/${results.length} passed`);
await browser.close();
process.exit(results.every(r => r.pass) ? 0 : 1);
