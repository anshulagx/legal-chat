import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import express, { type Request, type Response } from 'express';
import { rateLimit, type RateLimitInfo } from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import { isBcryptPassword, isEmail } from '../../scripts/account-validation.mjs';
import { isDuplicate, passwordCost, Session, User } from './accounts.ts';
import type { Config } from './config.ts';
import { HttpError, sendError } from './http.ts';

type Account = InstanceType<typeof User>;
const invalidLogin = () => new HttpError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
const unauthorized = () => new HttpError(401, 'UNAUTHENTICATED', 'Please log in to continue.');
const objectId = /^[a-f0-9]{24}$/;
const dummyHash = bcrypt.hash(randomBytes(24).toString('hex'), passwordCost);

function credentials(body: unknown) {
  const values = body as Record<string, unknown> | null | undefined;
  return {
    email: typeof values?.email === 'string' ? values.email.trim().toLowerCase() : '',
    password: typeof values?.password === 'string' ? values.password : '',
  };
}

function profile(account: Account) {
  return { id: account.id, email: account.emailNormalized, role: account.role };
}

export function authRouter(config: Config, available: () => boolean) {
  const router = express.Router();
  const name = config.secureCookie ? '__Host-legal_session' : 'legal_session';
  const cookie = { httpOnly: true, sameSite: 'lax', path: '/', secure: config.secureCookie } as const;

  const limiter = rateLimit({
    windowMs: config.authWindowMs,
    limit: config.authLimit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (req, res) => {
      const info = (req as Request & { rateLimit?: RateLimitInfo }).rateLimit;
      const reset = info?.resetTime?.getTime() ?? Date.now() + config.authWindowMs;
      const retry = Math.max(1, Math.ceil((reset - Date.now()) / 1000));
      res.set('Retry-After', String(retry));
      sendError(res, new HttpError(429, 'AUTH_RATE_LIMIT', 'Too many attempts. Please try again shortly.'), retry);
    },
  });

  async function issueSession(account: Account, res: Response, status: number) {
    const issuedAt = Math.floor(Date.now() / 1000);
    const session = await Session.create({ userId: account._id, expiresAt: new Date((issuedAt + config.ttl) * 1000) });
    const token = jwt.sign({ iat: issuedAt }, config.secret, {
      algorithm: 'HS256', issuer: config.issuer, audience: config.audience,
      subject: account.id, jwtid: session.id, expiresIn: config.ttl,
    });
    res.cookie(name, token, { ...cookie, expires: session.expiresAt });
    res.status(status).json(profile(account));
  }

  function sessionIdentity(req: Request) {
    const value = req.headers.cookie?.split(';').map(part => part.trim())
      .find(part => part.startsWith(`${name}=`))?.slice(name.length + 1);
    if (!value) return null;
    try {
      const claims = jwt.verify(value, config.secret, {
        algorithms: ['HS256'], issuer: config.issuer, audience: config.audience,
      });
      if (typeof claims === 'string' || typeof claims.exp !== 'number'
        || typeof claims.sub !== 'string' || !objectId.test(claims.sub)
        || typeof claims.jti !== 'string' || !objectId.test(claims.jti)) return null;
      return { _id: claims.jti, userId: claims.sub };
    } catch {
      return null;
    }
  }

  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.get('Origin') !== config.origin) {
      return next(new HttpError(403, 'INVALID_ORIGIN', 'This request must originate from the app.'));
    }
    if (!available()) return next(new HttpError(503, 'UNAVAILABLE', 'Account services are temporarily unavailable.'));
    next();
  });

  const json = express.json({ limit: '4kb' });
  router.post('/signup', limiter, json, async (req, res) => {
    const { email, password } = credentials(req.body);
    const fields: Record<string, string> = {};
    if (!isEmail(email)) fields.email = 'Enter a valid email address.';
    if (!isBcryptPassword(password)) fields.password = 'Enter a password of at most 72 UTF-8 bytes.';
    if (Object.keys(fields).length) throw new HttpError(400, 'INVALID_INPUT', 'Check the highlighted fields.', fields);
    let account;
    try {
      account = await User.create({ emailNormalized: email, passwordHash: await bcrypt.hash(password, passwordCost), role: 'customer' });
    } catch (error) {
      if (isDuplicate(error)) throw new HttpError(409, 'EMAIL_IN_USE', 'An account already uses this email.', {
        email: 'Log in or use another email address.',
      });
      throw error;
    }
    await issueSession(account, res, 201);
  });

  router.post('/login', limiter, json, async (req, res) => {
    const { email, password } = credentials(req.body);
    if (!isEmail(email) || !isBcryptPassword(password)) throw invalidLogin();
    const account = await User.findOne({ emailNormalized: email }).select('+passwordHash');
    const matches = await bcrypt.compare(password, account?.passwordHash ?? await dummyHash);
    if (!account || !matches) throw invalidLogin();
    await issueSession(account, res, 200);
  });

  router.get('/me', async (req, res) => {
    const identity = sessionIdentity(req);
    if (!identity || !await Session.exists({ ...identity, revokedAt: null, expiresAt: { $gt: new Date() } })) {
      throw unauthorized();
    }
    const account = await User.findById(identity.userId);
    if (!account) throw unauthorized();
    res.json(profile(account));
  });

  router.post('/logout', async (req, res) => {
    const identity = sessionIdentity(req);
    if (identity) await Session.updateOne({ ...identity, revokedAt: null }, { $set: { revokedAt: new Date() } });
    res.clearCookie(name, cookie).status(204).end();
  });
  return router;
}
