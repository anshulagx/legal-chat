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
  };
}

export type Config = ReturnType<typeof readConfig>;
