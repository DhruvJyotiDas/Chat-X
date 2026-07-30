import { chromium } from 'playwright';
import { readFileSync } from 'fs';

const signup = JSON.parse(readFileSync(new URL('./_signup.json', import.meta.url)));
const TOKEN = signup.token;
const USER = JSON.stringify(signup.user);
const SHOT_DIR = process.env.SHOT_DIR || '.';

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const errors = [];
page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
page.on('pageerror', err => errors.push('pageerror: ' + err.message));

await page.goto('http://localhost:3000/');
await page.evaluate(({ token, user }) => {
  localStorage.setItem('ibconnect_jwt', token);
  localStorage.setItem('ibconnect_me', user);
}, { token: TOKEN, user: USER });
await page.reload();

await page.waitForSelector('text=Home', { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(1500);
await page.screenshot({ path: `${SHOT_DIR}/01-dashboard.png`, fullPage: true });

// Chats
await page.click('text=Chats').catch(() => {});
await page.waitForTimeout(800);
await page.screenshot({ path: `${SHOT_DIR}/02-chats.png`, fullPage: true });

// Calendar
await page.click('text=Calendar').catch(() => {});
await page.waitForTimeout(800);
await page.screenshot({ path: `${SHOT_DIR}/03-calendar.png`, fullPage: true });

// Open new-event modal
await page.click('text=New Event').catch(() => {});
await page.waitForTimeout(500);
await page.screenshot({ path: `${SHOT_DIR}/04-calendar-new-event.png`, fullPage: true });
await page.keyboard.press('Escape').catch(() => {});

// Command palette
await page.keyboard.down('Control');
await page.keyboard.press('k');
await page.keyboard.up('Control');
await page.waitForTimeout(500);
await page.screenshot({ path: `${SHOT_DIR}/05-command-palette.png`, fullPage: true });
await page.keyboard.press('Escape').catch(() => {});

// Settings -> Preferences tab
await page.click('[title="Click to open settings"], [title="Settings"]').catch(() => {});
await page.waitForTimeout(300);
// fallback: click avatar area at bottom of sidebar
await page.evaluate(() => {
  const btn = Array.from(document.querySelectorAll('button, div')).find(el => el.textContent?.trim() === 'Settings');
});
await page.screenshot({ path: `${SHOT_DIR}/06-before-settings-click.png`, fullPage: true });

await browser.close();
console.log('CONSOLE_ERRORS:', JSON.stringify(errors, null, 2));
