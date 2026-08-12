// Verifies the image lightbox: clicking a chat image opens an in-place preview box
// (not a new tab/redirect) carrying Download and Share controls.
import { chromium } from 'playwright';
import crypto from 'crypto';

const BASE = process.env.BASE || 'http://127.0.0.1:3100';
const SHOTS = '/tmp/claude-1001/-home-ubuntu/52e9ddae-f949-4872-a25e-a5501ee7cb94/scratchpad';

function b64url(i) { return Buffer.from(i).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_'); }
function jwt(uid) {
  const S = (process.env.IBCONNECT_JWT_SECRET
  ?? 'ibconnect_jwt_secret_prod_2024_change_me')  // legacy fallback: the backend now requires IBCONNECT_JWT_SECRET, so export it to test a deployed build;
  const h = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64url(JSON.stringify({ userId: uid, exp: Math.floor(Date.now() / 1000) + 3600 }));
  const sig = crypto.createHmac('sha256', S).update(`${h}.${p}`).digest('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${h}.${p}.${sig}`;
}
const T2 = jwt('user-964ef540619374b1');
const USER2 = JSON.stringify({ id: 'user-964ef540619374b1', username: 'uitest2', displayName: 'Second Tester', email: 'uitest2@example.com' });

const results = [];
const check = (n, pass, detail = '') => { results.push({ n, pass }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${n}${detail ? ' — ' + detail : ''}`); };

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

await page.goto(BASE + '/');
await page.evaluate(({ token, user }) => {
  localStorage.setItem('ibconnect_jwt', token);
  localStorage.setItem('ibconnect_me', user);
}, { token: T2, user: USER2 });
await page.reload();
await page.waitForTimeout(2000);
await page.click('[aria-label="Chats"]');
await page.waitForTimeout(2500);
await page.locator('span:text-is("UI Test User"):visible').first().click();
await page.waitForTimeout(2000);

await page.setInputFiles('input[type="file"]', `${SHOTS}/test-image.png`);
await page.waitForTimeout(3000);

const dialog = page.locator('[role="dialog"][aria-label*="test-image.png"]');
check('no preview box before clicking', await dialog.count() === 0);

const pagesBefore = ctx.pages().length;
await page.locator('button[aria-label="Preview image test-image.png"]:visible').first().click();
await page.waitForTimeout(1200);

check('clicking the image opens a preview box', await dialog.count() === 1);
check('it did NOT open a new tab / redirect', ctx.pages().length === pagesBefore, `tabs ${pagesBefore} -> ${ctx.pages().length}`);
check('still on the chat page (no navigation)', new URL(page.url()).pathname === '/', page.url());

// It's a "small box", not a full-bleed viewer.
const box = await dialog.locator('div').first().boundingBox();
check('preview box is a contained box, not full screen', !!box && box.width <= 700 && box.width < 1400 && box.height < 900,
  box ? `${Math.round(box.width)}x${Math.round(box.height)}` : 'no box');

const previewImg = dialog.locator('img[alt="test-image.png"]');
check('preview box shows the image', await previewImg.count() === 1);
const decoded = await page.evaluate(() => {
  const d = document.querySelector('[role="dialog"]');
  const i = d?.querySelector('img');
  return i ? { w: i.naturalWidth, h: i.naturalHeight, fits: i.getBoundingClientRect().height <= window.innerHeight } : null;
});
check('preview image decoded and fits the viewport', !!decoded && decoded.w > 0 && decoded.fits, JSON.stringify(decoded));

check('preview box has a Download control', await dialog.locator('[aria-label="Download test-image.png"]').count() === 1);
check('preview box has a Share control', await dialog.locator('[aria-label="Share test-image.png"]').count() === 1);
check('preview box has a Close control', await dialog.locator('[aria-label="Close preview"]').count() === 1);
const dl = await dialog.locator('[aria-label="Download test-image.png"]').getAttribute('download');
check('Download control actually downloads (download attr set)', dl === 'test-image.png', String(dl));

await page.screenshot({ path: `${SHOTS}/preview-desktop.png` });

// Share must degrade gracefully rather than throw where the browser can't share files.
await dialog.locator('[aria-label="Share test-image.png"]').click();
await page.waitForTimeout(1500);
const shareText = (await dialog.locator('[aria-label="Share test-image.png"]').textContent())?.trim();
check('Share degrades gracefully (no crash, shows a state)', ['Share', 'Copied', 'Use Download'].includes(shareText || ''), `label "${shareText}"`);
check('preview box still open after Share', await dialog.count() === 1);

// Close paths
await page.keyboard.press('Escape');
await page.waitForTimeout(700);
check('Escape closes the preview', await dialog.count() === 0);

await page.locator('button[aria-label="Preview image test-image.png"]:visible').first().click();
await page.waitForTimeout(900);
await page.mouse.click(20, 20); // backdrop
await page.waitForTimeout(700);
check('clicking the backdrop closes the preview', await dialog.count() === 0);

await page.locator('button[aria-label="Preview image test-image.png"]:visible').first().click();
await page.waitForTimeout(900);
await dialog.locator('[aria-label="Close preview"]').click();
await page.waitForTimeout(700);
check('close button closes the preview', await dialog.count() === 0);

// Mobile
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(1200);
await page.locator('button[aria-label="Preview image test-image.png"]:visible').first().click();
await page.waitForTimeout(1200);
const mBox = await dialog.locator('div').first().boundingBox();
check('mobile: preview box fits inside the viewport', !!mBox && mBox.width <= 390 && mBox.x >= 0, mBox ? `${Math.round(mBox.width)}px @${Math.round(mBox.x)}` : 'no box');
const mNoScroll = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
check('mobile: no page horizontal scroll with preview open', mNoScroll);
await page.screenshot({ path: `${SHOTS}/preview-mobile.png` });

check('no page/console errors', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
const failed = results.filter(r => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
