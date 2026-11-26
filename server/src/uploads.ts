import { createHash, randomUUID } from 'node:crypto';
import express from 'express';
import mongoose, { Schema, Types } from 'mongoose';
import { rateLimit, type RateLimitInfo } from 'express-rate-limit';
import { isDuplicate } from './accounts.ts';
import { requestGuard, requireSession } from './auth.ts';
import type { Config } from './config.ts';
import { Conversation } from './conversations.ts';
import { HttpError, sendError } from './http.ts';
import { createStorage, maxOriginalBytes, uploadNow, type Storage } from './storage.ts';
import { collectionName } from './collections.ts';
import { AdminEvent } from './index-records.ts';

const documentSchema = new Schema({
  ownerId: { type: Schema.Types.ObjectId, required: true }, scope: { type: String, enum: ['private', 'shared'], required: true },
  conversationId: Schema.Types.ObjectId, title: { type: String, required: true },
  activeVersionId: { type: Schema.Types.ObjectId, default: null }, archivedAt: { type: Date, default: null },
  fixtureId: String, operationToken: String, revisionCounter: { type: Number, default: 1 }, createdAt: { type: Date, default: Date.now },
});
documentSchema.index({ fixtureId: 1 }, { unique: true, partialFilterExpression: { fixtureId: { $type: 'string' } } });
export const Document = mongoose.model('Document', documentSchema, collectionName('documents'));
const versionSchema = new Schema({
  documentId: { type: Schema.Types.ObjectId, required: true }, revision: { type: Number, default: 1 },
  ownerId: { type: Schema.Types.ObjectId, required: true }, scope: { type: String, required: true }, conversationId: Schema.Types.ObjectId,
  clientUploadId: { type: String, required: true }, requestHash: { type: String, required: true },
  filename: { type: String, required: true }, mime: { type: String, required: true }, size: { type: Number, required: true },
  key: { type: String, required: true }, expiresAt: { type: Date, required: true },
  state: { type: String, enum: ['reserved', 'queued', 'indexing', 'ready', 'failed', 'expired'], default: 'reserved' },
  s3VersionId: String, hash: String, queuedAt: Date, cleanedAt: Date,
  baseVersionId: { type: Schema.Types.ObjectId, default: null }, activeIndexGeneration: String,
  extractorVersion: String, chunkingVersion: String, embeddingModel: String, dimensions: Number,
  failureCode: String, failureReason: String, indexingStatus: String, fixtureId: String,
});
versionSchema.index({ ownerId: 1, clientUploadId: 1 }, { unique: true });
versionSchema.index({ documentId: 1, revision: 1 }, { unique: true });
versionSchema.index({ state: 1, expiresAt: 1 });
versionSchema.index({ conversationId: 1, scope: 1 });
export const DocumentVersion = mongoose.model('DocumentVersion', versionSchema, collectionName('documentversions'));
const jobSchema = new Schema({ versionId: { type: Schema.Types.ObjectId, required: true, unique: true }, state: { type: String, default: 'queued' },
  generation: String, leaseToken: String, leaseUntil: Date, retryAt: { type: Date, default: Date.now }, attempts: { type: Number, default: 0 },
  failureCode: String, createdAt: { type: Date, default: Date.now } });
jobSchema.index({ state: 1, retryAt: 1, leaseUntil: 1 });
export const IndexJob = mongoose.model('IndexJob', jobSchema, collectionName('indexjobs'));
type Version = InstanceType<typeof DocumentVersion>;
const objectId = /^[a-f0-9]{24}$/;
const notFound = () => new HttpError(404, 'NOT_FOUND', 'This upload could not be found.');
const expired = () => new HttpError(409, 'UPLOAD_EXPIRED', 'This upload expired. Choose the file again to start a new upload.');
const unavailable = () => new HttpError(503, 'STORAGE_UNAVAILABLE', 'File storage is temporarily unavailable. Please try again.');
export const cleanupGraceMs = 60 * 60 * 1000;

export async function initializeUploads() { await Promise.all([Document.init(), DocumentVersion.init(), IndexJob.init()]); }
function view(version: Version) {
  return { uploadId: version.id, versionId: version.id, documentId: String(version.documentId),
    ...(version.conversationId ? { conversationId: String(version.conversationId) } : {}),
    filename: version.filename, mime: version.mime, size: version.size, status: version.state,
    expiresAt: version.expiresAt.toISOString(), ...(version.hash ? { checksum: version.hash } : {}),
    revision: version.revision, activeIndexGeneration: version.activeIndexGeneration, indexingStatus: version.indexingStatus,
    failureCode: version.failureCode, ...(version.failureReason ? { failureReason: version.failureReason } : {}),
    ...(version.state === 'expired' ? { failureReason: 'Upload expired. Choose the file again.' } : {}),
  };
}
function parse(body: unknown, scope: string, conversationId?: string) {
  const input = body as Record<string, unknown> | undefined;
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || typeof input.filename !== 'string' || !input.filename.trim() || input.filename.length > 255
    || /[\x00-\x1f\x7f/\\]/.test(input.filename)
    || typeof input.clientUploadId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.clientUploadId)) {
    throw new HttpError(400, 'INVALID_INPUT', 'Provide a filename and a new upload ID.');
  }
  if (typeof input.size !== 'number' || !Number.isSafeInteger(input.size) || input.size < 1) throw new HttpError(400, 'INVALID_INPUT', 'The file must not be empty.');
  if (input.size > maxOriginalBytes) throw new HttpError(413, 'FILE_TOO_LARGE', 'Choose a file of at most 5 MiB.');
  if (!['application/pdf', 'text/plain'].includes(input.mime as string)) throw new HttpError(415, 'UNSUPPORTED_TYPE', 'Choose a PDF or plain text file.');
  const filename = input.filename.trim(), mime = input.mime as string, size = input.size, clientUploadId = input.clientUploadId;
  return { filename, mime, size, clientUploadId,
    requestHash: createHash('sha256').update(JSON.stringify({ filename, mime, size, scope, conversationId: conversationId ?? null })).digest('hex') };
}
async function ownedConversation(id: string, ownerId: string) {
  if (!objectId.test(id) || !await Conversation.exists({ _id: id, ownerId })) throw notFound();
}
async function reserve(ownerId: string, scope: 'private' | 'shared', conversationId: string | undefined,
  input: ReturnType<typeof parse>, prefix: string, targetDocumentId?: string) {
  const existing = await DocumentVersion.findOne({ ownerId, clientUploadId: input.clientUploadId });
  if (existing) {
    if (existing.requestHash !== input.requestHash) throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'This upload ID was already used for different input.');
    return existing;
  }
  try {
    return await mongoose.connection.transaction(async session => {
      const duplicate = await DocumentVersion.findOne({ ownerId, clientUploadId: input.clientUploadId }).session(session);
      if (duplicate) {
        if (duplicate.requestHash !== input.requestHash) throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'This upload ID was already used for different input.');
        return duplicate;
      }
      if (conversationId) {
        const reserved = await Conversation.updateOne({ _id: conversationId, ownerId, attachmentCount: { $lt: 5 } },
          { $inc: { attachmentCount: 1 }, $set: { updatedAt: uploadNow() } }, { session });
        if (!reserved.modifiedCount) throw new HttpError(409, 'ATTACHMENT_LIMIT', 'This chat already has five files or pending uploads.');
      }
      let documentId = new Types.ObjectId(), revision = 1, baseVersionId: Types.ObjectId | null = null;
      const versionId = new Types.ObjectId();
      if (targetDocumentId) {
        const target = await Document.findOneAndUpdate({ _id: targetDocumentId, scope: 'shared', archivedAt: null }, [
          { $set: { revisionCounter: { $add: [{ $ifNull: ['$revisionCounter', 1] }, 1] } } },
        ], { session, new: true });
        if (!target) throw notFound();
        documentId = target._id; revision = target.revisionCounter; baseVersionId = target.activeVersionId ?? null;
      } else await Document.create([{ _id: documentId, ownerId, scope, conversationId, title: input.filename }], { session });
      const [version] = await DocumentVersion.create([{ _id: versionId, documentId, ownerId, scope, conversationId,
        ...input, revision, baseVersionId, key: `${prefix}originals/${randomUUID()}`, expiresAt: new Date(uploadNow().getTime() + 300000) }], { session });
      if (scope === 'shared') await AdminEvent.create([{ actorId: ownerId, action: targetDocumentId ? 'stage-replacement' : 'upload', documentId, versionId }], { session });
      return version;
    }, { writeConcern: { w: 'majority' } });
  } catch (error) {
    if (!isDuplicate(error) && !(error instanceof HttpError && error.code === 'ATTACHMENT_LIMIT')) throw error;
    const winner = await DocumentVersion.findOne({ ownerId, clientUploadId: input.clientUploadId });
    if (!winner) throw error;
    if (winner.requestHash !== input.requestHash) throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'This upload ID was already used for different input.');
    return winner;
  }
}

export async function pin(version: Version, storage: Storage) {
  if (version.s3VersionId && version.hash) return version;
  if (version.state === 'expired') throw expired();
  let original;
  try { original = await storage.original(version.key); }
  catch (error) {
    const winner = await DocumentVersion.findById(version._id);
    if (winner?.s3VersionId && winner.hash) return winner;
    throw error;
  }
  const currentWinner = await DocumentVersion.findById(version._id);
  if (currentWinner?.s3VersionId && currentWinner.hash) return currentWinner;
  if (currentWinner?.state === 'expired') throw expired();
  if (!original) {
    if (version.expiresAt > uploadNow()) throw new HttpError(409, 'UPLOAD_NOT_RECEIVED', 'The file has not arrived yet. Retry completing this upload.');
    await mongoose.connection.transaction(async session => {
      const released = await DocumentVersion.updateOne({ _id: version._id, state: 'reserved' }, { $set: { state: 'expired' } }, { session });
      if (released.modifiedCount && version.conversationId) await Conversation.updateOne({ _id: version.conversationId, attachmentCount: { $gt: 0 } }, { $inc: { attachmentCount: -1 } }, { session });
    });
    const current = await DocumentVersion.findById(version._id);
    if (current?.s3VersionId && current.hash) return current;
    throw expired();
  }
  if (original.size !== version.size || original.mime !== version.mime || !original.versionId || original.versionId === 'null'
    || original.uploadedAt.getTime() > version.expiresAt.getTime()) throw new HttpError(409, 'ORIGINAL_MISMATCH', 'The uploaded file did not match its reservation. Start a new upload.');
  await mongoose.connection.transaction(async session => {
    const winner = await DocumentVersion.findOneAndUpdate({ _id: version._id, state: 'reserved' }, {
      $set: { state: 'queued', s3VersionId: original.versionId, hash: original.hash, queuedAt: uploadNow() },
    }, { session, new: true });
    if (winner) await IndexJob.create([{ versionId: winner._id }], { session });
  }, { writeConcern: { w: 'majority' } });
  const winner = await DocumentVersion.findById(version._id);
  if (!winner || winner.state === 'expired') throw expired();
  return winner;
}

export async function readPinnedOriginal(versionId: string, storage: Storage) {
  const version = await DocumentVersion.findById(versionId);
  if (!version?.s3VersionId || !version.hash) throw new Error('Original has not been pinned.');
  const original = await storage.original(version.key, version.s3VersionId);
  if (!original || original.versionId !== version.s3VersionId || original.hash !== version.hash || original.size !== version.size) throw new Error('Pinned original verification failed.');
  return original;
}

export async function cleanupUploads(storage: Storage, owned?: { ownerId: string; conversationId?: string }) {
  const due = await DocumentVersion.find({ state: 'reserved', expiresAt: { $lte: uploadNow() }, ...(owned ? { ownerId: owned.ownerId, ...(owned.conversationId ? { conversationId: owned.conversationId } : {}) } : {}) }).limit(50);
  for (const version of due) {
    try { await pin(version, storage); }
    catch (error) {
      if (!(error instanceof HttpError) || !['UPLOAD_EXPIRED', 'ORIGINAL_MISMATCH'].includes(error.code)) throw error;
      if (error.code === 'ORIGINAL_MISMATCH') {
        await mongoose.connection.transaction(async session => {
          const result = await DocumentVersion.updateOne({ _id: version._id, state: 'reserved' }, { $set: { state: 'expired' } }, { session });
          if (result.modifiedCount && version.conversationId) await Conversation.updateOne({ _id: version.conversationId, attachmentCount: { $gt: 0 } }, { $inc: { attachmentCount: -1 } }, { session });
        });
      }
    }
  }
  if (owned) return;
  const abandoned = await DocumentVersion.find({ state: { $ne: 'reserved' }, cleanedAt: { $exists: false }, expiresAt: { $lt: new Date(uploadNow().getTime() - cleanupGraceMs) } }).limit(50);
  for (const version of abandoned) {
    // Terminal states never revert to reserved. Keep their records indefinitely:
    // they fence late callbacks, retain idempotency and track replayed versions.
    for (const versionId of await storage.versions(version.key)) {
      if (versionId === version.s3VersionId || await DocumentVersion.exists({ key: version.key, $or: [{ state: 'reserved' }, { s3VersionId: versionId }] })) continue;
      await storage.remove(version.key, versionId);
    }
    await DocumentVersion.updateOne({ _id: version._id }, { $set: { cleanedAt: uploadNow() } });
  }
}

export function uploadRouter(config: Config, available: () => boolean, storage: Storage | undefined) {
  const router = express.Router();
  router.use((req, _res, next) => /^\/(?:uploads\/|admin\/(?:documents|document-versions)(?:\/|$)|conversations\/[^/]+\/attachments(?:\/|$)|knowledge\/starter-questions$)/.test(req.path) ? next() : next('router'));
  router.use(requestGuard(config, available), requireSession(config));
  router.use((req, res, next) => {
    if (req.path.startsWith('/admin/') && res.locals.account.role !== 'admin') return next(new HttpError(403, 'ADMIN_REQUIRED', 'Administrator access is required.'));
    next();
  });
  router.use(express.json({ limit: '4kb' }));
  const limiter = rateLimit({ windowMs: config.storage?.reservationWindowMs ?? 600000, limit: config.storage?.reservationLimit ?? 10,
    keyGenerator: (_req, res) => res.locals.account.id, standardHeaders: 'draft-8', legacyHeaders: false,
    skip: async (req, res) => typeof req.body?.clientUploadId === 'string' && Boolean(await DocumentVersion.exists({ ownerId: res.locals.account.id, clientUploadId: req.body.clientUploadId })),
    handler: (req, res) => {
      const info = (req as express.Request & { rateLimit?: RateLimitInfo }).rateLimit;
      const retry = Math.max(1, Math.ceil(((info?.resetTime?.getTime() ?? Date.now() + 600000) - Date.now()) / 1000));
      res.set('Retry-After', String(retry));
      sendError(res, new HttpError(429, 'UPLOAD_RATE_LIMIT', 'Too many upload reservations. Please try again shortly.'), retry);
    },
  });
  async function create(req: express.Request, res: express.Response, shared: boolean) {
    const ownerId = res.locals.account.id as string;
    const conversationId = shared ? undefined : String(req.params.id);
    if (conversationId) await ownedConversation(conversationId, ownerId);
    const input = parse(req.body, shared ? 'shared' : 'private', conversationId);
    const target = shared && req.params.id ? String(req.params.id) : undefined;
    if (target) {
      if (!objectId.test(target)) throw notFound();
      input.requestHash = createHash('sha256').update(`${input.requestHash}:${target}`).digest('hex');
    }
    if (!storage || !config.storage) throw unavailable();
    // Reconcile expired reservations before allocating another bounded slot.
    await cleanupUploads(storage, { ownerId, conversationId });
    let version = await reserve(ownerId, shared ? 'shared' : 'private', conversationId, input, config.storage.prefix, target);
    if (version.state === 'reserved' && version.expiresAt <= uploadNow()) {
      version = await pin(version, storage);
    }
    const seconds = Math.floor((version.expiresAt.getTime() - uploadNow().getTime()) / 1000);
    const form = version.state === 'reserved' && seconds > 0 ? await storage.form(version.key, version.mime, version.id, Math.min(300, seconds)) : undefined;
    res.status(201).json({ ...view(version), ...(form ? { form } : {}) });
  }
  router.post('/conversations/:id/attachments', limiter, (req, res) => create(req, res, false));
  router.post('/admin/documents', limiter, (req, res) => create(req, res, true));
  router.post('/admin/documents/:id/versions', limiter, (req, res) => create(req, res, true));
  router.get('/conversations/:id/attachments', async (req, res) => {
    await ownedConversation(String(req.params.id), res.locals.account.id);
    const versions = await DocumentVersion.find({ conversationId: req.params.id, scope: 'private', ownerId: res.locals.account.id }).sort({ _id: 1 });
    res.json({ items: versions.map(view) });
  });
  router.get('/admin/documents', async (_req, res) => {
    const versions = await DocumentVersion.find({ scope: 'shared' }).sort({ _id: -1 });
    const documents = await Document.find({ _id: { $in: versions.map(version => version.documentId) } });
    res.json({ items: versions.map(version => { const document = documents.find(doc => doc.id === String(version.documentId));
      return { ...view(version), baseVersionId: version.baseVersionId, activeVersionId: document?.activeVersionId,
        isActive: String(document?.activeVersionId) === version.id, archivedAt: document?.archivedAt?.toISOString() ?? null }; }) });
  });
  router.delete('/admin/documents/:id', async (req, res) => {
    if (!objectId.test(String(req.params.id))) throw notFound();
    await mongoose.connection.transaction(async session => {
      const document = await Document.findOneAndUpdate({ _id: req.params.id, scope: 'shared', archivedAt: null }, { $set: { archivedAt: uploadNow() } }, { session, new: true });
      if (!document) { if (!await Document.exists({ _id: req.params.id, scope: 'shared' }).session(session)) throw notFound(); return; }
      const versions = await DocumentVersion.find({ documentId: document._id }).session(session);
      await IndexJob.updateMany({ versionId: { $in: versions.map(version => version._id) }, state: { $in: ['queued', 'running'] } },
        { $set: { state: 'cancelled', failureCode: 'DOCUMENT_ARCHIVED' }, $unset: { leaseToken: '', leaseUntil: '' } }, { session });
      await DocumentVersion.updateMany({ documentId: document._id, state: { $in: ['queued', 'indexing'] } },
        { $set: { state: 'failed', indexingStatus: 'failed', failureCode: 'DOCUMENT_ARCHIVED', failureReason: 'This document was archived. Its original remains available for historical references.' } }, { session });
      await DocumentVersion.updateMany({ documentId: document._id, state: 'ready', indexingStatus: { $in: ['queued', 'indexing'] } },
        { $set: { indexingStatus: 'cancelled', failureCode: 'DOCUMENT_ARCHIVED', failureReason: 'This document was archived, so its pending search rebuild was cancelled.' } }, { session });
      await AdminEvent.create([{ actorId: res.locals.account.id, action: 'archive', documentId: document._id, requestId: res.locals.requestId }], { session });
    });
    res.status(204).end();
  });
  async function retryVersion(req: express.Request, res: express.Response, shared: boolean) {
    const id = String(req.params.versionId);
    if (!objectId.test(id)) throw notFound();
    const version = await DocumentVersion.findById(id);
    if (!version || version.scope !== (shared ? 'shared' : 'private')) throw notFound();
    if (!shared) {
      if (String(version.ownerId) !== res.locals.account.id || String(version.conversationId) !== String(req.params.id)) throw notFound();
      await ownedConversation(String(req.params.id), res.locals.account.id);
    }
    if (!config.indexing) throw new HttpError(409, 'INDEXING_DISABLED', 'Configure indexing before retrying this file.');
    const document = await Document.findById(version.documentId);
    if (document?.archivedAt) throw new HttpError(409, 'DOCUMENT_ARCHIVED', 'Archived documents cannot be retried.');
    if (!version.s3VersionId || !version.hash) throw expired();
    if (version.indexingStatus !== 'failed' && version.state !== 'failed') throw new HttpError(409, 'INDEXING_ACTIVE', 'This version is not failed.');
    await mongoose.connection.transaction(async session => {
      const stillActive = await Document.updateOne({ _id: version.documentId, archivedAt: null }, { $set: { operationToken: randomUUID() } }, { session });
      if (!stillActive.matchedCount) throw new HttpError(409, 'DOCUMENT_ARCHIVED', 'Archived documents cannot be retried.');
      const job = await IndexJob.findOneAndUpdate({ versionId: version._id, state: 'failed' },
        { $set: { state: 'queued', retryAt: uploadNow(), attempts: 0 }, $unset: { leaseToken: '', leaseUntil: '', failureCode: '' } }, { session });
      if (!job) throw new HttpError(409, 'INDEXING_ACTIVE', 'This indexing job has already been retried.');
      await DocumentVersion.updateOne({ _id: version._id }, { $set: { indexingStatus: 'queued', ...(version.activeIndexGeneration ? {} : { state: 'queued' }) }, $unset: { failureCode: '', failureReason: '' } }, { session });
      if (shared) await AdminEvent.create([{ actorId: res.locals.account.id, action: 'retry', documentId: version.documentId, versionId: version._id, requestId: res.locals.requestId }], { session });
    });
    res.status(202).json(view((await DocumentVersion.findById(version._id))!));
  }
  router.post('/admin/document-versions/:versionId/retry', (req, res) => retryVersion(req, res, true));
  router.post('/conversations/:id/attachments/:versionId/retry', (req, res) => retryVersion(req, res, false));
  router.get('/admin/documents/:id/events', async (req, res) => {
    if (!objectId.test(String(req.params.id))) throw notFound();
    res.json({ items: await AdminEvent.find({ documentId: req.params.id }).sort({ timestamp: 1, _id: 1 }).select('actorId action documentId versionId timestamp requestId').lean() });
  });
  router.get('/knowledge/starter-questions', async (_req, res) => {
    const documents = await Document.find({ scope: 'shared', fixtureId: { $exists: true }, archivedAt: null, activeVersionId: { $ne: null } });
    const ready = await DocumentVersion.find({ _id: { $in: documents.map(doc => doc.activeVersionId) }, state: 'ready', activeIndexGeneration: { $exists: true } });
    const questions = [ { fixture: 'help-guide', question: 'How do I export my contracts?' }, { fixture: 'notice-policy', question: 'What is the notice period?' } ];
    res.json({ items: questions.flatMap(item => { const document = documents.find(doc => doc.fixtureId === item.fixture); return document && ready.some(version => version.id === String(document.activeVersionId))
      ? [{ id: item.fixture, question: item.question, documentVersionIds: [String(document.activeVersionId)] }] : []; }) });
  });
  router.post('/uploads/:id/complete', async (req, res) => {
    const id = String(req.params.id);
    if (!objectId.test(id)) throw notFound();
    const version = await DocumentVersion.findById(id);
    if (!version || (version.scope === 'private' ? String(version.ownerId) !== res.locals.account.id : res.locals.account.role !== 'admin')) throw notFound();
    if (version.conversationId) await ownedConversation(String(version.conversationId), res.locals.account.id);
    if (!storage) throw unavailable();
    try { res.status(202).json(view(await pin(version, storage))); }
    catch (error) { if (error instanceof HttpError) throw error; throw unavailable(); }
  });
  router.use((error: unknown, _req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const bodyError = (error as { type?: string })?.type;
    next(error instanceof HttpError || bodyError === 'entity.parse.failed' || bodyError === 'entity.too.large' ? error : unavailable());
  });
  return router;
}
