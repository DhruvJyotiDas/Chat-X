// Verifies the real reported bug: clicking "Translate" on the OTHER
// person's message did nothing visible when that message sits near the
// bottom edge of the scrollable message list — the dropdown opened
// downward (top-full) and rendered clipped outside the scroll container.
// Fixed by opening upward (bottom-full), matching EmojiPicker/RewriteMenu's
// existing convention. Reproduced here with a short viewport height so even
// this thread's few messages fill it and the last message sits at the
// bottom edge, same as a real, longer conversation would.
import { chromium } from 'playwright';
import crypto from 'crypto';

const BASE = process.env.BASE || 'http://127.0.0.1:3103';
function b64url(i) { return Buffer.from(i).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_'); }
function jwt(uid) {
  const S = process.env.IBCONNECT_JWT_SECRET;
  const h = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64url(JSON.stringify({ userId: uid, exp: Math.floor(Date.now() / 1000) + 3600 }));
  const sig = crypto.createHmac('sha256', S).update(`${h}.${p}`).digest('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${h}.${p}.${sig}`;
}
const T1 = jwt('user-815ce7061367244d');
const U1 = JSON.stringify({ id: 'user-815ce7061367244d', username: 'uitest1', displayName: 'UI Test User', email: 'uitest1@example.com' });

const results = [];
const check = (n, pass, detail = '') => { results.push({ n, pass }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${n}${detail ? ' — ' + detail : ''}`); };

const browser = await chromium.launch({ args: ['--no-sandbox'] });
// Short viewport, same idea as testing at 390px width elsewhere in this repo
// for mobile — here it's the HEIGHT that matters, to force the last message
// right up against the bottom of the scroll area.
const ctx = await browser.newContext({ viewport: { width: 900, height: 480 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });

await page.goto(BASE + '/');
await page.evaluate(({ token, user }) => {
  localStorage.setItem('ibconnect_jwt', token);
  localStorage.setItem('ibconnect_me', user);
}, { token: T1, user: U1 });
await page.reload();
await page.waitForTimeout(2000);
await page.click('[aria-label="Chats"]');
await page.waitForTimeout(2000);
for (const name of ['Dhruv Jyoti Das']) {
  const el = page.locator(`span:text-is("${name}"):visible`).first();
  if (await el.count() > 0) { await el.click(); break; }
}
await page.waitForTimeout(1500);

// The LAST message in the thread — confirmed to be from the other person —
// is exactly the one sitting at the bottom edge of the scrolled view.
const lastTranslateBtn = page.locator('button:has-text("Translate"):visible').last();
check('a Translate button is present near the bottom of the scroll area', await lastTranslateBtn.count() > 0);

const buttonBox = await lastTranslateBtn.boundingBox();
await lastTranslateBtn.click();
await page.waitForTimeout(400);

// The dropdown must be GENUINELY visible on screen (not merely present in
// the DOM) — check its bounding box is within the viewport, not clipped
// above/below it, and that Playwright itself considers it visible.
const dropdown = page.locator('button:has-text("Spanish"):visible').first();
const dropdownVisible = await dropdown.isVisible().catch(() => false);
check('the language dropdown is actually visible after clicking Translate', dropdownVisible);

if (dropdownVisible) {
  const dropdownBox = await dropdown.boundingBox();
  const viewport = page.viewportSize();
  const withinViewport = dropdownBox && dropdownBox.y >= 0 && (dropdownBox.y + dropdownBox.height) <= viewport.height;
  check('the dropdown renders fully within the viewport (not clipped by the scroll container)', withinViewport,
    JSON.stringify({ dropdownBox, buttonBox, viewportHeight: viewport.height }));

  await dropdown.click();
  await page.waitForTimeout(15000);
  const errText = await page.locator('text=Translation failed').count();
  const resultCount = await page.locator('p.italic:visible').count();
  check('picking a language produces a real translated result, no error', resultCount > 0 && errText === 0, `resultCount=${resultCount} errorShown=${errText > 0}`);
}

check('zero console/page errors', errors.length === 0, errors.slice(0, 5).join(' | '));

console.log(`\n${results.filter(r => r.pass).length}/${results.length} passed`);
await browser.close();
process.exit(results.every(r => r.pass) ? 0 : 1);
