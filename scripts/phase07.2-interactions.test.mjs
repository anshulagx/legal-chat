import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { setup, json } from './phase05-harness.mjs';
const { chromium } = await import(process.env.QA_PLAYWRIGHT_MODULE ?? 'playwright-core');
async function browserPage(t, app) {
 const browser = await chromium.launch({ executablePath: process.env.QA_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
 t.after(() => browser.close());
 const context = await browser.newContext(); const [name,value] = app.a.cookie.split('='); await context.addCookies([{name,value,url:app.base}]);
 return context.newPage();
}
test('older conversation list cannot overwrite the refresh after a new reply', {timeout:60000}, async t => {
 const app = await setup(t);
 let release; const gate = new Promise(resolve => release=resolve); t.after(()=>release()); let lists=0;
 const page = await browserPage(t,app);
 await page.route('**/conversations?limit=20', async route => {
   if (++lists===1) {await gate; await route.fulfill({status:200,contentType:'application/json',body:'{"items":[],"nextCursor":null}'});} else await route.continue();
 });
 await page.goto(app.base+'/app'); await page.getByLabel('Your question',{exact:true}).fill('Fresh list regression'); await page.getByRole('button',{name:'Send question',exact:true}).click();
 await page.getByRole('button',{name:'Fresh list regression',exact:true}).first().waitFor();
 const delivered=page.waitForResponse(response=>response.url().endsWith('/conversations?limit=20'));
 release(); await delivered; await page.waitForTimeout(100);
 assert.equal(await page.getByRole('button',{name:'Fresh list regression',exact:true}).count(),1);
});
test('old chat draft failure cannot appear in the new chat', {timeout:60000}, async t => {
 const app=await setup(t);
 await json(await app.call('/chat/send',{cookie:app.a.cookie,body:{message:'missing liability cap',clientMessageId:randomUUID()}}));
 let release; const gate=new Promise(resolve=>release=resolve);t.after(()=>release());
 const page=await browserPage(t,app);
 await page.route('**/email-draft',async route=>{await gate;await route.fulfill({status:503,contentType:'application/json',body:'{"message":"Old draft failed"}'});});
 await page.goto(app.base+'/app');await page.getByRole('button',{name:'missing liability cap',exact:true}).first().click();
 await page.getByRole('button',{name:'Draft an email to support',exact:true}).click();await page.getByRole('button',{name:'New chat',exact:true}).first().click();
 const delivered=page.waitForResponse(response=>response.url().endsWith('/email-draft'));release();await delivered;
 await page.waitForTimeout(100); assert.equal(await page.getByText('Old draft failed',{exact:true}).count(),0);
 assert.equal(await page.getByRole('heading',{name:'How can we help?',exact:true}).count(),1);
});
