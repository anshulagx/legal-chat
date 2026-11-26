import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import mongoose, { Types } from 'mongoose';
import { User } from './accounts.ts';
import type { Config } from './config.ts';
import { Document, DocumentVersion, pin } from './uploads.ts';
import { IndexWorker } from './index-worker.ts';
import { uploadNow, type Storage } from './storage.ts';

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
export const fixtureObjectId = (value: string) => new Types.ObjectId(hash(value).slice(0, 24));
export const bootstrapFixtures = [
  { fixtureId: 'help-guide', revision: 1, file: 'help-guide.txt', title: 'Contract workspace help guide' },
  { fixtureId: 'notice-policy', revision: 1, file: 'notice-policy-v1.txt', title: 'Workspace notice policy' },
  { fixtureId: 'notice-policy', revision: 2, file: 'notice-policy-v2.txt', title: 'Workspace notice policy' },
];
export async function bootstrapKnowledge(config: Config, storage: Storage, worker: IndexWorker) {
  const admin = await User.findOne({ emailNormalized: config.adminEmail, role: 'admin' });
  if (!admin || !config.storage || !config.indexing) throw new Error('Bootstrap requires configured storage, indexing and seeded admin.');
  await worker.scheduleMigrations(true);
  for (const fixture of bootstrapFixtures) {
    const bytes = await readFile(new URL(`../../client/public/fixtures/${fixture.file}`, import.meta.url));
    const checksum = hash(bytes), documentId = fixtureObjectId(`document:${fixture.fixtureId}`);
    const versionId = fixtureObjectId(`version:${fixture.fixtureId}:${fixture.revision}`);
    await mongoose.connection.transaction(async session => {
      await Document.updateOne({ _id: documentId }, { $setOnInsert: { ownerId: admin._id, scope: 'shared', fixtureId: fixture.fixtureId, title: fixture.title, revisionCounter: fixture.revision } }, { upsert: true, session });
      const document = await Document.findById(documentId).session(session);
      if (document?.archivedAt) throw new Error('A bootstrap document is archived; restore explicitly or use a new fixture identity.');
      await Document.updateOne({ _id: documentId }, { $max: { revisionCounter: fixture.revision } }, { session });
      await DocumentVersion.updateOne({ _id: versionId }, { $setOnInsert: {
        documentId, revision: fixture.revision, ownerId: admin._id, scope: 'shared', fixtureId: `${fixture.fixtureId}:${fixture.revision}`,
        clientUploadId: `bootstrap-${fixture.fixtureId}-${fixture.revision}`, requestHash: checksum,
        filename: fixture.file, mime: 'text/plain', size: bytes.length, key: `${config.storage!.prefix}bootstrap/${versionId}`,
        expiresAt: new Date(uploadNow().getTime() + 300000), state: 'reserved', baseVersionId: document?.activeVersionId ?? null,
      } }, { session, upsert: true });
    });
    let version = (await DocumentVersion.findById(versionId))!;
    if (version.hash && version.hash !== checksum) throw new Error('A checked-in fixture changed without a new revision. Existing originals are immutable.');
    if (!version.s3VersionId) {
      const form = await storage.form(version.key, version.mime, version.id, 300);
      const data = new FormData();
      for (const [name, value] of Object.entries(form.fields)) data.append(name, value);
      data.append('file', new Blob([bytes], { type: 'text/plain' }), fixture.file);
      const response = await fetch(form.url, { method: 'POST', body: data, headers: { Origin: config.origin }, signal: AbortSignal.timeout(30000), redirect: 'error' });
      if (!response.ok) throw new Error('Bootstrap original upload failed.');
      version = await pin(version, storage);
    }
    const deadline = Date.now() + 600000;
    while (version.state !== 'ready' || version.activeIndexGeneration !== worker.generation) {
      if (version.state === 'failed' || version.indexingStatus === 'failed') throw new Error(`Bootstrap indexing failed: ${version.failureCode}`);
      await worker.scheduleMigrations();
      const ran = await worker.runOnce();
      if (!ran) await delay(250);
      if (Date.now() >= deadline) throw new Error('Bootstrap indexing deadline expired.');
      version = (await DocumentVersion.findById(versionId))!;
    }
  }
  return { documents: await Document.countDocuments({ fixtureId: { $exists: true } }),
    versions: await DocumentVersion.countDocuments({ fixtureId: { $exists: true } }),
    active: (await Document.find({ fixtureId: { $exists: true } }).sort({ fixtureId: 1 })).map(document => ({ fixtureId: document.fixtureId, versionId: String(document.activeVersionId) })) };
}
