// One simulated participant: a genuinely separate Chromium process tree
// (chromium.launchServer(), not a context under a shared browser — this is
// what makes real, isolated OS-level CPU accounting possible at all), real
// fake-media-driven getUserMedia, real UI-driven join, real getStats().
import { chromium } from 'playwright';
import crypto from 'crypto';
import { installFakeMedia, installPCTracker, collectStats, collectPerStreamVideoStats } from './browser-hooks.mjs';
import { treeCpuSecondsNow } from './proc.mjs';

function b64url(input) { return Buffer.from(input).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_'); }
function signHS256(payload, secret) {
  const h = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${h}.${p}.${sig}`;
}

export class LoadTestClient {
  constructor({ index, base, jwtSecret }) {
    this.index = index;
    this.base = base;
    this.jwtSecret = jwtSecret;
    this.id = `user-lt-${index}-${crypto.randomBytes(3).toString('hex')}`;
    this.name = `Load Client ${index}`;
    this.errors = [];
  }

  async launch() {
    this.browserServer = await chromium.launchServer({
      args: [
        '--no-sandbox',
        '--use-fake-ui-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
        // Explicit, not incidental: confirms/enforces the software-encode
        // premise this whole report is captioned with, rather than leaving
        // it to whatever this Chromium build's default happens to be.
        '--disable-gpu',
        '--disable-software-rasterizer=false',
      ],
    });
    this.pid = this.browserServer.process().pid;
    this.browser = await chromium.connect(this.browserServer.wsEndpoint());
    this.context = await this.browser.newContext({
      viewport: { width: 960, height: 720 },
      permissions: ['camera', 'microphone'],
    });
    await this.context.addInitScript(installFakeMedia, this.index);
    await this.context.addInitScript(installPCTracker);
    this.page = await this.context.newPage();
    this.page.on('pageerror', (e) => this.errors.push(`pageerror: ${e.message}`));
    this.page.on('console', (m) => {
      if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) this.errors.push(`console: ${m.text()}`);
    });
  }

  async signIn() {
    const exp = Math.floor(Date.now() / 1000) + 3600 * 6;
    await this.page.goto(`${this.base}/`);
    await this.page.evaluate(({ token, u }) => {
      localStorage.setItem('ibconnect_jwt', token);
      localStorage.setItem('ibconnect_me', JSON.stringify(u));
    }, {
      token: signHS256({ userId: this.id, exp }, this.jwtSecret),
      u: { id: this.id, username: `lt${this.index}`, displayName: this.name, email: `lt${this.index}@example.com` },
    });
    await this.page.reload();
    await this.page.waitForTimeout(1000);
  }

  /** Real click-through, same path an actual user takes. */
  async createRoom() {
    await this.page.click('[aria-label="Meetings"]');
    await this.page.waitForSelector('text=Start New Meeting', { timeout: 15000 });
    await this.page.click('text=Start New Meeting');
    await this.page.waitForTimeout(3000);
    const code = await this.page.evaluate(() => window.location.pathname.replace('/', '') || null);
    await this.page.keyboard.press('Escape').catch(() => {});
    return code;
  }

  async joinRoom(code) {
    await this.page.click('[aria-label="Meetings"]');
    await this.page.waitForTimeout(500);
    await this.page.fill('input[placeholder="ENTER ROOM CODE…"]', code);
    await this.page.click('button:has-text("Join")');
  }

  /** Aggregated bandwidth/freeze/drop numbers across every PC this page has
   *  ever created and not yet closed — mode-agnostic (see browser-hooks.mjs). */
  async sampleStats() {
    return this.page.evaluate(collectStats);
  }

  /** Per-stream freeze/drop detail, for the rung-level watchability check. */
  async samplePerStreamVideoStats() {
    return this.page.evaluate(collectPerStreamVideoStats);
  }

  /** This client's own OS-level CPU-seconds consumed so far (whole process
   *  tree — browser + GPU + renderer + any utility processes), read fresh
   *  each call. Callers take a before/after delta over the measurement
   *  window; a single call in isolation is not a rate. */
  cpuSecondsNow() {
    return treeCpuSecondsNow(this.pid);
  }

  async close() {
    try { await this.context?.close(); } catch { /* already gone */ }
    try { await this.browser?.close(); } catch { /* already gone */ }
    try { await this.browserServer?.close(); } catch { /* already gone */ }
  }
}
