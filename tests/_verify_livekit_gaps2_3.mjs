/**
 * Real verification of the quality-badge and stall-recovery fixes.
 *
 * Gap #2 (quality badges): confirms RoomEvent.ConnectionQualityChanged
 * genuinely fires with real data during an actual call. Gap #3
 * (stall-recovery): the actual trigger (a genuinely stalled decode for 3+
 * consecutive seconds) is impractical to force here, so this verifies the
 * mechanism the fix depends on instead — that setSubscribed(false) then
 * setSubscribed(true) on a live remote video publication genuinely
 * refreshes the stream (real new frames decoding afterward), against the
 * real LiveKit server, on a real published track.
 *
 * A bare `import('livekit-client')` injected into the real app's page can't
 * resolve (Vite only rewrites bare specifiers inside files it serves and
 * transforms, not scripts Playwright injects) — that's a test-environment
 * module-resolution limit, not an app bug. Worked around with
 * _lk_mechanism_test.html, a real file Vite serves and can therefore
 * resolve normally, run as a genuine THIRD LiveKit participant in the same
 * real room. It needs its own real /ws membership too — the token
 * endpoint's own auth design (approved earlier in this migration) requires
 * it — satisfied here with a raw WebSocket join_room rather than a full
 * second browser UI flow.
 */
import { chromium } from 'playwright';
import crypto from 'crypto';

const BASE = process.env.BASE ?? 'http://127.0.0.1:3011';
const JWT_SECRET = process.env.IBCONNECT_JWT_SECRET;
if (!JWT_SECRET) { console.error('IBCONNECT_JWT_SECRET must be set.'); process.exit(2); }

const exp = Math.floor(Date.now() / 1000) + 3600 * 6;
function b64url(i) { return Buffer.from(i).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_'); }
function signHS256(payload, secret) {
  const h = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64url(JSON.stringify(payload));
  const s = crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${h}.${p}.${s}`;
}

const results = [];
const check = (name, pass, detail = '') => { results.push({ name, pass }); console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); };

function fakeMediaFn(color) {
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 240;
    const ctx = canvas.getContext('2d'); let t = 0;
    (function draw() { t += 1; ctx.fillStyle = color; ctx.fillRect(0, 0, 320, 240); ctx.fillStyle = '#fff'; ctx.fillRect(t % 280, 0, 20, 20); requestAnimationFrame(draw); })();
    const videoStream = canvas.captureStream(15);
    const audioCtx = new AudioContext(); const dest = audioCtx.createMediaStreamDestination();
    const osc = audioCtx.createOscillator(); const g = audioCtx.createGain(); g.gain.value = 0.02;
    osc.connect(g).connect(dest); osc.start();
    const tracks = [];
    if (!constraints || constraints.video !== false) tracks.push(videoStream.getVideoTracks()[0]);
    if (!constraints || constraints.audio !== false) tracks.push(dest.stream.getAudioTracks()[0]);
    return new MediaStream(tracks);
  };
}

const errors = [];
const browser = await chromium.launch({ args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });

async function makePeer(user, color) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, permissions: ['camera', 'microphone'] });
  await ctx.addInitScript(fakeMediaFn, color);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${user.username}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`${user.username}: ${m.text()}`); });
  await page.goto(`${BASE}/`);
  await page.evaluate(({ token, u }) => {
    localStorage.setItem('ibconnect_jwt', token);
    localStorage.setItem('ibconnect_me', JSON.stringify(u));
  }, { token: signHS256({ userId: user.id, exp }, JWT_SECRET), u: user });
  await page.reload();
  await page.waitForTimeout(1200);
  return page;
}

console.log('── Host creates a meeting, guest joins ──');
const host = await makePeer({ id: 'user-g23-host', username: 'g23host', displayName: 'G23 Host', email: 'a@a.com' }, '#8b0000');
await host.click('[aria-label="Meetings"]');
await host.waitForSelector('text=Start New Meeting', { timeout: 15000 });
await host.click('text=Start New Meeting');
await host.waitForTimeout(4000);
const code = await host.evaluate(() => window.location.pathname.replace('/', '') || null);
check('host created a meeting', !!code, code ?? 'no code');
await host.keyboard.press('Escape').catch(() => {});
await host.waitForTimeout(300);

const guest = await makePeer({ id: 'user-g23-guest', username: 'g23guest', displayName: 'G23 Guest', email: 'b@b.com' }, '#1a5d1a');
await guest.click('[aria-label="Meetings"]');
await guest.waitForTimeout(800);
await guest.fill('input[placeholder="ENTER ROOM CODE…"]', code);
await guest.click('button:has-text("Join")');
await guest.waitForTimeout(5000);

console.log('\n── Gap #2: People panel renders cleanly with the new (LiveKit-pushed) quality source ──');
await host.click('[aria-label="People"]');
await host.waitForTimeout(1000);
check('People panel shows the guest as Connected, no crash', (await host.locator('text=Connected').count()) > 0);

console.log('\n── Giving the 3rd (mechanism-test) client real /ws membership via a raw WS join ──');
const meshWsUrl = BASE.replace('http', 'ws') + '/ws';
const thirdIdentity = 'user-g23-mechtest';
const roomCode = await new Promise((resolve, reject) => {
  const ws = new WebSocket(meshWsUrl);
  const timer = setTimeout(() => reject(new Error('timeout joining /ws')), 8000);
  ws.onopen = () => ws.send(JSON.stringify({ type: 'join_room', payload: { room_id: code, user_id: thirdIdentity, user_name: 'Mech Test' } }));
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'room_joined') { clearTimeout(timer); resolve(msg.payload.room_id); }
    if (msg.type === 'error') { clearTimeout(timer); reject(new Error(msg.payload.message)); }
  };
  ws.onerror = () => { clearTimeout(timer); reject(new Error('/ws error')); };
  // Deliberately kept open for the LiveKit connect below — closing it would
  // remove this identity from room.clients and the LiveKit token's
  // authorization (already-approved design) would then find nothing to
  // authorize a RECONNECT against, though the already-issued token itself
  // stays valid for its own TTL regardless.
});
check('3rd identity has real /ws room membership', !!roomCode, roomCode);

const tokenResp = await fetch(`${BASE}/api/livekit/token`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ room_id: code, user_id: thirdIdentity, user_name: 'Mech Test' }),
}).then((r) => r.json());
check('got a real LiveKit token for the 3rd identity (membership check passed)', !!tokenResp.token, JSON.stringify(tokenResp).slice(0, 100));

console.log('\n── Connecting the 3rd participant via a real page (resolves the real livekit-client module) ──');
const mechPage = await (await browser.newContext()).newPage();
mechPage.on('pageerror', (e) => errors.push(`mechtest: ${e.message}`));
await mechPage.goto(`${BASE}/tests/_lk_mechanism_test.html`);
await mechPage.waitForFunction(() => window.__mechTestReady === true, { timeout: 10000 });

const result = await mechPage.evaluate(
  ({ url, token, hostIdentity }) => window.__testQualityAndResubscribe(url, token, hostIdentity),
  { url: tokenResp.url, token: tokenResp.token, hostIdentity: 'user-g23-host' },
);
console.log('  mechanism-test result:', JSON.stringify(result, null, 2));

check('RoomEvent.ConnectionQualityChanged fired at least once with real data', (result.qualityEventCount ?? 0) > 0, JSON.stringify(result.sampleQualityEvents));
check('publication was subscribed before the cycle', result.wasSubscribed === true && result.hadTrackBefore === true);
check('unsubscribe actually took effect (isSubscribed briefly false)', result.subscribedFalseObserved === true);
check('resubscribe brought the track back (isSubscribed true, track present again)', result.isSubscribedAfter === true && result.hasTrackAfter === true);
check('the pipeline is genuinely decoding NEW frames after the cycle, not stuck', result.decodesAfter === true);

check('no console or page errors across any participant', errors.length === 0, errors.slice(0, 6).join(' | '));

await browser.close();
const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} checks passed`);
if (passed !== results.length) {
  console.log('Failed:');
  results.filter((r) => !r.pass).forEach((r) => console.log(`  - ${r.name}`));
}
