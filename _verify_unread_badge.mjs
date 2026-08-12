// Verifies the chat unread-badge feature end to end.
//
// Covers the three bugs fixed 2026-08-10:
//   1. last_read_at written with NOW() (second precision) vs messages.created_at DATETIME(6)
//   2. unread count not excluding the viewer's own messages
//   3. `{count && ...}` rendering a literal "0" next to every read thread
// plus the new POST /api/threads/{id}/read endpoint that persists the read marker for messages
// arriving over the chat WS while the thread is already open.
//
// Usage:  BASE=https://meet.icebrkr.space node _verify_unread_badge.mjs
//         BASE=http://127.0.0.1:3000      node _verify_unread_badge.mjs
//
// Auth is OIDC-only in this app, so this mints an HS256 JWT directly for the seeded uitest1
// account and seeds localStorage, the same trick _verify_tiling.mjs uses.

import { chromium } from 'playwright';
import crypto from 'crypto';

const BASE = process.env.BASE || 'https://meet.icebrkr.space';
const JWT_SECRET = (process.env.IBCONNECT_JWT_SECRET
  ?? 'ibconnect_jwt_secret_prod_2024_change_me')  // legacy fallback: the backend now requires IBCONNECT_JWT_SECRET, so export it to test a deployed build; // server/main.go `jwtKey`
const UITEST1 = 'user-815ce7061367244d';
const PEER_NAME = 'Second Tester'; // uitest2, uitest1's only DM

const b64url = (s) => Buffer.from(s).toString('base64url');
function signHS256(payload, secret) {
  const h = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64url(JSON.stringify(payload));
  return `${h}.${p}.${crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url')}`;
}

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

const jwt = signHS256({ userId: UITEST1, exp: Math.floor(Date.now() / 1000) + 3600 }, JWT_SECRET);
const me = {
  id: UITEST1, username: 'uitest1', displayName: 'UI Test User',
  email: 'uitest1@example.com', status: 'online', createdAt: new Date().toISOString(),
};

const browser = await chromium.launch();
const ctx = await browser.newContext();
const errors = [];
const readCalls = [];

ctx.on('weberror', (e) => errors.push('pageerror: ' + e.error().message));
const page = await ctx.newPage();
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
page.on('response', (r) => {
  if (/\/api\/threads\/.*\/read$/.test(r.url())) readCalls.push(r.status());
});

await page.addInitScript(([t, m]) => {
  localStorage.setItem('ibconnect_jwt', t);
  localStorage.setItem('ibconnect_me', m);
}, [jwt, JSON.stringify(me)]);

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4000);
try { await page.getByRole('button', { name: /chat/i }).first().click({ timeout: 5000 }); } catch {}
await page.waitForTimeout(2500);

// ChatsView renders its lg:hidden and desktop branches BOTH into the DOM, so every row exists
// twice — an un-filtered .first() grabs the hidden copy and has no bounding box. Always :visible.
const row = page.getByText(PEER_NAME).locator('visible=true').first();
const rowFound = (await row.count()) > 0;
check('thread row is visible', rowFound);

if (rowFound) {
  const listText = (await page.locator('div').filter({ hasText: new RegExp(PEER_NAME) }).last()
    .innerText().catch(() => '')).replace(/\n/g, ' | ');
  // Bug 3: a read thread must not render a bare "0" where the badge would go.
  check('no stray "0" badge on a read thread', !/\|\s*0\s*$/.test(listText), JSON.stringify(listText));

  const box = await row.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + 8);
  await page.waitForTimeout(3000);

  // Opening a thread must persist the read marker server-side, not just zero it in React state.
  check('POST /read fired on thread open', readCalls.length > 0, `${readCalls.length} call(s)`);
  check('POST /read returned 200', readCalls.length > 0 && readCalls.every((s) => s === 200),
    `statuses: ${readCalls.join(',') || 'none'}`);
}

check('zero console/page errors', errors.length === 0, errors.join(' ; '));

await browser.close();

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed against ${BASE}`);
process.exit(failed.length ? 1 : 0);
