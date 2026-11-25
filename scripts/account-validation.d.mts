export function isConfigured(value: string | undefined): value is string;
export function isEmail(value: string): boolean;
export function isBcryptPassword(value: string): boolean;
export function accountValidators(production: boolean): Record<
  'NODE_ENV' | 'APP_ORIGIN' | 'PORT' | 'JWT_SECRET' | 'JWT_ISSUER' | 'JWT_AUDIENCE' |
  'JWT_TTL_SECONDS' | 'ADMIN_SEED_EMAIL' | 'ADMIN_SEED_PASSWORD' | 'MONGODB_URI' |
  'MONGODB_DB_NAME' | 'AUTH_LOGIN_LIMIT' | 'AUTH_LOGIN_WINDOW_SECONDS',
  (value: string) => boolean
>;
