import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { MongoClient, ObjectId } from 'mongodb';
import { S3Client, ListObjectVersionsCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';

const real = Boolean(process.env.QA_S3_ENV_FILE);
const supplied = real ? parseEnv(await readFile(process.env.QA_S3_ENV_FILE, 'utf8')) : {};
const runId = randomUUID();
const database = `legal_chat_qa03_${runId.replaceAll('-', '')}`;
const mongoUri = process.env.QA_MONGODB_URI ?? supplied.MONGODB_URI ?? 'mongodb://127.0.0.1:27028/?replicaSet=legalChatQA';
const prefix = real ? `${supplied.S3_KEY_PREFIX}suite/${runId}/` : `legal-chat/qa/${runId}/`;
const aws = real ? Object.fromEntries(['AWS_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'S3_BUCKET'].map(name => [name, supplied[name] ?? '']))
  : { AWS_REGION: 'us-east-1', AWS_ACCESS_KEY_ID: 'fixture-key', AWS_SECRET_ACCESS_KEY: 'fixture-secret', S3_BUCKET: 'fixture-bucket' };
const fixture = fileURLToPath(new URL('./phase03-fixture.mjs', import.meta.url));
const admin = { email: 'admin@example.test', password: randomBytes(24).toString('hex') };
const bytes = Buffer.from('Fictional agreement. Notice period: 30 days.');
const hash = value => createHash('sha256').update(value).digest('hex');
const key = () => randomUUID();
const body = (overrides = {}) => ({ filename: 'agreement.txt', size: bytes.length, mime: 'text/plain', clientUploadId: key(), ...overrides });

async function launch(t, limit = 100) {
  const socket = createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
  const { port } = socket.address(); await new Promise(resolve => socket.close(resolve));
  const base = `http://localhost:${port}`;
  const origin = real ? supplied.APP_ORIGIN : base;
  const app = fork(fixture, { execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: {
    NODE_ENV: 'test', PORT: String(port), APP_ORIGIN: origin,
    MONGODB_URI: mongoUri, MONGODB_DB_NAME: database, JWT_SECRET: randomBytes(32).toString('hex'),
    JWT_ISSUER: 'qa03', JWT_AUDIENCE: 'qa03', JWT_TTL_SECONDS: '900',
    ADMIN_SEED_EMAIL: admin.email, ADMIN_SEED_PASSWORD: admin.password,
    AUTH_LOGIN_LIMIT: '100', AUTH_LOGIN_WINDOW_SECONDS: '60', ...aws, S3_KEY_PREFIX: prefix,
    UPLOAD_RESERVATION_LIMIT: String(limit), UPLOAD_RESERVATION_WINDOW_SECONDS: '60', QA_REAL_STORAGE: String(real),
  } });
  const exited = once(app, 'exit');
  let stopped = false;
  async function stop() { if (stopped) return; stopped = true; if (app.exitCode === null && app.signalCode === null) app.kill('SIGTERM'); if (app.connected) app.disconnect(); await exited; }
  t.after(stop);
  function call(path, { body: payload, method = payload ? 'POST' : 'GET', cookie, requestOrigin = origin } = {}) {
    return fetch(base + path, { method, headers: { ...(method === 'POST' ? { Origin: requestOrigin } : {}),
      ...(payload ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      ...(payload ? { body: JSON.stringify(payload) } : {}), signal: AbortSignal.timeout(30000) });
  }
  for (let tries = 0; tries < 150; tries++) {
    if ((await call('/health/ready').catch(() => null))?.status === 200) break;
    if (app.exitCode !== null || tries === 149) assert.fail('QA app did not become ready; check isolated MongoDB and S3 settings.');
    await delay(200);
  }
  return { call, stop, async control(command, args = {}) {
    const requestId = key();
    const response = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { app.off('message', listener); reject(new Error('Fixture control timed out')); }, 30000);
      function listener(message) { if (message.requestId !== requestId) return; clearTimeout(timeout); app.off('message', listener); message.error ? reject(new Error(message.error)) : resolve(message.result); }
      app.on('message', listener);
    });
    app.send({ command, requestId, ...args });
    return response;
  } };
}
async function json(response, expected = 200) { assert.equal(response.status, expected, `Expected HTTP ${expected}, got ${response.status}`); return response.json(); }
async function account(server, email, signup = true) {
  const credentials = { email, password: signup ? 'Fictional QA03 password' : admin.password };
  const response = await server.call(signup ? '/auth/signup' : '/auth/login', { body: credentials });
  const profile = await json(response, signup ? 201 : 200);
  return { id: profile.id, cookie: response.headers.get('set-cookie').split(';', 1)[0] };
}
async function upload(reservation, content = bytes, fields = {}) {
  assert.ok(reservation.form, 'Reservation has an upload form');
  const data = new FormData();
  for (const [name, value] of Object.entries({ ...reservation.form.fields, ...fields })) data.append(name, value);
  data.append('file', new Blob([content], { type: 'text/plain' }), 'fictional.txt');
  return fetch(reservation.form.url, { method: 'POST', body: data, redirect: 'error', signal: AbortSignal.timeout(30000) });
}

test(`Phase 03 immutable direct uploads (${real ? 'real S3' : 'isolated storage emulator'})`, { timeout: 240000 }, async t => {
  const dbClient = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 4000 });
  await dbClient.connect();
  const db = dbClient.db(database), versions = db.collection('documentversions'), docs = db.collection('documents'), jobs = db.collection('indexjobs');
  let server;
  try {
    server = await launch(t);
    const a = await account(server, 'a@example.test'), b = await account(server, 'b@example.test'), operator = await account(server, admin.email, false);
    const thread = async () => (await json(await server.call('/conversations', { cookie: a.cookie, body: {} }), 201)).id;
    const reserve = async (id, input = body(), cookie = a.cookie) => json(await server.call(`/conversations/${id}/attachments`, { cookie, body: input }), 201);
    let first;
    await t.test('03.1 direct upload pins a private original and returns queued attachment', async () => {
      const id = await thread(); first = await reserve(id);
      const post = await upload(first); assert.ok(post.status >= 200 && post.status < 300, 'S3 accepted direct file POST');
      const result = await json(await server.call(`/uploads/${first.uploadId}/complete`, { cookie: a.cookie, body: {} }), 202);
      assert.equal(result.status, 'queued'); assert.equal(result.checksum, hash(bytes));
      const listed = await json(await server.call(`/conversations/${id}/attachments`, { cookie: a.cookie }));
      assert.equal(listed.items.length, 1); assert.equal(listed.items[0].uploadId, first.uploadId);
      assert.equal(await jobs.countDocuments({ versionId: new ObjectId(first.uploadId) }), 1);
      const objectUrl = new URL(first.form.fields.key.split('/').map(encodeURIComponent).join('/'), first.form.url.endsWith('/') ? first.form.url : first.form.url + '/');
      const anonymous = await fetch(objectUrl, { signal: AbortSignal.timeout(15000) });
      assert.equal(anonymous.status, 403, 'Actual original is private to authenticated S3 requests');
    });
    await t.test('03.2 duplicate completion and repeated reservation create one pinned version and queued job', async () => {
      const id = await thread(), input = body();
      const reservations = await Promise.all([reserve(id, input), reserve(id, input)]);
      assert.equal(reservations[0].uploadId, reservations[1].uploadId);
      const reservation = reservations[0]; assert.ok((await upload(reservation)).ok);
      const completions = await Promise.all([0, 1].map(() => server.call(`/uploads/${reservation.uploadId}/complete`, { cookie: a.cookie, body: {} }).then(response => json(response, 202))));
      assert.equal(completions[0].checksum, completions[1].checksum);
      assert.equal(await versions.countDocuments({ ownerId: new ObjectId(a.id), clientUploadId: input.clientUploadId }), 1);
      assert.equal(await jobs.countDocuments({ versionId: new ObjectId(reservation.uploadId) }), 1);
      assert.equal(await docs.countDocuments({ conversationId: new ObjectId(id) }), 1);
      assert.equal((await reserve(id, input)).status, 'queued');
    });
    await t.test('03.2 signed form replay changes latest bytes while worker input remains first pinned checksum', async () => {
      const replayBytes = Buffer.from('Fictional agreement. Notice period: 60 days.');
      assert.ok((await upload(first, replayBytes)).ok, 'Still-valid form can be replayed');
      const stored = await versions.findOne({ _id: new ObjectId(first.uploadId) });
      const pinned = await server.control('read-pinned', { versionId: first.uploadId });
      assert.equal(pinned.hash, hash(bytes)); assert.equal(pinned.versionId, stored.s3VersionId);
      const latest = await server.control('read-latest', { versionId: first.uploadId });
      assert.equal(latest.hash, hash(replayBytes)); assert.notEqual(latest.versionId, pinned.versionId);
      const replay = await json(await server.call(`/uploads/${first.uploadId}/complete`, { cookie: a.cookie, body: {} }), 202);
      assert.equal(replay.checksum, hash(bytes));
    });
    await t.test('03.3 oversized uploads, unsupported MIME and out-of-policy signed posts are rejected', async () => {
      const id = await thread();
      assert.equal((await server.call(`/conversations/${id}/attachments`, { cookie: a.cookie, body: body({ size: 5 * 1024 * 1024 + 1 }) })).status, 413);
      assert.equal((await server.call(`/conversations/${id}/attachments`, { cookie: a.cookie, body: body({ mime: 'application/zip' }) })).status, 415);
      const reservation = await reserve(id);
      assert.ok(!(await upload(reservation, Buffer.alloc(5 * 1024 * 1024 + 1))).ok, 'S3 enforces content-length policy');
      assert.ok(!(await upload(reservation, bytes, { 'Content-Type': 'application/zip' })).ok, 'S3 enforces signed MIME');
    });
    await t.test('03.3 six concurrent reservations enforce five slots and same-key retry at last slot', async () => {
      const id = await thread();
      const responses = await Promise.all(Array.from({ length: 6 }, () => server.call(`/conversations/${id}/attachments`, { cookie: a.cookie, body: body() })));
      assert.equal(responses.filter(response => response.status === 201).length, 5); assert.equal(responses.filter(response => response.status === 409).length, 1);
      const id2 = await thread(); for (let i = 0; i < 4; i++) await reserve(id2);
      const input = body(); const [one, two] = await Promise.all([reserve(id2, input), reserve(id2, input)]);
      assert.equal(one.uploadId, two.uploadId);
      assert.equal((await db.collection('conversations').findOne({ _id: new ObjectId(id2) })).attachmentCount, 5);
    });
    await t.test('03.4 ownership, customer admin denial and idempotency conflicts', async () => {
      const id = first.conversationId;
      assert.equal((await server.call(`/conversations/${id}/attachments`, { cookie: b.cookie })).status, 404);
      assert.equal((await server.call(`/uploads/${first.uploadId}/complete`, { cookie: b.cookie, body: {} })).status, 404);
      for (const method of ['GET', 'POST']) assert.equal((await server.call('/admin/documents', { cookie: a.cookie, method, ...(method === 'POST' ? { body: body() } : {}) })).status, 403);
      const shared = await json(await server.call('/admin/documents', { cookie: operator.cookie, body: body() }), 201);
      assert.ok((await upload(shared)).ok);
      assert.equal((await server.call(`/uploads/${shared.uploadId}/complete`, { cookie: operator.cookie, body: {} })).status, 202);
      const input = body(); await reserve(id, input);
      assert.equal((await server.call(`/conversations/${id}/attachments`, { cookie: a.cookie, body: { ...input, filename: 'changed.txt' } })).status, 409);
      assert.equal((await server.call(`/conversations/${id}/attachments`, { body: body() })).status, 401);
      assert.equal((await server.call(`/conversations/${id}/attachments`, { cookie: a.cookie, requestOrigin: 'https://other.example.test', body: body() })).status, 403);
    });
    await t.test('03.3 reservation expiry and slot recovery preserve pinned originals and reconcile arrived bytes', async () => {
      const id = await thread();
      const empty = await reserve(id), arrived = await reserve(id);
      assert.ok((await upload(arrived)).ok);
      await server.control('advance-clock', { milliseconds: 301000 });
      await server.control('cleanup');
      assert.equal((await versions.findOne({ _id: new ObjectId(empty.uploadId) })).state, 'expired');
      assert.equal((await versions.findOne({ _id: new ObjectId(arrived.uploadId) })).state, 'queued');
      assert.equal((await db.collection('conversations').findOne({ _id: new ObjectId(id) })).attachmentCount, 1);
      assert.equal((await server.call(`/uploads/${empty.uploadId}/complete`, { cookie: a.cookie, body: {} })).status, 409);
      const replacement = await reserve(id); assert.notEqual(replacement.uploadId, empty.uploadId);
      assert.equal((await server.control('read-pinned', { versionId: first.uploadId })).hash, hash(bytes));
      await server.control('advance-clock', { milliseconds: 3600001 }); await server.control('cleanup');
      assert.equal((await server.control('read-pinned', { versionId: first.uploadId })).hash, hash(bytes));
    });
    await t.test('03.4 configurable per-user reservation limit returns Retry-After', async subtest => {
      const limited = await launch(subtest, 2);
      const customer = await account(limited, 'limited@example.test');
      const id = (await json(await limited.call('/conversations', { cookie: customer.cookie, body: {} }), 201)).id;
      for (let i = 0; i < 2; i++) assert.equal((await limited.call(`/conversations/${id}/attachments`, { cookie: customer.cookie, body: body() })).status, 201);
      const response = await limited.call(`/conversations/${id}/attachments`, { cookie: customer.cookie, body: body() });
      const rejected = await json(response, 429); const retry = Number(response.headers.get('retry-after'));
      assert.ok(retry > 0 && retry <= 60); assert.equal(rejected.retryAfterSeconds, retry);
    });
  } finally {
    await server?.stop();
    if (real) {
      const s3 = new S3Client({ region: aws.AWS_REGION, credentials: { accessKeyId: aws.AWS_ACCESS_KEY_ID, secretAccessKey: aws.AWS_SECRET_ACCESS_KEY, sessionToken: aws.AWS_SESSION_TOKEN || undefined } });
      try {
        let KeyMarker, VersionIdMarker;
        do {
          const page = await s3.send(new ListObjectVersionsCommand({ Bucket: aws.S3_BUCKET, Prefix: prefix, KeyMarker, VersionIdMarker }));
          for (const item of [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])]) if (item.Key?.startsWith(prefix) && item.VersionId) await s3.send(new DeleteObjectCommand({ Bucket: aws.S3_BUCKET, Key: item.Key, VersionId: item.VersionId }));
          KeyMarker = page.IsTruncated ? page.NextKeyMarker : undefined; VersionIdMarker = page.IsTruncated ? page.NextVersionIdMarker : undefined;
        } while (KeyMarker);
      } finally { s3.destroy(); }
    }
    await db.dropDatabase(); await dbClient.close();
  }
});
