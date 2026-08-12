// Deeper mobile pass: the states the sweep couldn't reach by aria-label —
// Calls after the responsive fix, a chat thread open, the Settings modal, the
// command palette and the in-call screen.
import { chromium, devices } from 'playwright';
import crypto from 'crypto';
import { mkdirSync } from 'fs';

const BASE = process.env.BASE ?? 'http://127.0.0.1:3100';
const SHOT = '/tmp/claude-1001/-home-ubuntu/2ddff6bf-4824-4ec1-922c-37faab8a5ab6/scratchpad/mobile2';
mkdirSync(SHOT, { recursive: true });

const b64url = (i) => Buffer.from(i).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
function signHS256(payload, secret) {
  const h = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest('base64')
    .replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${h}.${p}.${sig}`;
}
const SECRET = (process.env.IBCONNECT_JWT_SECRET
  ?? 'ibconnect_jwt_secret_prod_2024_change_me')  // legacy fallback: the backend now requires IBCONNECT_JWT_SECRET, so export it to test a deployed build;
const exp = Math.floor(Date.now() / 1000) + 3600 * 6;
const TOKEN = signHS256({ userId: 'user-815ce7061367244d', exp }, SECRET);
const USER = JSON.stringify({ id: 'user-815ce7061367244d', username: 'uitest1', displayName: 'UI Test User', email: 'uitest1@example.com' });

function fakeMedia() {
  const mk = (w, h, fill) => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    (function draw() { ctx.fillStyle = fill; ctx.fillRect(0, 0, w, h); requestAnimationFrame(draw); })();
    return c.captureStream(15);
  };
  navigator.mediaDevices.getUserMedia = async (c) => {
    const v = mk(320, 240, '#e63946');
    const ac = new AudioContext();
    const dest = ac.createMediaStreamDestination();
    const g = ac.createGain(); g.gain.value = 0.0001;
    const o = ac.createOscillator(); o.connect(g).connect(dest); o.start();
    const t = [];
    if (!c || c.video !== false) t.push(v.getVideoTracks()[0]);
    if (!c || c.audio !== false) t.push(dest.stream.getAudioTracks()[0]);
    return new MediaStream(t);
  };
  navigator.mediaDevices.getDisplayMedia = async () => new MediaStream([mk(1280, 720, '#2a9d8f').getVideoTracks()[0]]);
}

function probe() {
  const vw = document.documentElement.clientWidth;
  const issues = [];
  const describe = (el) => {
    const cls = (el.className || '').toString().split(' ').slice(0, 3).join('.');
    const txt = (el.innerText || '').trim().slice(0, 36).replace(/\s+/g, ' ');
    return `${el.tagName.toLowerCase()}${cls ? '.' + cls : ''}${txt ? ` "${txt}"` : ''}`;
  };
  const visible = (el) => {
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || +s.opacity === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const decorative = (el) => getComputedStyle(el).pointerEvents === 'none';
  const inScroller = (el) => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const ox = getComputedStyle(p).overflowX;
      if ((ox === 'auto' || ox === 'scroll') && p.scrollWidth > p.clientWidth) return true;
    }
    return false;
  };
  const offCanvas = (el) => {
    for (let p = el; p && p !== document.body; p = p.parentElement) {
      const t = getComputedStyle(p).transform;
      if (t && t !== 'none' && /matrix.*-\d{3,}/.test(t)) return true;
    }
    return false;
  };
  if (document.documentElement.scrollWidth > vw + 1) {
    issues.push({ kind: 'page-h-scroll', detail: `page scrollWidth ${document.documentElement.scrollWidth} > ${vw}` });
  }
  const seen = new Set();
  for (const el of document.querySelectorAll('body *')) {
    if (!visible(el) || decorative(el) || inScroller(el) || offCanvas(el)) continue;
    const r = el.getBoundingClientRect();
    let d = null, kind = null;
    if (r.left >= vw - 2) { kind = 'starts-off-screen'; d = `${describe(el)} x=${Math.round(r.left)}`; }
    else if (r.right > vw + 2 && r.left >= 0) { kind = 'cut-off-right'; d = `${describe(el)} right=${Math.round(r.right)} vw=${vw}`; }
    if (d && !seen.has(d)) { seen.add(d); issues.push({ kind, detail: d }); }
  }
  return { issues, vw };
}

const browser = await chromium.launch({ args: ['--no-sandbox', '--use-fake-ui-for-media-stream'] });
for (const dev of ['iPhone 12', 'Galaxy S9+']) {
  const ctx = await browser.newContext({ ...devices[dev] });
  await ctx.addInitScript(fakeMedia);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto(BASE + '/');
  await page.evaluate(({ t, u }) => {
    localStorage.setItem('ibconnect_jwt', t); localStorage.setItem('ibconnect_me', u);
  }, { t: TOKEN, u: USER });
  await page.reload();
  await page.waitForTimeout(2500);
  console.log(`\n════ ${dev} (${devices[dev].viewport.width}px) ════`);

  const audit = async (label, shot) => {
    await page.waitForTimeout(800);
    const r = await page.evaluate(probe);
    if (shot) await page.screenshot({ path: `${SHOT}/${dev.replace(/\W/g, '')}-${shot}.png` });
    console.log(`\n── ${label} ──`);
    if (!r.issues.length) console.log('   layout: clean');
    r.issues.slice(0, 6).forEach((i) => console.log(`   [${i.kind}] ${i.detail}`));
    if (r.issues.length > 6) console.log(`   … and ${r.issues.length - 6} more`);
  };
  const drawer = async () => { await page.click('.md\\:hidden.fixed.top-3.left-3').catch(() => {}); await page.waitForTimeout(600); };
  const nav = async (a) => { await drawer(); await page.click(`[aria-label="${a}"]`); await page.waitForTimeout(1400); };

  // Calls — both mobile panels
  await nav('Calls');
  await audit('Calls · Recent panel', '01-calls-recent');
  await page.click('button:has-text("Contacts")');
  await audit('Calls · Contacts panel', '02-calls-contacts');

  // Chats with a thread open
  try {
    await nav('Chats');
    const thread = page.locator('div.cursor-pointer').first();
    if (await thread.count()) { await thread.click(); await page.waitForTimeout(1200); }
    await audit('Chats · thread open', '03-chat-thread');
  } catch (e) { console.log('\n── Chats thread ── ' + e.message.split('\n')[0]); }

  // Settings modal (gear has no aria-label — click it by icon position in the rail)
  try {
    await drawer();
    await page.locator('nav button').filter({ has: page.locator('svg.lucide-settings') }).first().click();
    await page.waitForTimeout(1000);
    await audit('Settings modal', '04-settings');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(600);
  } catch (e) { console.log('\n── Settings modal ── ' + e.message.split('\n')[0]); }

  // In-call screen
  try {
    await nav('Meetings');
    await page.click('text=Start New Meeting');
    await page.waitForTimeout(5000);
    await page.keyboard.press('Escape');
    await audit('In-call screen', '05-in-call');
    await page.click('button[title="Chat"], button[aria-label="Chat"]').catch(() => {});
    await page.waitForTimeout(900);
    await audit('In-call · side panel open', '06-in-call-panel');
    await page.click('button:has-text("Leave")').catch(() => {});
    await page.waitForTimeout(1500);
  } catch (e) { console.log('\n── In-call ── ' + e.message.split('\n')[0]); }

  const real = errors.filter((e) => !/favicon|ResizeObserver loop|React DevTools/i.test(e));
  console.log(`\n   console errors: ${real.length ? real.slice(0, 4).join(' | ') : 'none'}`);
  await ctx.close();
}
console.log('\nScreenshots: ' + SHOT);
await browser.close();
