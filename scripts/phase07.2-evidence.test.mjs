// Optional Playwright tooling and isolated MongoDB setup are documented in README.md.
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { setup, json } from './phase05-harness.mjs';
const { chromium } = await import(process.env.QA_PLAYWRIGHT_MODULE ?? 'playwright-core');

async function pageFor(t, app) {
  const browser = await chromium.launch({ executablePath: process.env.QA_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext();
  const [name, value] = app.a.cookie.split('=');
  await context.addCookies([{ name, value, url: app.base }]);
  return context.newPage();
}

test('reopened comparison identifies missing sides by pinned version rather than row citations or list order', { timeout: 30000 }, async t => {
  const app = await setup(t);
  const conversationId = await app.conversation();
  const original = await app.seed('Notice is 30 days.', { conversationId, filename: 'original-agreement.txt', revision: 2 });
  const amendment = await app.seed('Notice is 60 days.', { conversationId, filename: 'amendment.txt', revision: 4 });
  await json(await app.call('/chat/send', { cookie: app.a.cookie, body: {
    message: 'Compare pinned agreements', clientMessageId: randomUUID(), conversationId,
    selectedDocumentVersionIds: [amendment.versionId, original.versionId],
  } }));
  const page = await pageFor(t, app);
  await page.goto(app.base + '/app');
  await page.getByRole('button', { name: 'Compare pinned agreements', exact: true }).click();
  const rows = page.locator('.comparison-row');
  await rows.first().getByRole('heading', { name: 'amendment.txt · Revision 4', exact: true }).waitFor();
  for (const row of await rows.all()) {
    assert.deepEqual(await row.locator('.comparison-order').allTextContents(), ['First document', 'Second document']);
    assert.deepEqual(await row.locator('.comparison-identity').allTextContents(), ['amendment.txt · Revision 4', 'original-agreement.txt · Revision 2']);
  }
  assert.equal(await rows.nth(1).getByText('No matching evidence in this version.', { exact: true }).count(), 1);
  await page.reload();
  await page.getByRole('button', { name: 'Compare pinned agreements', exact: true }).click();
  await rows.nth(1).getByRole('heading', { name: 'original-agreement.txt · Revision 2', exact: true }).waitFor();
});

test('dismissing a loading source preserves the active chat and subsequent exact source', { timeout: 30000 }, async t => {
  const app = await setup(t);
  const source = await app.seed('Notice requires 30 days.', { scope: 'shared', filename: 'source-dialog-policy.txt' });
  await json(await app.call('/chat/send', { cookie: app.a.cookie, body: { message: 'Source dialog regression', clientMessageId: randomUUID() } }));
  const page = await pageFor(t, app);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  let requests = 0;
  await page.route(`**/sources/${source.versionId}/passages/**`, async route => {
    if (++requests === 1) await gate;
    await route.continue().catch(() => {}); // An aborted first request is the expected dismissal path.
  });
  await page.goto(app.base + '/app');
  await page.getByRole('button', { name: 'Source dialog regression', exact: true }).click();
  const citation = page.getByRole('button', { name: 'View source: source-dialog-policy.txt', exact: true }).first();
  await citation.click();
  await page.getByText('Opening source…', { exact: true }).waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('dialog').count(), 0);
  assert.equal(await citation.evaluate(element => element === document.activeElement), true);
  release();
  await citation.click();
  await page.getByRole('heading', { name: 'Exact cited passage', exact: true }).waitFor();
  assert.equal(await page.getByRole('dialog').getByRole('heading', { name: 'source-dialog-policy.txt', exact: true }).count(), 1);
  assert.equal(await page.getByRole('dialog').getByText('Notice requires 30 days.', { exact: true }).count(), 2);
});

test('citation previews escape transcript clipping, remain hoverable and dismiss with Escape', { timeout: 30000 }, async t => {
  const app = await setup(t);
  const text = Array.from({ length: 10 }, (_, index) => `Clause ${index + 1}: fictional notice is 30 days and customers can ask the support team for details.`).join('\n\n');
  await app.seed(text, { scope: 'shared', filename: 'preview-policy.txt' });
  await json(await app.call('/chat/send', { cookie: app.a.cookie, body: { message: 'Preview boundary regression', clientMessageId: randomUUID() } }));
  const page = await pageFor(t, app);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(app.base + '/app');
  await page.getByRole('button', { name: 'Previous chats', exact: true }).click();
  await page.getByRole('button', { name: 'Preview boundary regression', exact: true }).click();
  const citation = page.getByRole('button', { name: 'View source: preview-policy.txt', exact: true }).first();
  await citation.focus();
  await page.evaluate(() => {
    const citation = document.querySelector('.citation-button');
    const transcript = document.querySelector('.chat-transcript');
    transcript.scrollTop += citation.getBoundingClientRect().top - transcript.getBoundingClientRect().top - 10;
  });
  await citation.hover();
  const tooltip = page.getByRole('tooltip');
  await tooltip.waitFor();
  assert.deepEqual(await tooltip.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    return {
      outsideClippingContainers: element.parentElement === document.body,
      withinViewport: bounds.top >= 0 && bounds.bottom <= innerHeight && bounds.left >= 0 && bounds.right <= innerWidth,
      visibleAtTop: element.contains(document.elementFromPoint(bounds.left + 8, bounds.top + 8)),
    };
  }), { outsideClippingContainers: true, withinViewport: true, visibleAtTop: true });
  await tooltip.hover();
  await page.waitForTimeout(200); // The quote must persist when the pointer moves onto it.
  assert.equal(await tooltip.count(), 1);
  await page.keyboard.press('Escape');
  assert.equal(await tooltip.count(), 0);
});

test('file readiness announces transitions once while collapsed and does not repeat unchanged polling results', { timeout: 30000 }, async t => {
  const app = await setup(t);
  const conversationId = await app.conversation();
  await app.seed('Fictional processing attachment.', { conversationId, filename: 'readiness.txt' });
  await app.db.collection('conversations').updateOne({ _id: new (await import('mongodb')).ObjectId(conversationId) }, { $set: { title: 'Readiness regression', attachmentCount: 1 } });
  const page = await pageFor(t, app);
  let requests = 0;
  await page.route(`**/conversations/${conversationId}/attachments`, async route => {
    const response = await route.fetch();
    const body = await response.json();
    requests += 1;
    if (requests < 3) body.items = body.items.map(item => ({ ...item, status: 'queued', indexingStatus: 'queued' }));
    await route.fulfill({ response, json: body });
  });
  await page.goto(app.base + '/app');
  await page.getByRole('button', { name: 'Readiness regression', exact: true }).click();
  const live = page.locator('.composer-dock .sr-only[role="status"]');
  await live.filter({ hasText: 'readiness.txt: Queued for processing.' }).waitFor({state:'attached'});
  assert.equal(await page.locator('.chat-files').getAttribute('open'), null);
  await live.evaluate(element => {
    window.readinessAnnouncements = [element.textContent];
    new MutationObserver(() => window.readinessAnnouncements.push(element.textContent))
      .observe(element, { childList: true, characterData: true, subtree: true });
  });
  await live.filter({ hasText: 'readiness.txt: Ready.' }).waitFor({state:'attached'});
  assert.ok(requests >= 3, 'An unchanged queued poll preceded the ready transition.');
  // Expanding and closing files must not announce the same readiness transition again.
  await page.locator('.chat-files > summary').click();
  await page.getByText('Try sample files', { exact: true }).waitFor();
  await page.locator('.chat-files > summary').click();
  assert.deepEqual(await page.evaluate(() => window.readinessAnnouncements), ['readiness.txt: Queued for processing.', 'readiness.txt: Ready.']);
});

test('short citation quote stays next to its anchor and remains reachable by a slow pointer', { timeout: 30000 }, async t => {
  const app = await setup(t);
  await app.seed('Notice requires 30 days.', { scope: 'shared', filename: 'short-preview-policy.txt' });
  await json(await app.call('/chat/send', { cookie: app.a.cookie, body: { message: 'Short preview regression', clientMessageId: randomUUID() } }));
  const page = await pageFor(t, app);
  await page.setViewportSize({ width: 1280, height: 600 });
  await page.goto(app.base + '/app');
  await page.getByRole('button', { name: 'Short preview regression', exact: true }).click();
  const citation = page.getByRole('button', { name: 'View source: short-preview-policy.txt', exact: true }).first();
  await citation.hover();
  const tooltip = page.getByRole('tooltip');
  await tooltip.waitFor();
  const anchor = await citation.boundingBox(), quote = await tooltip.boundingBox();
  assert.ok(quote.height < 100, 'Exercise a short quote rather than a max-height preview.');
  const gap = quote.y < anchor.y ? anchor.y - (quote.y + quote.height) : quote.y - (anchor.y + anchor.height);
  assert.ok(gap >= 0 && gap <= 8, `Quote must adjoin its anchor; observed gap ${gap}px.`);
  const x = Math.max(anchor.x + 5, quote.x + 5);
  const start = anchor.y + anchor.height / 2, end = quote.y + quote.height / 2;
  await page.mouse.move(x, start);
  for (let step = 1; step <= 10; step++) {
    await page.mouse.move(x, start + (end - start) * step / 10);
    await page.waitForTimeout(50);
  }
  assert.equal(await tooltip.count(), 1, 'Quote remains visible while the pointer crosses onto it.');
  await page.keyboard.press('Escape');
  assert.equal(await tooltip.count(), 0);
});
