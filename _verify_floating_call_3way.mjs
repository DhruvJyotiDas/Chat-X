// Narrow follow-up to the floating-call suite: with THREE people in the room, the
// minimised window shows one peer but must keep audio for BOTH remote peers. A
// one-remote-peer test can't tell "audio follows the visible tile" from "audio is
// wired per peer", which is the whole point of the fix (see PeerAudio in
// src/components/meeting/FloatingCallWindow.tsx).
import { chromium } from 'playwright';
import crypto from 'crypto';

const BASE = process.env.BASE || 'http://127.0.0.1:3100';
const SHOTS = process.env.SHOTS || '/tmp';

function b64url(i) { return Buffer.from(i).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_'); }
function jwt(uid) {
  const S = (process.env.IBCONNECT_JWT_SECRET
  ?? 'ibconnect_jwt_secret_prod_2024_change_me')  // legacy fallback: the backend now requires IBCONNECT_JWT_SECRET, so export it to test a deployed build;
  const h = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64url(JSON.stringify({ userId: uid, exp: Math.floor(Date.now() / 1000) + 3600 }));
  const sig = crypto.createHmac('sha256', S).update(`${h}.${p}`).digest('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${h}.${p}.${sig}`;
}
const ACCOUNTS = [
  { t: jwt('user-815ce7061367244d'), u: JSON.stringify({ id: 'user-815ce7061367244d', username: 'uitest1', displayName: 'UI Test User', email: 'uitest1@example.com' }), color: '#e63946' },
  { t: jwt('user-964ef540619374b1'), u: JSON.stringify({ id: 'user-964ef540619374b1', username: 'uitest2', displayName: 'Second Tester', email: 'uitest2@example.com' }), color: '#457b9d' },
  { t: jwt('user-c6e3c1eea384f6f3'), u: JSON.stringify({ id: 'user-c6e3c1eea384f6f3', username: 'uitest3', displayName: 'UI Smoke Tester', email: 'uitest3@example.com' }), color: '#2a9d8f' },
];

function fakeMedia({ color }) {
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    const c = document.createElement('canvas'); c.width = 320; c.height = 240;
    const ctx = c.getContext('2d');
    (function draw() { ctx.fillStyle = color; ctx.fillRect(0, 0, 320, 240); requestAnimationFrame(draw); })();
    const v = c.captureStream(15);
    const ac = new AudioContext(); const dest = ac.createMediaStreamDestination();
    const osc = ac.createOscillator(); const g = ac.createGain(); g.gain.value = 0.2;
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
const pages = [];
for (const acct of ACCOUNTS) {
  const c = await browser.newContext({ viewport: { width: 1280, height: 820 } });
  await c.addInitScript(fakeMedia, { color: acct.color });
  const p = await c.newPage();
  await p.goto(BASE + '/');
  await p.evaluate(({ t, u }) => { localStorage.setItem('ibconnect_jwt', t); localStorage.setItem('ibconnect_me', u); }, { t: acct.t, u: acct.u });
  await p.reload();
  await p.waitForTimeout(1800);
  pages.push(p);
}
const [A, B, C] = pages;

await A.click('[aria-label="Meetings"]');
await A.waitForSelector('text=Start New Meeting', { timeout: 15000 });
await A.click('text=Start New Meeting');
await A.waitForTimeout(4500);
const room = await A.evaluate(() => location.pathname.replace('/', ''));
console.log('Room:', room);
const gotIt = A.locator('button:has-text("Got it")').first();
if (await gotIt.count()) await gotIt.click().catch(() => {});
await A.keyboard.press('Escape').catch(() => {});

for (const p of [B, C]) {
  await p.click('[aria-label="Meetings"]');
  await p.waitForTimeout(800);
  await p.fill('input[placeholder="ENTER ROOM CODE…"]', room);
  await p.click('button:has-text("Join")');
  await p.waitForTimeout(4500);
}
await A.waitForTimeout(4000);

const peerCount = await A.evaluate(() => [...document.querySelectorAll('video')].filter(v => v.srcObject && !v.muted).length);
check('A has two remote peers before minimising', peerCount >= 2, `remote videos: ${peerCount}`);

await A.click('[title="Minimise call"]');
await A.waitForTimeout(3000);

const box = A.locator('[aria-label="Ongoing call — minimised"]');
check('floating window appears with 3 in the room', await box.count() === 1);

const state = await A.evaluate(() => {
  const b = document.querySelector('[aria-label="Ongoing call — minimised"]');
  const audios = [...b.querySelectorAll('audio')].map(a => ({
    hasStream: !!a.srcObject,
    tracks: a.srcObject ? a.srcObject.getAudioTracks().length : 0,
    paused: a.paused, muted: a.muted,
  }));
  const vids = [...b.querySelectorAll('video')].length;
  const count = [...b.querySelectorAll('span')].map(s => s.textContent).find(t => /^\d+$/.test(t || ''));
  return { audios, vids, count };
});

check('only ONE video tile is shown (it is a small window)', state.vids === 1, `videos: ${state.vids}`);
check('an <audio> exists for EACH remote peer, not just the shown one', state.audios.length === 2, JSON.stringify(state.audios));
check('every peer audio is attached, unmuted and playing', state.audios.length === 2 && state.audios.every(a => a.hasStream && a.tracks > 0 && !a.paused && !a.muted), JSON.stringify(state.audios));
check('participant count reads 3', state.count === '3', `count badge: ${state.count}`);
await A.screenshot({ path: `${SHOTS}/float-3way.png` });

// Dropping one peer must retire exactly one audio element, not all of them.
await C.click('button:has-text("Leave")').catch(async () => { await C.click('[title="Leave"]'); });
await A.waitForTimeout(4500);
const after = await A.evaluate(() => {
  const b = document.querySelector('[aria-label="Ongoing call — minimised"]');
  if (!b) return null;
  return { audios: b.querySelectorAll('audio').length, playing: [...b.querySelectorAll('audio')].every(a => !!a.srcObject && !a.paused) };
});
check('a peer leaving removes only their audio', after?.audios === 1, JSON.stringify(after));
check('the remaining peer is still audible', after?.playing === true, JSON.stringify(after));

await browser.close();
const failed = results.filter(r => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
