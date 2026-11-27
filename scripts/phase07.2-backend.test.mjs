import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { setup, json, stream } from './phase05-harness.mjs';

test('7.2 terminal lookup failures preserve HTTP or SSE error semantics and saved replies', { timeout: 30000 }, async t => {
  const app = await setup(t, { fixture: './phase07.2-backend-fixture.mjs' });
  const input = { message: 'LOOKUP_FAIL_EARLY', clientMessageId: randomUUID() };
  const response = await app.call('/chat/send', { cookie: app.a.cookie, body: input, accept: 'text/event-stream' });
  const failure = await json(response, 503);
  assert.equal(failure.code, 'ANSWER_UNAVAILABLE');
  assert.ok(failure.requestId);
  // The result was saved before the transport lookup failed. Replaying the
  // same request returns that result instead of spending a new generation.
  const replay = await json(await app.call('/chat/send', { cookie: app.a.cookie, body: input }));
  assert.equal(replay.status, 'completed');
  assert.equal(replay.response, 'Fictional saved reply.');
  assert.equal(await app.db.collection('messages').countDocuments({ clientMessageId: input.clientMessageId }), 1);

  const events = await stream(await app.call('/chat/send', { cookie: app.a.cookie,
    body: { message: 'LOOKUP_FAIL_LATE', clientMessageId: randomUUID() }, accept: 'text/event-stream' }));
  assert.ok(events.some(event => event.event === 'paragraph'));
  assert.equal(events.at(-1).event, 'error');
  assert.equal(events.at(-1).data.code, 'ANSWER_UNAVAILABLE');
});
