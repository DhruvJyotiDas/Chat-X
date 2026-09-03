/**
 * Regression suite for two bugs reported after the 2026-08-17 deploy:
 *
 *  1. Joiners saw the host as "Guest" instead of their account name. MeetingProvider read
 *     `ibconnect_me` once in a `useState` initialiser; AuthContext writes that key AFTER
 *     it resolves, so on a fresh sign-in the initialiser found nothing and fell through to
 *     `{ id: getOrCreateUserId(), name: 'Guest' }` forever. It also sent a throwaway
 *     user_id, and `raisedHands` was keyed by that same throwaway id while tiles are keyed
 *     by `user.id` — so your own raised hand never showed on your own tile.
 *
 *  2. Turning your camera off left others looking at a frozen frame. The sending side is
 *     correct (removeTrack + stop + renegotiate) and the receiver's stream really does drop
 *     to 0 video tracks — but a <video> keeps the last decoded frame painted, and RemoteTile
 *     only fell back to an avatar when there was no stream at all.
 *
 * The identity test deliberately starts with the JWT present and `ibconnect_me` ABSENT,
 * which is the state a fresh OIDC landing is actually in. Seeding both (as the other
 * suites do) hides the bug completely.
 *
 * BASE selects the target.
 */
import { chromium } from 'playwright';
import crypto from 'crypto';

const BASE = process.env.BASE ?? 'http://127.0.0.1:3101';
const SECRET = process.env.IBCONNECT_JWT_SECRET;
if (!SECRET) { console.error('IBCONNECT_JWT_SECRET must be set.'); process.exit(2); }

const exp = Math.floor(Date.now() / 1000) + 3600 * 6;
const b64 = (i) => Buffer.from(i).toString('base64').replace(/=+$/,'').replace(/\+/g,'-').replace(/\//g,'_');
const sign = (p) => { const h=b64(JSON.stringify({alg:'HS256',typ:'JWT'})),y=b64(JSON.stringify(p));
  return `${h}.${y}.`+crypto.createHmac('sha256',SECRET).update(`${h}.${y}`).digest('base64').replace(/=+$/,'').replace(/\+/g,'-').replace(/\//g,'_'); };

const HOST = { id: 'user-815ce7061367244d', displayName: 'UI Test User' };

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const stub = () => {
  navigator.mediaDevices.getUserMedia = async (c = {}) => {
    const t = [];
    if (c.video) {
      const cv = document.createElement('canvas'); cv.width = 320; cv.height = 240;
      const g = cv.getContext('2d');
      (function d(){ g.fillStyle='#c0392b'; g.fillRect(0,0,320,240); requestAnimationFrame(d); })();
      t.push(cv.captureStream(15).getVideoTracks()[0]);
    }
    if (c.audio) {
      const a = new AudioContext(), dst = a.createMediaStreamDestination(), o = a.createOscillator();
      o.connect(dst); o.start(); t.push(dst.stream.getAudioTracks()[0]);
    }
    return new MediaStream(t);
  };
};

const browser = await chromium.launch({
  args: ['--no-sandbox','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream','--autoplay-policy=no-user-gesture-required'],
});
const errors = [];
const mk = async (label) => {
  const ctx = await browser.newContext({ viewport:{width:1280,height:900}, permissions:['camera','microphone'] });
  await ctx.addInitScript(stub);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${label}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (/Failed to load resource|favicon|ERR_ABORTED/.test(t)) return;
    errors.push(`${label}: ${t}`);
  });
  return { ctx, page };
};

// ── 1. Identity on a fresh sign-in ───────────────────────────────────────────
console.log('\n── Host identity as joiners see it ──');
const host = await mk('host');
await host.page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
await host.page.evaluate(({ t }) => {
  localStorage.clear();
  // Token only. This is what a fresh OIDC landing looks like before AuthContext resolves.
  localStorage.setItem('ibconnect_jwt', t);
}, { t: sign({ userId: HOST.id, exp }) });
await host.page.reload({ waitUntil: 'domcontentloaded' });
await host.page.waitForTimeout(3500);

await host.page.evaluate(() => {
  window.__sent = [];
  const orig = WebSocket.prototype.send;
  WebSocket.prototype.send = function (d) { try { window.__sent.push(JSON.parse(d)); } catch {} return orig.call(this, d); };
});

await host.page.click('[aria-label="Meetings"]');
await host.page.waitForTimeout(1200);
await host.page.click('text=/Instant start/i');
await host.page.waitForTimeout(5500);
await host.page.keyboard.press('Escape');
await host.page.waitForTimeout(700);
const room = await host.page.evaluate(() => location.pathname.replace('/', ''));
check('room created', !!room, room);

const payload = await host.page.evaluate(() => window.__sent.find((m) => m.type === 'create_room')?.payload);
check('create_room sends the account display name, not "Guest"',
  payload?.user_name === HOST.displayName, JSON.stringify(payload?.user_name));
check('create_room sends the real account id, not a throwaway',
  payload?.user_id === HOST.id, String(payload?.user_id));

const guest = await mk('guest');
await guest.page.goto(`${BASE}/${room}`, { waitUntil: 'domcontentloaded' });
await guest.page.waitForTimeout(2500);
const nameField = guest.page.locator('input[aria-label="Your name"]');
check('an unauthenticated link visitor gets the lobby', await nameField.isVisible().catch(() => false));
if (await nameField.isVisible().catch(() => false)) {
  await nameField.fill('Link Guest');
  await guest.page.click('button:has-text("Join now")');
}
await guest.page.waitForTimeout(6500);

const tileNames = () => guest.page.evaluate(() => {
  const grid = document.querySelector('.flex-wrap.items-center.justify-center.content-center');
  return grid ? [...grid.querySelectorAll('.absolute.bg-\\[\\#111\\]\\/70')].map((e) => e.textContent.trim()) : [];
});
const seen = await tileNames();
check('the joiner sees the host by their real name', seen.some((n) => n.includes(HOST.displayName)), seen.join(' | '));
check('the joiner does NOT see the host as a Guest placeholder',
  !seen.some((n) => /^Guest/i.test(n)), seen.join(' | '));
check("the guest's own typed name is used", seen.some((n) => n.includes('Link Guest')), seen.join(' | '));

// Own raised hand must land on your own tile — it was keyed by the throwaway id.
await host.page.click('[title="Raise hand"]');
await host.page.waitForTimeout(1200);
check('your own raised hand appears on your own tile',
  await host.page.locator(`[aria-label="${HOST.displayName} has their hand raised"]`).first().isVisible().catch(() => false));
await host.page.click('[title="Lower hand"]');
await host.page.waitForTimeout(800);

// ── 2. Camera off, as the other side sees it ─────────────────────────────────
console.log('\n── Camera off is shown as off, not frozen ──');
const remoteView = () => guest.page.evaluate(() => {
  const vids = [...document.querySelectorAll('video')].filter((v) => v.srcObject && v.srcObject.getAudioTracks().length > 0);
  return {
    videoTracks: vids.map((v) => v.srcObject.getVideoTracks().length),
    hiddenVideos: vids.filter((v) => v.classList.contains('invisible')).length,
    cameraOffLabel: /Camera off/i.test(document.body.innerText),
    connecting: /Connecting/i.test(document.body.innerText),
  };
});

const before = await remoteView();
check('while the camera is on, no "Camera off" placeholder is shown',
  !before.cameraOffLabel && before.hiddenVideos === 0, JSON.stringify(before));

await host.page.click('[title="Turn camera off"]');
await guest.page.waitForTimeout(4000);
const off = await remoteView();
check('the track really is removed from the receiver (sender side is correct)',
  off.videoTracks.includes(0), JSON.stringify(off.videoTracks));
check('the frozen frame is hidden', off.hiddenVideos > 0, `${off.hiddenVideos} hidden`);
check('an avatar with "Camera off" is shown instead', off.cameraOffLabel, JSON.stringify(off));
check('it is NOT reported as "Connecting…" — off is a choice, not a fault',
  !off.connecting, JSON.stringify(off));

await host.page.click('[title="Turn camera on"]');
await guest.page.waitForTimeout(5000);
const back = await remoteView();
check('turning the camera back on restores the picture',
  back.videoTracks.every((n) => n > 0) && back.hiddenVideos === 0 && !back.cameraOffLabel,
  JSON.stringify(back));

// Someone who joins with the camera already off has no track to announce at all —
// this is why detection watches the stream rather than trusting a signalling message.
console.log('\n── Joining with the camera already off ──');
const shy = await mk('shy');
await shy.page.goto(`${BASE}/${room}`, { waitUntil: 'domcontentloaded' });
await shy.page.waitForTimeout(2500);
const shyName = shy.page.locator('input[aria-label="Your name"]');
if (await shyName.isVisible().catch(() => false)) {
  await shyName.fill('Camera Shy');
  await shy.page.click('[aria-label="Turn camera off"]').catch(() => {});
  await shy.page.waitForTimeout(500);
  await shy.page.click('button:has-text("Join now")');
}
await shy.page.waitForTimeout(7000);
const hostSees = await host.page.evaluate(() => ({
  cameraOff: (document.body.innerText.match(/Camera off/gi) || []).length,
  names: (() => {
    const g = document.querySelector('.flex-wrap.items-center.justify-center.content-center');
    return g ? [...g.querySelectorAll('.absolute.bg-\\[\\#111\\]\\/70')].map((e) => e.textContent.trim()) : [];
  })(),
}));
check('a peer who joined with the camera off is shown as off, not connecting',
  hostSees.names.some((n) => n.includes('Camera Shy')) && hostSees.cameraOff >= 1,
  JSON.stringify(hostSees));

check('no console or page errors', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) console.log('Failed:\n' + failed.map((f) => `  - ${f.name}`).join('\n'));
process.exit(failed.length ? 1 : 0);
