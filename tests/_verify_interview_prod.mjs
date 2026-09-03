/**
 * Production check for the Virtual Interview feature with NO GPU connected.
 * The design promise is that everything not needing the model keeps working and
 * the UI says so plainly, rather than failing obscurely. This asserts that.
 */
import { chromium } from 'playwright';
import crypto from 'crypto';
const BASE = process.env.BASE ?? 'https://meet.icebrkr.space';
const SECRET = process.env.IBCONNECT_JWT_SECRET;
const exp = Math.floor(Date.now()/1000)+3600;
const b64=(i)=>Buffer.from(i).toString('base64').replace(/=+$/,'').replace(/\+/g,'-').replace(/\//g,'_');
const sign=(p)=>{const h=b64(JSON.stringify({alg:'HS256',typ:'JWT'})),y=b64(JSON.stringify(p));
 return `${h}.${y}.`+crypto.createHmac('sha256',SECRET).update(`${h}.${y}`).digest('base64').replace(/=+$/,'').replace(/\+/g,'-').replace(/\//g,'_');};
const user={id:'user-815ce7061367244d',username:'uitest1',displayName:'UI Test User',email:'uitest1@example.com'};
const R=[]; const check=(n,p,d='')=>{R.push(p);console.log(`  ${p?'PASS':'FAIL'}  ${n}${d?` — ${d}`:''}`);};

const br=await chromium.launch({args:['--no-sandbox']});
const ctx=await br.newContext({viewport:{width:1280,height:900}});
const page=await ctx.newPage();
const errs=[];
page.on('pageerror',e=>errs.push(e.message));
page.on('console',m=>{if(m.type()==='error'&&!/Failed to load resource/.test(m.text()))errs.push(m.text());});
await page.goto(`${BASE}/`,{waitUntil:'domcontentloaded'});
await page.evaluate(({t,u})=>{localStorage.setItem('ibconnect_jwt',t);localStorage.setItem('ibconnect_me',JSON.stringify(u));},{t:sign({userId:user.id,exp}),u:user});
await page.reload({waitUntil:'domcontentloaded'});
await page.waitForTimeout(2000);

check('Interview entry present in the sidebar',
  await page.locator('[aria-label="Interview"]').isVisible().catch(()=>false));
await page.click('[aria-label="Interview"]');
await page.waitForTimeout(1500);

const st = await page.evaluate(async()=>{const r=await fetch('/api/interview/status',{headers:{Authorization:`Bearer ${localStorage.getItem('ibconnect_jwt')}`}});return r.json();});
check('engine reports NOT configured (no GPU VM yet)', st.configured===false, JSON.stringify(st));
check('and explains why in plain language', !!st.detail && /GPU|not connected/i.test(st.detail), st.detail);

const bodyTxt = await page.evaluate(()=>document.body.innerText);
check('UI shows an honest banner rather than a broken screen',
  /not connected yet/i.test(bodyTxt), (bodyTxt.match(/[^\n]*not connected[^\n]*/i)||[''])[0].trim().slice(0,80));
check('CV upload is still offered', /Start with your CV|Choose a file/i.test(bodyTxt));

// CV pipeline must work with no GPU at all.
const CV = `Asha Menon\nFrontend Engineer\n\nasha@example.com\n\nSKILLS\nReact, TypeScript, CSS, Figma\n\nhttps://github.com/octocat\n`;
await page.setInputFiles('input[type=file]', {name:'cv.txt',mimeType:'text/plain',buffer:Buffer.from(CV)});
await page.waitForTimeout(5000);
const prof = await page.evaluate(async()=>{const r=await fetch('/api/interview/profile',{headers:{Authorization:`Bearer ${localStorage.getItem('ibconnect_jwt')}`}});return r.json();});
check('CV parses in production with no GPU', prof?.fullName==='Asha Menon', prof?.fullName);
check('skills extracted', (prof?.skills||[]).length>=3, (prof?.skills||[]).join(', '));
check('GitHub enriched live from the public API',
  !!prof?.github && !prof.github.unavailable, prof?.github?`${prof.github.login}: ${prof.github.publicRepos} repos`:'none');

check('no console or page errors', errs.length===0, errs.slice(0,2).join(' | '));
await br.close();
const f=R.filter(x=>!x).length;
console.log(`\n${R.length-f}/${R.length} checks passed`);
process.exit(f?1:0);
