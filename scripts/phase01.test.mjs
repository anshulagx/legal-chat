import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import { MongoClient } from 'mongodb';

const fixtureDatabase = `legal_chat_qa01_${randomUUID().replaceAll('-', '')}`;
const mongoUri = process.env.QA_MONGODB_URI ?? 'mongodb://127.0.0.1:27017';
const admin = { email: 'admin@example.test', password: randomBytes(24).toString('hex') };
const fixture = fileURLToPath(new URL('./phase01-fixture.mjs', import.meta.url));

async function unusedPort() {
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const { port } = reservation.address();
  await new Promise(resolve => reservation.close(resolve));
  return port;
}

async function launch(t, { limit = 20, secure = false } = {}) {
  const port = await unusedPort();
  const base = `http://127.0.0.1:${port}`;
  const origin = secure ? `https://127.0.0.1:${port}` : base;
  const app = fork(fixture, {
    env: {
      NODE_ENV: secure ? 'production' : 'test',
      PORT: String(port), APP_ORIGIN: origin,
      MONGODB_URI: mongoUri, MONGODB_DB_NAME: fixtureDatabase,
      JWT_SECRET: randomBytes(32).toString('hex'),
      JWT_ISSUER: 'qa01', JWT_AUDIENCE: 'browser-qa01', JWT_TTL_SECONDS: '900',
      ADMIN_SEED_EMAIL: admin.email, ADMIN_SEED_PASSWORD: admin.password,
      AUTH_LOGIN_LIMIT: String(limit), AUTH_LOGIN_WINDOW_SECONDS: '60',
    },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    execArgv: [],
  });
  const exited = once(app, 'exit');
  t.after(async () => {
    if (app.exitCode === null && app.signalCode === null) app.kill('SIGTERM');
    await exited;
  });

  function call(path, { body, method = body ? 'POST' : 'GET', requestOrigin = origin, cookie } = {}) {
    const headers = {};
    if (method === 'POST') headers.Origin = requestOrigin;
    if (body) headers['Content-Type'] = 'application/json';
    if (cookie) headers.Cookie = cookie;
    return fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(4500) });
  }

  for (let tries = 0; tries < 50; tries++) {
    const ready = await call('/health/ready').catch(() => null);
    if (ready?.status === 200) return { app, call };
    if (app.exitCode !== null || app.signalCode !== null) break;
    await delay(300);
  }
  assert.fail('App did not become ready. Verify the build and isolated MongoDB connectivity and permissions.');
}

function sessionCookie(response, secure) {
  const header = response.headers.get('set-cookie') ?? '';
  assert.ok(/; HttpOnly(?:;|$)/i.test(header), 'HttpOnly attribute');
  assert.ok(/; SameSite=Lax(?:;|$)/i.test(header), 'SameSite=Lax attribute');
  assert.ok(/; Path=\/(?:;|$)/i.test(header), 'Path=/ attribute');
  assert.equal(/; Secure(?:;|$)/i.test(header), secure, 'Secure attribute matches HTTPS');
  assert.ok(!/; Domain=/i.test(header), 'Cookie is host-only');
  const cookie = header.split(';', 1)[0];
  assert.ok(cookie.startsWith(secure ? '__Host-legal_session=' : 'legal_session='), 'Session cookie name');
  return cookie;
}

test('Phase 01 service checks', async t => {
  const db = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 3000 });
  try {
    await db.connect();
  } catch {
    await db.close();
    assert.fail('Isolated MongoDB connection unavailable.');
  }
  const users = db.db(fixtureDatabase).collection('users');
  try {
    const first = await launch(t);
    const { call } = first;
    const customer = { email: 'Customer.A@example.test', password: 'QA-only customer password' };

    await t.test('01.1 liveness and readiness start healthy', async () => {
      for (const path of ['/health/live', '/health/ready']) {
        const response = await call(path);
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { status: 'ok' });
      }
      assert.equal((await call('/')).status, 200);
    });

    await t.test('01.2 signup, login, reload session, logout and revocation', async () => {
      assert.equal((await call('/auth/me')).status, 401);
      const signup = await call('/auth/signup', { body: customer });
      assert.equal(signup.status, 201);
      const cookie = sessionCookie(signup, false);
      const profile = await signup.json();
      assert.deepEqual(Object.keys(profile).sort(), ['email', 'id', 'role']);
      assert.equal(profile.email, customer.email.toLowerCase());
      const me = await call('/auth/me', { cookie });
      assert.equal(me.status, 200);
      assert.equal(me.headers.get('cache-control'), 'no-store');
      assert.deepEqual(await me.json(), profile);
      const logout = await call('/auth/logout', { method: 'POST', cookie });
      assert.equal(logout.status, 204);
      sessionCookie(logout, false);
      assert.equal((await call('/auth/me', { cookie })).status, 401);
      const login = await call('/auth/login', { body: customer });
      assert.equal(login.status, 200);
      assert.deepEqual(await (await call('/auth/me', { cookie: sessionCookie(login, false) })).json(), profile);
    });

    await t.test('01.3 unique normalization, bcrypt, role, credentials and Origin', async () => {
      assert.equal((await call('/auth/signup', { body: { ...customer, email: customer.email.toLowerCase() } })).status, 409);
      const tooLong = await call('/auth/signup', { body: { email: 'long@example.test', password: 'é'.repeat(37) } });
      assert.equal(tooLong.status, 400);
      assert.ok((await tooLong.json()).fields?.password);
      const second = await call('/auth/signup', { body: { ...customer, email: 'customer.b@example.test', role: 'admin' } });
      assert.equal(second.status, 201);
      assert.equal((await second.json()).role, 'customer');
      assert.equal((await call('/auth/signup', { body: { ...customer, email: 'foreign@example.test' }, requestOrigin: 'https://other.example.test' })).status, 403);
      const emailNormalized = customer.email.toLowerCase();
      assert.equal(await users.countDocuments({ emailNormalized }), 1);
      const stored = await users.findOne({ emailNormalized });
      assert.ok(/^\$2[aby]\$12\$/.test(stored?.passwordHash ?? ''), 'Bcrypt hash with cost 12 persisted');
      assert.ok(await bcrypt.compare(customer.password, stored.passwordHash), 'Bcrypt verifies fixture password');
      assert.equal(await users.countDocuments({ emailNormalized: { $in: ['long@example.test', 'foreign@example.test'] } }), 0);
      const failures = [];
      for (const email of [customer.email, 'unknown@example.test']) {
        const result = await call('/auth/login', { body: { email, password: 'wrong QA password' } });
        assert.equal(result.status, 401);
        const { code, message, requestId } = await result.json();
        assert.equal(result.headers.get('x-request-id'), requestId);
        failures.push({ code, message });
      }
      assert.deepEqual(failures[0], failures[1]);
      const seeded = await call('/auth/login', { body: admin });
      assert.equal(seeded.status, 200);
      assert.equal((await seeded.json()).role, 'admin');
    });

    await t.test('01.4 small IP limit includes Retry-After', async subtest => {
      const limited = await launch(subtest, { limit: 2, secure: true });
      const login = await limited.call('/auth/login', { body: customer });
      assert.equal(login.status, 200);
      sessionCookie(login, true);
      assert.equal((await limited.call('/auth/login', { body: admin })).status, 200);
      const rejected = await limited.call('/auth/login', { body: customer });
      assert.equal(rejected.status, 429);
      const retry = Number(rejected.headers.get('retry-after'));
      assert.ok(retry > 0 && retry <= 60);
      assert.equal((await rejected.json()).retryAfterSeconds, retry);
    });

    await t.test('01.1 disconnect turns readiness unhealthy and preserves liveness', async () => {
      const message = once(first.app, 'message', { signal: AbortSignal.timeout(5000) });
      first.app.send('disconnect-database');
      assert.deepEqual(await message, ['database-disconnected']);
      const ready = await call('/health/ready');
      assert.equal(ready.status, 503);
      assert.deepEqual(await ready.json(), { status: 'unavailable' });
      assert.equal((await call('/health/live')).status, 200);
    });
  } finally {
    try {
      await db.db(fixtureDatabase).dropDatabase();
    } catch {
      assert.fail('Could not clean up the generated QA database.');
    } finally {
      await db.close();
    }
  }
});
