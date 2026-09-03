/**
 * Mobile-width companion to _verify_call_upgrades.mjs.
 *
 * Adding raise-hand and reactions pushed the control bar past the width of a phone —
 * at 390px the last two buttons landed outside the viewport, scrollable in principle
 * and unreachable in practice. The bar is now split desktop/mobile the way
 * suitenumerique/meet splits theirs, and this asserts the mobile half actually works:
 * nothing off-screen, tap targets intact, and every secondary action still reachable.
 *
 * A desktop context creates the room, because the sidebar that gets you to Meetings is
 * not reachable at phone widths; the phone contexts then join it by URL.
 */
import { chromium } from 'playwright';
import crypto from 'crypto';
const BASE = 'http://127.0.0.1:3101';
const S = process.env.IBCONNECT_JWT_SECRET;
const b64 = i => Buffer.from(i).toString('base64').replace(/=+$/,'').replace(/\+/g,'-').replace(/\//g,'_');
const sign = p => { const h=b64(JSON.stringify({alg:'HS256',typ:'JWT'})),y=b64(JSON.stringify(p));
  return `${h}.${y}.`+crypto.createHmac('sha256',S).update(`${h}.${y}`).digest('base64').replace(/=+$/,'').replace(/\+/g,'-').replace(/\//g,'_'); };
const U1 = { id:'user-815ce7061367244d', displayName:'UI Test User' };
const U2 = { id:'user-964ef540619374b1', displayName:'Second Tester' };

const stub = () => {
  navigator.mediaDevices.getUserMedia = async (c={}) => {
    const tr=[];
    if(c.video){const cv=document.createElement('canvas');cv.width=320;cv.height=240;const g=cv.getContext('2d');
      (function d(){g.fillStyle='#2a9d8f';g.fillRect(0,0,320,240);requestAnimationFrame(d);})();tr.push(cv.captureStream(10).getVideoTracks()[0]);}
    if(c.audio){const a=new AudioContext(),d=a.createMediaStreamDestination(),o=a.createOscillator();o.connect(d);o.start();tr.push(d.stream.getAudioTracks()[0]);}
    return new MediaStream(tr);
  };
};

const b = await chromium.launch({ args:['--no-sandbox','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream','--autoplay-policy=no-user-gesture-required'] });

async function ctx(user, vp, mobile) {
  const c = await b.newContext({ viewport: vp, permissions:['camera','microphone'], isMobile: mobile, hasTouch: mobile });
  await c.addInitScript(stub);
  const p = await c.newPage();
  await p.goto(BASE+'/');
  await p.evaluate(({t,u})=>{localStorage.setItem('ibconnect_jwt',t);localStorage.setItem('ibconnect_me',JSON.stringify(u));},
    {t:sign({userId:user.id,exp:Math.floor(Date.now()/1000)+21600}),u:user});
  await p.reload(); await p.waitForTimeout(2000);
  return { c, p };
}

// Desktop creates the room.
const host = await ctx(U1, {width:1280,height:900}, false);
await host.p.click('[aria-label="Meetings"]'); await host.p.waitForTimeout(1200);
await host.p.click('text=/Instant start/i'); await host.p.waitForTimeout(5000);
await host.p.keyboard.press('Escape');
const room = await host.p.evaluate(()=>location.pathname.replace('/',''));
console.log('room:', room);

let fails = 0;
const ok = (n, pass, d='') => { if(!pass) fails++; console.log(`  ${pass?'PASS':'FAIL'}  ${n}${d?` — ${d}`:''}`); };

for (const vp of [{width:390,height:844,name:'iPhone 12'},{width:360,height:740,name:'small Android'}]) {
  const m = await ctx(U2, {width:vp.width,height:vp.height}, true);
  await m.p.goto(`${BASE}/${room}`); await m.p.waitForTimeout(5000);
  await m.p.keyboard.press('Escape'); await m.p.waitForTimeout(800);

  console.log(`\n${vp.name} (${vp.width}px)`);

  const bar = await m.p.evaluate(() => {
    const el = document.querySelector('.overflow-x-auto.scrollbar-hide');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { w: Math.round(r.width), scrollW: el.scrollWidth, overflowing: el.scrollWidth > Math.ceil(r.width) + 1,
             pageSideScroll: document.documentElement.scrollWidth > window.innerWidth };
  });
  ok('control bar fits without horizontal scroll', bar && !bar.overflowing, JSON.stringify(bar));
  ok('page does not scroll sideways', bar && !bar.pageSideScroll);

  // Every visible control must be inside the viewport.
  const outside = await m.p.evaluate(() => {
    const bar = document.querySelector('.overflow-x-auto.scrollbar-hide');
    if (!bar) return ['no bar'];
    return [...bar.querySelectorAll('button')].filter(el => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return false;   // display:none, desktop-only
      return r.left < 0 || r.right > window.innerWidth;
    }).map(el => el.getAttribute('title') || el.textContent?.trim() || '?');
  });
  ok('no visible control sits outside the viewport', outside.length === 0, outside.join(', ') || 'none');

  // Tap targets: 36px is the documented mobile minimum in this codebase.
  const small = await m.p.evaluate(() => {
    const bar = document.querySelector('.overflow-x-auto.scrollbar-hide');
    return [...bar.querySelectorAll('button')].filter(el => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && (r.width < 36 || r.height < 36);
    }).map(el => `${el.getAttribute('title')||'?'}:${Math.round(el.getBoundingClientRect().width)}x${Math.round(el.getBoundingClientRect().height)}`);
  });
  ok('every tap target is at least 36px', small.length === 0, small.join(', ') || 'none');

  // The More sheet reaches the secondary actions.
  await m.p.click('[title="More options"]');
  await m.p.waitForTimeout(700);
  const sheetItems = await m.p.evaluate(() =>
    [...document.querySelectorAll('div.md\\:hidden button')].map(b => b.textContent?.trim()).filter(t => t && t.length < 30));
  ok('More sheet exposes the secondary actions', sheetItems.length >= 5, sheetItems.join(' | '));
  ok('reactions reachable on mobile', sheetItems.some(t => /reaction/i.test(t)), sheetItems.join(' | '));
  ok('raise hand reachable on mobile', sheetItems.some(t => /hand/i.test(t)));

  const sheetFits = await m.p.evaluate(() => {
    const el = [...document.querySelectorAll('div')].find(d => d.className.includes('md:hidden') && d.className.includes('bottom-20'));
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: Math.round(r.left), right: Math.round(r.right), vw: window.innerWidth, fits: r.left >= 0 && r.right <= window.innerWidth };
  });
  ok('More sheet fits on screen', sheetFits?.fits === true, JSON.stringify(sheetFits));

  // Actually send a reaction from the phone.
  const rxBtn = m.p.locator('div.md\\:hidden button:has-text("Send a reaction")').first();
  if (await rxBtn.isVisible().catch(()=>false)) {
    await rxBtn.click();
    await m.p.waitForTimeout(700);
    const pickerFits = await m.p.evaluate(() => {
      const el = document.querySelector('[aria-label="Send a reaction"]');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { fits: r.left >= 0 && r.right <= window.innerWidth, w: Math.round(r.width), vw: window.innerWidth };
    });
    ok('reaction picker opens and fits on a phone', pickerFits?.fits === true, JSON.stringify(pickerFits));
    await m.p.locator('[aria-label="React with 👍"]').click();
    await m.p.waitForTimeout(900);
    const seen = await host.p.locator('.ib-reaction-rise').count();
    ok('reaction sent from mobile reaches the desktop peer', seen > 0, `${seen} on screen`);
  } else {
    ok('reaction picker opens and fits on a phone', false, 'sheet item not found');
    ok('reaction sent from mobile reaches the desktop peer', false, 'sheet item not found');
  }
  await m.c.close();
}
await b.close();
console.log(fails ? `\n${fails} check(s) failed` : '\nall mobile checks passed');
process.exit(fails ? 1 : 0);
