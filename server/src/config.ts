import { accountValidators, isConfigured } from '../../scripts/account-validation.mjs';

export function readConfig(env: NodeJS.ProcessEnv) {
  const production = env.NODE_ENV === 'production';
  const validators = accountValidators(production);
  const values = {} as Record<keyof typeof validators, string>;
  const invalid: string[] = [];
  for (const key of Object.keys(validators) as (keyof typeof validators)[]) {
    const value = env[key];
    if (isConfigured(value) && validators[key](value)) values[key] = value;
    else invalid.push(key);
  }
  if (invalid.length) throw new Error(`Invalid or missing configuration: ${invalid.join(', ')}`);

  const storageNames = ['AWS_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'S3_BUCKET', 'S3_KEY_PREFIX', 'UPLOAD_RESERVATION_LIMIT', 'UPLOAD_RESERVATION_WINDOW_SECONDS'] as const;
  const storageConfigured = storageNames.some(name => !!env[name]);
  if (storageConfigured) {
    const missing = storageNames.filter(name => !isConfigured(env[name]));
    if (missing.length) throw new Error(`Invalid or missing upload configuration: ${missing.join(', ')}`);
    if (!/^[a-z]{2}(?:-[a-z]+)+-\d+$/.test(env.AWS_REGION!) || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(env.S3_BUCKET!)
      || !/^[A-Za-z0-9/_-]+\/$/.test(env.S3_KEY_PREFIX!) || env.S3_KEY_PREFIX!.includes('..')
      || !/^\d+$/.test(env.UPLOAD_RESERVATION_LIMIT!) || !Number.isSafeInteger(Number(env.UPLOAD_RESERVATION_LIMIT)) || Number(env.UPLOAD_RESERVATION_LIMIT) < 1
      || !/^\d+$/.test(env.UPLOAD_RESERVATION_WINDOW_SECONDS!) || Number(env.UPLOAD_RESERVATION_WINDOW_SECONDS) < 1
      || Number(env.UPLOAD_RESERVATION_WINDOW_SECONDS) > 2147483) throw new Error('Invalid upload configuration.');
  }
  const indexingEnabled = env.INDEXING_ENABLED === 'true';
  if (env.INDEXING_ENABLED && !['true', 'false'].includes(env.INDEXING_ENABLED)) throw new Error('Invalid INDEXING_ENABLED.');
  if (indexingEnabled && (!storageConfigured || !isConfigured(env.OPENROUTER_API_KEY)
    || !/^[\w.-]+\/[\w.:-]+$/.test(env.OPENROUTER_EMBEDDING_MODEL ?? '')
    || !/^\d+$/.test(env.OPENROUTER_EMBEDDING_DIMENSIONS ?? '')
    || Number(env.OPENROUTER_EMBEDDING_DIMENSIONS) < 1 || Number(env.OPENROUTER_EMBEDDING_DIMENSIONS) > 8192)) throw new Error('Invalid or missing indexing configuration.');

  const answerConfigured = !!env.OPENROUTER_API_KEY && !!env.OPENROUTER_CHAT_MODEL;
  if (env.OPENROUTER_CHAT_MODEL && !/^[\w.-]+\/[\w.:-]+$/.test(env.OPENROUTER_CHAT_MODEL)) throw new Error('Invalid OPENROUTER_CHAT_MODEL.');
  if (env.ANSWER_DEADLINE_MS && (!/^\d+$/.test(env.ANSWER_DEADLINE_MS) || Number(env.ANSWER_DEADLINE_MS) < 1000 || Number(env.ANSWER_DEADLINE_MS) > 180000)) throw new Error('Invalid ANSWER_DEADLINE_MS.');
  const telemetryConfigured = !!env.LANGFUSE_BASE_URL && !!env.LANGFUSE_PUBLIC_KEY && !!env.LANGFUSE_SECRET_KEY;
  if (telemetryConfigured && !/^https:\/\/(?:us\.|jp\.|hipaa\.)?cloud\.langfuse\.com\/?$/.test(env.LANGFUSE_BASE_URL!)) throw new Error('Invalid LANGFUSE_BASE_URL.');
  if (env.HOST && !['0.0.0.0', '::', '127.0.0.1', '::1', 'localhost'].includes(env.HOST)) throw new Error('Invalid HOST.');
  for (const key of ['CHAT_GENERATION_LIMIT', 'CHAT_GENERATION_WINDOW_SECONDS', 'CHAT_ATTEMPT_LEASE_MS']) {
    if (env[key] && (!/^\d+$/.test(env[key]!) || !Number.isSafeInteger(Number(env[key])) || Number(env[key]) < (key === 'CHAT_ATTEMPT_LEASE_MS' ? 1000 : 1) || Number(env[key]) > 2147483)) throw new Error(`Invalid ${key}.`);
  }
  return {
    generationLimit: Number(env.CHAT_GENERATION_LIMIT ?? 10),
    generationWindowMs: Number(env.CHAT_GENERATION_WINDOW_SECONDS ?? 600) * 1000,
    attemptLeaseMs: Number(env.CHAT_ATTEMPT_LEASE_MS ?? 90000),
    queryEmbedding: env.OPENROUTER_API_KEY && /^[\w.-]+\/[\w.:-]+$/.test(env.OPENROUTER_EMBEDDING_MODEL ?? '')
      && /^\d+$/.test(env.OPENROUTER_EMBEDDING_DIMENSIONS ?? '') && Number(env.OPENROUTER_EMBEDDING_DIMENSIONS) >= 1 && Number(env.OPENROUTER_EMBEDDING_DIMENSIONS) <= 8192
      ? { apiKey: env.OPENROUTER_API_KEY, model: env.OPENROUTER_EMBEDDING_MODEL!, dimensions: Number(env.OPENROUTER_EMBEDDING_DIMENSIONS), leaseMs: 120000, indexWaitMs: 180000 } : undefined,
    answer: answerConfigured ? { apiKey: env.OPENROUTER_API_KEY!, model: env.OPENROUTER_CHAT_MODEL!, deadlineMs: Number(env.ANSWER_DEADLINE_MS ?? 90000) } : undefined,
    telemetry: telemetryConfigured ? { baseUrl: env.LANGFUSE_BASE_URL!.replace(/\/$/, ''), publicKey: env.LANGFUSE_PUBLIC_KEY!, secretKey: env.LANGFUSE_SECRET_KEY!, environment: env.LANGFUSE_TRACING_ENVIRONMENT ?? (production ? 'production' : 'development') } : undefined,
    origin: values.APP_ORIGIN,
    port: Number(values.PORT),
    host: env.HOST || (production ? '0.0.0.0' : new URL(values.APP_ORIGIN).hostname.replace(/^\[|\]$/g, '')),
    secureCookie: values.APP_ORIGIN.startsWith('https:'),
    trustedProxy: production && env.RENDER === 'true' ? 1 : false as const,
    mongoUri: values.MONGODB_URI,
    database: values.MONGODB_DB_NAME,
    secret: values.JWT_SECRET,
    issuer: values.JWT_ISSUER,
    audience: values.JWT_AUDIENCE,
    ttl: Number(values.JWT_TTL_SECONDS),
    adminEmail: values.ADMIN_SEED_EMAIL.toLowerCase(),
    adminPassword: values.ADMIN_SEED_PASSWORD,
    authLimit: Number(values.AUTH_LOGIN_LIMIT),
    authWindowMs: Number(values.AUTH_LOGIN_WINDOW_SECONDS) * 1000,
    indexing: indexingEnabled ? { apiKey: env.OPENROUTER_API_KEY!, model: env.OPENROUTER_EMBEDDING_MODEL!,
      dimensions: Number(env.OPENROUTER_EMBEDDING_DIMENSIONS), leaseMs: 120000, indexWaitMs: 180000 } : undefined,
    storage: storageConfigured ? {
      region: env.AWS_REGION!, bucket: env.S3_BUCKET!, prefix: env.S3_KEY_PREFIX!,
      credentials: { accessKeyId: env.AWS_ACCESS_KEY_ID!, secretAccessKey: env.AWS_SECRET_ACCESS_KEY!, sessionToken: env.AWS_SESSION_TOKEN || undefined },
      reservationLimit: Number(env.UPLOAD_RESERVATION_LIMIT), reservationWindowMs: Number(env.UPLOAD_RESERVATION_WINDOW_SECONDS) * 1000,
    } : undefined,
  };
}

export type Config = ReturnType<typeof readConfig>;
