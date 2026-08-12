// Verifies the dynamic grid layout + client-side active-speaker ring added to
// ActiveMeetingView (see src/lib/gridLayout.ts, src/hooks/useAudioLevels.ts).
// Mints JWTs directly (same trick as _smoke_test.mjs) for two pre-existing local
// dev accounts (uitest1/uitest2) rather than going through the OIDC "Continue with
// IB" flow, using the HS256 secret already hardcoded in server/main.go (`jwtKey`).
import { chromium } from 'playwright';
import crypto from 'crypto';
import { mkdirSync } from 'fs';

const SHOT_DIR = process.env.SHOT_DIR || './_verify_tiling_shots';
mkdirSync(SHOT_DIR, { recursive: true });

function b64url(input) { return Buffer.from(input).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_'); }
function signHS256(payload, secret) {
  const h = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${h}.${p}.${sig}`;
}
const JWT_SECRET = (process.env.IBCONNECT_JWT_SECRET
  ?? 'ibconnect_jwt_secret_prod_2024_change_me')  // legacy fallback: the backend now requires IBCONNECT_JWT_SECRET, so export it to test a deployed build; // server/main.go `jwtKey`
const exp = Math.floor(Date.now() / 1000) + 3600 * 6;
const t1 = signHS256({ userId: 'user-815ce7061367244d', exp }, JWT_SECRET); // uitest1
const t2 = signHS256({ userId: 'user-964ef540619374b1', exp }, JWT_SECRET); // uitest2

const USER1 = JSON.stringify({ id: 'user-815ce7061367244d', username: 'uitest1', displayName: 'UI Test User', email: 'uitest1@example.com' });
const USER2 = JSON.stringify({ id: 'user-964ef540619374b1', username: 'uitest2', displayName: 'Second Tester', email: 'uitest2@example.com' });

function fakeMediaFn({ color, tone }) {
    const OriginalGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const canvas = document.createElement('canvas');
      canvas.width = 320; canvas.height = 240;
      const ctx = canvas.getContext('2d');
      function draw() {
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#000';
        ctx.font = '20px sans-serif';
        ctx.fillText(new Date().toISOString().slice(11, 19), 10, 30);
        requestAnimationFrame(draw);
      }
      draw();
      const videoStream = canvas.captureStream(15);

      const audioCtx = new AudioContext();
      const dest = audioCtx.createMediaStreamDestination();
      if (tone) {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        gain.gain.value = 0.4;
        osc.frequency.value = 220;
        osc.connect(gain).connect(dest);
        osc.start();
        window.__oscGain = gain;
      } else {
        const gain = audioCtx.createGain();
        gain.gain.value = 0.0001;
        const osc = audioCtx.createOscillator();
        osc.connect(gain).connect(dest);
        osc.start();
      }

      const tracks = [];
      if (!constraints || constraints.video !== false) tracks.push(videoStream.getVideoTracks()[0]);
      if (!constraints || constraints.audio !== false) tracks.push(dest.stream.getAudioTracks()[0]);
      return new MediaStream(tracks);
    };
}

const browser = await chromium.launch({ args: ['--no-sandbox', '--use-fake-ui-for-media-stream'] });

const ctxA = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const ctxB = await browser.newContext({ viewport: { width: 1400, height: 900 } });

await ctxA.addInitScript(fakeMediaFn, { color: '#e63946', tone: true }); // host: red camera, WITH audio tone (should trigger speaking ring)
await ctxB.addInitScript(fakeMediaFn, { color: '#457b9d', tone: false }); // joiner: blue camera, silent

const pageA = await ctxA.newPage();
const pageB = await ctxB.newPage();

const errorsA = []; const errorsB = [];
pageA.on('pageerror', (e) => errorsA.push(e.message));
pageB.on('pageerror', (e) => errorsB.push(e.message));

console.log('1. Logging in both contexts...');
await pageA.goto('http://localhost:3000/');
await pageA.evaluate(({ token, user }) => {
  localStorage.setItem('ibconnect_jwt', token);
  localStorage.setItem('ibconnect_me', user);
}, { token: t1, user: USER1 });
await pageA.reload();
await pageA.waitForTimeout(1200);

await pageB.goto('http://localhost:3000/');
await pageB.evaluate(({ token, user }) => {
  localStorage.setItem('ibconnect_jwt', token);
  localStorage.setItem('ibconnect_me', user);
}, { token: t2, user: USER2 });
await pageB.reload();
await pageB.waitForTimeout(1200);

console.log('2. Host (A) navigating to Meetings and starting a meeting...');
await pageA.click('[aria-label="Meetings"]');
await pageA.waitForSelector('text=Start New Meeting', { timeout: 10000 });
await pageA.screenshot({ path: '/tmp/claude-1001/-home-ubuntu/fceaf7d3-c80b-49ac-8bb1-fa080f16e8b3/scratchpad/A-debrief-before.png' });
await pageA.click('text=Start New Meeting');
await pageA.waitForTimeout(4000);
await pageA.screenshot({ path: '/tmp/claude-1001/-home-ubuntu/fceaf7d3-c80b-49ac-8bb1-fa080f16e8b3/scratchpad/A-after-start-click.png' });
console.log('   errorsA so far:', errorsA);

const roomId = await pageA.evaluate(() => window.location.pathname.replace('/', ''));
console.log('   Room code:', roomId);
if (!roomId) throw new Error('Did not get a room code from host context');

console.log('3. Joiner (B) navigating to Meetings and joining with the code...');
await pageB.click('[aria-label="Meetings"]');
await pageB.waitForTimeout(500);
await pageB.fill('input[placeholder="ENTER ROOM CODE…"]', roomId);
await pageB.click('button:has-text("Join")');
await pageB.waitForTimeout(4000);

console.log('4. Waiting for both peers to see 2 tiles...');
await pageA.waitForTimeout(2000);

await pageA.screenshot({ path: '/tmp/claude-1001/-home-ubuntu/fceaf7d3-c80b-49ac-8bb1-fa080f16e8b3/scratchpad/A-2up-wide.png' });
await pageB.screenshot({ path: '/tmp/claude-1001/-home-ubuntu/fceaf7d3-c80b-49ac-8bb1-fa080f16e8b3/scratchpad/B-2up-wide.png' });

console.log('5. Inspecting grid container style (should be inline gridTemplateColumns/Rows, not a fixed Tailwind class)...');
const gridStyleA = await pageA.evaluate(() => {
  const el = document.querySelector('[style*="grid-template-columns"]');
  return el ? el.getAttribute('style') : null;
});
console.log('   A grid inline style:', gridStyleA);

console.log('6. Checking for active-speaker ring (A is emitting a tone, should highlight)...');
await pageA.waitForTimeout(1500); // let the audio-level poller catch up (HOLD_MS=600, POLL_MS=120)
const speakingRingCountA = await pageA.evaluate(() => document.querySelectorAll('.ring-\\[\\#8ab4f8\\]\\/70').length);
console.log('   Tiles with speaking ring on A side:', speakingRingCountA);
await pageA.screenshot({ path: '/tmp/claude-1001/-home-ubuntu/fceaf7d3-c80b-49ac-8bb1-fa080f16e8b3/scratchpad/A-speaking.png' });

console.log('7. Resizing host window to a narrow portrait shape to confirm the grid recomputes...');
await pageA.setViewportSize({ width: 420, height: 900 });
await pageA.waitForTimeout(800);
const gridStyleA_narrow = await pageA.evaluate(() => {
  const el = document.querySelector('[style*="grid-template-columns"]');
  return el ? el.getAttribute('style') : null;
});
console.log('   A grid inline style (narrow/portrait):', gridStyleA_narrow);
await pageA.screenshot({ path: '/tmp/claude-1001/-home-ubuntu/fceaf7d3-c80b-49ac-8bb1-fa080f16e8b3/scratchpad/A-narrow-portrait.png' });

console.log('\nConsole/page errors A:', errorsA.length ? errorsA : 'none');
console.log('Console/page errors B:', errorsB.length ? errorsB : 'none');

await pageA.evaluate(() => {}).catch(() => {});
await browser.close();
console.log('\nDone.');
