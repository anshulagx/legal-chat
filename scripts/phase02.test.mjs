import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { MongoClient, ObjectId } from 'mongodb';

const mongoUri = process.env.QA_MONGODB_URI ?? 'mongodb://127.0.0.1:27028/?replicaSet=legalChatQA';
const database = `legal_chat_qa02_${randomUUID().replaceAll('-', '')}`;
const secret = randomBytes(32).toString('hex');
const admin = { email: 'admin@example.test', password: randomBytes(24).toString('hex') };
const fixture = fileURLToPath(new URL('./phase02-fixture.mjs', import.meta.url));

async function waitFor(predicate, description) {
  const deadline = Date.now() + 12000;
  while (!await predicate()) {
    assert.ok(Date.now() < deadline, description);
    await delay(30);
  }
}

async function launch(t, { paused = false } = {}) {
  const socket = createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const { port } = socket.address();
  await new Promise(resolve => socket.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const app = fork(fixture, { execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: {
    NODE_ENV: 'test', PORT: String(port), APP_ORIGIN: base,
    MONGODB_URI: mongoUri, MONGODB_DB_NAME: database,
    JWT_SECRET: secret, JWT_ISSUER: 'qa02', JWT_AUDIENCE: 'qa02-browser', JWT_TTL_SECONDS: '900',
    ADMIN_SEED_EMAIL: admin.email, ADMIN_SEED_PASSWORD: admin.password,
    AUTH_LOGIN_LIMIT: '100', AUTH_LOGIN_WINDOW_SECONDS: '60', QA_PAUSE_ANSWERS: String(paused),
  } });
  const events = [];
  app.on('message', message => events.push(message));
  const exited = once(app, 'exit');
  let stopped = false;
  async function stop() {
    if (stopped) return;
    stopped = true;
    if (app.exitCode === null && app.signalCode === null) app.kill('SIGTERM');
    if (app.connected) app.disconnect();
    await exited;
  }
  t.after(stop);
  function call(path, { body, method = body ? 'POST' : 'GET', cookie, origin = base } = {}) {
    return fetch(base + path, { method, headers: {
      ...(method === 'POST' ? { Origin: origin } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}),
    }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000) });
  }
  await waitFor(async () => {
    assert.equal(app.exitCode, null, 'Fixture exited before readiness');
    return (await call('/health/ready').catch(() => null))?.status === 200;
  }, 'Fixture did not become ready');
  return { call, stop, events, async control(command) {
    const start = events.length;
    app.send(command);
    await waitFor(() => events.slice(start).some(event => event.event === 'control' && event.command === command), 'Fixture control acknowledgment');
  } };
}

async function json(response, status = 200) {
  assert.equal(response.status, status);
  return response.json();
}
async function account(server, email) {
  const credentials = { email, password: 'Fictional phase02 password' };
  const response = await server.call('/auth/signup', { body: credentials });
  const profile = await json(response, 201);
  return { credentials, id: profile.id, cookie: response.headers.get('set-cookie').split(';', 1)[0] };
}
const key = () => randomUUID();
const countGenerations = (...servers) => servers.flatMap(server => server.events).filter(event => event.event === 'generation').length;

test('Phase 02 durable conversation integration', { timeout: 120000 }, async t => {
  const client = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 4000 });
  try {
    await client.connect();
    const hello = await client.db('admin').command({ hello: 1 });
    assert.ok(hello.setName || hello.msg === 'isdbgrid', 'QA MongoDB must support transactions (replica set or Atlas)');
  } catch (error) {
    await client.close();
    throw error;
  }
  const db = client.db(database);
  const conversations = db.collection('conversations');
  const messages = db.collection('messages');
  try {
    let one = await launch(t, { paused: true });
    let two = await launch(t, { paused: true });
    const a = await account(one, 'customer.a@example.test');
    const b = await account(one, 'customer.b@example.test');
    let first;
    const firstBody = { message: `Unique question ${key()}`, clientMessageId: key() };

    await t.test('02.2 concurrent first sends across processes reserve one thread, turn and generation', async () => {
      const initialCount = countGenerations(one, two);
      const requests = [one, two].map(server => server.call('/chat/send', { cookie: a.cookie, body: firstBody }));
      await waitFor(() => countGenerations(one, two) > initialCount, 'First generation started');
      const active = await Promise.race(requests);
      const pending = await json(active, 202);
      assert.equal(pending.status, 'generating');
      assert.equal(countGenerations(one, two), initialCount + 1);
      const duplicate = await json(await two.call('/chat/send', { cookie: a.cookie, body: firstBody }), 202);
      assert.equal(duplicate.userMessageId, pending.userMessageId);
      assert.equal(duplicate.attemptId, pending.attemptId);
      assert.equal(duplicate.conversationId, pending.conversationId);
      await one.control('release-answers');
      await two.control('release-answers');
      const responses = await Promise.all(requests);
      // The earlier Promise.race consumed one response; replay instead of reading its body twice.
      assert.deepEqual(responses.map(response => response.status).sort(), [200, 202]);
      first = await json(await one.call('/chat/send', { cookie: a.cookie, body: firstBody }));
      assert.equal(first.status, 'completed');
      assert.equal(first.response, `Fixture answer: ${firstBody.message}`);
      for (const field of ['conversationId', 'userMessageId', 'attemptId']) assert.equal(first[field], pending[field]);
      assert.equal(await conversations.countDocuments({}), 1);
      assert.equal(await messages.countDocuments({ role: 'user', clientMessageId: firstBody.clientMessageId }), 1);
      assert.equal(await messages.countDocuments({ conversationId: new ObjectId(first.conversationId) }), 2);
      assert.equal(countGenerations(one, two), initialCount + 1);
    });

    await t.test('02.2 idempotency conflicts reject changed text and conversation without generating', async () => {
      const before = countGenerations(one, two);
      for (const body of [{ ...firstBody, message: 'Changed text' }, { ...firstBody, conversationId: first.conversationId }]) {
        const conflict = await json(await one.call('/chat/send', { cookie: a.cookie, body }), 409);
        assert.equal(conflict.code, 'IDEMPOTENCY_CONFLICT');
      }
      assert.equal(countGenerations(one, two), before);
      assert.equal(await messages.countDocuments({}), 2);
    });

    await t.test('02.1 restart and login preserve question, title, IDs and ordered history', async () => {
      await one.stop(); await two.stop();
      one = await launch(t); two = await launch(t);
      const login = await one.call('/auth/login', { body: a.credentials });
      await json(login);
      a.cookie = login.headers.get('set-cookie').split(';', 1)[0];
      const list = await json(await one.call('/conversations', { cookie: a.cookie }));
      assert.equal(list.items[0].id, first.conversationId);
      assert.equal(list.items[0].title, firstBody.message.slice(0, 80));
      const history = await json(await one.call(`/chat/history?conversationId=${first.conversationId}`, { cookie: a.cookie }));
      assert.deepEqual(history.items.map(item => item.id), [first.userMessageId, first.attemptId]);
      assert.deepEqual(history.items.map(item => item.sequence), [0, 1]);
      assert.deepEqual(history.items.map(item => item.role), ['user', 'assistant']);
      assert.equal(history.items[0].content, firstBody.message);
      assert.equal(history.items[1].content, first.response);
      assert.ok(history.items.every(item => item.status === 'completed'));
    });

    await t.test('02.3 keyset pages are distinct with timestamp ties; empty drafts stay hidden', async () => {
      const empty = await json(await one.call('/conversations', { cookie: a.cookie, body: {} }), 201);
      for (let index = 0; index < 2; index++) await json(await one.call('/chat/send', {
        cookie: a.cookie, body: { message: `Another thread ${index}`, clientMessageId: key() },
      }));
      const secondTurn = await json(await one.call('/chat/send', { cookie: a.cookie,
        body: { message: 'A follow-up question', clientMessageId: key(), conversationId: first.conversationId } }));
      const threadHistory = await json(await one.call(`/chat/history?conversationId=${first.conversationId}`, { cookie: a.cookie }));
      assert.deepEqual(threadHistory.items.map(item => item.sequence), [0, 1, 2, 3]);
      assert.equal(threadHistory.items[2].id, secondTurn.userMessageId);
      await conversations.updateMany({}, { $set: { updatedAt: new Date('2026-01-01T00:00:00Z') } });
      await messages.updateMany({}, { $set: { createdAt: new Date('2026-01-01T00:00:00Z') } });
      for (const path of ['/conversations', '/chat/history', `/chat/history?conversationId=${first.conversationId}`]) {
        const ids = [];
        let cursor;
        do {
          const page = await json(await one.call(`${path}${path.includes('?') ? '&' : '?'}limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { cookie: a.cookie }));
          assert.equal(page.items.length, 1);
          ids.push(page.items[0].id);
          cursor = page.nextCursor;
          assert.ok(ids.length <= 10, 'Pagination terminates');
        } while (cursor);
        assert.equal(new Set(ids).size, ids.length);
        assert.equal(ids.length, path === '/conversations' ? 3 : path === '/chat/history' ? 8 : 4);
        assert.ok(!ids.includes(empty.id));
      }
    });

    await t.test('02.3 accounts and admin cannot list, read or mutate another account thread', async () => {
      const adminLogin = await one.call('/auth/login', { body: admin });
      await json(adminLogin);
      const adminCookie = adminLogin.headers.get('set-cookie').split(';', 1)[0];
      for (const cookie of [b.cookie, adminCookie]) {
        assert.deepEqual((await json(await one.call('/conversations', { cookie }))).items, []);
        assert.deepEqual((await json(await one.call('/chat/history', { cookie }))).items, []);
        assert.equal((await one.call(`/chat/history?conversationId=${first.conversationId}`, { cookie })).status, 404);
        assert.equal((await one.call('/chat/send', { cookie, body: { message: 'Forbidden question', clientMessageId: key(), conversationId: first.conversationId } })).status, 404);
      }
      const page = await json(await one.call('/conversations?limit=1', { cookie: a.cookie }));
      assert.equal((await one.call(`/conversations?cursor=${encodeURIComponent(page.nextCursor)}`, { cookie: b.cookie })).status, 400);
      assert.equal((await one.call(`/chat/history?cursor=${encodeURIComponent(page.nextCursor)}`, { cookie: a.cookie })).status, 400);
      assert.equal((await one.call('/conversations?cursor=broken', { cookie: a.cookie })).status, 400);
      assert.equal((await one.call('/chat/history?limit=0', { cookie: a.cookie })).status, 400);
      assert.equal((await one.call('/chat/history?conversationId[$ne]=x', { cookie: a.cookie })).status, 400);
    });

    await t.test('reservation rolls back thread, sequence, user and attempt on database rejection', async () => {
      const beforeConversations = await conversations.countDocuments({});
      const beforeMessages = await messages.countDocuments({});
      const threadBefore = await conversations.findOne({ _id: new ObjectId(first.conversationId) });
      await db.command({ collMod: 'messages', validator: { role: { $ne: 'assistant' } }, validationLevel: 'strict', validationAction: 'error' });
      try {
        for (const conversationId of [undefined, first.conversationId]) {
          const response = await one.call('/chat/send', { cookie: a.cookie, body: { message: 'Rollback fixture', clientMessageId: key(), ...(conversationId ? { conversationId } : {}) } });
          const error = await json(response, 500);
          assert.equal(error.code, 'INTERNAL_ERROR');
          assert.equal(response.headers.get('x-request-id'), error.requestId);
        }
      } finally {
        await db.command({ collMod: 'messages', validator: {} });
      }
      assert.equal(await conversations.countDocuments({}), beforeConversations);
      assert.equal(await messages.countDocuments({}), beforeMessages);
      assert.deepEqual(await conversations.findOne({ _id: threadBefore._id }), threadBefore);
    });

    await t.test('different sends serialize generation per thread across server processes', async () => {
      await one.control('pause-answers');
      const before = countGenerations(one, two);
      const running = one.call('/chat/send', { cookie: a.cookie, body: { message: 'First serialized question', clientMessageId: key(), conversationId: first.conversationId } });
      await waitFor(() => countGenerations(one, two) > before, 'Serialized generation started');
      const conflict = await json(await two.call('/chat/send', { cookie: a.cookie,
        body: { message: 'Concurrent different question', clientMessageId: key(), conversationId: first.conversationId } }), 409);
      assert.equal(conflict.code, 'GENERATION_ACTIVE');
      await one.control('release-answers');
      await json(await running);
      await json(await two.call('/chat/send', { cookie: a.cookie,
        body: { message: 'Next serialized question', clientMessageId: key(), conversationId: first.conversationId } }));
      const history = await json(await one.call(`/chat/history?conversationId=${first.conversationId}`, { cookie: a.cookie }));
      assert.deepEqual(history.items.map(item => item.sequence), [0, 1, 2, 3, 4, 5, 6, 7]);
      assert.equal(countGenerations(one, two), before + 2);
    });

    await t.test('adapter failure preserves the user turn, terminal result and unlocks next send', async () => {
      await one.control('fail-next-answer');
      const body = { message: 'Fictional adapter failure', clientMessageId: key() };
      const result = await json(await one.call('/chat/send', { cookie: a.cookie, body }));
      assert.equal(result.status, 'failed');
      assert.equal(result.failureCode, 'ANSWER_UNAVAILABLE');
      const before = countGenerations(one, two);
      assert.deepEqual(await json(await two.call('/chat/send', { cookie: a.cookie, body })), result);
      assert.equal(countGenerations(one, two), before);
      await json(await one.call('/chat/send', { cookie: a.cookie,
        body: { message: 'Question after failure', clientMessageId: key(), conversationId: result.conversationId } }));
      const history = await json(await one.call(`/chat/history?conversationId=${result.conversationId}`, { cookie: a.cookie }));
      assert.equal(history.items[0].content, body.message);
      assert.equal(history.items[0].status, 'failed');
      assert.equal(history.items[1].status, 'failed');
      assert.equal(history.items[3].status, 'completed');
    });

    await t.test('protected chat routes enforce session revocation, input bounds and Origin', async () => {
      for (const path of ['/conversations', '/chat/history']) assert.equal((await one.call(path)).status, 401);
      for (const path of ['/conversations', '/chat/send']) assert.equal((await one.call(path, { body: {} })).status, 401);
      assert.equal((await one.call('/chat/send', { cookie: a.cookie, origin: 'https://other.example.test', body: firstBody })).status, 403);
      for (const body of [{ message: ' ' }, { message: 'x'.repeat(8001) }, { message: 'x', clientMessageId: {} }, { message: 'x', selectedDocumentVersionIds: ['unavailable'] }]) {
        assert.equal((await one.call('/chat/send', { cookie: a.cookie, body })).status, 400);
      }
      assert.equal((await one.call('/auth/logout', { cookie: b.cookie, method: 'POST' })).status, 204);
      assert.equal((await one.call('/chat/history', { cookie: b.cookie })).status, 401);
      assert.equal((await one.call('/chat/send', { cookie: b.cookie, body: { message: 'Revoked' } })).status, 401);
    });
    await one.stop(); await two.stop();
  } finally {
    await db.dropDatabase();
    await client.close();
  }
});
