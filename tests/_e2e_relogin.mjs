import { chromium } from 'playwright';

const email = process.argv[2];
const password = process.argv[3];

const errors = [];
const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();
page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
page.on('pageerror', (err) => errors.push(err.message));

console.log('1. Fresh context, visiting IB Connect root...');
await page.goto('https://meet.icebrkr.space/', { waitUntil: 'networkidle' });

console.log('2. Clicking Continue with IB...');
await page.getByText('Continue with IB').click();
await page.waitForURL(/\/auth\/login/, { timeout: 15000 });

console.log('3. Logging in with existing credentials...');
await page.getByLabel('Email').fill(email);
await page.getByLabel('Password').fill(password);
await page.getByRole('button', { name: 'Continue' }).click();

console.log('4. Waiting for redirect back into IB Connect...');
await page.waitForURL('https://meet.icebrkr.space/', { timeout: 15000 });
await page.waitForLoadState('networkidle');
await page.waitForTimeout(800);

const bodyText = await page.textContent('body');
const loggedIn = bodyText && !bodyText.includes('Continue with IB');
console.log('Logged in:', loggedIn);
console.log(errors.length ? 'Errors: ' + errors.join(' | ') : 'No console/page errors.');

await browser.close();
process.exit(loggedIn ? 0 : 1);
