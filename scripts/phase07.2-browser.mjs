// Deterministic independent UI QA. Run against a built isolated candidate.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setup, json } from './phase05-harness.mjs';
const { chromium } = await import(process.env.QA_PLAYWRIGHT_MODULE ?? 'playwright-core');
const axePath = process.env.QA_AXE_PATH;
if (!axePath) throw new Error('QA_AXE_PATH must identify axe-core/axe.min.js.');
const output = resolve(process.env.QA_OUTPUT_DIR ?? 'qa');
await mkdir(output, { recursive: true });
const cleanup = [];
const report = { timestamp: new Date().toISOString(), candidate: process.env.QA_CANDIDATE ?? 'working tree; see QA report manifest', checks: [], surfaces: [], viewports: [], limitations: [
  'Headless Chrome and deterministic fictional adapters do not establish hosted-provider behavior.',
  'Observed screen-reader walkthrough: BLOCKED; requires a real assistive technology operator.',
  'Native browser 200% zoom: BLOCKED; CSS zoom and device scaling are not substitutes.',
  'Mobile keyboard: viewport resize emulation only, not a real OS keyboard observation.',
] };
let browser;
async function check(name, fn) {
  try { const detail = await fn(); report.checks.push({ name, verdict: 'PASS', detail }); console.info(JSON.stringify({ check: name, verdict: 'PASS' })); }
  catch (error) { const message = error instanceof Error ? error.message : String(error); report.checks.push({ name, verdict: 'FAIL', error: message }); console.info(JSON.stringify({ check: name, verdict: 'FAIL', error: message })); }
}
async function authenticate(context, app, account) {
  const [name, value] = account.cookie.split('=');
  await context.addCookies([{ name, value, url: app.base, httpOnly: true, sameSite: 'Lax' }]);
}
async function inspect(page, surface) {
  for (const width of [320, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    if (surface === 'files') await page.locator('.chat-files > summary').scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve(output, `phase07.2-after-${surface}-${width}.png`) });
    const geometry = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth + 1,
      bodyOverflow: document.body.scrollWidth > innerWidth + 1,
      composer: (() => { const box = document.querySelector('.composer')?.getBoundingClientRect(); return box ? { top: box.top, bottom: box.bottom, height: innerHeight } : null; })() }));
    report.viewports.push({ surface, width, ...geometry });
    assert.equal(geometry.overflow, false, `${surface} horizontal overflow at ${width}`);
    await page.addScriptTag({ path: axePath });
    const scan = await page.evaluate(async () => {
      const result = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] } });
      return { violations: result.violations.map(item => ({ id: item.id, impact: item.impact, nodes: item.nodes.map(node => ({ target: node.target, summary: node.failureSummary })) })),
        incomplete: result.incomplete.map(item => ({ id: item.id, nodes: item.nodes.map(node => ({ target: node.target, summary: node.failureSummary })) })) };
    });
    const contrastInspection = await page.evaluate(() => [...document.querySelectorAll('.source-dialog mark, .source-dialog > p')].map(el => {
      const style = getComputedStyle(el); let parent = el; let background;
      while (parent) { const color = getComputedStyle(parent).backgroundColor; if (color !== 'rgba(0, 0, 0, 0)' && color !== 'transparent') { background = color; break; } parent = parent.parentElement; }
      return { tag: el.tagName, foreground: style.color, background: background ?? 'rgb(255, 255, 255)', text: el.textContent?.slice(0, 80) };
    }));
    report.surfaces.push({ surface, width, ...scan, contrastInspection });
    assert.equal(scan.violations.length, 0, `${surface} axe violations at ${width}: ${JSON.stringify(scan.violations)}`);
  }
}
async function ask(page, question) {
  await page.getByLabel('Your question', { exact: true }).fill(question);
  await page.getByRole('button', { name: 'Send question', exact: true }).click();
  await page.getByText('Reply completed.', { exact: true }).waitFor();
}
async function openChat(page, title) {
  const button = page.getByRole('button', { name: title, exact: true });
  if (page.viewportSize().width < 768) await page.getByRole('button', { name: /^(History|Previous chats)$/ }).click();
  await page.getByRole('button', { name: title, exact: true }).last().click();
}
try {
  const app = await setup({ after: fn => cleanup.push(fn) });
  browser = await chromium.launch({ executablePath: process.env.QA_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ bypassCSP: true, viewport: { width: 1280, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  await check('Signup and login reflow, axe and keyboard order', async () => {
    await page.goto(app.base + '/signup'); await page.getByRole('heading', { name: 'Create your account', exact: true }).waitFor(); await inspect(page, 'signup');
    await page.getByLabel('Email address').focus(); await page.keyboard.press('Tab');
    assert.equal(await page.getByLabel('Password').evaluate(el => el === document.activeElement), true);
    await page.goto(app.base + '/login'); await page.getByRole('heading', { name: 'Log in', exact: true }).waitFor(); await inspect(page, 'login');
  });
  await authenticate(context, app, app.a);
  const policy = await app.seed('Fictional support policy: the notice period is 30 days.', { scope: 'shared', filename: 'fictional-policy.txt' });
  const { ObjectId } = await import('mongodb');
  await app.db.collection('documents').updateOne({ _id: new ObjectId(policy.documentId) }, { $set: { fixtureId: 'notice-policy' } });
  await page.goto(app.base + '/app'); await page.getByLabel('Your question', { exact: true }).waitFor();
  await check('Fresh chat reflow and persistent composer', async () => {
    await inspect(page, 'fresh');
    assert.equal(await page.getByRole('button', { name: /^(Shared documents|Manage shared documents)$/ }).count(), 0);
  });
  await check('Grounded answer and exact source with Escape focus return', async () => {
    await page.getByRole('button', { name: 'What is the notice period?', exact: true }).click();
    await page.getByText('Reply completed.', { exact: true }).waitFor();
    const anchor = page.getByRole('button', { name: 'View source: fictional-policy.txt', exact: true }).first();
    await anchor.focus(); await page.keyboard.press('Escape'); assert.equal(await page.getByRole('tooltip').count(), 0);
    await page.keyboard.press('Enter'); await page.getByRole('dialog').waitFor(); await page.getByRole('heading', { name: 'Exact cited passage' }).waitFor();
    assert.equal(await page.locator('.source-dialog blockquote').innerText(), policy.text);
    await inspect(page, 'source');
    await page.keyboard.press('Escape'); await page.getByRole('dialog').waitFor({ state: 'detached' });
    assert.equal(await anchor.evaluate(el => el === document.activeElement), true);
  });
  await check('Closing a delayed source prevents stale dialog resurrection', async () => {
    let release; const gate = new Promise(resolve => { release = resolve; });
    const pattern = '**/sources/*/passages/*';
    await page.route(pattern, async route => { await gate; await route.continue().catch(() => undefined); });
    try {
      await page.getByRole('button', { name: 'View source: fictional-policy.txt', exact: true }).first().click();
      await page.getByText('Opening source…', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Close source', exact: true }).click();
      release(); await page.getByRole('dialog').waitFor({ state: 'detached' });
      assert.equal(await page.getByRole('heading', { name: 'Exact cited passage' }).count(), 0);
    } finally { release(); await page.unroute(pattern); }
  });
  await check('Absent evidence opt-in support draft and clipboard', async () => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await ask(page, 'What is the missing liability cap?');
    await page.getByRole('button', { name: 'Draft an email to support', exact: true }).click();
    const draft = page.getByLabel('Email draft text', { exact: true }); await draft.waitFor();
    assert.match(await draft.inputValue(), /liability cap/);
    await page.getByRole('button', { name: 'Copy draft', exact: true }).click();
    await page.getByText(/Draft copied/).waitFor();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    assert.ok(copied.startsWith('Subject: ')); assert.ok(copied.endsWith(await draft.inputValue()));
  });
  const comparisonId = await app.conversation();
  const left = await app.seed('Notice is 30 days. Export window is seven days.', { conversationId: comparisonId, filename: 'fictional-original-agreement-with-a-deliberately-long-filename.txt' });
  const right = await app.seed('Notice is 60 days.', { conversationId: comparisonId, filename: 'fictional-amendment.txt' });
  await json(await app.call('/chat/send', { cookie: app.a.cookie, body: { conversationId: comparisonId, clientMessageId: randomUUID(), message: 'Compare these agreements', selectedDocumentVersionIds: [left.versionId, right.versionId] } }));
  await page.reload();
  await check('Reopened comparison identities, missing side and scope at all widths', async () => {
    await openChat(page, 'Compare these agreements');
    await page.getByRole('heading', { name: 'Agreement comparison', exact: true }).waitFor();
    const sides = await page.locator('.comparison-side h4').allTextContents();
    assert.ok(sides.some(text => text.includes('fictional-original-agreement')));
    assert.ok(sides.some(text => text.includes('fictional-amendment')));
    assert.ok(await page.getByText('No matching evidence in this version.', { exact: true }).count());
    await inspect(page, 'comparison');
  });
  await check('File readiness, explicit document order and swap', async () => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.locator('.chat-files > summary').click();
    await page.getByLabel(/^First document/).selectOption(left.versionId);
    await page.getByLabel(/^Second document/).selectOption(right.versionId);
    await page.getByRole('button', { name: 'Swap order', exact: true }).click();
    assert.equal(await page.getByLabel(/^First document/).inputValue(), right.versionId);
    assert.equal(await page.getByLabel(/^Second document/).inputValue(), left.versionId);
    await inspect(page, 'files');
    await page.getByRole('button', { name: 'Swap order', exact: true }).click();
    await page.locator('.chat-files > summary').click();
  });
  await check('Mobile history native modal Escape and focus return', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    const trigger = page.getByRole('button', { name: /^(History|Previous chats)$/ });
    await trigger.focus(); await trigger.click();
    const drawer = page.getByRole('dialog'); await drawer.waitFor();
    await page.screenshot({ path: resolve(output, 'phase07.2-after-history-390.png') });
    const focusSequence = [];
    try {
      for (let i = 0; i < 12; i++) {
        await page.keyboard.press('Tab');
        const focus = await drawer.evaluate(el => ({ contained: el.contains(document.activeElement), body: document.activeElement === document.body, name: document.activeElement?.textContent?.slice(0, 100), tag: document.activeElement?.tagName }));
        focusSequence.push(focus);
        assert.ok(focus.contained || focus.body, 'Tab reached an interactive background control');
      }
    } finally { await page.keyboard.press('Escape'); }
    await drawer.waitFor({ state: 'hidden' });
    assert.equal(await trigger.evaluate(el => el === document.activeElement), true);
    return { focusSequence, note: 'Native modal may focus document body between Tab cycles; no background control received focus.' };
  });
  await check('Emulated small keyboard viewport keeps question controls reachable', async () => {
    await page.setViewportSize({ width: 390, height: 420 });
    try {
      await page.getByLabel('Your question', { exact: true }).focus();
      await page.getByRole('button', { name: 'Send question', exact: true }).focus();
      const box = await page.getByRole('button', { name: 'Send question', exact: true }).boundingBox();
      assert.ok(box && box.y >= 0 && box.y + box.height <= 420, `Send geometry ${JSON.stringify(box)}`);
      await page.screenshot({ path: resolve(output, 'phase07.2-after-keyboard-emulated.png') });
    } finally { await page.setViewportSize({ width: 1280, height: 900 }); }
  });
  await check('Customer isolation and admin denial', async () => {
    assert.equal((await app.call(`/chat/history?conversationId=${comparisonId}`, { cookie: app.b.cookie })).status, 404);
    assert.equal((await app.call(`/sources/${left.versionId}/passages/${left.passageId}`, { cookie: app.b.cookie })).status, 404);
    assert.equal((await app.call('/admin/documents', { cookie: app.a.cookie })).status, 403);
  });
  await authenticate(context, app, app.admin); await page.reload();
  await check('Dedicated admin destination and reflow', async () => {
    const adminSource = await app.seed('Fictional admin reading policy. '.repeat(100), { scope: 'shared', filename: 'fictional-admin-reading-policy.txt' });
    await json(await app.call('/chat/send', { cookie: app.admin.cookie, body: { clientMessageId: randomUUID(), message: 'Admin reading position fixture', selectedDocumentVersionIds: [adminSource.versionId] } }));
    await page.reload(); await openChat(page, 'Admin reading position fixture');
    await page.locator('.answer-paragraph').first().waitFor();
    await page.locator('.chat-transcript').evaluate(el => { el.scrollTop = 0; el.dispatchEvent(new Event('scroll')); });
    const readingPosition = await page.locator('.chat-transcript').evaluate(el => el.scrollTop);
    const unsent = 'Preserve my unsent admin support question';
    await page.getByLabel('Your question', { exact: true }).fill(unsent);
    await page.getByRole('button', { name: 'Shared documents', exact: true }).click();
    await page.getByRole('heading', { name: 'Shared documents', exact: true, level: 1 }).waitFor();
    assert.equal(await page.getByLabel('Your question', { exact: true }).isVisible(), false);
    await inspect(page, 'admin');
    await page.getByRole('button', { name: /Back to chat|Return to chat/ }).click();
    await page.getByLabel('Your question', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('Your question', { exact: true }).inputValue(), unsent);
    assert.ok(Math.abs(await page.locator('.chat-transcript').evaluate(el => el.scrollTop) - readingPosition) <= 2, 'Admin navigation lost paused reading position');
  });
  await check('Policy replacement and archive retain historical source identity', async () => {
    const replacement = await app.seed('Fictional replacement policy: notice is 60 days.', { scope: 'shared', filename: 'fictional-policy-revision-two.txt', documentId: policy.documentId, revision: 2 });
    const historical = await json(await app.call(`/sources/${policy.versionId}/passages/${policy.passageId}`, { cookie: app.a.cookie }));
    assert.equal(historical.label, 'Superseded'); assert.equal(historical.quote, policy.text);
    assert.equal((await fetch(`${app.base}/admin/documents/${replacement.documentId}`, { method: 'DELETE', headers: { Cookie: app.admin.cookie, Origin: app.base } })).status, 204);
    const archived = await json(await app.call(`/sources/${policy.versionId}/passages/${policy.passageId}`, { cookie: app.a.cookie }));
    assert.equal(archived.label, 'Archived'); assert.equal(archived.quote, policy.text);
    return 'Fixture-seeded replacement publication; real archive endpoint; historical exact-source reads.';
  });
  await check('Logout clears private workspace', async () => {
    await page.getByRole('button', { name: 'Log out', exact: true }).click();
    await page.getByRole('heading', { name: 'Log in', exact: true }).waitFor();
    assert.equal(await page.locator('.message-list').count(), 0);
  });
  await check('Session expiry clears mounted private views', async () => {
    await authenticate(context, app, app.b); await page.goto(app.base + '/app');
    await page.getByLabel('Your question', { exact: true }).waitFor();
    await app.db.collection('sessions').updateMany({ userId: new ObjectId(app.b.id) }, { $set: { revokedAt: new Date() } });
    await page.getByLabel('Your question', { exact: true }).fill('Question after session expiry');
    await page.getByRole('button', { name: 'Send question', exact: true }).click();
    await page.getByRole('heading', { name: 'Log in', exact: true }).waitFor();
    assert.equal(await page.locator('.message-list').count(), 0);
  });
  await context.close();
  const long = await setup({ after: fn => cleanup.push(fn) }, { fixture: './phase07.2-browser-fixture.mjs' });
  await long.seed('Fictional policy: notice is thirty days and support can identify the applicable agreement revision. ', { scope: 'shared', filename: 'fictional-stream-policy.txt' });
  const lc = await browser.newContext({ viewport: { width: 1280, height: 900 } }); await authenticate(lc, long, long.a);
  const lp = await lc.newPage(); lp.setDefaultTimeout(12000); await lp.goto(long.base + '/app');
  await check('Long incremental stream follows bottom, preserves paused reading and returns to latest', async () => {
    await lp.getByLabel('Your question', { exact: true }).fill('LONG_STREAM');
    await lp.getByRole('button', { name: 'Send question', exact: true }).click();
    await lp.waitForFunction(() => document.querySelectorAll('.answer-paragraph').length >= 3);
    const transcript = lp.locator('.chat-transcript');
    const following = await transcript.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight);
    assert.ok(following <= 100, `Following distance ${following}`);
    await transcript.evaluate(el => { el.scrollTop = 0; el.dispatchEvent(new Event('scroll')); });
    const startCount = await lp.locator('.answer-paragraph').count();
    const before = await transcript.evaluate(el => el.scrollTop);
    await lp.waitForFunction(count => document.querySelectorAll('.answer-paragraph').length >= count + 2, startCount);
    assert.ok(Math.abs(await transcript.evaluate(el => el.scrollTop) - before) <= 2, 'Streaming moved a paused reader');
    await lp.getByRole('button', { name: 'Latest answer', exact: true }).click();
    await lp.getByText('Reply completed.', { exact: true }).waitFor();
    assert.ok(await transcript.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight) <= 100);
    for (const width of [320, 390, 768, 1280]) {
      await lp.setViewportSize({ width, height: 900 });
      const box = await lp.getByRole('button', { name: 'Send question', exact: true }).boundingBox();
      assert.ok(box && box.y >= 0 && box.y + box.height <= 900, `Composer inaccessible at ${width}`);
      await lp.screenshot({ path: resolve(output, `phase07.2-after-long-${width}.png`) });
    }
  });
  await lc.close();
  const recovery = await setup({ after: fn => cleanup.push(fn) }, { fixture: './phase07-fixture.mjs' });
  const rc = await browser.newContext({ viewport: { width: 390, height: 844 } }); await authenticate(rc, recovery, recovery.a);
  const rp = await rc.newPage(); rp.setDefaultTimeout(10000); await rp.goto(recovery.base + '/app');
  await check('Partial failure retry, cancellation and recovery', async () => {
    await rp.getByLabel('Your question', { exact: true }).fill('FAIL_PARTIAL'); await rp.getByRole('button', { name: 'Send question', exact: true }).click();
    await rp.getByRole('button', { name: 'Retry reply', exact: true }).click(); await rp.getByText('Reply completed.', { exact: true }).waitFor();
    assert.equal(await rp.locator('.message-user').count(), 1); assert.equal(await rp.locator('.message-assistant').count(), 2);
    await rp.getByLabel('Your question', { exact: true }).fill('WAIT'); await rp.getByRole('button', { name: 'Send question', exact: true }).click();
    await rp.getByRole('button', { name: 'Stop reply', exact: true }).click(); await rp.getByRole('button', { name: 'Retry reply', exact: true }).waitFor();
  });
  await rc.close();
  const quota = await setup({ after: fn => cleanup.push(fn) }, { fixture: './phase07-fixture.mjs', env: { CHAT_GENERATION_LIMIT: '1', CHAT_GENERATION_WINDOW_SECONDS: '3' } });
  const qc = await browser.newContext({ viewport: { width: 390, height: 844 } }); await authenticate(qc, quota, quota.a);
  const qp = await qc.newPage(); qp.setDefaultTimeout(10000); await qp.goto(quota.base + '/app');
  await check('429 cooldown preserves question and delays explicit retry', async () => {
    await ask(qp, 'First quota question');
    await qp.getByLabel('Your question', { exact: true }).fill('Preserve this throttled question');
    await qp.getByRole('button', { name: 'Send question', exact: true }).click();
    const delayed = qp.getByRole('button', { name: /Retry available in/ }); await delayed.waitFor();
    assert.equal(await delayed.isDisabled(), true);
    assert.equal(await qp.getByText('Preserve this throttled question', { exact: true }).count(), 1);
    await qp.getByRole('button', { name: 'Retry sending', exact: true }).click();
    await qp.getByText('Reply completed.', { exact: true }).waitFor();
    assert.equal(await qp.locator('.message-user').count(), 2);
  });
  await qc.close();
  const matched = await setup({ after: fn => cleanup.push(fn) });
  const mc = await browser.newContext({ viewport: { width: 1280, height: 900 } }); await authenticate(mc, matched, matched.a);
  const mp = await mc.newPage(); mp.setDefaultTimeout(10000);
  await check('Identical baseline long-answer fixture and viewport captures', async () => {
    const text='Fictional agreement notice is 30 days. '+Array.from({length:10},(_,i)=>`Clause ${i+1}: A fictional customer may request a review of the applicable terms through the support team. This fixture contains no real customer information.`).join('\n\n');
    await matched.seed(text, { scope: 'shared', filename: 'fictional-long-policy.txt' });
    await mp.goto(matched.base + '/app'); await ask(mp, 'What notice applies?');
    for (const [width, height, label] of [[1280, 900, 'desktop'], [390, 844, 'mobile']]) {
      await mp.setViewportSize({ width, height });
      await mp.locator('.chat-transcript').evaluate(el => { el.scrollTop = 0; el.dispatchEvent(new Event('scroll')); });
      await mp.screenshot({ path: resolve(output, `phase07.2-after-match-long-${label}.png`) });
    }
    return 'Matches /private/tmp/legal-chat-phase072-ui-review.mjs: ten-clause text, filename, question, 1280x900 and390x844. Reader positioned at top.';
  });
  await mc.close();
} finally {
  await writeFile(resolve(output, 'phase07.2-browser.json'), JSON.stringify(report, null, 2) + '\n');
  await browser?.close(); for (const fn of cleanup.reverse()) await fn();
}
if (report.checks.some(item => item.verdict === 'FAIL')) process.exitCode = 1;
