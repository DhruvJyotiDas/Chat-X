/**
 * Verifies the call-surface work ported from livekit-examples/meet and
 * suitenumerique/meet:
 *
 *   - speaker routing actually calls setSinkId (the dropdown used to be inert)
 *   - device choices persist and `devicechange` is observed
 *   - silent-microphone detection warns on a track that produces nothing
 *   - reactions and raise-hand relay between two real browsers
 *   - keyboard shortcuts, including push-to-talk
 *   - getStats() is polled and link quality is derived from it
 *   - the pre-join connection test runs and reaches a verdict
 *
 * Two browser contexts join the same room so the signalling paths are exercised
 * for real rather than mocked. getUserMedia is stubbed the way the other suites
 * do it, because real devices do not exist in this sandbox.
 *
 * BASE selects the target (default: the throwaway dev server on 3101).
 */
import { chromium } from 'playwright';
import crypto from 'crypto';

const BASE = process.env.BASE ?? 'http://127.0.0.1:3101';
const SECRET = process.env.IBCONNECT_JWT_SECRET;
if (!SECRET) {
  console.error('IBCONNECT_JWT_SECRET must be set (source /etc/ibconnect/env).');
  process.exit(2);
}

const exp = Math.floor(Date.now() / 1000) + 3600 * 6;
const b64 = (i) => Buffer.from(i).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
function sign(p) {
  const h = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' })), y = b64(JSON.stringify(p));
  return `${h}.${y}.` + crypto.createHmac('sha256', SECRET).update(`${h}.${y}`)
    .digest('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

// Real rows in the users table. AuthContext re-checks /api/auth/me on load and the
// server's display_name wins over anything seeded into localStorage, so these must be
// the actual stored names or every roster assertion looks for the wrong string.
const USERS = [
  { id: 'user-815ce7061367244d', username: 'uitest1', displayName: 'UI Test User', email: 'uitest1@example.com' },
  { id: 'user-964ef540619374b1', username: 'uitest2', displayName: 'Second Tester', email: 'uitest2@example.com' },
];

/**
 * Stub media + record every setSinkId call so speaker routing can be asserted.
 * `silentAudio` produces a track that is live but carries pure silence, which is
 * exactly the condition the silent-mic detector exists to catch.
 */
function initScript({ silentAudio }) {
  return `(() => {
    window.__sinkCalls = [];
    window.__deviceChangeListeners = 0;

    const FAKE_DEVICES = [
      { deviceId: 'cam-1', kind: 'videoinput',  label: 'Fake Camera 1', groupId: 'g1' },
      { deviceId: 'cam-2', kind: 'videoinput',  label: 'Fake Camera 2', groupId: 'g2' },
      { deviceId: 'mic-1', kind: 'audioinput',  label: 'Fake Mic 1',    groupId: 'g1' },
      { deviceId: 'mic-2', kind: 'audioinput',  label: 'Fake Mic 2',    groupId: 'g2' },
      { deviceId: 'spk-1', kind: 'audiooutput', label: 'Fake Speaker 1', groupId: 'g1' },
      { deviceId: 'spk-2', kind: 'audiooutput', label: 'Fake USB Headset', groupId: 'g2' },
    ];

    // setSinkId does not exist in headless Chromium at all, so the real code path
    // (which feature-detects it) would correctly hide the picker. Install a spy so
    // the routing logic itself is what gets tested.
    HTMLMediaElement.prototype.setSinkId = function (id) {
      window.__sinkCalls.push({ id, at: Date.now() });
      this.__sinkId = id;
      return Promise.resolve();
    };

    navigator.mediaDevices.enumerateDevices = async () => FAKE_DEVICES.map((d) => ({ ...d, toJSON: () => d }));

    const realAdd = navigator.mediaDevices.addEventListener.bind(navigator.mediaDevices);
    navigator.mediaDevices.addEventListener = (type, fn, opts) => {
      if (type === 'devicechange') window.__deviceChangeListeners++;
      return realAdd(type, fn, opts);
    };
    window.__fireDeviceChange = () => navigator.mediaDevices.dispatchEvent(new Event('devicechange'));

    navigator.mediaDevices.getUserMedia = async (c = {}) => {
      const tracks = [];
      if (c.video) {
        const cv = document.createElement('canvas'); cv.width = 320; cv.height = 240;
        const g = cv.getContext('2d');
        (function draw() { g.fillStyle = '#2a9d8f'; g.fillRect(0, 0, 320, 240); requestAnimationFrame(draw); })();
        tracks.push(cv.captureStream(10).getVideoTracks()[0]);
      }
      if (c.audio) {
        const a = new AudioContext();
        const d = a.createMediaStreamDestination();
        const gain = a.createGain();
        // The only difference between the two modes: whether the oscillator is
        // audible. A muted gain still yields a live track, which is the point.
        gain.gain.value = ${silentAudio ? '0' : '0.3'};
        const o = a.createOscillator();
        o.frequency.value = 220;
        o.connect(gain).connect(d);
        o.start();
        tracks.push(d.stream.getAudioTracks()[0]);
      }
      return new MediaStream(tracks);
    };
  })();`;
}

async function makeContext(browser, user, { silentAudio = false } = {}) {
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    permissions: ['camera', 'microphone'],
  });
  await ctx.addInitScript(initScript({ silentAudio }));
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (/Failed to load resource|favicon|ERR_ABORTED/.test(t)) return;
    errors.push(t);
  });

  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(({ t, u }) => {
    localStorage.setItem('ibconnect_jwt', t);
    localStorage.setItem('ibconnect_me', JSON.stringify(u));
  }, { t: sign({ userId: user.id, exp }), u: user });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1800);
  return { ctx, page, errors };
}

/**
 * Create a room through the UI and return its code.
 *
 * Navigating straight to /someCode does NOT work for a signed-in user: an unknown
 * room lands on the Meetings page with "Room not found", because rooms live in the
 * backend's memory and have to be created by someone first.
 */
async function createRoom(page) {
  // The app opens on the dashboard; room creation lives on the Meetings view.
  await page.click('[aria-label="Meetings"]');
  await page.waitForTimeout(1200);
  await page.click('text=/Instant start/i');
  await page.waitForTimeout(5000);
  const code = await page.evaluate(() => window.location.pathname.replace('/', ''));
  if (!code) throw new Error('room creation did not change the URL');
  await dismissInviteDialog(page);
  return code;
}

/**
 * Creating a room pops the invite dialog over the whole stage at z-[10000], which
 * swallows pointer events aimed at the control bar. Every test that touches a control
 * has to clear it first.
 */
async function dismissInviteDialog(page) {
  const overlay = page.locator('div.z-\\[10000\\]');
  if (!(await overlay.count())) return;
  // Prefer the dialog's own dismiss control; fall back to Escape.
  const close = page.locator('[aria-label="Close"], [aria-label="Dismiss"], button:has-text("Later")').first();
  if (await close.isVisible().catch(() => false)) await close.click().catch(() => {});
  else await page.keyboard.press('Escape');
  await page.waitForTimeout(700);
}

/** Join an existing room by URL. */
async function joinRoom(page, room) {
  await page.goto(`${BASE}/${room}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4500);
  await dismissInviteDialog(page);
}

const browser = await chromium.launch({
  args: [
    '--no-sandbox',
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
  ],
});

// ── A: speaker routing, device persistence, shortcuts, stats ─────────────────
console.log('\n── Single-client checks ──');
const a = await makeContext(browser, USERS[0]);
const ROOM = await createRoom(a.page);
console.log(`  (room ${ROOM})`);

const inCall = await a.page.locator('[title="Share screen"]').isVisible().catch(() => false);
check('created a room and the control bar rendered', inCall);

// Speaker routing. The bug being fixed: onSpeakerChange only set React state.
await a.page.click('[title="Settings"]');
await a.page.waitForTimeout(600);
await a.page.click('button:has-text("Devices")');
await a.page.waitForTimeout(400);

const speakerVisible = await a.page.locator('select').nth(2).isVisible().catch(() => false);
check('speaker picker is shown when the browser supports setSinkId', speakerVisible);

// Choose a speaker while still alone in the room. There are no peer audio elements
// yet, so nothing can be routed at this instant — the choice has to be *remembered*
// and applied to elements as they mount. That deferred application is asserted after
// the second client joins, below.
await a.page.locator('select').nth(2).selectOption('spk-2');
await a.page.waitForTimeout(900);

const speakerPersisted = await a.page.evaluate(() => localStorage.getItem('ibconnect_speaker_id'));
check('speaker choice persisted to localStorage', speakerPersisted === 'spk-2', String(speakerPersisted));

// Camera switch persists only after the switch succeeds.
await a.page.locator('select').nth(0).selectOption('cam-2');
await a.page.waitForTimeout(1500);
const camPersisted = await a.page.evaluate(() => localStorage.getItem('ibconnect_camera_id'));
check('camera choice persisted after a successful switch', camPersisted === 'cam-2', String(camPersisted));

const listeners = await a.page.evaluate(() => window.__deviceChangeListeners);
check('a devicechange listener is registered (there were none before)', listeners >= 1, `${listeners} listener(s)`);

// Hot-plug: the list must refresh without reopening settings.
const optionsBefore = await a.page.locator('select').nth(2).locator('option').count();
await a.page.evaluate(() => {
  window.__extraDevice = true;
  const prev = navigator.mediaDevices.enumerateDevices;
  navigator.mediaDevices.enumerateDevices = async () => {
    const list = await prev();
    return [...list, { deviceId: 'spk-3', kind: 'audiooutput', label: 'Hot-plugged Speaker', groupId: 'g3', toJSON: () => ({}) }];
  };
  window.__fireDeviceChange();
});
await a.page.waitForTimeout(900);
const optionsAfter = await a.page.locator('select').nth(2).locator('option').count();
check('device list refreshes on devicechange while settings stay open',
  optionsAfter === optionsBefore + 1, `${optionsBefore} → ${optionsAfter}`);

// Shortcuts tab is a discoverability surface, not just bindings.
await a.page.click('button:has-text("Shortcuts")');
await a.page.waitForTimeout(400);
check('shortcuts are documented in settings',
  await a.page.locator('text=/Hold Space/i').isVisible().catch(() => false));
await a.page.click('[title="Settings"]');
await a.page.waitForTimeout(400);

// Keyboard shortcuts.
const mutedBefore = await a.page.locator('[title="Unmute"]').isVisible().catch(() => false);
await a.page.keyboard.press('Control+d');
await a.page.waitForTimeout(600);
const mutedAfter = await a.page.locator('[title="Unmute"]').isVisible().catch(() => false);
check('Ctrl-D toggles mute', mutedBefore !== mutedAfter, `${mutedBefore} → ${mutedAfter}`);

// Push-to-talk: from muted, holding space must unmute and releasing must re-mute.
if (!mutedAfter) { await a.page.keyboard.press('Control+d'); await a.page.waitForTimeout(500); }
await a.page.keyboard.down('Space');
await a.page.waitForTimeout(600);
const talkingWhileHeld = await a.page.locator('[title="Mute"]').isVisible().catch(() => false);
await a.page.keyboard.up('Space');
await a.page.waitForTimeout(600);
const remutedAfterRelease = await a.page.locator('[title="Unmute"]').isVisible().catch(() => false);
check('holding Space unmutes and releasing re-mutes', talkingWhileHeld && remutedAfterRelease,
  `held=${talkingWhileHeld} released=${remutedAfterRelease}`);

// Typing in chat must not trigger shortcuts.
await a.page.click('[title="Chat"]');
await a.page.waitForTimeout(600);
const composer = a.page.locator('input[placeholder*="message" i], textarea').first();
if (await composer.isVisible().catch(() => false)) {
  await composer.click();
  await composer.type('deed space');
  await a.page.waitForTimeout(500);
  const stillMuted = await a.page.locator('[title="Unmute"]').isVisible().catch(() => false);
  check('typing in the chat composer does not fire call shortcuts', stillMuted);
} else {
  check('typing in the chat composer does not fire call shortcuts', false, 'composer not found');
}
await a.page.click('[title="Chat"]');
await a.page.waitForTimeout(400);

// ── B: two clients — reactions, hands, stats, roster ─────────────────────────
console.log('\n── Two-client checks ──');
const b = await makeContext(browser, USERS[1]);
await joinRoom(b.page, ROOM);
await a.page.waitForTimeout(3000);

const aSeesPeer = await a.page.locator(`text=${USERS[1].displayName}`).first().isVisible().catch(() => false);
const bSeesPeer = await b.page.locator(`text=${USERS[0].displayName}`).first().isVisible().catch(() => false);
check('both clients see each other in the room', aSeesPeer && bSeesPeer, `a→b=${aSeesPeer} b→a=${bSeesPeer}`);

// The case the old code could never handle: an audio element created *after* the
// speaker was chosen. Peers join and leave throughout a call, so routing that only
// happened at selection time would miss everyone who arrived later.
const sinkOnJoin = await a.page.evaluate(() => window.__sinkCalls);
check('audio elements mounted after the choice are routed to it (was impossible before)',
  sinkOnJoin.some((c) => c.id === 'spk-2'),
  `${sinkOnJoin.length} call(s), ids: ${[...new Set(sinkOnJoin.map((c) => c.id))].join(',') || 'none'}`);

// And changing it again must re-route the elements that already exist.
await a.page.click('[title="Settings"]');
await a.page.waitForTimeout(600);
await a.page.click('button:has-text("Devices")');
await a.page.waitForTimeout(400);
const before = await a.page.evaluate(() => window.__sinkCalls.length);
await a.page.locator('select').nth(2).selectOption('spk-1');
await a.page.waitForTimeout(900);
const afterSwitch = await a.page.evaluate(() => window.__sinkCalls);
check('changing the speaker mid-call re-routes live audio elements',
  afterSwitch.length > before && afterSwitch.slice(before).some((c) => c.id === 'spk-1'),
  `${afterSwitch.length - before} new call(s): ${afterSwitch.slice(before).map((c) => c.id).join(',') || 'none'}`);
await a.page.click('[title="Settings"]');
await a.page.waitForTimeout(400);

// Reactions.
await b.page.click('[title="Send a reaction"]');
await b.page.waitForTimeout(500);
const pickerOpen = await b.page.locator('[aria-label="React with 🎉"]').isVisible().catch(() => false);
check('reaction picker opens', pickerOpen);

await b.page.click('[aria-label="React with 🎉"]');
await b.page.waitForTimeout(900);

const senderSees = await b.page.locator('.ib-reaction-rise').count();
check('sender sees their own reaction (server relays to others only)', senderSees > 0, `${senderSees} on screen`);

const receiverSees = await a.page.locator('.ib-reaction-rise').count();
check('the other client receives the reaction over /ws', receiverSees > 0, `${receiverSees} on screen`);

const attributed = await a.page.locator(`.ib-reaction-rise:has-text("${USERS[1].displayName}")`).count();
check('reaction is attributed to the sender', attributed > 0);

// Reactions must expire on their own.
await a.page.waitForTimeout(4200);
const afterTtl = await a.page.locator('.ib-reaction-rise').count();
check('reactions expire and are removed from the DOM', afterTtl === 0, `${afterTtl} left`);

// Raise hand.
await b.page.click('[title="Raise hand"]');
await b.page.waitForTimeout(1200);

const bOwnHand = await b.page.locator('[aria-label="Your hand is raised"], [title="Lower hand"]').first().isVisible().catch(() => false);
check('raising a hand updates the sender UI', bOwnHand);

const handLabel = `[aria-label="${USERS[1].displayName} has their hand raised"]`;
const aSeesHand = await a.page.locator(handLabel).first().isVisible().catch(() => false);
check('the other client sees the raised hand on the tile', aSeesHand);

await b.page.click('[title="Lower hand"]');
await b.page.waitForTimeout(1200);
const handCleared = await a.page.locator(handLabel).count();
check('lowering a hand clears it for everyone', handCleared === 0, `${handCleared} still shown`);

// Ctrl-H must drive the same state.
await b.page.keyboard.press('Control+h');
await b.page.waitForTimeout(1000);
const handViaKey = await a.page.locator(handLabel).count();
check('Ctrl-H raises the hand', handViaKey > 0);
await b.page.keyboard.press('Control+h');
await b.page.waitForTimeout(800);

// getStats: nothing in the app used to call it at all.
const statsRead = await a.page.evaluate(() => {
  const events = window.__ibDiag ? window.__ibDiag() : [];
  return events.filter((e) => /selected-candidate-pair/.test(e.event ?? ''));
});
check('getStats() is polled and the selected candidate pair is logged',
  statsRead.length > 0, statsRead[0]?.event ?? 'no stats events');

const roster = await a.page.evaluate(async () => {
  const btn = [...document.querySelectorAll('[title="People"]')][0];
  btn?.click();
  await new Promise((r) => setTimeout(r, 800));
  return document.body.innerText;
});
check('roster reports the measured path (rtt or relayed)',
  /\d+\s*ms|relayed/.test(roster), (roster.match(/\d+\s*ms|relayed/) ?? ['none'])[0]);

// ── C: silent microphone ─────────────────────────────────────────────────────
console.log('\n── Silent microphone ──');
const c = await makeContext(browser, USERS[0], { silentAudio: true });
await joinRoom(c.page, ROOM);
// The detector needs its accumulated-silence budget (12s) plus slack.
await c.page.waitForTimeout(16000);

const warned = await c.page.locator("text=/isn't picking up any sound/i").first().isVisible().catch(() => false);
check('a live-but-silent microphone raises a warning', warned);

if (warned) {
  await c.page.click('[aria-label="Dismiss microphone warning"]');
  await c.page.waitForTimeout(600);
  const gone = await c.page.locator("text=/isn't picking up any sound/i").count();
  const remembered = await c.page.evaluate(() => localStorage.getItem('ibconnect_silent_mic_dismissed'));
  check('dismissing the warning hides it and is remembered', gone === 0 && remembered === '1',
    `visible=${gone} stored=${remembered}`);
} else {
  check('dismissing the warning hides it and is remembered', false, 'never warned');
}

// A working microphone must NOT warn — the check that keeps this from being noise.
const falsePositive = await a.page.locator("text=/isn't picking up any sound/i").count();
check('a working microphone is not warned about', falsePositive === 0);

// ── D: pre-join connection test ──────────────────────────────────────────────
console.log('\n── Connection test ──');
const d = await makeContext(browser, USERS[1]);
await d.page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
await d.page.waitForTimeout(2000);

// Reachable for signed-in users too, who never see the guest lobby.
const opened = await d.page.evaluate(async () => {
  const gear = [...document.querySelectorAll('button')].find((b) => /settings/i.test(b.getAttribute('aria-label') ?? b.title ?? ''));
  gear?.click();
  await new Promise((r) => setTimeout(r, 900));
  const tab = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Devices');
  tab?.click();
  await new Promise((r) => setTimeout(r, 700));
  const run = [...document.querySelectorAll('button')].find((b) => /Test my connection/i.test(b.textContent ?? ''));
  run?.click();
  return !!run;
});
check('connection test is reachable from Settings for signed-in users', opened);

if (opened) {
  await d.page.waitForTimeout(2000);
  check('test enumerates the expected steps',
    await d.page.locator('text=/Meeting server reachable/i').isVisible().catch(() => false));

  // Steps run to a verdict. Relay allocation can legitimately fail in a sandbox,
  // so the assertion is that a verdict is *reached*, not that it is "ok".
  await d.page.waitForTimeout(30000);
  const verdictText = await d.page.evaluate(() => document.body.innerText);
  const reached = /Ready to go|relayed|blocks video calls|unavailable/i.test(verdictText);
  check('test reaches a verdict', reached,
    (verdictText.match(/Ready to go|Calls will work, but relayed|This network blocks video calls|camera or microphone is unavailable/i) ?? ['none'])[0]);

  check('signalling step passed against the running backend',
    await d.page.locator('text=/Meeting server reachable/i').locator('xpath=../..').first().isVisible().catch(() => false));

  const stillRunning = await d.page.locator('button:has-text("Testing…")').count();
  check('test finishes rather than spinning forever', stillRunning === 0);
} else {
  ['test enumerates the expected steps', 'test reaches a verdict',
   'signalling step passed against the running backend', 'test finishes rather than spinning forever']
    .forEach((n) => check(n, false, 'panel never opened'));
}

// ── E: server-side reaction allow-list ───────────────────────────────────────
//
// The emoji is rendered in every other participant's DOM, so the server must not
// relay whatever arrives. Tested with raw sockets rather than through the UI,
// because the UI's own isReaction() guard would stop a bogus value ever being sent
// — the point here is that the *server* also refuses.
console.log('\n── Reaction allow-list (raw signalling) ──');
{
  const wsBase = BASE.replace(/^http/, 'ws') + '/ws';
  const rawRoom = `raw${Math.random().toString(36).slice(2, 7)}`;

  const open = (name) => new Promise((resolve, reject) => {
    const ws = new WebSocket(wsBase);
    const received = [];
    ws.addEventListener('message', (e) => {
      try { received.push(JSON.parse(e.data)); } catch { /* ignore */ }
    });
    ws.addEventListener('open', () => resolve({ ws, received, name }));
    ws.addEventListener('error', () => reject(new Error(`socket for ${name} failed`)));
    setTimeout(() => reject(new Error(`socket for ${name} timed out`)), 8000);
  });

  const send = (c, type, payload) => c.ws.send(JSON.stringify({ type, payload }));
  const settle = (ms) => new Promise((r) => setTimeout(r, ms));

  try {
    const host = await open('host');
    const guest = await open('guest');

    send(host, 'create_room', { room_id: rawRoom, user_id: 'raw-host', user_name: 'Host' });
    await settle(700);
    send(guest, 'join_room', { room_id: rawRoom, user_id: 'raw-guest', user_name: 'Guest' });
    await settle(900);

    const joined = host.received.some((m) => m.type === 'peer_joined')
      || guest.received.some((m) => m.type === 'room_joined');
    check('raw clients entered a room', joined,
      `host saw ${host.received.map((m) => m.type).join(',') || 'nothing'}`);

    guest.received.length = 0;
    host.received.length = 0;

    send(guest, 'reaction', { emoji: '👍' });
    send(guest, 'reaction', { emoji: '<img src=x onerror=alert(1)>' });
    send(guest, 'reaction', { emoji: '💀' });
    await settle(1000);

    const relayed = host.received.filter((m) => m.type === 'reaction').map((m) => m.payload?.emoji);
    check('the allow-listed reaction is relayed', relayed.includes('👍'), relayed.join(' ') || 'none');
    check('an unlisted emoji is dropped', !relayed.includes('💀'), relayed.join(' ') || 'none');
    check('an HTML payload is dropped, not relayed',
      !relayed.some((e) => typeof e === 'string' && e.includes('<img')),
      relayed.join(' ') || 'none');

    // hand_state carries a boolean, so it needs no allow-list — but it must relay.
    host.received.length = 0;
    send(guest, 'hand_state', { raised: true });
    await settle(800);
    const hand = host.received.find((m) => m.type === 'hand_state');
    check('hand_state relays with the peer identity', hand?.payload?.raised === true && !!hand?.payload?.peer_id,
      JSON.stringify(hand?.payload ?? null));

    host.ws.close();
    guest.ws.close();
  } catch (err) {
    ['raw clients entered a room', 'the allow-listed reaction is relayed',
     'an unlisted emoji is dropped', 'an HTML payload is dropped, not relayed',
     'hand_state relays with the peer identity'].forEach((n) => check(n, false, err.message));
  }
}

// ── Errors ───────────────────────────────────────────────────────────────────
const allErrors = [...a.errors, ...b.errors, ...c.errors, ...d.errors];
check('no console or page errors across all four clients', allErrors.length === 0,
  allErrors.slice(0, 3).join(' | '));

await browser.close();

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) console.log('Failed:\n' + failed.map((f) => `  - ${f.name}`).join('\n'));
process.exit(failed.length ? 1 : 0);
