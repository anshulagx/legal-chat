import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { setup, json, stream, ObjectId } from './phase05-harness.mjs';
const body = (message, extra = {}) => ({ message, clientMessageId: randomUUID(), ...extra });
async function until(fn) {
  const deadline = Date.now() + 7000;
  while (!await fn()) { assert.ok(Date.now() < deadline, 'State transition timed out'); await delay(30); }
}
test('Phase 07 recovery integration', { timeout: 90000 }, async t => {
  const app = await setup(t, { fixture: './phase07-fixture.mjs', env: { CHAT_GENERATION_LIMIT: '100', CHAT_ATTEMPT_LEASE_MS: '1500' } });
  let failed;
  await t.test('07.1 pre-header failure returns retryable 503 with durable IDs', async () => {
    const response = await app.call('/chat/send', { cookie: app.a.cookie, body: body('FAIL_EARLY'), accept: 'text/event-stream' });
    failed = await json(response, 503); assert.equal(failed.status, 'failed'); assert.equal(failed.retryable, true);
    assert.equal(failed.failureCode, 'ANSWER_UNAVAILABLE');
  });
  await t.test('07.1 interrupted streams preserve partial paragraphs and question', async () => {
    const response = await app.call('/chat/send', { cookie: app.a.cookie, body: body('WAIT'), accept: 'text/event-stream' });
    const reader = response.body.getReader(); let bytes = '';
    while (!bytes.includes('event: paragraph')) bytes += new TextDecoder().decode((await reader.read()).value);
    await reader.cancel();
    let attempt;
    await until(async () => { attempt = await app.db.collection('messages').findOne({ content: '', role: 'assistant', status: 'interrupted' }); return !!attempt; });
    assert.equal(attempt.paragraphs.length, 1);
    const user = await app.db.collection('messages').findOne({ _id: attempt.parentTurnId }); assert.equal(user.content, 'WAIT');
    const saved = await json(await app.call(`/chat/history?conversationId=${user.conversationId}`, { cookie: app.a.cookie }));
    assert.equal(saved.items.find(item => item.id === String(attempt._id)).status, 'interrupted');
  });
  await t.test('07.1 after-paragraph failure emits terminal SSE error', async () => {
    const events = await stream(await app.call('/chat/send', { cookie: app.a.cookie, body: body('FAIL_PARTIAL'), accept: 'text/event-stream' }));
    assert.equal(events[0].event, 'accepted'); assert.ok(events.some(item => item.event === 'paragraph'));
    assert.equal(events.at(-1).event, 'error'); assert.equal(events.at(-1).data.status, 'failed');
  });
  await t.test('07.2 concurrent retries create one fresh attempt and preserve selections', async () => {
    // Original selectors are durable metadata even if their sources later change.
    const selectors = [String(new ObjectId()), String(new ObjectId())];
    await app.db.collection('messages').updateOne({ _id: new ObjectId(failed.userMessageId) }, { $set: { selectedDocumentVersionIds: selectors } });
    const retryId = randomUUID(), path = `/chat/messages/${failed.userMessageId}/retry`;
    const responses = await Promise.all([1, 2].map(() => app.call(path, { cookie: app.a.cookie, body: { retryId } })));
    const results = await Promise.all(responses.map(response => json(response, response.status)));
    assert.ok(responses.every(response => [200, 202].includes(response.status)));
    assert.equal(results[0].attemptId, results[1].attemptId); assert.notEqual(results[0].attemptId, failed.attemptId);
    assert.equal(await app.db.collection('messages').countDocuments({ parentTurnId: new ObjectId(failed.userMessageId), retryId }), 1);
    assert.equal(await app.db.collection('messages').countDocuments({ _id: new ObjectId(failed.userMessageId), role: 'user' }), 1);
    const history = await json(await app.call(`/chat/history?conversationId=${failed.conversationId}`, { cookie: app.a.cookie }));
    assert.deepEqual(history.items[0].selectedDocumentVersionIds, selectors);
    const fresh = history.items.find(item => item.id === results[0].attemptId); assert.equal(fresh.status, 'completed'); assert.equal(fresh.followUps.length, 2);
    assert.equal(history.items.find(item => item.id === failed.attemptId).status, 'failed');
    assert.equal((await app.call(path, { cookie: app.b.cookie, body: { retryId } })).status, 404);
    assert.equal((await app.call(path, { cookie: app.admin.cookie, body: { retryId } })).status, 404);
    assert.equal((await app.call(path, { cookie: app.a.cookie, body: { retryId: randomUUID() } })).status, 409);
  });
  await t.test('07.2 stale attempts after restart are interrupted and release the thread', async () => {
    const pending = await app.call('/chat/send', { cookie: app.a.cookie, body: body('WAIT'), accept: 'text/event-stream' });
    const reader = pending.body.getReader(); let text = '';
    while (!text.includes('event: paragraph')) text += new TextDecoder().decode((await reader.read()).value);
    const attempt = await app.db.collection('messages').findOne({ role: 'assistant', status: 'generating' });
    await app.restart(); await reader.cancel().catch(() => {});
    await delay(1600);
    const conversationId = String(attempt.conversationId);
    const history = await json(await app.call(`/chat/history?conversationId=${conversationId}`, { cookie: app.a.cookie }));
    const saved = history.items.find(item => item.id === String(attempt._id));
    assert.equal(saved.status, 'interrupted'); assert.equal(saved.paragraphs.length, 1);
    const next = await json(await app.call('/chat/send', { cookie: app.a.cookie, body: body('Recovered', { conversationId }) })); assert.equal(next.status, 'completed');
  });
  await t.test('07.2 explicit cancellation is owned, durable and unlocks generation', async () => {
    const pending = await app.call('/chat/send', { cookie: app.a.cookie, body: body('WAIT'), accept: 'text/event-stream' });
    let accepted; const reading = stream(pending, event => { if (event.event === 'accepted') accepted = event.data; });
    await until(() => !!accepted);
    const path = `/chat/messages/${accepted.attemptId}/cancel`;
    assert.equal((await app.call(path, { cookie: app.b.cookie, body: {} })).status, 404);
    assert.equal((await json(await app.call(path, { cookie: app.a.cookie, body: {} }))).status, 'interrupted');
    const events = await reading; assert.equal(events.at(-1).event, 'error');
    const next = await json(await app.call('/chat/send', { cookie: app.a.cookie, body: body('After cancellation', { conversationId: accepted.conversationId }) })); assert.equal(next.status, 'completed');
  });
  await t.test('07.3 provider Retry-After survives reload and blocks premature retry', async () => {
    const response = await app.call('/chat/send', { cookie: app.a.cookie, body: body('THROTTLE'), accept: 'text/event-stream' });
    const failure = await json(response, 429); assert.equal(response.headers.get('retry-after'), '1');
    const path = `/chat/messages/${failure.userMessageId}/retry`, retryId = randomUUID();
    assert.equal((await app.call(path, { cookie: app.a.cookie, body: { retryId } })).status, 429);
    await delay(1100);
    assert.equal((await json(await app.call(path, { cookie: app.a.cookie, body: { retryId } }))).status, 'completed');
  });
});

test('07.3 generation quotas are per-user and replays do not spend another slot', { timeout: 30000 }, async t => {
  const app = await setup(t, { fixture: './phase07-fixture.mjs', env: { CHAT_GENERATION_LIMIT: '1', CHAT_GENERATION_WINDOW_SECONDS: '1' } });
  const input = body('First'); await json(await app.call('/chat/send', { cookie: app.a.cookie, body: input }));
  await json(await app.call('/chat/send', { cookie: app.a.cookie, body: input }));
  const limited = await app.call('/chat/send', { cookie: app.a.cookie, body: body('Second') });
  const error = await json(limited, 429); assert.ok(Number(limited.headers.get('retry-after')) > 0); assert.ok(error.retryAfterSeconds > 0);
  await json(await app.call('/chat/send', { cookie: app.b.cookie, body: body('Independent') }));
  await delay(1100); await json(await app.call('/chat/send', { cookie: app.a.cookie, body: body('After expiry') }));
});

test('07.2 retry snapshots current evidence while retaining the failed snapshot', { timeout: 30000 }, async t => {
  const app = await setup(t);
  const original = await app.seed('Fictional original notice: 30 days.', { scope: 'shared', filename: 'policy.txt' });
  const failure = await json(await app.call('/chat/send', { cookie: app.a.cookie, body: body('RETRY_SNAPSHOT') }), 503);
  const old = await app.db.collection('messages').findOne({ _id: new ObjectId(failure.attemptId) });
  assert.ok(old.evidenceSnapshot.versions.some(version => version.versionId === original.versionId));
  const replacement = await app.seed('Fictional replacement notice: 60 days.', { scope: 'shared', filename: 'policy.txt', documentId: original.documentId, revision: 2 });
  const result = await json(await app.call(`/chat/messages/${failure.userMessageId}/retry`, { cookie: app.a.cookie, body: { retryId: randomUUID() } }));
  assert.equal(result.status, 'completed');
  const fresh = await app.db.collection('messages').findOne({ _id: new ObjectId(result.attemptId) });
  assert.ok(fresh.evidenceSnapshot.versions.some(version => version.versionId === replacement.versionId));
  assert.ok(!fresh.evidenceSnapshot.versions.some(version => version.versionId === original.versionId));
  assert.deepEqual((await app.db.collection('messages').findOne({ _id: old._id })).evidenceSnapshot, old.evidenceSnapshot);
});
