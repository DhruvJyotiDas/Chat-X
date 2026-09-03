/**
 * Regression suite for: "when someone joins my room I cannot see their camera feed,
 * it's always black or shows camera off." Root cause: `classifyDisconnect()`
 * (src/lib/diagnostics.ts) probed `/api/auth/me` on every signalling disconnect and
 * treated ANY 401/403 as `session-expired` — which stops reconnection permanently and
 * signs the user out. A guest joining by link never has `ibconnect_jwt` at all (`/ws`
 * doesn't require auth), so `/api/auth/me` returning 401 for them is not a dead
 * session, it's the only answer it could ever give. Every guest whose signalling
 * socket dropped even once — a phone hopping wifi/cellular, a brief blip, both routine
 * on a real network — got permanently kicked out of reconnecting, with no recovery.
 * From the host's side this looked exactly like the reported symptom: the guest's tile
 * either goes black/frozen or shows "Camera off" and never comes back, because the
 * server broadcasts `peer_left` for the dead connection and no `peer_joined` ever
 * follows it (the guest gave up reconnecting).
 *
 * Fix: `classifyDisconnect()` now short-circuits to `'network'` (normal reconnection)
 * when there's no token in `localStorage` at all — a guest's 401 is not evidence of
 * anything. A signed-in user's 401 still correctly means `'session-expired'`
 * (`_verify_session_expiry.mjs` guards that).
 *
 * This suite reproduces the exact chain: host creates a room, a guest joins with
 * camera on, then the guest's SIGNALLING SOCKET is killed (not a page reload — matches
 * a phone locking its screen or a network handoff) and asserts the host recovers the
 * guest's live video, not a stuck "Camera off"/gone-forever tile.
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

const HOST = { id: 'user-815ce7061367244d' };

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

function stub() {
  navigator.mediaDevices.getUserMedia = async (constraints = {}) => {
    const t = [];
    if (constraints.video) {
      const cv = document.createElement('canvas'); cv.width = 320; cv.height = 240;
      const g = cv.getContext('2d');
      (function d(){ g.fillStyle = '#27ae60'; g.fillRect(0, 0, 320, 240); requestAnimationFrame(d); })();
      t.push(cv.captureStream(15).getVideoTracks()[0]);
    }
    if (constraints.audio) {
      const a = new AudioContext(), dst = a.createMediaStreamDestination(), o = a.createOscillator();
      o.connect(dst); o.start(); t.push(dst.stream.getAudioTracks()[0]);
    }
    return new MediaStream(t);
  };
}
// Collects WebSocket instances so the /ws one can be killed without a page reload —
// matches CLAUDE.md's documented trick for simulating a dead socket (a phone locking
// its screen, a wifi/cellular handoff), not a browser close.
function sockSpy() {
  window.__sockets = [];
  const OrigWS = window.WebSocket;
  window.WebSocket = new Proxy(OrigWS, {
    construct(target, args) {
      const ws = new target(...args);
      window.__sockets.push(ws);
      return ws;
    },
  });
}

const browser = await chromium.launch({
  args: ['--no-sandbox','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream','--autoplay-policy=no-user-gesture-required'],
});
const errors = [];
const mk = async (label) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ['camera','microphone'] });
  await ctx.addInitScript(stub);
  await ctx.addInitScript(sockSpy);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${label}: ${e.message}`));
  return { ctx, page, label };
};

console.log('── Setup: host + guest (camera on) ──');
const host = await mk('host');
await host.page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
await host.page.evaluate(({ t }) => { localStorage.clear(); localStorage.setItem('ibconnect_jwt', t); }, { t: sign({ userId: HOST.id, exp }) });
await host.page.reload({ waitUntil: 'domcontentloaded' });
await host.page.waitForTimeout(3000);
await host.page.click('[aria-label="Meetings"]');
await host.page.waitForTimeout(1200);
await host.page.click('text=/Instant start/i');
await host.page.waitForTimeout(5000);
await host.page.keyboard.press('Escape');
await host.page.waitForTimeout(500);
const room = await host.page.evaluate(() => location.pathname.replace('/', ''));
check('room created', !!room, room);

const guest = await mk('guest');
await guest.page.goto(`${BASE}/${room}`, { waitUntil: 'domcontentloaded' });
await guest.page.waitForTimeout(1500);
await guest.page.locator('input[aria-label="Your name"]').fill('Guest On Mobile');
await guest.page.click('button:has-text("Join now")');
await guest.page.waitForTimeout(6000);

const hostSeesGuestVideo = () => host.page.evaluate(() => {
  const videos = [...document.querySelectorAll('video')];
  for (const v of videos) {
    let node = v;
    for (let d = 0; d < 8 && node; d++) {
      if (node.classList && (node.classList.contains('rounded-xl') || node.classList.contains('rounded-2xl'))) {
        const label = node.querySelector('.truncate');
        if (label && label.textContent.trim().includes('Guest On Mobile')) {
          const tr = v.srcObject?.getVideoTracks()[0];
          return { present: true, live: tr?.readyState === 'live' && !tr?.muted, invisible: v.classList.contains('invisible') };
        }
        break;
      }
      node = node.parentElement;
    }
  }
  return { present: false };
});

check('host sees the guest\'s live video before anything goes wrong', (await hostSeesGuestVideo()).live);

console.log('\n── Killing the guest\'s signalling socket (no page reload) — a phone locking its screen ──');
await guest.page.evaluate(() => {
  const ws = window.__sockets.find((s) => s.url && s.url.includes('/ws'));
  if (ws) ws.close();
});
await host.page.waitForTimeout(3000);

const guestNoticeShown = await guest.page.evaluate(() => /another device or tab|session|sign in/i.test(document.body.innerText));
check('the guest was NOT wrongly told their session expired or signed out', !guestNoticeShown,
  guestNoticeShown ? 'guest page shows session/sign-in text' : '');

// Give the reconnect + re-offer a comfortable window.
await host.page.waitForTimeout(6000);
const after = await hostSeesGuestVideo();
check('host recovers the guest\'s tile after the reconnect (present)', after.present, JSON.stringify(after));
check('host recovers the guest\'s LIVE video, not stuck black/"Camera off"/gone', !!after.live, JSON.stringify(after));

check('no console or page errors', errors.length === 0, errors.join(' | '));

await browser.close();

const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} checks passed`);
if (passed !== results.length) {
  console.log('Failed:');
  results.filter((r) => !r.pass).forEach((r) => console.log(`  - ${r.name}`));
  process.exit(1);
}
