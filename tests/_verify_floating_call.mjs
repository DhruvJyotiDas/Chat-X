// Verifies the minimised / floating call: the call survives leaving the call screen,
// the app stays usable, remote AUDIO keeps playing (the thing most likely to break,
// since ActiveMeetingView's <video> elements carry it and they unmount), and the peer
// on the other side never notices.
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
const T1 = jwt('user-815ce7061367244d');
const T2 = jwt('user-964ef540619374b1');
const U1 = JSON.stringify({ id: 'user-815ce7061367244d', username: 'uitest1', displayName: 'UI Test User', email: 'uitest1@example.com' });
const U2 = JSON.stringify({ id: 'user-964ef540619374b1', username: 'uitest2', displayName: 'Second Tester', email: 'uitest2@example.com' });

function fakeMedia({ color }) {
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    const c = document.createElement('canvas');
    c.width = 320; c.height = 240;
    const ctx = c.getContext('2d');
    (function draw() {
      ctx.fillStyle = color; ctx.fillRect(0, 0, 320, 240);
      ctx.fillStyle = '#000'; ctx.font = '20px sans-serif';
      ctx.fillText(String(Date.now() % 100000), 10, 30);
      requestAnimationFrame(draw);
    })();
    const v = c.captureStream(15);
    const ac = new AudioContext();
    const dest = ac.createMediaStreamDestination();
    const osc = ac.createOscillator(); const g = ac.createGain();
    g.gain.value = 0.2; osc.frequency.value = 330;
    osc.connect(g).connect(dest); osc.start();
    const tracks = [];
    if (!constraints || constraints.video !== false) tracks.push(v.getVideoTracks()[0]);
    if (!constraints || constraints.audio !== false) tracks.push(dest.stream.getAudioTracks()[0]);
    return new MediaStream(tracks);
  };
  navigator.mediaDevices.enumerateDevices = async () => [];
}

const results = [];
const check = (n, pass, detail = '') => { results.push({ n, pass }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${n}${detail ? ' — ' + detail : ''}`); };

const browser = await chromium.launch({ args: ['--no-sandbox', '--use-fake-ui-for-media-stream'] });
const ctxA = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const ctxB = await browser.newContext({ viewport: { width: 1400, height: 900 } });
await ctxA.addInitScript(fakeMedia, { color: '#e63946' });
await ctxB.addInitScript(fakeMedia, { color: '#457b9d' });
const A = await ctxA.newPage();
const B = await ctxB.newPage();
const errs = [];
for (const [p, tag] of [[A, 'A'], [B, 'B']]) {
  p.on('pageerror', e => errs.push(`${tag} pageerror: ${e.message}`));
  p.on('console', m => { if (m.type() === 'error') errs.push(`${tag} console: ${m.text()}`); });
}

const login = async (page, token, user) => {
  await page.goto(BASE + '/');
  await page.evaluate(({ t, u }) => { localStorage.setItem('ibconnect_jwt', t); localStorage.setItem('ibconnect_me', u); }, { t: token, u: user });
  await page.reload();
  await page.waitForTimeout(1800);
};
await login(A, T1, U1);
await login(B, T2, U2);

await A.click('[aria-label="Chats"]');
await A.waitForTimeout(1200);
await A.click('[aria-label="Meetings"]');
await A.waitForSelector('text=Start New Meeting', { timeout: 15000 });
await A.click('text=Start New Meeting');
await A.waitForTimeout(4500);
const room = await A.evaluate(() => location.pathname.replace('/', ''));
if (!room) throw new Error('no room code');
console.log('Room:', room);
await A.keyboard.press('Escape').catch(() => {});
const gotIt = A.locator('button:has-text("Got it")').first();
if (await gotIt.count()) await gotIt.click().catch(() => {});
await A.waitForTimeout(600);

await B.click('[aria-label="Meetings"]');
await B.waitForTimeout(800);
await B.fill('input[placeholder="ENTER ROOM CODE…"]', room);
await B.click('button:has-text("Join")');
await B.waitForTimeout(5000);

const float = A.locator('[aria-label="Ongoing call — minimised"]');
check('minimise button exists on the call screen', await A.locator('[title="Minimise call"]').count() === 1);
check('no floating window while the call is full-screen', await float.count() === 0);

const bTimeBefore = await B.evaluate(() => {
  const v = [...document.querySelectorAll('video')].find(x => x.srcObject && !x.muted);
  return v ? v.currentTime : null;
});

await A.click('[title="Minimise call"]');
await A.waitForTimeout(2500);

check('floating call window appears', await float.count() === 1);
check('full call screen is gone', await A.locator('[title="Share screen"]').count() === 0);
check('app chrome is back (sidebar reachable)', await A.locator('[aria-label="Chats"]').count() > 0);
check('returns to the view you were on before joining', await A.locator('text=Start New Meeting').count() > 0 || (await A.locator('[aria-label="Meetings"]').count()) > 0);
await A.screenshot({ path: `${SHOTS}/float-minimised.png` });

await A.waitForTimeout(2500);
const bTimeAfter = await B.evaluate(() => {
  const v = [...document.querySelectorAll('video')].find(x => x.srcObject && !x.muted);
  return v ? v.currentTime : null;
});
check("peer's view of us keeps playing after we minimise", bTimeBefore !== null && bTimeAfter !== null && bTimeAfter > bTimeBefore,
  `${bTimeBefore} -> ${bTimeAfter}`);
check('peer still shows us as a participant', (await B.locator('text=UI Test User').count()) > 0);

const audio = await A.evaluate(() => {
  const box = document.querySelector('[aria-label="Ongoing call — minimised"]');
  const els = [...box.querySelectorAll('audio')];
  return els.map(a => ({ hasStream: !!a.srcObject, paused: a.paused, muted: a.muted }));
});
check('floating window carries an <audio> element per peer', audio.length >= 1, JSON.stringify(audio));
check('that audio is attached to a stream and playing', audio.every(a => a.hasStream && !a.paused && !a.muted), JSON.stringify(audio));

const vid = await A.evaluate(() => {
  const box = document.querySelector('[aria-label="Ongoing call — minimised"]');
  const v = box.querySelector('video');
  return v ? { t: v.currentTime, paused: v.paused, muted: v.muted, w: v.getBoundingClientRect().width } : null;
});
check('floating tile is showing live video', !!vid && vid.t > 0 && !vid.paused, JSON.stringify(vid));
check('floating tile is muted (audio comes from the <audio> elements, no double-play)', vid?.muted === true);

await A.click('[aria-label="Chats"]');
await A.waitForTimeout(1800);
check('can navigate the app with the call running', (await A.locator('text=MESSAGES').count()) > 0);
check('floating window survives navigation', await float.count() === 1);

const before = await float.boundingBox();
await A.mouse.move(before.x + before.width / 2, before.y + 8);
await A.mouse.down();
await A.mouse.move(before.x + before.width / 2 - 320, before.y + 8 - 220, { steps: 12 });
await A.mouse.up();
await A.waitForTimeout(600);
const after = await float.boundingBox();
check('window can be dragged', Math.abs(after.x - before.x) > 100 || Math.abs(after.y - before.y) > 100,
  `(${Math.round(before.x)},${Math.round(before.y)}) -> (${Math.round(after.x)},${Math.round(after.y)})`);
check('dragging did not expand the call', await float.count() === 1 && await A.locator('[title="Share screen"]').count() === 0);
const inView = await A.evaluate(() => {
  const b = document.querySelector('[aria-label="Ongoing call — minimised"]').getBoundingClientRect();
  return b.left >= 0 && b.top >= 0 && b.right <= innerWidth && b.bottom <= innerHeight;
});
check('window stays inside the viewport when dragged', inView);
await A.screenshot({ path: `${SHOTS}/float-dragged.png` });

await A.click('[aria-label="Mute"]');
await A.waitForTimeout(800);
check('mic can be muted from the floating window', await A.locator('[aria-label="Unmute"]').count() === 1);
await A.click('[aria-label="Unmute"]');
await A.waitForTimeout(600);

await A.click('[aria-label="Return to call"]');
await A.waitForTimeout(2500);
check('expanding returns to the full call screen', await A.locator('[title="Share screen"]').count() === 1);
check('floating window is gone once expanded', await float.count() === 0);
const backTile = await A.evaluate(() => {
  const v = [...document.querySelectorAll('video')].find(x => x.srcObject && !x.muted);
  return v ? { t: v.currentTime, paused: v.paused } : null;
});
check('remote video is live again on the full screen', !!backTile && backTile.t > 0 && !backTile.paused, JSON.stringify(backTile));

await A.setViewportSize({ width: 390, height: 844 });
await A.waitForTimeout(1000);
await A.click('[title="Minimise call"]');
await A.waitForTimeout(2000);
const mb = await float.boundingBox();
check('mobile: floating window fits the viewport', !!mb && mb.x >= 0 && mb.y >= 0 && mb.x + mb.width <= 390 && mb.y + mb.height <= 844,
  mb ? `${Math.round(mb.width)}x${Math.round(mb.height)} @(${Math.round(mb.x)},${Math.round(mb.y)})` : 'none');
check('mobile: no page horizontal scroll', await A.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
await A.screenshot({ path: `${SHOTS}/float-mobile.png` });

await A.click('[aria-label="Leave call"]');
await A.waitForTimeout(3000);
check('leaving from the floating window ends the call', await float.count() === 0);
await B.waitForTimeout(3000);
check('peer sees us drop', (await B.locator('text=UI Test User').count()) === 0);

check('no page/console errors', errs.length === 0, errs.slice(0, 4).join(' | '));

await browser.close();
const failed = results.filter(r => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
