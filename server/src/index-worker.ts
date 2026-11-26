import { createHash, randomUUID } from 'node:crypto';
import mongoose, { type ClientSession } from 'mongoose';
import type { Config } from './config.ts';
import { Document, DocumentVersion, IndexJob, readPinnedOriginal } from './uploads.ts';
import { AdminEvent, Chunk, EmbeddingCache, Generation, IndexSetting, Passage } from './index-records.ts';
import { buildChunks, chunkingVersion, extractOriginal, extractorVersion, ProcessingError } from './extraction.ts';
import { assertVectors, createIndexProviders, type IndexConfig, type IndexProviders } from './index-providers.ts';
import { uploadNow, type Storage } from './storage.ts';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const generationId = (config: IndexConfig) => digest(JSON.stringify([config.model, config.dimensions, extractorVersion, chunkingVersion])).slice(0, 32);
export type ClaimedJob = { id: string; versionId: string; generation: string; token: string };
export class LeaseLost extends Error {}

export class IndexWorker {
  readonly generation: string;
  readonly providers: IndexProviders;
  readonly config: IndexConfig; readonly storage: Storage;
  constructor(config: IndexConfig, storage: Storage, providers = createIndexProviders()) {
    this.config = config; this.storage = storage;
    this.generation = generationId(config); this.providers = providers;
  }
  async scheduleMigrations(activate = false) {
    if (activate) await IndexSetting.updateOne({ _id: 'configuration' }, { $set: { generation: this.generation } }, { upsert: true });
    const desired = await IndexSetting.findById('configuration');
    if (desired && desired.generation !== this.generation) return;
    await Generation.updateOne({ _id: this.generation }, { $setOnInsert: {
      model: this.config.model, dimensions: this.config.dimensions, extractorVersion, chunkingVersion,
    } }, { upsert: true });
    for (const version of await DocumentVersion.find({ state: 'ready', activeIndexGeneration: { $ne: this.generation } })) {
      if (await Document.exists({ _id: version.documentId, archivedAt: { $ne: null } })) continue;
      await IndexJob.updateOne({ versionId: version._id, state: { $ne: 'running' }, $or: [{ generation: { $ne: this.generation } }, { state: 'complete' }] }, {
        $set: { state: 'queued', generation: this.generation, retryAt: uploadNow(), attempts: 0 },
        $unset: { leaseToken: '', leaseUntil: '', failureCode: '' },
      });
    }
    await IndexJob.updateMany({ state: 'queued', generation: { $exists: true, $ne: this.generation } },
      { $set: { generation: this.generation, retryAt: uploadNow(), attempts: 0 } });
    await IndexJob.updateMany({ state: 'running', generation: { $ne: this.generation }, leaseUntil: { $lte: uploadNow() } },
      { $set: { state: 'queued', generation: this.generation, retryAt: uploadNow(), attempts: 0 }, $unset: { leaseToken: '', leaseUntil: '' } });
  }
  async claim(): Promise<ClaimedJob | null> {
    const desired = await IndexSetting.findById('configuration');
    if (desired && desired.generation !== this.generation) return null;
    const token = randomUUID(), now = uploadNow();
    const job = await IndexJob.findOneAndUpdate({ $and: [{ $or: [{ generation: this.generation }, { generation: { $exists: false } }] }, { $or: [
      { state: 'queued', retryAt: { $lte: now } }, { state: 'running', leaseUntil: { $lte: now } },
    ] }] }, { $set: { state: 'running', leaseToken: token, leaseUntil: new Date(now.getTime() + this.config.leaseMs), generation: this.generation }, $inc: { attempts: 1 } },
    { sort: { createdAt: 1 }, new: true });
    return job ? { id: job.id, versionId: String(job.versionId), generation: this.generation, token } : null;
  }
  async fenced<T>(job: ClaimedJob, action: (session: ClientSession) => Promise<T>): Promise<T> {
    return mongoose.connection.transaction(async session => {
      const lock = await IndexJob.updateOne({ _id: job.id, state: 'running', leaseToken: job.token, generation: job.generation, leaseUntil: { $gt: uploadNow() } }, {
        $set: { leaseUntil: new Date(uploadNow().getTime() + this.config.leaseMs) },
      }, { session });
      if (!lock.matchedCount) throw new LeaseLost('Worker lease no longer belongs to this attempt.');
      return action(session);
    }, { writeConcern: { w: 'majority' } });
  }
  async process(job: ClaimedJob, heartbeat = true) {
    let lost = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    if (heartbeat) timer = setInterval(() => {
      void this.fenced(job, async () => undefined).catch(() => { lost = true; });
    }, Math.max(1000, this.config.leaseMs / 3)).unref();
    try {
      const version = await DocumentVersion.findById(job.versionId);
      if (!version?.s3VersionId || !version.hash) throw new ProcessingError('ORIGINAL_MISSING', 'The original file has not been pinned. Upload it again.');
      await this.fenced(job, async session => {
        await DocumentVersion.updateOne({ _id: version._id }, { $set: { indexingStatus: 'indexing', ...(version.activeIndexGeneration ? {} : { state: 'indexing' }) },
          $unset: { failureCode: '', failureReason: '' } }, { session });
        await Generation.updateOne({ _id: job.generation }, { $setOnInsert: { model: this.config.model, dimensions: this.config.dimensions, extractorVersion, chunkingVersion } }, { upsert: true, session });
      });
      const original = await readPinnedOriginal(job.versionId, this.storage);
      const extracted = await extractOriginal(original.bytes, version.mime);
      const passages = extracted.map(passage => ({ ...passage, id: `${job.versionId}:p:${passage.ordinal}` }));
      const chunkInputs = buildChunks(passages);
      if (!chunkInputs.length) throw new ProcessingError('NO_TEXT', 'No searchable text was found in this original.');
      for (let start = 0; start < passages.length; start += 32) {
        const batch = passages.slice(start, start + 32);
        await this.fenced(job, async session => {
          const stored = await Passage.find({ _id: { $in: batch.map(passage => passage.id) } }).session(session);
          for (const passage of batch) {
            const existing = stored.find(row => row.id === passage.id);
            if (existing && (existing.text !== passage.text || existing.page !== passage.page || existing.start !== passage.start || existing.end !== passage.end)) {
              throw new ProcessingError('ANCHOR_CHANGED', 'Reprocessing changed immutable source anchors. Preserve the existing version and upload a new revision.');
            }
          }
          await Passage.bulkWrite(batch.map(passage => ({ updateOne: { filter: { _id: passage.id },
            update: { $setOnInsert: { ...passage, versionId: job.versionId, extractorVersion } }, upsert: true } })), { session });
        });
      }
      const scope = version.scope === 'shared' ? 'shared' : `${version.ownerId}:${version.conversationId}`;
      const vectors: number[][] = [];
      for (let start = 0; start < chunkInputs.length; start += 8) {
        const batch = chunkInputs.slice(start, start + 8);
        const cacheKeys = batch.map(chunk => digest(JSON.stringify([scope, this.config.model, this.config.dimensions, extractorVersion, chunkingVersion, digest(chunk.searchText)])));
        const cached = await EmbeddingCache.find({ _id: { $in: cacheKeys } });
        const missing = batch.map((_, i) => i).filter(i => !cached.some(cache => cache.id === cacheKeys[i]));
        const produced = missing.length ? await this.providers.embed(missing.map(i => batch[i].searchText), this.config) : [];
        assertVectors(produced, missing.length, this.config.dimensions);
        const results = batch.map((_, i) => cached.find(cache => cache.id === cacheKeys[i])?.vector ?? produced[missing.indexOf(i)]);
        assertVectors(results, batch.length, this.config.dimensions);
        await this.fenced(job, async session => {
          for (let i = 0; i < batch.length; i++) {
            await EmbeddingCache.updateOne({ _id: cacheKeys[i] }, { $setOnInsert: { scope, model: this.config.model, dimensions: this.config.dimensions,
              processingVersion: `${extractorVersion}:${chunkingVersion}`, contentHash: digest(batch[i].searchText), vector: results[i] } }, { session, upsert: true });
            await Chunk.updateOne({ _id: `${job.versionId}:${job.generation}:c:${batch[i].ordinal}` }, { $set: {
              ...batch[i], chunkId: `${job.versionId}:${job.generation}:c:${batch[i].ordinal}`, versionId: job.versionId, generation: job.generation, vectors: { [`d${this.config.dimensions}`]: results[i] },
            } }, { session, upsert: true });
          }
        });
        vectors.push(...results);
      }
      if (lost) throw new LeaseLost();
      await this.providers.ensure(this.config);
      await this.providers.probe(job.versionId, job.generation, this.config,
        chunkInputs.map((chunk, i) => ({ id: `${job.versionId}:${job.generation}:c:${chunk.ordinal}`, text: chunk.searchText, vector: vectors[i] })));
      await this.fenced(job, async session => {
        const document = await Document.findById(version.documentId).session(session);
        if (!document) throw new ProcessingError('DOCUMENT_MISSING', 'This document no longer exists.');
        if (version.scope === 'shared') {
          if (document.archivedAt) throw new ProcessingError('DOCUMENT_ARCHIVED', 'This document was archived during processing. Its original is retained and it will not publish.');
          const alreadyActive = String(document.activeVersionId) === version.id;
          if (!alreadyActive && !version.activeIndexGeneration) {
            const published = await Document.updateOne({ _id: document._id, archivedAt: null, activeVersionId: version.baseVersionId ?? null },
              { $set: { activeVersionId: version._id } }, { session });
            if (!published.matchedCount) throw new ProcessingError('PUBLICATION_CONFLICT', 'Another replacement won publication. Upload a new revision based on the current active version.');
            await AdminEvent.create([{ actorId: version.ownerId, action: 'publish', documentId: document._id, versionId: version._id }], { session });
          }
        }
        await DocumentVersion.updateOne({ _id: version._id }, { $set: {
          state: 'ready', indexingStatus: 'ready', activeIndexGeneration: job.generation,
          embeddingModel: this.config.model, dimensions: this.config.dimensions, extractorVersion, chunkingVersion,
        }, $unset: { failureCode: '', failureReason: '' } }, { session });
        await IndexJob.updateOne({ _id: job.id }, { $set: { state: 'complete' }, $unset: { leaseToken: '', leaseUntil: '', failureCode: '' } }, { session });
      });
    } catch (error) {
      if (error instanceof LeaseLost) return;
      const issue = error instanceof ProcessingError ? error : new ProcessingError('INDEXING_UNAVAILABLE', 'Indexing could not finish. Check storage and database access, then retry the same pinned version.', true, 5000);
      try {
        await this.fenced(job, async session => {
          const currentJob = await IndexJob.findById(job.id).session(session);
          const version = await DocumentVersion.findById(job.versionId).session(session);
          const retry = issue.retryable && (currentJob?.attempts ?? 3) < 3;
          await IndexJob.updateOne({ _id: job.id }, { $set: { state: retry ? 'queued' : 'failed', failureCode: issue.code,
            retryAt: new Date(uploadNow().getTime() + Math.max(issue.retryAfterMs, 1000 * 2 ** (currentJob?.attempts ?? 1))) }, $unset: { leaseToken: '', leaseUntil: '' } }, { session });
          await DocumentVersion.updateOne({ _id: job.versionId }, { $set: { ...(version?.activeIndexGeneration ? {} : { state: retry ? 'queued' : 'failed' }),
            indexingStatus: retry ? 'queued' : 'failed', failureCode: issue.code, failureReason: issue.message } }, { session });
        });
      } catch (failure) { if (!(failure instanceof LeaseLost)) throw failure; }
    } finally { if (timer) clearInterval(timer); }
  }
  async runOnce() { const job = await this.claim(); if (!job) return false; await this.process(job); return true; }
}

export function startIndexWorker(config: Config, storage: Storage | undefined) {
  if (!config.indexing || !storage) return () => undefined;
  const worker = new IndexWorker(config.indexing, storage);
  let stopped = false, busy = false;
  const tick = async () => {
    if (stopped || busy) return;
    busy = true;
    try { await worker.scheduleMigrations(); await worker.runOnce(); } catch { console.error(JSON.stringify({ event: 'index_worker_unavailable' })); }
    finally { busy = false; }
  };
  void worker.scheduleMigrations(true).then(tick).catch(() => console.error(JSON.stringify({ event: 'index_schedule_unavailable' })));
  const timer = setInterval(() => void tick(), 1000).unref();
  return () => { stopped = true; clearInterval(timer); };
}
