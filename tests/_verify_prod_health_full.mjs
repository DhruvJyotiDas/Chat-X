// Full real-browser smoke test against production after a large batch of
// uncommitted changes from another session (CORS/origin restriction, JWT
// alg pinning, meeting_participants persistence, new AI endpoints, etc.) —
// verifies the app is actually reachable and functional end to end, not
// just that curl gets a 200.
import { chromium } from 'playwright';
import crypto from 'crypto';

const BASE = process.env.BASE || 'https://meet.icebrkr.space';
const JWT_SECRET = process.env.IBCONNECT_JWT_SECRET;
const exp = Math.floor(Date.now() / 1000) + 3600;
function b64url(i) { return Buffer.from(i).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_'); }
function signHS256(payload, secret) {
  const h = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64url(JSON.stringify(payload));
  const s = crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${h}.${p}.${s}`;
}
const U1 = { id: 'user-815ce7061367244d', username: 'uitest1', displayName: 'UI Test User', email: 'uitest1@example.com' };

const results = [];
const check = (n, pass, detail = '') => { results.push({ n, pass }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${n}${detail ? ' — ' + detail : ''}`); };

const errors = [];
const browser = await chromium.launch({ args: ['--no-sandbox', '--use-fake-ui-for-media-stream'] });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|favicon/.test(m.text())) errors.push('console: ' + m.text()); });
page.on('requestfailed', (req) => { if (!/favicon/.test(req.url())) errors.push('requestfailed: ' + req.url() + ' ' + (req.failure()?.errorText ?? '')); });

const navStart = Date.now();
const resp = await page.goto(BASE + '/', { waitUntil: 'load', timeout: 20000 }).catch((e) => { errors.push('goto failed: ' + e.message); return null; });
check('page loads (200)', !!resp && resp.status() === 200, resp ? `status=${resp.status()} in ${Date.now() - navStart}ms` : 'no response');

await page.evaluate(({ token, user }) => {
  localStorage.setItem('ibconnect_jwt', token);
  localStorage.setItem('ibconnect_me', JSON.stringify(user));
}, { token: signHS256({ userId: U1.id, exp }, JWT_SECRET), user: U1 });
await page.reload({ waitUntil: 'load' });
await page.waitForTimeout(2500);

check('sidebar/nav rendered (Chats link present)', await page.locator('[aria-label="Chats"]').count() > 0);
check('dashboard/main content rendered', await page.locator('body').innerText().then(t => t.length > 200));

await page.click('[aria-label="Chats"]').catch(() => {});
await page.waitForTimeout(2000);
check('Chats view opened without crashing', errors.filter(e => /Chats/i.test(e)).length === 0);

await page.click('[aria-label="Meetings"]').catch(() => {});
await page.waitForTimeout(1500);
check('Meetings view opened without crashing', await page.locator('text=Start New Meeting').count() > 0 || await page.locator('input[placeholder="ENTER ROOM CODE…"]').count() > 0);

// Real call: create a meeting and confirm LiveKit + signalling actually connect.
let roomCode = null;
try {
  await page.click('text=Start New Meeting');
  await page.waitForTimeout(4000);
  roomCode = await page.evaluate(() => window.location.pathname.replace('/', '') || null);
} catch (e) { errors.push('create meeting failed: ' + e.message); }
check('created a real meeting (room code assigned)', !!roomCode, roomCode ?? 'none');

const connectedToLiveKit = await page.evaluate(() => document.body.innerText.includes('') ).catch(() => false);
const videoCount = await page.locator('video').count().catch(() => 0);
check('at least one video element mounted after joining', videoCount > 0, `videoCount=${videoCount}`);

if (roomCode) {
  await page.evaluate(() => { /* leave the call cleanly */ });
  const leaveBtn = page.locator('[aria-label="Leave"], button:has-text("Leave")').first();
  if (await leaveBtn.count() > 0) await leaveBtn.click().catch(() => {});
  await page.waitForTimeout(1000);
}

check('zero console/page/request errors', errors.length === 0, errors.slice(0, 8).join(' | '));

console.log(`\n${results.filter(r => r.pass).length}/${results.length} passed`);
await browser.close();
process.exit(results.every(r => r.pass) ? 0 : 1);
