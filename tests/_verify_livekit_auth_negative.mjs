/**
 * Stage 4 addendum #2 — negative-path auth. Confirms LiveKit actually
 * rejects a bad token (not just that a good one connects), and confirms the
 * token endpoint's membership check actually refuses an identity that was
 * never admitted to the room, rather than trusting a client-supplied user_id.
 *
 * livekit-client needs real WebRTC/DOM APIs, so the connect attempts run
 * inside a real browser page (_lk_negtest.html, served by the same Vite dev
 * server) rather than in plain Node.
 */
import { chromium } from 'playwright';
import crypto from 'crypto';

const BASE = process.env.BASE ?? 'http://127.0.0.1:3006';
const LIVEKIT_URL = 'ws://127.0.0.1:7880';
const LIVEKIT_SECRET = 'secret'; // the known --dev placeholder, same as the backend's LIVEKIT_API_SECRET for this run
const JWT_SECRET = process.env.IBCONNECT_JWT_SECRET;
if (!JWT_SECRET) { console.error('IBCONNECT_JWT_SECRET must be set.'); process.exit(2); }

const results = [];
const check = (name, pass, detail = '') => { results.push({ name, pass }); console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); };

function b64url(input) {
  return Buffer.from(input).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function signHS256(header, payload, secret) {
  const h = b64url(JSON.stringify(header));
  const p = b64url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${h}.${p}.${sig}`;
}
// Mirrors server/livekit.go's exact claims shape.
function forgeLiveKitToken({ identity, room, secret = LIVEKIT_SECRET, expiresInSec = 600 }) {
  const now = Math.floor(Date.now() / 1000);
  return signHS256(
    { alg: 'HS256', typ: 'JWT' },
    {
      identity, name: identity,
      video: { roomJoin: true, room, canPublish: true, canSubscribe: true },
      iss: 'devkey', sub: identity,
      iat: now, nbf: now, exp: now + expiresInSec,
    },
    secret,
  );
}

const browser = await chromium.launch({ args: ['--no-sandbox', '--use-fake-ui-for-media-stream'] });

// ── Part 1: does LiveKit itself actually reject bad tokens? ────────────────
const lkPage = await (await browser.newContext()).newPage();
await lkPage.goto(`${BASE}/tests/_lk_negtest.html`);
await lkPage.waitForFunction(() => window.__lkReady === true, { timeout: 10000 });

async function tryConnect(token) {
  return lkPage.evaluate(({ url, token }) => window.__tryConnect(url, token), { url: LIVEKIT_URL, token });
}

console.log('── Baseline: a genuinely valid token DOES connect (sanity check the harness itself) ──');
const validToken = forgeLiveKitToken({ identity: 'user-negtest-valid', room: 'NEG-TEST-ROOM' });
const validResult = await tryConnect(validToken);
check('a correctly-signed, unexpired token connects', validResult.connected === true, JSON.stringify(validResult));

console.log('\n── Tampered token (flipped signature) is rejected ──');
const tampered = validToken.slice(0, -4) + (validToken.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA');
const tamperedResult = await tryConnect(tampered);
check('a tampered token is REJECTED by LiveKit', tamperedResult.connected === false, JSON.stringify(tamperedResult));

console.log('\n── Wrong-secret token (signed with a different key) is rejected ──');
const wrongSecretToken = forgeLiveKitToken({ identity: 'user-negtest-wrongsecret', room: 'NEG-TEST-ROOM', secret: 'not-the-real-secret' });
const wrongSecretResult = await tryConnect(wrongSecretToken);
check('a token signed with the wrong secret is REJECTED by LiveKit', wrongSecretResult.connected === false, JSON.stringify(wrongSecretResult));

console.log('\n── Expired token (exp already in the past) is rejected ──');
const expiredToken = forgeLiveKitToken({ identity: 'user-negtest-expired', room: 'NEG-TEST-ROOM', expiresInSec: -600 });
const expiredResult = await tryConnect(expiredToken);
check('an expired token is REJECTED by LiveKit', expiredResult.connected === false, JSON.stringify(expiredResult));

console.log('\n── Empty token is rejected ──');
const emptyResult = await tryConnect('');
check('an empty token is REJECTED by LiveKit', emptyResult.connected === false, JSON.stringify(emptyResult));

// ── Part 2: does OUR endpoint's membership check actually refuse? ──────────
console.log('\n── Guest user_id never admitted to the room gets 403, not a token ──');
const exp = Math.floor(Date.now() / 1000) + 3600 * 6;
function ibSignHS256(payload, secret) { return signHS256({ alg: 'HS256', typ: 'JWT' }, payload, secret); }
function fakeMediaFn() {
  navigator.mediaDevices.getUserMedia = async () => {
    const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 240;
    const stream = canvas.captureStream(5);
    const audioCtx = new AudioContext(); const dest = audioCtx.createMediaStreamDestination();
    const osc = audioCtx.createOscillator(); osc.connect(dest); osc.start();
    return new MediaStream([...stream.getVideoTracks(), ...dest.stream.getAudioTracks()]);
  };
}
const ctx = await browser.newContext({ viewport: { width: 1024, height: 768 }, permissions: ['camera', 'microphone'] });
await ctx.addInitScript(fakeMediaFn);
const page = await ctx.newPage();
await page.goto(`${BASE}/`);
await page.evaluate(({ token, u }) => {
  localStorage.setItem('ibconnect_jwt', token);
  localStorage.setItem('ibconnect_me', JSON.stringify(u));
}, { token: ibSignHS256({ userId: 'user-negtest-realmember', exp }, JWT_SECRET), u: { id: 'user-negtest-realmember', username: 'realmember', displayName: 'Real Member', email: 'real@example.com' } });
await page.reload();
await page.waitForTimeout(1200);
await page.click('[aria-label="Meetings"]');
await page.waitForSelector('text=Start New Meeting', { timeout: 15000 });
await page.click('text=Start New Meeting');
await page.waitForTimeout(3500);
const realRoomCode = await page.evaluate(() => window.location.pathname.replace('/', '') || null);
check('a real room exists for the impersonation test', !!realRoomCode, realRoomCode ?? 'none');

const impersonationAttempt = await fetch(`${BASE}/api/livekit/token`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ room_id: realRoomCode, user_id: 'user-never-joined-this-room', user_name: 'Ghost' }),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
check('a user_id that never joined that room via /ws gets 403, not a token',
  impersonationAttempt.status === 403 && !impersonationAttempt.body?.token,
  `status=${impersonationAttempt.status} body=${JSON.stringify(impersonationAttempt.body)}`);

const noRoomAttempt = await fetch(`${BASE}/api/livekit/token`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ room_id: 'ZZZZ-NOPE', user_id: 'user-negtest-realmember', user_name: 'Real Member' }),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
check('a room_id that does not exist at all gets 403, not a token',
  noRoomAttempt.status === 403 && !noRoomAttempt.body?.token,
  `status=${noRoomAttempt.status} body=${JSON.stringify(noRoomAttempt.body)}`);

console.log('\n── Signed-in caller cannot impersonate another identity via the request body ──');
// user-negtest-realmember IS a real member of realRoomCode (via session JWT),
// but supplies a DIFFERENT user_id in the body — server/livekit.go must use
// the session's identity, not the body's, for a signed-in caller.
const impersonateOwnSession = await page.evaluate(async ({ roomId }) => {
  const res = await fetch('/api/livekit/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('ibconnect_jwt')}` },
    body: JSON.stringify({ room_id: roomId, user_id: 'user-someone-else-entirely', user_name: 'Not Me' }),
  });
  const body = await res.json().catch(() => null);
  // Decode the JWT payload (no verification needed client-side, just reading
  // what identity actually got embedded) to check whose identity it granted.
  let identity = null;
  if (body?.token) {
    const payload = JSON.parse(atob(body.token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    identity = payload.identity;
  }
  return { status: res.status, identity };
}, { roomId: realRoomCode });
check('a signed-in caller\'s token carries THEIR OWN session identity, not the body\'s user_id',
  impersonateOwnSession.identity === 'user-negtest-realmember',
  JSON.stringify(impersonateOwnSession));

await browser.close();

const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} checks passed`);
if (passed !== results.length) {
  console.log('Failed:');
  results.filter((r) => !r.pass).forEach((r) => console.log(`  - ${r.name}`));
}
