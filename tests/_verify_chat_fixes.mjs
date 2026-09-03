// Verifies the two reported chat bugs:
//  1. a DM shows the OTHER person's name/avatar, not your own (loadThread in server/main.go
//     served the creator's-eye view to both sides)
//  2. image attachments render as images, not as a downloadable file card
import { chromium } from 'playwright';
import crypto from 'crypto';
import { writeFileSync } from 'fs';

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
// uitest2 is the RECIPIENT of the uitest1-created DM — the side that saw its own name.
const T2 = jwt('user-964ef540619374b1');
const USER2 = JSON.stringify({ id: 'user-964ef540619374b1', username: 'uitest2', displayName: 'Second Tester', email: 'uitest2@example.com' });

// Test files: a real 4x4 PNG, and a text file that must stay a file card.
const PNG = null;
// test-image.png is pre-generated (900x600) by the Pillow snippet in the session log
writeFileSync(`${SHOTS}/test-notes.txt`, 'plain text attachment, must stay a file card\n');

const results = [];
const check = (name, pass, detail = '') => { results.push({ name, pass }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); };

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
await page.screenshot({ path: `${SHOTS}/chat-list.png` });

// ── Bug 1: thread list + header show the other person ───────────────────────
const listNames = await page.evaluate(() =>
  [...document.querySelectorAll('span.font-semibold.text-xs')].map(e => e.textContent.trim()));
check('thread list shows the other person ("UI Test User")', listNames.includes('UI Test User'), listNames.join(' | '));
check('thread list does NOT show my own name as a thread title', !listNames.includes('Second Tester'), listNames.join(' | '));

// ChatsView renders both a lg:hidden mobile branch and a desktop branch — click the visible one.
await page.locator('span:text-is("UI Test User"):visible').first().click();
await page.waitForTimeout(2000);

const headerName = await page.locator('h3.font-bold.text-sm').first().textContent();
check('chat header shows the other person', headerName?.trim() === 'UI Test User', `got "${headerName?.trim()}"`);

// Avatar in the header must be the counterpart's image (uitest1 has a temp red 1x1 PNG).
const headerAvatarSrc = await page.evaluate(() => {
  const h3 = document.querySelector('h3.font-bold.text-sm');
  const bar = h3?.closest('div')?.parentElement;
  const img = bar?.querySelector('img');
  return img ? img.getAttribute('src') : null;
});
check('header renders the counterpart\'s avatar image', !!headerAvatarSrc && headerAvatarSrc.startsWith('data:image/'),
  headerAvatarSrc ? headerAvatarSrc.slice(0, 30) : 'no <img> in header');

await page.screenshot({ path: `${SHOTS}/chat-open.png` });

// ── Bug 2: image attachment renders inline ──────────────────────────────────
const beforeImgs = await page.locator('.overflow-y-auto img[alt="test-image.png"]').count();
await page.setInputFiles('input[type="file"]', `${SHOTS}/test-image.png`);
await page.waitForTimeout(3000);

const inlineImg = page.locator('img[alt="test-image.png"]');
check('image attachment renders as an <img>', await inlineImg.count() > beforeImgs, `count=${await inlineImg.count()}`);
const imgOk = await page.evaluate(() => {
  const i = [...document.querySelectorAll('img')].find(x => x.alt === 'test-image.png');
  return i ? { complete: i.complete, w: i.naturalWidth, h: i.naturalHeight, box: i.getBoundingClientRect().width } : null;
});
check('the image actually decoded (non-zero natural size)', !!imgOk && imgOk.w > 0 && imgOk.h > 0, JSON.stringify(imgOk));
check('image message has a download control', await page.locator('[aria-label="Download test-image.png"]:visible').count() >= 1);
// The file card's filename is a `p.text-xs.font-semibold`; the thread-list preview that also
// contains the name is a `p.text-[10px]`, so scope to the card to avoid a false positive.
const cardName = (n) => page.locator(`p.text-xs.font-semibold:has-text("${n}")`);
check('image message is NOT rendered as a file card', await cardName('test-image.png').count() === 0);

// ── Non-image must still be a file card ─────────────────────────────────────
await page.setInputFiles('input[type="file"]', `${SHOTS}/test-notes.txt`);
await page.waitForTimeout(3000);
check('non-image attachment still renders as a file card', await cardName('test-notes.txt').count() > 0);
check('non-image did NOT become an <img>', await page.locator('img[alt="test-notes.txt"]').count() === 0);

await page.screenshot({ path: `${SHOTS}/chat-attachments.png` });

// ── Mobile ──────────────────────────────────────────────────────────────────
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(1500);
const noHScroll = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
check('mobile: no page horizontal scroll', noHScroll);
const imgFits = await page.evaluate(() => {
  const i = [...document.querySelectorAll('img')].find(x => x.alt === 'test-image.png');
  return i ? i.getBoundingClientRect().right <= window.innerWidth + 1 : null;
});
check('mobile: inline image stays inside the viewport', imgFits === true, String(imgFits));
await page.screenshot({ path: `${SHOTS}/chat-mobile.png` });

check('no page/console errors', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
const failed = results.filter(r => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
