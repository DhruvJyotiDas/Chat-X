/**
 * Drives the Virtual Interview end to end through the real UI, against the mock
 * GPU service (gpu/mock_server.py). Proves the whole product works before the
 * GPU machine exists.
 *
 * Requires: mock on :8099, backend with INTERVIEW_GPU_URL pointing at it, and a
 * dev server. Microphone and camera are stubbed the same way the call suites do
 * it, since getUserMedia does not work in this sandbox.
 *
 * BASE selects the target.
 */
import { chromium } from 'playwright';
import crypto from 'crypto';

const BASE = process.env.BASE ?? 'http://127.0.0.1:3100';
const SECRET = process.env.IBCONNECT_JWT_SECRET ?? 'ibconnect_jwt_secret_prod_2024_change_me';
const exp = Math.floor(Date.now() / 1000) + 3600 * 6;
const b64 = (i) => Buffer.from(i).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
function sign(p) {
  const h = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' })), y = b64(JSON.stringify(p));
  return `${h}.${y}.` + crypto.createHmac('sha256', SECRET).update(`${h}.${y}`)
    .digest('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}
const user = { id: 'user-815ce7061367244d', username: 'uitest1', displayName: 'UI Test User', email: 'uitest1@example.com' };

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const CV = `Dhruv Jyoti Das
Backend Engineer

dhruvjyoti100@example.com
Phone: +91 98765 43210
Bangalore, India

SUMMARY
Backend engineer building real-time systems in Go and TypeScript. Shipped a
WebRTC video platform used by several hundred students.

SKILLS
Go, TypeScript, React, PostgreSQL, Docker, Kubernetes, WebRTC, Redis

LINKS
https://github.com/torvalds
https://linkedin.com/in/example
`;

const browser = await chromium.launch({
  args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });

// Stub camera + mic: real getUserMedia does not work headless here.
await ctx.addInitScript(() => {
  navigator.mediaDevices.getUserMedia = async (c = {}) => {
    const tracks = [];
    if (c.video) {
      const cv = document.createElement('canvas'); cv.width = 320; cv.height = 240;
      const g = cv.getContext('2d');
      (function draw() { g.fillStyle = '#2a9d8f'; g.fillRect(0, 0, 320, 240); requestAnimationFrame(draw); })();
      tracks.push(cv.captureStream(10).getVideoTracks()[0]);
    }
    if (c.audio) {
      const a = new AudioContext(), d = a.createMediaStreamDestination(), o = a.createOscillator();
      const gain = a.createGain(); gain.gain.value = 0.3;
      o.frequency.value = 220; o.connect(gain).connect(d); o.start();
      tracks.push(d.stream.getAudioTracks()[0]);
    }
    return new MediaStream(tracks);
  };
  // Speech synthesis is absent in headless Chromium; stub it so the UI's call
  // does not throw.
  window.speechSynthesis = window.speechSynthesis || { speak() {}, cancel() {} };
});

const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });

await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
await page.evaluate(({ t, u }) => {
  localStorage.setItem('ibconnect_jwt', t);
  localStorage.setItem('ibconnect_me', JSON.stringify(u));
}, { t: sign({ userId: user.id, exp }), u: user });
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);

// ── 1. Navigation ────────────────────────────────────────────────────────────
console.log('\n── Entry point ──');
await page.click('[aria-label="Interview"]');
await page.waitForTimeout(1200);
check('sidebar has a Virtual Interview entry and it opens',
  await page.locator('text=/Start with your CV|Your profile|Set up an interview/i').first().isVisible().catch(() => false));

const engineReady = await page.evaluate(async () => {
  const r = await fetch('/api/interview/status', {
    headers: { Authorization: `Bearer ${localStorage.getItem('ibconnect_jwt')}` },
  });
  return r.json();
});
check('engine status reports the mock as ready', engineReady.ready === true, JSON.stringify(engineReady));

// ── 2. CV upload through the real file input ─────────────────────────────────
console.log('\n── CV upload and parsing ──');
await page.setInputFiles('input[type=file]', {
  name: 'dhruv-cv.txt', mimeType: 'text/plain', buffer: Buffer.from(CV),
});
await page.waitForTimeout(4000);   // parse + live GitHub enrichment

const setupVisible = await page.locator('text=/Generate questions/i').first().isVisible().catch(() => false);
check('upload advances to interview setup', setupVisible);

const prof = await page.evaluate(async () => {
  const r = await fetch('/api/interview/profile', {
    headers: { Authorization: `Bearer ${localStorage.getItem('ibconnect_jwt')}` },
  });
  return r.json();
});
check('CV parsed: name extracted', prof?.fullName === 'Dhruv Jyoti Das', prof?.fullName);
check('CV parsed: skills detected', (prof?.skills || []).length >= 6, (prof?.skills || []).join(', '));
check('CV parsed: GitHub and LinkedIn both found as links',
  (prof?.links || []).some((l) => l.platform === 'github') && (prof?.links || []).some((l) => l.platform === 'linkedin'),
  (prof?.links || []).map((l) => l.platform).join(', '));
check('GitHub enriched from the public API (LinkedIn deliberately not scraped)',
  !!prof?.github && !prof.github.unavailable && prof.github.publicRepos > 0,
  prof?.github ? `${prof.github.login}: ${prof.github.publicRepos} repos` : 'none');

// ── 3. Generate questions ────────────────────────────────────────────────────
console.log('\n── Question generation ──');
await page.fill('input[placeholder*="Backend Engineer" i]', 'Backend Engineer');
await page.click('button:has-text("Generate questions")');
await page.waitForTimeout(4000);

const onReady = await page.locator('button:has-text("Start interview")').isVisible().catch(() => false);
check('questions generated and device check shown', onReady);

// ── 4. Run the interview ─────────────────────────────────────────────────────
console.log('\n── Live interview ──');
await page.click('button:has-text("Start interview")');
await page.waitForTimeout(2500);

const qVisible = await page.locator('text=/Question 1 of/i').isVisible().catch(() => false);
check('interview starts and shows the first question', qVisible);

await page.click('button:has-text("Record answer")');
await page.waitForTimeout(3500);   // real audio captured into the WAV encoder
const recording = await page.locator('button:has-text("Stop and submit")').isVisible().catch(() => false);
check('recording state is active with a stop control', recording);

await page.click('button:has-text("Stop and submit")');
await page.waitForTimeout(6000);   // WAV encode + upload + transcribe + evaluate

const scored = await page.locator('text=/Answer scored/i').isVisible().catch(() => false);
check('answer was uploaded, transcribed and scored', scored);

const perQuestion = await page.evaluate(() => {
  const el = [...document.querySelectorAll('*')].find((n) => /wpm/.test(n.textContent || '') && n.children.length === 0);
  return el ? el.textContent : null;
});
check('per-answer delivery metrics are shown', !!perQuestion, perQuestion ?? 'none');

// ── 5. Finish and report ─────────────────────────────────────────────────────
console.log('\n── Report ──');
await page.click('button:has-text("Next question"), button:has-text("Finish and see report")');
await page.waitForTimeout(2000);
// End early to reach the report without answering every question.
const endEarly = page.locator('button:has-text("End early")');
if (await endEarly.isVisible().catch(() => false)) {
  await endEarly.click();
  await page.waitForTimeout(5000);
}

const reportVisible = await page.locator('text=/Practise again|Question by question/i').first().isVisible().catch(() => false);
check('report is produced and rendered', reportVisible);

const sessions = await page.evaluate(async () => {
  const r = await fetch('/api/interview/sessions', {
    headers: { Authorization: `Bearer ${localStorage.getItem('ibconnect_jwt')}` },
  });
  return r.json();
});
check('session persisted with a score', Array.isArray(sessions) && sessions.length > 0
  && typeof sessions[0].overallScore === 'number',
  sessions?.[0] ? `${sessions[0].role}: ${sessions[0].overallScore}` : 'none');

// ── 6. No media in the database ──────────────────────────────────────────────
const answersHaveNoMedia = await page.evaluate(async (sid) => {
  const r = await fetch(`/api/interview/sessions/${sid}`, {
    headers: { Authorization: `Bearer ${localStorage.getItem('ibconnect_jwt')}` },
  });
  const s = await r.json();
  const blob = JSON.stringify(s.answers || []);
  return { hasTranscript: /transcript/.test(blob) && (s.answers?.[0]?.transcript || '').length > 0,
           leaksAudio: /audioWav|framesB64|data:image|data:audio/.test(blob) };
}, sessions?.[0]?.id);
check('transcripts stored', answersHaveNoMedia.hasTranscript);
check('audio and frames are NOT persisted (by design)', !answersHaveNoMedia.leaksAudio);

check('no console or page errors', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
