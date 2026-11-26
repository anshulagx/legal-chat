// Optional browser QA tooling can be installed in an isolated /tmp prefix.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { setup } from './phase05-harness.mjs';
const { chromium } = await import(process.env.QA_PLAYWRIGHT_MODULE ?? 'playwright-core');
const axePath = process.env.QA_AXE_PATH;
if (!axePath) throw new Error('Set QA_AXE_PATH to axe-core/axe.min.js.');
const cleanup = [];
const app = await setup({ after: fn => cleanup.push(fn) });
let browser;
const report = { timestamp: new Date().toISOString(), scanner: 'axe-core WCAG 2 A/AA, 2.1 AA, 2.2 AA', surfaces: [], keyboard: [], reflow: [], screenReader: 'BLOCKED: requires an observed operator walkthrough' };
try {
  browser = await chromium.launch({ executablePath: process.env.QA_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ bypassCSP: true, viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  async function scan(surface) {
    await page.addScriptTag({ path: axePath });
    const result = await page.evaluate(async () => {
      const scan = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] } });
      return { violations: scan.violations.map(item => ({ id: item.id, impact: item.impact, nodes: item.nodes.map(node => node.target) })), incomplete: scan.incomplete.map(item => ({ id: item.id, nodes: item.nodes.map(node => ({ target: node.target, summary: node.failureSummary })) })) };
    });
    report.surfaces.push({ surface, ...result });
    await page.setViewportSize({ width: 320, height: 900 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    const overflowNodes = await page.evaluate(() => [...document.querySelectorAll('body *')].filter(el => el.getBoundingClientRect().right > innerWidth + 1).map(el => ({ tag: el.tagName, className: el.className, width: el.getBoundingClientRect().width, right: el.getBoundingClientRect().right })).slice(0, 20));
    report.reflow.push({ surface, width: 320, overflow, overflowNodes });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.evaluate(() => { document.body.style.zoom = '200%'; });
    const zoomOverflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    report.reflow.push({ surface, zoomPercent: 200, overflow: zoomOverflow });
    await page.evaluate(() => { document.body.style.zoom = ''; });
  }
  await page.goto(app.base + '/signup'); await page.getByRole('heading', { name: 'Create your account' }).waitFor(); await scan('signup');
  await page.getByLabel('Email address').focus(); await page.keyboard.press('Tab'); assert.equal(await page.getByLabel('Password').evaluate(element => element === document.activeElement), true);
  report.keyboard.push('Signup email → password follows Tab order.');
  await page.goto(app.base + '/login'); await page.getByRole('heading', { name: 'Log in' }).waitFor(); await scan('login');
  const [cookieName, cookieValue] = app.a.cookie.split('='); await context.addCookies([{ name: cookieName, value: cookieValue, url: app.base, httpOnly: true, sameSite: 'Lax' }]);
  await app.seed('Fictional policy: notice requires 30 days.', { scope: 'shared', filename: 'fictional-policy.txt' });
  await page.goto(app.base + '/app'); await page.getByLabel('Your question', { exact: true }).waitFor();
  await page.getByLabel('Your question', { exact: true }).fill('What notice applies?'); await page.getByRole('button', { name: 'Send question', exact: true }).click();
  const anchor = page.getByRole('button', { name: 'View source: fictional-policy.txt', exact: true }).first(); await anchor.waitFor();
  await page.getByText('Reply completed.', { exact: true }).waitFor();
  await scan('chat');
  await anchor.focus(); await page.keyboard.press('Escape'); assert.equal(await page.getByRole('tooltip').count(), 0);
  await page.keyboard.press('Enter'); await page.getByRole('dialog').waitFor(); await page.getByRole('heading', { name: 'Exact cited passage' }).waitFor(); await page.screenshot({ path: new URL('../qa/phase07-source.png', import.meta.url).pathname }); await scan('source viewer');
  await page.keyboard.press('Escape'); await page.getByRole('dialog').waitFor({ state: 'detached' });
  assert.equal(await anchor.evaluate(element => element === document.activeElement), true); report.keyboard.push('Citation Enter opens source; Escape closes and returns focus; tooltip Escape dismisses.');
  const [adminName, adminValue] = app.admin.cookie.split('='); await context.addCookies([{ name: adminName, value: adminValue, url: app.base, httpOnly: true, sameSite: 'Lax' }]);
  await page.reload(); await page.getByText('Manage shared documents', { exact: true }).click(); await page.getByRole('heading', { name: 'Shared documents' }).waitFor(); await scan('admin');
  await context.close();

  const recovery = await setup({ after: fn => cleanup.push(fn) }, { fixture: './phase07-fixture.mjs' });
  const recoveryContext = await browser.newContext({ viewport: { width: 320, height: 900 } });
  const [name, value] = recovery.a.cookie.split('='); await recoveryContext.addCookies([{ name, value, url: recovery.base, httpOnly: true, sameSite: 'Lax' }]);
  const chat = await recoveryContext.newPage(); await chat.goto(recovery.base + '/app');
  await chat.getByLabel('Your question', { exact: true }).fill('FAIL_PARTIAL'); await chat.getByRole('button', { name: 'Send question', exact: true }).click();
  await chat.getByRole('button', { name: 'Retry reply', exact: true }).waitFor();
  await chat.getByRole('button', { name: 'Retry reply', exact: true }).click();
  await chat.getByText('Reply completed.', { exact: true }).waitFor();
  assert.equal(await chat.getByRole('button', { name: 'Retry reply', exact: true }).count(), 0);
  assert.equal(await chat.locator('.message-user').count(), 1); assert.equal(await chat.locator('.message-assistant').count(), 2);
  report.keyboard.push('Partial failure → explicit retry keeps one question and distinct failed/completed replies; obsolete retry control disappears.');
  await chat.getByLabel('Your question', { exact: true }).fill('WAIT'); await chat.getByRole('button', { name: 'Send question', exact: true }).click();
  await chat.getByRole('button', { name: 'Stop reply', exact: true }).click(); await chat.getByRole('button', { name: 'Retry reply', exact: true }).waitFor();
  report.keyboard.push('Stop reply produces an interrupted attempt and offers retry.');
  await recoveryContext.close();
  const quota = await setup({ after: fn => cleanup.push(fn) }, { fixture: './phase07-fixture.mjs', env: { CHAT_GENERATION_LIMIT: '1', CHAT_GENERATION_WINDOW_SECONDS: '3' } });
  const quotaContext = await browser.newContext();
  const [quotaName, quotaValue] = quota.a.cookie.split('='); await quotaContext.addCookies([{ name: quotaName, value: quotaValue, url: quota.base, httpOnly: true, sameSite: 'Lax' }]);
  const limited = await quotaContext.newPage(); await limited.goto(quota.base + '/app');
  await limited.getByLabel('Your question', { exact: true }).fill('First quota question'); await limited.getByRole('button', { name: 'Send question', exact: true }).click();
  await limited.getByText('Reply completed.', { exact: true }).waitFor();
  await limited.getByLabel('Your question', { exact: true }).fill('Preserve this throttled question'); await limited.getByRole('button', { name: 'Send question', exact: true }).click();
  const delayed = limited.getByRole('button', { name: /Retry available in/ }); await delayed.waitFor(); assert.equal(await delayed.isDisabled(), true);
  assert.equal(await limited.getByText('Preserve this throttled question', { exact: true }).count(), 1);
  await limited.getByRole('button', { name: 'Retry sending', exact: true }).click();
  await limited.getByText('Reply completed.', { exact: true }).waitFor(); assert.equal(await limited.locator('.message-user').count(), 2);
  report.keyboard.push('429 in an existing conversation keeps the optimistic question and disables retry until the matching countdown expires.');
  await quotaContext.close();
  const violations = report.surfaces.flatMap(item => item.violations);
  assert.equal(violations.length, 0, JSON.stringify(violations)); assert.ok(report.reflow.every(item => !item.overflow));
} finally {
  await writeFile(new URL('../qa/phase07-browser.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
  await browser?.close(); for (const fn of cleanup.reverse()) await fn();
}
