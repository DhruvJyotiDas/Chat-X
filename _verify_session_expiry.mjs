/**
 * Reproduces the 2026-08-12 incident and proves it is fixed.
 *
 * Then: a token signed with a rotated/old key made /chat-ws answer 401. The
 * WebSocket API hides handshake status from JS, so the browser could only say
 * "can't establish a connection", and both sockets retried every 3s forever —
 * an endless `reconnecting…` loop with no way to learn the session was simply
 * dead.
 *
 * Now: the sockets probe /api/auth/me (where the status IS readable), classify
 * the disconnect, and a dead session signs the user out instead of looping.
 *
 * BASE selects the target.
 */
import { chromium } from 'playwright';
import crypto from 'crypto';

const BASE = process.env.BASE ?? 'http://127.0.0.1:3100';
const GOOD = process.env.IBCONNECT_JWT_SECRET ?? 'ibconnect_jwt_secret_prod_2024_change_me';
const STALE = 'ibconnect_jwt_secret_prod_2024_change_me__rotated_away';
const exp = Math.floor(Date.now() / 1000) + 3600 * 6;

const b64 = (i) => Buffer.from(i).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
function sign(payload, secret) {
  const h = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64(JSON.stringify(payload));
  const s = crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest('base64')
    .replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${h}.${p}.${s}`;
}
const user = { id: 'user-815ce7061367244d', username: 'uitest1', displayName: 'UI Test User', email: 'uitest1@example.com' };

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const browser = await chromium.launch({ args: ['--no-sandbox'] });

async function run(label, secret) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await ctx.newPage();
  const logs = [];
  page.on('console', (m) => logs.push(m.text()));
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(({ t, u }) => {
    localStorage.setItem('ibconnect_jwt', t);
    localStorage.setItem('ibconnect_me', JSON.stringify(u));
  }, { t: sign({ userId: user.id, exp }, secret), u: user });
  await page.reload({ waitUntil: 'domcontentloaded' });
  // Long enough that the OLD code would have logged several 3s reconnects.
  await page.waitForTimeout(16000);
  const diagEvents = await page.evaluate(() => (window.__ibDiag ? window.__ibDiag() : []));
  const stillHasSession = await page.evaluate(() => !!localStorage.getItem('ibconnect_jwt'));
  await ctx.close();
  return { label, logs, diagEvents, stillHasSession };
}

// ── 1. THE ACTUAL INCIDENT: a live session whose key is rotated mid-use ──────
//
// The page is already open and authenticated. No reload happens, so
// AuthContext's mount-time /api/auth/me check never re-runs — the ONLY thing
// that notices is the socket, when it reconnects with a token the server no
// longer accepts. That is precisely the 2026-08-12 report: an endless
// `reconnecting…` loop with no prompt to sign in.
console.log('\n── Live session, key rotated underneath it (the real incident) ──');
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  // Capture every WebSocket so we can sever one on demand.
  await ctx.addInitScript(() => {
    window.__sockets = [];
    const Native = window.WebSocket;
    window.WebSocket = function (...args) {
      const ws = new Native(...args);
      window.__sockets.push(ws);
      return ws;
    };
    window.WebSocket.prototype = Native.prototype;
    Object.assign(window.WebSocket, Native);
  });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });

  // Sign in with a GOOD token so the app fully authenticates and connects.
  await page.evaluate(({ t, u }) => {
    localStorage.setItem('ibconnect_jwt', t);
    localStorage.setItem('ibconnect_me', JSON.stringify(u));
  }, { t: sign({ userId: user.id, exp }, GOOD), u: user });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);

  const connectedFirst = await page.evaluate(
    () => (window.__ibDiag ? window.__ibDiag() : []).some((e) => e.event === 'connected'));
  check('session starts healthy and the socket connects', connectedFirst);

  // Now rotate the key out from under the live page, exactly as a deploy does.
  await page.evaluate((stale) => localStorage.setItem('ibconnect_jwt', stale),
    sign({ userId: user.id, exp }, STALE));
  // Sever the live socket so it reconnects — with the now-dead token.
  await page.evaluate(() => {
    (window.__sockets || []).filter((w) => w.readyState === 1).forEach((w) => w.close());
  });
  await page.waitForTimeout(14000);

  const ev = await page.evaluate(() => (window.__ibDiag ? window.__ibDiag() : []));
  const classified = ev.filter((e) => e.event === 'disconnect classified');
  const expired = ev.filter((e) => e.cat === 'session' && /expired/i.test(e.event));
  const scheduled = ev.filter((e) => e.event === 'reconnect scheduled');
  const stillHasSession = await page.evaluate(() => !!localStorage.getItem('ibconnect_jwt'));

  check('the reconnect is classified rather than blindly retried',
    classified.length > 0, `${classified.length} classification event(s)`);
  check('classified specifically as session-expired',
    classified.some((e) => e.detail?.cause === 'session-expired'),
    JSON.stringify([...new Set(classified.map((e) => e.detail?.cause))]));
  check('session expiry is reported and the user is signed out',
    expired.length > 0, expired.map((e) => e.event).join(' | ') || 'none');
  check('local session is cleared (returns to sign-in)',
    !stillHasSession, stillHasSession ? 'jwt STILL present' : 'jwt removed');
  check('does NOT enter an endless reconnect loop',
    scheduled.length === 0, `${scheduled.length} reconnect(s) scheduled — expected 0`);
  check('diagnostics captured the whole chain',
    ev.length >= 4, `${ev.length} events via window.__ibDiag()`);
  await ctx.close();
}

// ── 2. Valid token: must be unaffected ───────────────────────────────────────
console.log('\n── Valid token (regression guard) ──');
{
  const r = await run('valid', GOOD);
  const expired = r.diagEvents.filter((e) => e.cat === 'session' && /expired/i.test(e.event));
  const connected = r.diagEvents.filter((e) => e.event === 'connected');
  check('a healthy session is NOT signed out', r.stillHasSession);
  check('no false session-expired', expired.length === 0, `${expired.length} event(s)`);
  check('sockets connect normally', connected.length > 0, `${connected.length} connect event(s)`);
}

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
