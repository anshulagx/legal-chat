// Requires the optional browser tooling described in README.md.
import assert from 'node:assert/strict';
import test from 'node:test';
import { setup, ObjectId } from './phase05-harness.mjs';

const { chromium } = await import(process.env.QA_PLAYWRIGHT_MODULE ?? 'playwright-core');

test('indexing retry locks chat navigation until the originating attachment list is reconciled', { timeout: 30000 }, async t => {
  const app = await setup(t);
  const first = await app.conversation();
  const second = await app.conversation();
  for (const [id, title] of [[first, 'Chat A'], [second, 'Chat B']]) {
    await app.db.collection('conversations').updateOne({ _id: new ObjectId(id) }, { $set: { title, attachmentCount: 1 } });
  }
  const failed = await app.seed('Fictional failed attachment.', { conversationId: first, filename: 'a-failed.txt' });
  await app.db.collection('documentversions').updateOne({ _id: new ObjectId(failed.versionId) }, { $set: { state: 'failed', indexingStatus: 'failed' } });
  await app.seed('Fictional attachment in the other chat.', { conversationId: second, filename: 'b-ready.txt' });

  const browser = await chromium.launch({ executablePath: process.env.QA_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext();
  const [name, value] = app.a.cookie.split('=');
  await context.addCookies([{ name, value, url: app.base }]);
  const page = await context.newPage();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  // Hold the mutation to exercise the real user interaction during a slow response.
  await page.route('**/attachments/*/retry', async route => {
    await gate;
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await page.goto(app.base + '/app');
  await page.getByRole('button', { name: 'Chat A', exact: true }).click();
  await page.getByRole('button', { name: 'Retry indexing', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'Chat B', exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: 'New chat', exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: 'Send question', exact: true }).isDisabled(), true);
  release();
  await page.getByRole('button', { name: 'Chat B', exact: true }).click();
  await page.locator('.chat-files > summary').click();
  await page.getByText('b-ready.txt', { exact: true }).waitFor();
  assert.equal(await page.getByText('a-failed.txt', { exact: true }).count(), 0);
  assert.equal(await page.getByRole('heading', { name: 'Chat B', exact: true }).count(), 1);
});
