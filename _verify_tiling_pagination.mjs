import { chromium } from 'playwright';
import crypto from 'crypto';

const SHOT_DIR = '/tmp/claude-1001/-home-ubuntu/fceaf7d3-c80b-49ac-8bb1-fa080f16e8b3/scratchpad';
function b64url(input) { return Buffer.from(input).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_'); }
function signHS256(payload, secret) {
  const h = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${h}.${p}.${sig}`;
}
const JWT_SECRET = (process.env.IBCONNECT_JWT_SECRET
  ?? 'ibconnect_jwt_secret_prod_2024_change_me')  // legacy fallback: the backend now requires IBCONNECT_JWT_SECRET, so export it to test a deployed build;
const exp = Math.floor(Date.now() / 1000) + 3600 * 6;

const users = [
  { id: 'user-815ce7061367244d', username: 'uitest1', displayName: 'UI Test User', email: 'uitest1@example.com', color: '#e63946' },
  { id: 'user-964ef540619374b1', username: 'uitest2', displayName: 'Second Tester', email: 'uitest2@example.com', color: '#457b9d' },
  { id: 'user-c6e3c1eea384f6f3', username: 'uitest3', displayName: 'Third Tester', email: 'uitest3@example.com', color: '#2a9d8f' },
];

function fakeMediaFn({ color }) {
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const canvas = document.createElement('canvas');
      canvas.width = 320; canvas.height = 240;
      const ctx = canvas.getContext('2d');
      function draw() { ctx.fillStyle = color; ctx.fillRect(0, 0, canvas.width, canvas.height); requestAnimationFrame(draw); }
      draw();
      const videoStream = canvas.captureStream(15);
      const audioCtx = new AudioContext();
      const dest = audioCtx.createMediaStreamDestination();
      const gain = audioCtx.createGain(); gain.gain.value = 0.0001;
      const osc = audioCtx.createOscillator(); osc.connect(gain).connect(dest); osc.start();
      const tracks = [];
      if (!constraints || constraints.video !== false) tracks.push(videoStream.getVideoTracks()[0]);
      if (!constraints || constraints.audio !== false) tracks.push(dest.stream.getAudioTracks()[0]);
      return new MediaStream(tracks);
    };
}

const browser = await chromium.launch({ args: ['--no-sandbox', '--use-fake-ui-for-media-stream'] });
// Host starts on a NARROW portrait viewport (phone-like) so 3 tiles exceed the picked layout's capacity.
const ctxA = await browser.newContext({ viewport: { width: 1400, height: 900 } });
await ctxA.addInitScript(fakeMediaFn, { color: users[0].color });
const pageA = await ctxA.newPage();
pageA.on('pageerror', (e) => console.log('PAGE ERROR A:', e.message));

const t1 = signHS256({ userId: users[0].id, exp }, JWT_SECRET);
await pageA.goto('http://localhost:3000/');
await pageA.evaluate(({ token, user }) => {
  localStorage.setItem('ibconnect_jwt', token);
  localStorage.setItem('ibconnect_me', JSON.stringify(user));
}, { token: t1, user: users[0] });
await pageA.reload();
await pageA.waitForTimeout(1000);

console.log('Host starting meeting...');
await pageA.click('[aria-label="Meetings"]');
await pageA.waitForSelector('text=Start New Meeting', { timeout: 10000 });
await pageA.click('text=Start New Meeting');
await pageA.waitForTimeout(3000);
const roomId = await pageA.evaluate(() => window.location.pathname.replace('/', ''));
console.log('Room:', roomId);

for (let i = 1; i < users.length; i++) {
  const u = users[i];
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await ctx.addInitScript(fakeMediaFn, { color: u.color });
  const page = await ctx.newPage();
  const t = signHS256({ userId: u.id, exp }, JWT_SECRET);
  await page.goto('http://localhost:3000/');
  await page.evaluate(({ token, user }) => {
    localStorage.setItem('ibconnect_jwt', token);
    localStorage.setItem('ibconnect_me', JSON.stringify(user));
  }, { token: t, user: u });
  await page.reload();
  await page.waitForTimeout(1000);
  await page.click('[aria-label="Meetings"]');
  await page.waitForTimeout(500);
  await page.fill('input[placeholder="ENTER ROOM CODE…"]', roomId);
  await page.click('button:has-text("Join")');
  await page.waitForTimeout(3000);
  console.log(`Peer ${i} (${u.displayName}) joined.`);
}

await pageA.waitForTimeout(2500);

console.log('Resizing host to narrow portrait (390x800) after all 3 peers joined...');
await pageA.setViewportSize({ width: 390, height: 800 });
await pageA.waitForTimeout(800);

await pageA.locator('svg.lucide-x').first().click({ force: true }).catch(()=>{});
await pageA.waitForTimeout(300);

const gridStyle = await pageA.evaluate(() => {
  const el = document.querySelector('[style*="grid-template-columns"]');
  return el ? el.getAttribute('style') : null;
});
console.log('Host grid style (390x800, 3 tiles):', gridStyle);

const visibleTileCount = await pageA.evaluate(() => {
  const el = document.querySelector('[style*="grid-template-columns"]');
  return el ? el.children.length : -1;
});
console.log('Visible tile count on current page:', visibleTileCount);

const hasPagination = await pageA.evaluate(() => !!document.querySelector('button[aria-label="Next participants"]'));
console.log('Pagination controls present:', hasPagination);

await pageA.screenshot({ path: `${SHOT_DIR}/pagination-page1.png` });

if (hasPagination) {
  await pageA.click('button[aria-label="Next participants"]', { force: true });
  await pageA.waitForTimeout(500);
  const visibleTileCount2 = await pageA.evaluate(() => {
    const el = document.querySelector('[style*="grid-template-columns"]');
    return el ? el.children.length : -1;
  });
  console.log('Visible tile count on page 2:', visibleTileCount2);
  await pageA.screenshot({ path: `${SHOT_DIR}/pagination-page2.png` });
}

await browser.close();
console.log('Done.');
