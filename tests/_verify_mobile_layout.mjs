// Mobile-viewport audit. Walks every view and overlay on emulated phones and
// reports layout defects: page-level horizontal scroll, elements clipped off the
// right edge with no scroll container, and undersized tap targets.
//
//   BASE=https://meet.icebrkr.space node _audit_mobile.mjs
import { chromium, devices } from 'playwright';
import crypto from 'crypto';
import { mkdirSync } from 'fs';

const BASE = process.env.BASE ?? 'https://meet.icebrkr.space';
const SHOT = process.env.SHOT_DIR ?? '/tmp/claude-1001/-home-ubuntu/2ddff6bf-4824-4ec1-922c-37faab8a5ab6/scratchpad/mobile';
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
  // Decorative overlays (the .accent-glow radial washes) are deliberately larger
  // than their clipping parent — not defects.
  const decorative = (el) => getComputedStyle(el).pointerEvents === 'none';
  // Anything living inside a horizontal scroller is reachable by swiping.
  const inScroller = (el) => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const ox = getComputedStyle(p).overflowX;
      if ((ox === 'auto' || ox === 'scroll') && p.scrollWidth > p.clientWidth) return true;
    }
    return false;
  };
  // Off-canvas drawers sit at translateX(-100%) until opened.
  const offCanvas = (el) => {
    for (let p = el; p && p !== document.body; p = p.parentElement) {
      const t = getComputedStyle(p).transform;
      if (t && t !== 'none' && /matrix.*-\d{3,}/.test(t)) return true;
    }
    return false;
  };

  if (document.documentElement.scrollWidth > vw + 1) {
    issues.push({ kind: 'page-h-scroll', detail: `page scrollWidth ${document.documentElement.scrollWidth} > viewport ${vw}` });
  }

  const seen = new Set();
  for (const el of document.querySelectorAll('body *')) {
    if (!visible(el) || decorative(el) || inScroller(el) || offCanvas(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.left >= vw - 2) {
      const d = `${describe(el)} starts at x=${Math.round(r.left)} (off-screen)`;
      if (!seen.has(d)) { seen.add(d); issues.push({ kind: 'starts-off-screen', detail: d }); }
    } else if (r.right > vw + 2 && r.left >= 0) {
      const d = `${describe(el)} right=${Math.round(r.right)} vw=${vw}`;
      if (!seen.has(d)) { seen.add(d); issues.push({ kind: 'cut-off-right', detail: d }); }
    }
  }

  const small = [];
  for (const el of document.querySelectorAll('button, a[href], [role=button]')) {
    if (!visible(el) || offCanvas(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 30 || r.height < 30) small.push(`${describe(el)} ${Math.round(r.width)}x${Math.round(r.height)}`);
  }
  return { issues, small, vw };
}

const results = [];
async function run(deviceName) {
  const device = devices[deviceName];
  const browser = await chromium.launch({ args: ['--no-sandbox', '--use-fake-ui-for-media-stream'] });
  const ctx = await browser.newContext({ ...device });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto(BASE + '/');
  await page.evaluate(({ t, u }) => {
    localStorage.setItem('ibconnect_jwt', t);
    localStorage.setItem('ibconnect_me', u);
  }, { t: TOKEN, u: USER });
  await page.reload();
  await page.waitForTimeout(2500);

  console.log(`\n════ ${deviceName} (${device.viewport.width}x${device.viewport.height}) ════`);

  const audit = async (label, shot) => {
    await page.waitForTimeout(800);
    const r = await page.evaluate(probe);
    if (shot) await page.screenshot({ path: `${SHOT}/${deviceName.replace(/\W/g, '')}-${shot}.png` });
    results.push({ device: deviceName, label, ...r });
    const bad = r.issues.filter((i) => i.kind !== 'small');
    console.log(`\n── ${label} ──`);
    if (!bad.length) console.log('   layout: clean');
    bad.slice(0, 8).forEach((i) => console.log(`   [${i.kind}] ${i.detail}`));
    if (bad.length > 8) console.log(`   … and ${bad.length - 8} more`);
    if (r.small.length) console.log(`   [tap<30px] ${r.small.length}: ${r.small.slice(0, 4).join(' | ')}`);
  };

  const openDrawer = async () => {
    await page.click('.md\\:hidden.fixed.top-3.left-3').catch(() => {});
    await page.waitForTimeout(600);
  };
  const nav = async (aria) => {
    await openDrawer();
    await page.click(`[aria-label="${aria}"]`);
    await page.waitForTimeout(1400);
  };

  await audit('Dashboard', '01-dashboard');
  await openDrawer();
  await audit('Sidebar drawer open', '02-drawer');
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(400);

  for (const [aria, shot] of [
    ['Chats', '03-chats'], ['Calls', '04-calls'], ['Meetings', '05-meetings'],
    ['Calendar', '06-calendar'], ['Security', '07-security'], ['Support', '08-support'],
  ]) {
    try { await nav(aria); await audit(aria, shot); }
    catch (e) { console.log(`\n── ${aria} ── navigation failed: ${e.message.split('\n')[0]}`); }
  }

  // Overlays
  try {
    await nav('Meetings');
    await page.click('text=Schedule');
    await audit('Schedule meeting modal', '09-schedule-modal');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
  } catch (e) { console.log('\n── Schedule modal ── ' + e.message.split('\n')[0]); }

  try {
    await openDrawer();
    await page.click('[aria-label="Settings"]');
    await audit('Settings modal', '10-settings');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
  } catch (e) { console.log('\n── Settings modal ── ' + e.message.split('\n')[0]); }

  try {
    await nav('Calendar');
    await page.click('button:has-text("New Event"), button:has-text("Add Event")');
    await audit('Calendar event modal', '11-calendar-modal');
    await page.keyboard.press('Escape');
  } catch (e) { console.log('\n── Calendar modal ── ' + e.message.split('\n')[0]); }

  const real = errors.filter((e) => !/favicon|ResizeObserver loop|React DevTools/i.test(e));
  console.log(`\n   console errors: ${real.length ? real.slice(0, 4).join(' | ') : 'none'}`);
  await browser.close();
}

for (const d of ['iPhone 12', 'Galaxy S9+']) await run(d);

console.log('\n════ SUMMARY ════');
for (const r of results) {
  const n = r.issues.length;
  if (n) console.log(`  ${r.device} / ${r.label}: ${n} layout issue(s), ${r.small.length} small tap target(s)`);
}
console.log('\nScreenshots: ' + SHOT);
