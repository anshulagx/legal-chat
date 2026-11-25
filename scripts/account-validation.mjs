export function matchesUrl(value, schemes, originOnly = false) {
  try {
    const url = new URL(value);
    return schemes.includes(url.protocol) && !!url.hostname && !url.username && !url.password
      && (!originOnly || url.origin === value);
  } catch {
    return false;
  }
}

export function integer(value, min, max) {
  return /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) >= min && Number(value) <= max;
}

export function isConfigured(value) {
  return !!value?.trim() && !/^(?:your[_ -]|replace[_ -]|changeme$|<|\$\{)/i.test(value.trim());
}

export function isEmail(value) {
  return Buffer.byteLength(value) <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export function isBcryptPassword(value) {
  return !!value.trim() && Buffer.byteLength(value) <= 72;
}

export function accountValidators(production) {
  return {
    NODE_ENV: value => ['development', 'production', 'test'].includes(value),
    APP_ORIGIN: value => matchesUrl(value, production ? ['https:'] : ['http:', 'https:'], true),
    PORT: value => integer(value, 1, 65535),
    JWT_SECRET: value => Buffer.byteLength(value) >= 32,
    JWT_ISSUER: value => !/\s/.test(value),
    JWT_AUDIENCE: value => !/\s/.test(value),
    JWT_TTL_SECONDS: value => integer(value, 1, 86400),
    ADMIN_SEED_EMAIL: isEmail,
    ADMIN_SEED_PASSWORD: isBcryptPassword,
    MONGODB_URI: value => /^mongodb(?:\+srv)?:\/\/.+/.test(value) && !/<[^>]+>/.test(value),
    MONGODB_DB_NAME: value => /^[a-zA-Z0-9_-]{1,63}$/.test(value),
    AUTH_LOGIN_LIMIT: value => integer(value, 1, Number.MAX_SAFE_INTEGER),
    AUTH_LOGIN_WINDOW_SECONDS: value => integer(value, 1, 2147483),
  };
}
