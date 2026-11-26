import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import express from 'express';
import mongoose from 'mongoose';
import { initializeAccounts } from './accounts.ts';
import { authRouter } from './auth.ts';
import { chatRouter } from './chat.ts';
import { sourceRouter } from './sources.ts';
import { initializeConversations } from './conversations.ts';
import { cleanupUploads, initializeUploads, uploadRouter } from './uploads.ts';
import { createStorage } from './storage.ts';
import { initializeIndexRecords } from './index-records.ts';
import { startIndexWorker } from './index-worker.ts';
import { readConfig } from './config.ts';
import { errorHandler, HttpError, requestMetadata } from './http.ts';

let config;
try {
  config = readConfig(process.env);
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}

const app = express();
const currentConfig = config;
const storage = createStorage(config);
const storageOrigin = config.storage ? `https://${config.storage.bucket}.s3.${config.storage.region}.amazonaws.com` : '';
const assets = fileURLToPath(new URL('../../client/dist/', import.meta.url));
let initialized = false;
let stopping = false;
let stopWorker = () => {};
const available = () => initialized && !stopping && mongoose.connection.readyState === 1;

app.disable('x-powered-by');
app.set('trust proxy', config.trustedProxy);
app.use(requestMetadata, (_req, res, next) => {
  res.set({
    'Content-Security-Policy': `default-src 'self'; connect-src 'self' ${storageOrigin}; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`,
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  });
  next();
});

app.get('/health/live', (_req, res) => res.set('Cache-Control', 'no-store').json({ status: 'ok' }));
app.get('/health/ready', async (_req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    if (available()) {
      await mongoose.connection.db!.command({ ping: 1 }, { timeoutMS: 1500 });
      return res.json({ status: 'ok' });
    }
  } catch {
    // Keep infrastructure details out of the response.
  }
  res.status(503).json({ status: 'unavailable' });
});
app.use('/auth', authRouter(config, available));
app.use(chatRouter(config, available));
app.use(sourceRouter(config, available, storage));
app.use(uploadRouter(config, available, storage));
app.get(['/', '/login', '/signup', '/app'], (_req, res) => {
  res.set('Cache-Control', 'no-store').sendFile(resolve(assets, 'index.html'));
});
app.use('/assets', express.static(resolve(assets, 'assets'), { index: false, immutable: true, maxAge: '1y' }));
app.use('/fixtures', express.static(resolve(assets, 'fixtures'), { index: false, setHeaders: res => res.setHeader('Content-Disposition', 'attachment') }));
app.use((_req, _res, next) => next(new HttpError(404, 'NOT_FOUND', 'This page could not be found.')));
app.use(errorHandler);

mongoose.set('bufferCommands', false);
const server = app.listen(config.port, config.host);
server.once('listening', () => console.info(JSON.stringify({ event: 'listening', port: currentConfig.port })));
server.on('error', () => {
  console.error(JSON.stringify({ event: 'listener_failed' }));
  process.exit(1);
});

async function connectDatabase() {
  while (!initialized && !stopping) {
    try {
      await mongoose.connect(currentConfig.mongoUri, { dbName: currentConfig.database, serverSelectionTimeoutMS: 3000 });
      await initializeAccounts(currentConfig);
      await initializeConversations();
      await initializeUploads();
      await initializeIndexRecords();
      if (storage) await storage.verify(currentConfig.origin);
      initialized = true;
      stopWorker = startIndexWorker(currentConfig, storage);
      console.info(JSON.stringify({ event: 'accounts_ready' }));
    } catch {
      console.error(JSON.stringify({ event: 'accounts_unavailable' }));
      await delay(3000, undefined, { ref: false });
    }
  }
}
void connectDatabase();
let cleaning = false;
const cleanupTimer = setInterval(() => {
  if (!storage || !available() || cleaning) return;
  cleaning = true;
  void cleanupUploads(storage).catch(() => console.error(JSON.stringify({ event: 'upload_cleanup_unavailable' }))).finally(() => { cleaning = false; });
}, 60000).unref();

async function shutdown() {
  if (stopping) return;
  stopping = true;
  stopWorker();
  clearInterval(cleanupTimer);
  const deadline = setTimeout(() => process.exit(1), 5000).unref();
  await new Promise<void>(done => server.close(() => done()));
  await mongoose.disconnect();
  clearTimeout(deadline);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void shutdown().catch(() => process.exit(1)));
}
