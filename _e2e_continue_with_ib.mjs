import { chromium } from 'playwright';
import { execSync } from 'child_process';

const rand = Math.random().toString(36).slice(2, 10);
const email = `e2e_${rand}@example.com`;
const name = 'E2E Test User';
const password = 'Sup3rSecurePassw0rd!';

function getOTPFromLog(email, purpose) {
  const out = execSync(`sudo journalctl -u ib-account --no-pager -n 3000`, { encoding: 'utf8' });
  const lines = out.split('\n').filter(l => l.includes('mail[log-mode]') && l.includes(email));
  const relevant = purpose === 'verify_email'
    ? lines.filter(l => l.includes('verification code'))
    : lines;
  const last = relevant[relevant.length - 1];
  if (!last) throw new Error(`No OTP email found in log for ${email} (${purpose})`);
  const idx = out.lastIndexOf(last);
  const chunk = out.slice(idx, idx + 1200);
  const m = chunk.match(/code is:? (\d{6})/) || chunk.match(/\b(\d{6})\b/);
  if (!m) throw new Error(`Could not parse OTP from: ${chunk}`);
  return m[1];
}

const errors = [];
const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();
page.on('console', (msg) => { if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`); });
page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
page.on('requestfailed', (req) => errors.push(`requestfailed: ${req.url()} ${req.failure()?.errorText}`));

console.log('1. Visiting IB Connect root...');
await page.goto('https://meet.icebrkr.space/', { waitUntil: 'networkidle' });
await page.screenshot({ path: '/tmp/claude-1001/-home-ubuntu-IB-Connect-ver-2/7ab3622f-605b-4f9a-9a46-f79f406b6ccd/scratchpad/01-login.png' });

console.log('2. Clicking Continue with IB...');
await page.getByText('Continue with IB').click();
await page.waitForURL(/meet\.icebrkr\.space\/auth\/login/, { timeout: 15000 });
await page.screenshot({ path: '/tmp/claude-1001/-home-ubuntu-IB-Connect-ver-2/7ab3622f-605b-4f9a-9a46-f79f406b6ccd/scratchpad/02-ibaccount-login.png' });

console.log('3. Navigating to Create an IB Account...');
await page.getByText('Create an IB Account').click();
await page.waitForURL(/\/auth\/register/);

console.log('4. Filling registration form...');
await page.getByLabel('Full name').fill(name);
await page.getByLabel('Email').fill(email);
await page.getByLabel('Password', { exact: true }).fill(password);
await page.getByLabel('Confirm password').fill(password);
await page.getByRole('button', { name: 'Create account' }).click();

await page.waitForURL(/\/auth\/verify-email/, { timeout: 15000 });
console.log('5. Registered, now on verify-email screen. Fetching OTP from ib-account log...');
await page.waitForTimeout(1500);
const otp = getOTPFromLog(email, 'verify_email');
console.log('   OTP:', otp);
await page.getByLabel('Verification code').fill(otp);
await page.getByRole('button', { name: 'Verify' }).click();

console.log('6. Waiting for redirect back into IB Connect...');
await page.waitForURL('https://meet.icebrkr.space/', { timeout: 15000 });
await page.waitForLoadState('networkidle');
await page.waitForTimeout(1000);
await page.screenshot({ path: '/tmp/claude-1001/-home-ubuntu-IB-Connect-ver-2/7ab3622f-605b-4f9a-9a46-f79f406b6ccd/scratchpad/03-ibconnect-loggedin.png' });

const bodyText = await page.textContent('body');
const loggedIn = bodyText && !bodyText.includes('Continue with IB');
console.log('7. Logged into IB Connect:', loggedIn);

if (errors.length) {
  console.log('--- Console/page errors encountered ---');
  for (const e of errors) console.log(e);
} else {
  console.log('No console errors, page errors, or failed requests observed.');
}

await browser.close();
console.log(`CREDENTIALS: ${email} ${password}`);
console.log(loggedIn ? 'RESULT: PASS' : 'RESULT: FAIL');
process.exit(loggedIn ? 0 : 1);
