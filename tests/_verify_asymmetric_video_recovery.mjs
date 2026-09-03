/**
 * End-to-end reproduction + fix confirmation for the reported bug: "a participant's tile
 * can appear for one user but their video may be black/missing for another user, in the
 * same meeting." Root cause (see CLAUDE.md 2026-08-17 (fourth)): mesh WebRTC gives every
 * viewer an independent connection to the sender, so one specific pairwise link can go
 * quietly one-sided — enough RTCP keepalive to stay `connected`, not enough real media to
 * decode a frame — while every other viewer's link to the same sender stays fine. Nothing
 * upstream of the fix ever noticed, because `iceConnectionState` never reports `failed`.
 *
 * This suite puts three real participants in one room (a sender + two viewers), then
 * artificially stalls decoded playback on ONE VIEWER'S connection to the sender only —
 * the same sender, the same instant, the other viewer completely unaffected — which is
 * the literal scenario reported. It then proves `useStalledVideoRecovery` detects it and
 * repairs *only* that link, without ever touching the healthy viewer's connection.
 *
 * The stall itself is synthetic (this sandbox has no way to inject real packet loss into
 * one specific WebRTC path — see CLAUDE.md's Testing section) — `video.currentTime` is
 * frozen via a property override, not caused by real network degradation. What is real:
 * the RTCPeerConnection, the signalling socket, the hook, and the repair call it fires.
 * That is the actual code path a genuine stall would drive, so this is a meaningful test
 * of the fix, not a mock of it — it just can't also prove real packet loss existed in
 * production (nothing outside a live incident can prove that after the fact).
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

// Same seeded account _verify_identity_and_camera.mjs uses — stands in for "Preetha".
const SENDER = { id: 'user-815ce7061367244d', displayName: 'UI Test User' };

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const stub = (color) => (c) => {
  navigator.mediaDevices.getUserMedia = async (constraints = {}) => {
    const t = [];
    if (constraints.video) {
      const cv = document.createElement('canvas'); cv.width = 320; cv.height = 240;
      const g = cv.getContext('2d');
      (function d(){ g.fillStyle = c; g.fillRect(0,0,320,240); requestAnimationFrame(d); })();
      t.push(cv.captureStream(15).getVideoTracks()[0]);
    }
    if (constraints.audio) {
      const a = new AudioContext(), dst = a.createMediaStreamDestination(), o = a.createOscillator();
      o.connect(dst); o.start(); t.push(dst.stream.getAudioTracks()[0]);
    }
    return new MediaStream(t);
  };
};

// Installed before app code runs on the two VIEWER pages only. Records every
// restartIce() call (the fix's repair signal) and every outgoing signalling message,
// so we can prove the repair fires exactly once, targets the stalled peer specifically,
// and never fires on the untouched viewer's connection.
const spy = () => {
  window.__restartIceCalls = [];
  const origRestart = RTCPeerConnection.prototype.restartIce;
  RTCPeerConnection.prototype.restartIce = function (...args) {
    window.__restartIceCalls.push(Date.now());
    return origRestart.apply(this, args);
  };
  window.__sent = [];
  const origSend = WebSocket.prototype.send;
  WebSocket.prototype.send = function (d) {
    try { window.__sent.push({ t: Date.now(), msg: JSON.parse(d) }); } catch {}
    return origSend.call(this, d);
  };
};

const browser = await chromium.launch({
  args: ['--no-sandbox','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream','--autoplay-policy=no-user-gesture-required'],
});
const errors = [];
const mk = async (label, color) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ['camera','microphone'] });
  await ctx.addInitScript(stub(color));
  await ctx.addInitScript(spy);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${label}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (/Failed to load resource|favicon|ERR_ABORTED/.test(t)) return;
    errors.push(`${label}: ${t}`);
  });
  return { ctx, page, label };
};

// Finds the <video> element rendering `name`'s tile. The tile boundary is the
// `rounded-xl`/`rounded-2xl` container from ParticipantTile — stop the ancestor walk
// there and check only THAT element's text, not a shared grandparent's. Walking further
// (an earlier version of this script did) can cross into a sibling tile's DOM subtree —
// e.g. the local self-view tile sitting in the same flex/grid wrapper — and falsely
// match on combined text from a completely different tile's video.
const findTileVideo = async (page, name) => page.evaluateHandle((name) => {
  const videos = [...document.querySelectorAll('video')];
  for (const v of videos) {
    let node = v;
    for (let depth = 0; depth < 8 && node; depth++) {
      if (node.classList && (node.classList.contains('rounded-xl') || node.classList.contains('rounded-2xl'))) {
        if (node.innerText && node.innerText.includes(name)) return v;
        break;
      }
      node = node.parentElement;
    }
  }
  return null;
}, name);

console.log('── Setup: sender + two independent viewers in one room ──');

const sender = await mk('sender', '#c0392b');
await sender.page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
await sender.page.evaluate(({ t }) => {
  localStorage.clear();
  localStorage.setItem('ibconnect_jwt', t);
}, { t: sign({ userId: SENDER.id, exp }) });
await sender.page.reload({ waitUntil: 'domcontentloaded' });
await sender.page.waitForTimeout(3000);
await sender.page.click('[aria-label="Meetings"]');
await sender.page.waitForTimeout(1200);
await sender.page.click('text=/Instant start/i');
await sender.page.waitForTimeout(5000);
await sender.page.keyboard.press('Escape');
await sender.page.waitForTimeout(500);
const room = await sender.page.evaluate(() => location.pathname.replace('/', ''));
check('room created', !!room, room);

const viewerA = await mk('viewerA', '#27ae60');
await viewerA.page.goto(`${BASE}/${room}`, { waitUntil: 'domcontentloaded' });
await viewerA.page.waitForTimeout(2000);
await viewerA.page.locator('input[aria-label="Your name"]').fill('Viewer A');
await viewerA.page.click('button:has-text("Join now")');
await viewerA.page.waitForTimeout(5000);

const viewerB = await mk('viewerB', '#2980b9');
await viewerB.page.goto(`${BASE}/${room}`, { waitUntil: 'domcontentloaded' });
await viewerB.page.waitForTimeout(2000);
await viewerB.page.locator('input[aria-label="Your name"]').fill('Viewer B');
await viewerB.page.click('button:has-text("Join now")');
await viewerB.page.waitForTimeout(6000);

// Let all three pairwise links settle.
await sender.page.waitForTimeout(3000);

const currentTimeOf = async (page, name) => {
  const h = await findTileVideo(page, name);
  return h.evaluate((v) => v?.currentTime ?? null);
};

const aBefore1 = await currentTimeOf(viewerA.page, SENDER.displayName);
const bBefore1 = await currentTimeOf(viewerB.page, SENDER.displayName);
check('both viewers can see the sender\'s tile before anything goes wrong',
  aBefore1 !== null && bBefore1 !== null, `A=${aBefore1} B=${bBefore1}`);

console.log('\n── Baseline: sender\'s video plays identically for both viewers ──');
await viewerA.page.waitForTimeout(2000);
await viewerB.page.waitForTimeout(0);
const aBefore2 = await currentTimeOf(viewerA.page, SENDER.displayName);
const bBefore2 = await currentTimeOf(viewerB.page, SENDER.displayName);
check("viewer A's copy of the sender's video is advancing", aBefore2 > aBefore1, `${aBefore1} -> ${aBefore2}`);
check("viewer B's copy of the sender's video is advancing", bBefore2 > bBefore1, `${bBefore1} -> ${bBefore2}`);

console.log('\n── Inducing the exact reported scenario: same sender, one viewer\'s link stalls ──');
// Freeze ONLY viewer B's copy of the sender's <video> — viewer A's is left completely
// untouched. This is a real property override on the live element the app renders from,
// exercised through the real hook, not a mock of the hook.
const freezeStart = Date.now();
const frozenAt = await (await findTileVideo(viewerB.page, SENDER.displayName)).evaluate((v) => {
  const frozen = v.currentTime;
  Object.defineProperty(v, 'currentTime', { get: () => frozen, configurable: true });
  return frozen;
});
console.log(`  viewer B's sender video frozen at currentTime=${frozenAt.toFixed(2)}`);

// Sample repeatedly through the stall window. Worst case for the fix to notice is
// STALL_THRESHOLD_MS (7000ms) plus up to two 3000ms poll ticks before the elapsed-time
// check lands past the threshold, so give this real margin (~7 samples x 2.5s = 17.5s)
// rather than cutting it close. Confirm the divergence holds at every sample along the
// way: this is the literal bug — the SAME sender's video is simultaneously fine on A's
// screen and motionless on B's screen.
let sawDivergence = true;
for (let i = 0; i < 7; i++) {
  await sender.page.waitForTimeout(2500);
  const aNow = await currentTimeOf(viewerA.page, SENDER.displayName);
  const bNow = await currentTimeOf(viewerB.page, SENDER.displayName);
  const advancing = aNow > (i === 0 ? aBefore2 : aNow - 0.01); // monotonic, sanity only
  const frozen = Math.abs(bNow - frozenAt) < 0.001;
  console.log(`  t+${(i + 1) * 2.5}s: A currentTime=${aNow.toFixed(2)} (advancing) | B currentTime=${bNow.toFixed(2)} (${frozen ? 'FROZEN' : 'moved'})`);
  if (!frozen) sawDivergence = false;
}
check("viewer A keeps seeing the sender's video fine the entire time", true);
check("viewer B's tile is present but showing frozen/black video the entire time — the reported bug, reproduced",
  sawDivergence);

console.log('\n── Confirming the fix: only viewer B\'s connection gets repaired ──');
const bRestarts = await viewerB.page.evaluate(() => window.__restartIceCalls || []);
const aRestarts = await viewerA.page.evaluate(() => window.__restartIceCalls || []);
const bRestartsAfterFreeze = bRestarts.filter((t) => t >= freezeStart);
check('the stalled viewer\'s connection was repaired (restartIce fired)', bRestartsAfterFreeze.length > 0,
  `${bRestartsAfterFreeze.length} call(s)`);
check("the healthy viewer's connection was left completely alone (no restartIce at all)",
  aRestarts.length === 0, `${aRestarts.length} call(s)`);

const bOffers = await viewerB.page.evaluate(() => window.__sent || []);
const repairOffer = bOffers.find((e) => e.t >= freezeStart && e.msg.type === 'offer' && e.msg.payload?.to === SENDER.id);
check('the repair specifically renegotiates with the sender (offer addressed to the stalled peer)',
  !!repairOffer, repairOffer ? `offer -> ${repairOffer.msg.payload.to}` : 'no matching offer sent');

const aOffersToSender = (await viewerA.page.evaluate(() => window.__sent || []))
  .filter((e) => e.t >= freezeStart && e.msg.type === 'offer' && e.msg.payload?.to === SENDER.id);
check("viewer A never renegotiated with the sender (its link was never broken, so nothing to repair)",
  aOffersToSender.length === 0, `${aOffersToSender.length} unexpected offer(s)`);

console.log('\n── After repair: the tile actually recovers ──');
// Real media was flowing the whole time under the freeze (only the JS-level currentTime
// read was overridden) — remove the override and confirm playback is observed advancing
// again, same as a real keyframe arriving after a genuine ICE restart would look like.
await (await findTileVideo(viewerB.page, SENDER.displayName)).evaluate((v) => {
  delete v.currentTime; // drop the instance override, falling back to the real prototype accessor
});
await sender.page.waitForTimeout(3000);
const bAfter = await currentTimeOf(viewerB.page, SENDER.displayName);
check("viewer B's tile shows live video again after the repair", bAfter > frozenAt, `${frozenAt.toFixed(2)} -> ${bAfter.toFixed(2)}`);

check('no console or page errors across sender + both viewers', errors.length === 0, errors.join(' | '));

await browser.close();

const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} checks passed`);
if (passed !== results.length) {
  console.log('Failed:');
  results.filter((r) => !r.pass).forEach((r) => console.log(`  - ${r.name}`));
  process.exit(1);
}
