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

  return {
    origin: values.APP_ORIGIN,
    port: Number(values.PORT),
    host: production ? '0.0.0.0' : new URL(values.APP_ORIGIN).hostname.replace(/^\[|\]$/g, ''),
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
    storage: storageConfigured ? {
      region: env.AWS_REGION!, bucket: env.S3_BUCKET!, prefix: env.S3_KEY_PREFIX!,
      credentials: { accessKeyId: env.AWS_ACCESS_KEY_ID!, secretAccessKey: env.AWS_SECRET_ACCESS_KEY!, sessionToken: env.AWS_SESSION_TOKEN || undefined },
      reservationLimit: Number(env.UPLOAD_RESERVATION_LIMIT), reservationWindowMs: Number(env.UPLOAD_RESERVATION_WINDOW_SECONDS) * 1000,
    } : undefined,
  };
}

export type Config = ReturnType<typeof readConfig>;
