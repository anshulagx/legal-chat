import { execFile } from 'node:child_process';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { lookup, resolveSrv } from 'node:dns/promises';
import { readFile } from 'node:fs/promises';
import { parseArgs, parseEnv, promisify } from 'node:util';
import { probeAtlas, probeS3 } from './preflight-storage.mjs';

const { values: args } = parseArgs({
  options: {
    'env-file': { type: 'string' },
    'allow-model-calls': { type: 'boolean', default: false },
  },
});

const run = promisify(execFile);
const timeout = 12_000;
const valid = new Set();

class CheckError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function report(status, name, evidence) {
  console.log(`${status}  ${name} — ${evidence}`);
  if (status === 'FAIL' || status === 'BLOCKED') process.exitCode = 1;
}

function requireThat(condition, message) {
  if (!condition) throw new CheckError('FAIL', message);
}

async function check(name, action) {
  try {
    report('PASS', name, await action());
  } catch (error) {
    const code = error.cause?.code ?? error.reason?.error?.code ?? error.code;
    if (error instanceof CheckError) {
      report(error.status, name, error.message);
    } else if (error.code === 'ERR_MODULE_NOT_FOUND') {
      report('BLOCKED', name, 'Install the preflight dependencies with npm install.');
    } else if (['ENOTFOUND', 'ENODATA', 'EAI_AGAIN', 'ECONNREFUSED', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT'].includes(code)
      || ['TimeoutError', 'MongoServerSelectionError'].includes(error.name)) {
      report('BLOCKED', name, 'Connection unavailable. Check DNS, network access and provider IP allowlists.');
    } else {
      const status = error.$metadata?.httpStatusCode ?? error.statusCode;
      report('FAIL', name, Number.isInteger(status)
        ? `Provider returned HTTP ${status}.`
        : 'Probe failed. Check the configured service and permissions.');
    }
  }
}

function requireFields(...names) {
  const missing = names.filter(name => !valid.has(name));
  if (missing.length) throw new CheckError('BLOCKED', `Resolve ${missing.join(', ')} first.`);
}

function urlMatches(value, schemes, originOnly = false) {
  try {
    const url = new URL(value);
    return schemes.includes(url.protocol) && url.hostname && !url.username && !url.password
      && (!originOnly || url.origin === value);
  } catch {
    return false;
  }
}

function integer(value, min, max) {
  return /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) >= min && Number(value) <= max;
}

function validate(env, template) {
  const production = env.NODE_ENV === 'production';
  const validators = {
    NODE_ENV: value => ['development', 'production', 'test'].includes(value),
    APP_ORIGIN: value => urlMatches(value, production ? ['https:'] : ['http:', 'https:'], true),
    PORT: value => integer(value, 1, 65535),
    JWT_SECRET: value => Buffer.byteLength(value) >= 32,
    JWT_TTL_SECONDS: value => integer(value, 1, Number.MAX_SAFE_INTEGER),
    ADMIN_SEED_EMAIL: value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value),
    ADMIN_SEED_PASSWORD: value => Buffer.byteLength(value) <= 72,
    MONGODB_URI: value => /^mongodb(?:\+srv)?:\/\/.+/.test(value) && !/<[^>]+>/.test(value),
    MONGODB_DB_NAME: value => /^[a-zA-Z0-9_-]{1,63}$/.test(value),
    AWS_REGION: value => /^[a-z]{2}(?:-[a-z]+)+-\d+$/.test(value),
    AWS_ACCESS_KEY_ID: value => /^(AKIA|ASIA)[A-Z0-9]{16}$/.test(value),
    AWS_SECRET_ACCESS_KEY: value => /^[A-Za-z0-9+/=]{40}$/.test(value),
    AWS_SESSION_TOKEN: value => !/\s/.test(value),
    S3_BUCKET: value => /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(value),
    S3_KEY_PREFIX: value => /^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*\/$/.test(value),
    OPENROUTER_API_KEY: value => !/\s/.test(value),
    OPENROUTER_CHAT_MODEL: value => /^[\w.-]+\/[\w.:-]+$/.test(value),
    OPENROUTER_EMBEDDING_MODEL: value => /^[\w.-]+\/[\w.:-]+$/.test(value),
    OPENROUTER_EMBEDDING_DIMENSIONS: value => integer(value, 1, 8192),
    LANGFUSE_BASE_URL: value => urlMatches(value.replace(/\/$/, ''), ['https:'], true),
    LANGFUSE_PUBLIC_KEY: value => /^pk-lf-\S+$/.test(value),
    LANGFUSE_SECRET_KEY: value => /^sk-lf-\S+$/.test(value),
    LANGFUSE_TRACE_CONTENT: value => value === 'false' || (!production && value === 'true'),
  };
  for (const name of Object.keys(template)) {
    const value = env[name];
    if (name === 'AWS_SESSION_TOKEN' && !value && !env.AWS_ACCESS_KEY_ID?.startsWith('ASIA')) {
      valid.add(name);
      report('PASS', name, 'Optional with a long-lived IAM access key.');
    } else if (!value?.trim() || /^(?:your[_ -]|replace[_ -]|changeme$|<|\$\{)/i.test(value.trim())) {
      report('BLOCKED', name, 'Missing or placeholder.');
    } else {
      const validator = validators[name] ?? (name.endsWith('_LIMIT') || name.endsWith('_WINDOW_SECONDS')
        ? candidate => integer(candidate, 1, Number.MAX_SAFE_INTEGER)
        : candidate => !/\s/.test(candidate));
      if (!validator(value)) {
        report('FAIL', name, 'Value does not match the required format or range.');
      } else {
        env[name] = value;
        valid.add(name);
        report('PASS', name, 'Present and valid format.');
      }
    }
  }
}

async function providerFetch(url, init, expectedStatus = 200) {
  const response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(timeout) });
  requireThat(response.status === expectedStatus, `Provider returned HTTP ${response.status}.`);
  return response;
}

function openRouter(env, path, payload) {
  return providerFetch(`https://openrouter.ai/api/v1/${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

async function openRouterReady() {
  requireFields('OPENROUTER_API_KEY');
  await lookup('openrouter.ai');
  if (!args['allow-model-calls']) {
    throw new CheckError('BLOCKED', 'Set an OpenRouter key cap and rerun with --allow-model-calls.');
  }
}

async function runChecks(env) {
  const production = env.NODE_ENV === 'production';
  let embedding;
  await Promise.all([
    check('JWT signing and verification', async () => {
      requireFields('JWT_SECRET', 'JWT_ISSUER', 'JWT_AUDIENCE', 'JWT_TTL_SECONDS');
      const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
      const claims = { iss: env.JWT_ISSUER, aud: env.JWT_AUDIENCE, sub: 'preflight', exp: Math.floor(Date.now() / 1000) + Number(env.JWT_TTL_SECONDS) };
      const body = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(claims)}`;
      const sign = value => createHmac('sha256', env.JWT_SECRET).update(value).digest();
      const token = `${body}.${sign(body).toString('base64url')}`;
      const [header, payload, signature] = token.split('.');
      const decoded = JSON.parse(Buffer.from(payload, 'base64url'));
      requireThat(timingSafeEqual(sign(`${header}.${payload}`), Buffer.from(signature, 'base64url'))
        && decoded.iss === claims.iss && decoded.aud === claims.aud && decoded.exp > Date.now() / 1000, 'JWT verification failed.');
      return 'Disposable HS256 token verified.';
    }),
    check('OpenRouter chat', async () => {
      requireFields('OPENROUTER_CHAT_MODEL');
      await openRouterReady();
      const result = await openRouter(env, 'chat/completions', {
        model: env.OPENROUTER_CHAT_MODEL, max_tokens: 16,
        messages: [{ role: 'user', content: 'Reply with the word OK.' }],
      });
      const body = await result.json();
      requireThat(Boolean(body.choices?.[0]?.message?.content?.trim()), 'Chat response was empty.');
      return `${env.OPENROUTER_CHAT_MODEL} returned a response.`;
    }),
    check('OpenRouter embeddings', async () => {
      requireFields('OPENROUTER_EMBEDDING_MODEL', 'OPENROUTER_EMBEDDING_DIMENSIONS');
      await openRouterReady();
      const result = await openRouter(env, 'embeddings', {
        model: env.OPENROUTER_EMBEDDING_MODEL, input: 'Fictional legal chat preflight fixture.',
        dimensions: Number(env.OPENROUTER_EMBEDDING_DIMENSIONS),
      });
      const body = await result.json();
      const vector = body.data?.[0]?.embedding;
      requireThat(Array.isArray(vector) && vector.length === Number(env.OPENROUTER_EMBEDDING_DIMENSIONS)
        && vector.every(Number.isFinite), 'Embedding dimension or values differ from configuration.');
      embedding = vector;
      return `${env.OPENROUTER_EMBEDDING_MODEL} returned ${vector.length} dimensions.`;
    }),
    check('Amazon S3', async () => {
      requireFields('NODE_ENV', 'APP_ORIGIN', 'AWS_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'S3_BUCKET', 'S3_KEY_PREFIX');
      await lookup(`s3.${env.AWS_REGION}.amazonaws.com`);
      return await probeS3(env, production, requireThat);
    }),
    check('Langfuse Cloud', async () => {
      requireFields('NODE_ENV', 'LANGFUSE_BASE_URL', 'LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY', 'LANGFUSE_TRACING_ENVIRONMENT', 'LANGFUSE_TRACE_CONTENT');
      const base = env.LANGFUSE_BASE_URL.replace(/\/$/, '');
      const origin = new URL(base);
      requireThat(['cloud.langfuse.com', 'us.cloud.langfuse.com', 'jp.cloud.langfuse.com', 'hipaa.cloud.langfuse.com'].includes(origin.hostname)
        && !origin.port, 'Expected an official Langfuse Cloud origin.');
      const headers = { Authorization: `Basic ${Buffer.from(`${env.LANGFUSE_PUBLIC_KEY}:${env.LANGFUSE_SECRET_KEY}`).toString('base64')}` };
      const project = await (await providerFetch(`${base}/api/public/projects`, { headers })).json();
      requireThat(Array.isArray(project.data) && project.data.length > 0, 'No project found for these keys.');
      if (production) return 'Project access confirmed with a read-only request.';
      const traceId = randomUUID().replaceAll('-', '');
      const start = BigInt(Date.now()) * 1_000_000n;
      const otlp = { resourceSpans: [{
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'legal-chat-preflight' } }] },
        scopeSpans: [{ scope: { name: 'legal-chat-preflight' }, spans: [{
          traceId, spanId: randomUUID().replaceAll('-', '').slice(0, 16), name: 'legal-chat-preflight', kind: 1,
          startTimeUnixNano: String(start), endTimeUnixNano: String(start + 1_000_000n),
          attributes: [{ key: 'langfuse.environment', value: { stringValue: env.LANGFUSE_TRACING_ENVIRONMENT } }],
        }] }],
      }] };
      const result = await providerFetch(`${base}/api/public/otel/v1/traces`, {
        method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(otlp),
      });
      const accepted = await result.json();
      requireThat(!Number(accepted.partialSuccess?.rejectedSpans ?? 0), 'Langfuse rejected the trace.');
      report('MANUAL', 'Langfuse dashboard', `Locate content-free trace ${traceId} in the configured project.`);
      return 'Project access and content-free trace ingestion confirmed.';
    }),
    check('Docker Compose', async () => {
      try {
        await run('docker', ['compose', 'version'], { timeout });
        await run('docker', ['version', '--format', '{{.Server.Version}}'], { timeout });
      } catch {
        throw new CheckError('BLOCKED', 'The Docker Compose CLI or daemon is unavailable to this process.');
      }
      return 'Compose CLI and Docker daemon accessible.';
    }),
  ]);
  await check('MongoDB Atlas', async () => {
    requireFields('NODE_ENV', 'MONGODB_URI', 'MONGODB_DB_NAME');
    if (env.MONGODB_URI.startsWith('mongodb+srv://')) {
      const authority = env.MONGODB_URI.slice('mongodb+srv://'.length).split(/[/?]/, 1)[0];
      await resolveSrv(`_mongodb._tcp.${authority.slice(authority.lastIndexOf('@') + 1)}`);
    }
    return await probeAtlas(env, production, embedding, requireThat, message => new CheckError('BLOCKED', message));
  });
  report('MANUAL', 'GitHub, Render, browser and demo', 'Verify baseline SHA and write route, Render service and outbound IPs, Chrome, screen reader and recording access.');
}

if (!args['env-file']) {
  report('BLOCKED', 'Env file', 'Run npm run preflight -- --env-file <path>.');
} else {
  try {
    const template = parseEnv(await readFile(new URL('../.env.example', import.meta.url), 'utf8'));
    const env = parseEnv(await readFile(args['env-file'], 'utf8'));
    console.log(`Node ${process.versions.node} preflight`);
    validate(env, template);
    await runChecks(env);
  } catch {
    report('BLOCKED', 'Env file', 'Unable to read or parse the selected env file and template.');
  }
}
