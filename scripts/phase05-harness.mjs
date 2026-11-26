import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { MongoClient, ObjectId } from 'mongodb';

export { ObjectId };
export const hash = value => createHash('sha256').update(value).digest('hex');
export async function setup(t, options = {}) {
  const uri = process.env.QA_MONGODB_URI ?? 'mongodb://127.0.0.1:27028/?replicaSet=legalChatQA';
  const database = `legal_chat_qa05_${randomUUID().replaceAll('-', '')}`;
  const mongo = new MongoClient(uri, { serverSelectionTimeoutMS: 4000 });
  await mongo.connect();
  const db = mongo.db(database);
  const socket = createServer();socket.listen(0, '127.0.0.1');await once(socket, 'listening');
  const port = socket.address().port;await new Promise(resolve => socket.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const adminCredentials = { email: 'admin@example.test', password: randomBytes(24).toString('hex') };
  const restartSecret = randomBytes(32).toString('hex');
  let child = fork(new URL(options.fixture ?? './phase05-fixture.mjs', import.meta.url), { execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: {
    NODE_ENV: 'test', PORT: String(port), APP_ORIGIN: base, MONGODB_URI: uri, MONGODB_DB_NAME: database,
    JWT_SECRET: restartSecret, JWT_ISSUER: 'qa05', JWT_AUDIENCE: 'qa05', JWT_TTL_SECONDS: '900',
    ADMIN_SEED_EMAIL: adminCredentials.email, ADMIN_SEED_PASSWORD: adminCredentials.password,
    AUTH_LOGIN_LIMIT: '100', AUTH_LOGIN_WINDOW_SECONDS: '60', CHAT_GENERATION_LIMIT: '100',
    ...options.env,
    OPENROUTER_API_KEY: 'fixture-only', OPENROUTER_CHAT_MODEL: 'fixture/chat',
  } });
  let output = '';child.stdout.on('data', value => output += value);child.stderr.on('data', value => output += value);
  let exited = once(child, 'exit');
  let stopped = false;
  async function stop() {
    if (stopped) return;stopped = true;
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await exited;await db.dropDatabase();await mongo.close();
  }
  t.after(stop);
  function call(path, { cookie, body, method = body ? 'POST' : 'GET', accept } = {}) {
    return fetch(base + path, { method, headers: { ...(method === 'POST' ? { Origin: base } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}),
      ...(accept ? { Accept: accept } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20000) });
  }
  const deadline = Date.now() + 15000;
  while ((await call('/health/ready').catch(() => null))?.status !== 200) {
    assert.ok(child.exitCode === null && Date.now() < deadline, `Fixture readiness failed: ${output}`);await delay(30);
  }
  async function account(email) {
    const response = await call('/auth/signup', { body: { email, password: 'Fictional phase05 password' } });
    const user = await json(response, 201);return { id: user.id, cookie: response.headers.get('set-cookie').split(';', 1)[0] };
  }
  const a = await account('a@example.test'), b = await account('b@example.test');
  const login = await call('/auth/login', { body: adminCredentials });await json(login);
  const admin = { cookie: login.headers.get('set-cookie').split(';', 1)[0] };
  async function conversation(owner = a) { return (await json(await call('/conversations', { cookie: owner.cookie, body: {} }), 201)).id; }
  async function seed(text, { owner = a, conversationId, scope = 'private', filename = 'fixture.txt', page, revision = 1, documentId, originalBytes } = {}) {
    const did = documentId ? new ObjectId(documentId) : new ObjectId(), vid = new ObjectId();
    const ownerId = new ObjectId(owner.id), pid = `passage-${vid}`, cid = `chunk-${vid}`;
    const common = { ownerId, scope, ...(conversationId ? { conversationId: new ObjectId(conversationId) } : {}) };
    if (!documentId) await db.collection('documents').insertOne({ _id: did, ...common, title: filename, activeVersionId: vid, archivedAt: null, revisionCounter: revision });
    else await db.collection('documents').updateOne({ _id: did }, { $set: { activeVersionId: vid, revisionCounter: revision } });
    await db.collection('documentversions').insertOne({ _id: vid, documentId: did, ...common, revision, filename, mime: page ? 'application/pdf' : 'text/plain',
      state: 'ready', activeIndexGeneration: 'fixture-gen', embeddingModel: 'fixture/embed', dimensions: 8,
      key: originalBytes ? `base64:${Buffer.from(originalBytes).toString('base64')}` : text, s3VersionId: 'pinned-fixture', hash: hash(originalBytes ?? text), size: originalBytes?.length ?? Buffer.byteLength(text),
      clientUploadId: randomUUID(), requestHash: hash(text), expiresAt: new Date(Date.now() + 300000) });
    await db.collection('passages').insertOne({ _id: pid, versionId: String(vid), ordinal: 0, text,
      ...(page ? { page } : { start: 0, end: text.length }), extractorVersion: 'fixture' });
    await db.collection('chunks').insertOne({ _id: cid, chunkId: cid, versionId: String(vid), generation: 'fixture-gen', passageIds: [pid], ordinal: 0, searchText: text, tokenCount: 50 });
    await db.collection('indexgenerations').updateOne({ _id: 'fixture-gen' }, { $set: { model: 'fixture/embed', dimensions: 8 } }, { upsert: true });
    if (scope === 'shared') await db.collection('adminevents').insertOne({ action: 'publish', versionId: vid, documentId: did });
    return { versionId: String(vid), documentId: String(did), passageId: pid, chunkId: cid, text };
  }
  return { call, db, a, b, admin, conversation, seed, stop, base,
    async restart() {
      child.kill('SIGKILL'); await exited;
      child = fork(new URL(options.fixture ?? './phase05-fixture.mjs', import.meta.url), { execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: {
        NODE_ENV: 'test', PORT: String(port), APP_ORIGIN: base, MONGODB_URI: uri, MONGODB_DB_NAME: database,
        JWT_SECRET: restartSecret, JWT_ISSUER: 'qa05', JWT_AUDIENCE: 'qa05', JWT_TTL_SECONDS: '900',
        ADMIN_SEED_EMAIL: adminCredentials.email, ADMIN_SEED_PASSWORD: adminCredentials.password,
        AUTH_LOGIN_LIMIT: '100', AUTH_LOGIN_WINDOW_SECONDS: '60', CHAT_GENERATION_LIMIT: '100', ...options.env,
        OPENROUTER_API_KEY: 'fixture-only', OPENROUTER_CHAT_MODEL: 'fixture/chat',
      } });
      child.stdout.on('data', value => output += value); child.stderr.on('data', value => output += value);
      exited = once(child, 'exit');
      const until = Date.now() + 15000;
      while ((await call('/health/ready').catch(() => null))?.status !== 200) {
        assert.ok(child.exitCode === null && Date.now() < until, `Restart failed: ${output}`); await delay(30);
      }
    },
  };
}
export async function json(response, status = 200) { assert.equal(response.status, status);return response.json(); }
export async function stream(response, onEvent) {
  assert.equal(response.status, 200);assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const decoder = new TextDecoder(), reader = response.body.getReader(), events = [];let buffer = '';
  while (true) {
    const { value, done } = await reader.read();buffer += decoder.decode(value, { stream: !done });
    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      const packet = buffer.slice(0, boundary);buffer = buffer.slice(boundary + 2);
      const event = packet.split('\n').find(line => line.startsWith('event: '))?.slice(7);
      const data = packet.split('\n').find(line => line.startsWith('data: '))?.slice(6);
      if (event && data) { const item = { event, data: JSON.parse(data), at: Date.now() };events.push(item);await onEvent?.(item); }
    }
    if (done) break;
  }
  return events;
}
