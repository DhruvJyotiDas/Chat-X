// Verifies the document preview: clicking a non-image attachment card opens the same
// in-place box, with a real inline body for PDFs and text-ish files, a graceful
// "no preview" body for everything else, and Share/Download on the box.
//
// Fixtures it expects next to itself (see SESSION-NOTES-2026-08-08.md for the generators):
//   test-doc.pdf, test-notes.txt, test-sheet.csv, test-report.docx, test-image.png
// Point FIXTURES at wherever they live.
import { chromium } from 'playwright';
import crypto from 'crypto';

const BASE = process.env.BASE || 'http://127.0.0.1:3100';
const FIXTURES = process.env.FIXTURES || '/tmp/ibconnect-fixtures';
const SHOTS = process.env.SHOTS || FIXTURES;

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

const dialog = page.locator('[role="dialog"]');
const openCard = async (name) => {
  await page.locator(`button[aria-label="Preview file ${name}"]:visible`).last().click();
  await page.waitForTimeout(1800);
};
const close = async () => { await page.keyboard.press('Escape'); await page.waitForTimeout(600); };

// ── PDF ─────────────────────────────────────────────────────────────────────
await page.setInputFiles('input[type="file"]', `${FIXTURES}/test-doc.pdf`);
await page.waitForTimeout(3000);
check('PDF still arrives as a file card (not an image)', await page.locator('p.text-xs.font-semibold:has-text("test-doc.pdf")').count() > 0);

const tabsBefore = ctx.pages().length;
await openCard('test-doc.pdf');
check('clicking a PDF card opens the preview box', await dialog.count() === 1);
check('PDF preview did not open a new tab', ctx.pages().length === tabsBefore, `tabs ${tabsBefore} -> ${ctx.pages().length}`);

// Headless Chromium ships no PDF plugin, so asserting "an iframe exists" would be a
// green check over a blank rectangle. Branch on what this browser can actually do.
const canRenderPdf = await page.evaluate(() => navigator.pdfViewerEnabled === true);
console.log(`      (browser pdfViewerEnabled = ${canRenderPdf})`);
const iframeInfo = await page.evaluate(() => {
  const f = document.querySelector('[role="dialog"] iframe');
  if (!f) return null;
  const r = f.getBoundingClientRect();
  return { src: f.getAttribute('src')?.slice(0, 5), w: Math.round(r.width), h: Math.round(r.height) };
});
if (canRenderPdf) {
  check('PDF renders in an inline viewer frame', !!iframeInfo && iframeInfo.w > 0 && iframeInfo.h > 0, JSON.stringify(iframeInfo));
  check('PDF frame uses a blob: URL (data: is blocked in iframes)', iframeInfo?.src === 'blob:', String(iframeInfo?.src));
} else {
  check('no PDF viewer: shows an explanation, not a blank frame', iframeInfo === null && (await dialog.textContent() || '').includes("can't display PDFs inline"));
  check('no PDF viewer: Download is still offered', await dialog.locator('[aria-label="Download test-doc.pdf"]').count() === 1);
}
check('PDF box has Share + Download', await dialog.locator('[aria-label="Share test-doc.pdf"]').count() === 1 && await dialog.locator('[aria-label="Download test-doc.pdf"]').count() === 1);
await page.screenshot({ path: `${SHOTS}/doc-pdf.png` });
await close();
check('Escape closes the PDF preview', await dialog.count() === 0);

// ── Plain text ──────────────────────────────────────────────────────────────
await page.setInputFiles('input[type="file"]', `${FIXTURES}/test-notes.txt`);
await page.waitForTimeout(3000);
await openCard('test-notes.txt');
const preText = await dialog.locator('pre').first().textContent().catch(() => null);
check('text file renders its contents inline', !!preText && preText.includes('Quarterly notes'), (preText || '').slice(0, 40));
check('long unbroken tokens do not overflow the box', await page.evaluate(() => {
  const p = document.querySelector('[role="dialog"] pre');
  return p ? p.scrollWidth <= p.clientWidth + 1 : false;
}));
await page.screenshot({ path: `${SHOTS}/doc-text.png` });
await close();

// ── CSV ─────────────────────────────────────────────────────────────────────
await page.setInputFiles('input[type="file"]', `${FIXTURES}/test-sheet.csv`);
await page.waitForTimeout(3000);
await openCard('test-sheet.csv');
const csvText = await dialog.locator('pre').first().textContent().catch(() => null);
check('CSV previews as text', !!csvText && csvText.includes('Dhruv,Founder,Zurich'), (csvText || '').slice(0, 40));
await close();

// ── Unsupported type (.docx) ────────────────────────────────────────────────
await page.setInputFiles('input[type="file"]', `${FIXTURES}/test-report.docx`);
await page.waitForTimeout(3000);
await openCard('test-report.docx');
check('unsupported type still opens the box', await dialog.count() === 1);
check('unsupported type shows a "no preview" message', (await dialog.textContent() || '').includes('No inline preview'));
check('unsupported type still offers Share + Download', await dialog.locator('[aria-label="Share test-report.docx"]').count() === 1 && await dialog.locator('[aria-label="Download test-report.docx"]').count() === 1);
check('no empty iframe for an unsupported type', await dialog.locator('iframe').count() === 0);
await page.screenshot({ path: `${SHOTS}/doc-unsupported.png` });
await close();

// ── Card download button must NOT open the preview ──────────────────────────
await page.locator('[aria-label="Download test-report.docx"]:visible').last().click().catch(() => {});
await page.waitForTimeout(800);
check('the card download button does not open the preview', await dialog.count() === 0);

// ── Images still work through the shared modal ──────────────────────────────
await page.setInputFiles('input[type="file"]', `${FIXTURES}/test-image.png`);
await page.waitForTimeout(3000);
await page.locator('button[aria-label="Preview image test-image.png"]:visible').last().click();
await page.waitForTimeout(1200);
check('image preview still works after the refactor', await dialog.locator('img[alt="test-image.png"]').count() === 1);
await close();

// ── Mobile ──────────────────────────────────────────────────────────────────
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(1200);
await openCard('test-doc.pdf');
const mBox = await dialog.locator('div').first().boundingBox();
check('mobile: PDF box fits the viewport', !!mBox && mBox.width <= 390 && mBox.x >= 0, mBox ? `${Math.round(mBox.width)}px @${Math.round(mBox.x)}` : 'none');
check('mobile: no page horizontal scroll', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
await page.screenshot({ path: `${SHOTS}/doc-mobile.png` });

check('no page/console errors', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
const failed = results.filter(r => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
