import express from 'express';
import { requestGuard, requireSession } from './auth.ts';
import type { Config } from './config.ts';
import { Conversation } from './conversations.ts';
import { AdminEvent, Passage } from './index-records.ts';
import { HttpError } from './http.ts';
import type { Storage } from './storage.ts';
import { Document, DocumentVersion, readPinnedOriginal } from './uploads.ts';

const missing = () => new HttpError(404, 'NOT_FOUND', 'This source could not be found.');
export async function authorizeSource(versionId: string, ownerId: string) {
  if (!/^[a-f0-9]{24}$/.test(versionId)) throw missing();
  const version = await DocumentVersion.findById(versionId);
  if (!version || version.state !== 'ready') throw missing();
  const document = await Document.findById(version.documentId);
  if (!document) throw missing();
  if (version.scope === 'private') {
    if (String(version.ownerId) !== ownerId || !await Conversation.exists({ _id: version.conversationId, ownerId })) throw missing();
  } else if (version.scope !== 'shared' || (String(document.activeVersionId) !== version.id
    && !await AdminEvent.exists({ action: 'publish', versionId: version._id }))) throw missing();
  const label = document.archivedAt ? 'Archived' : version.scope === 'shared' && String(document.activeVersionId) !== version.id ? 'Superseded' : 'Current';
  return { version, label };
}

export function sourceRouter(config: Config, available: () => boolean, storage: Storage | undefined) {
  const router = express.Router();
  router.use((req, _res, next) => req.path.startsWith('/sources/') ? next() : next('router'));
  router.use(requestGuard(config, available), requireSession(config));
  router.use((_req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });
  router.get('/sources/:versionId/passages/:passageId', async (req, res) => {
    const { version, label } = await authorizeSource(String(req.params.versionId), res.locals.account.id);
    const passage = await Passage.findOne({ _id: String(req.params.passageId), versionId: version.id });
    if (!passage) throw missing();
    const passages = await Passage.find({ versionId: version.id }).sort({ ordinal: 1 }).select('_id text page start end').lean();
    res.json({ versionId: version.id, passageId: passage.id, filename: version.filename, revision: version.revision,
      label, quote: passage.text, text: passage.text, page: passage.page, start: passage.start, end: passage.end,
      fileUrl: `/sources/${version.id}/file${passage.page ? `#page=${passage.page}` : ''}`,
      passages: passages.map(p => ({ id: p._id, text: p.text, page: p.page, start: p.start, end: p.end })) });
  });
  router.get('/sources/:versionId/file', async (req, res) => {
    const { version, label } = await authorizeSource(String(req.params.versionId), res.locals.account.id);
    if (!storage) throw new HttpError(503, 'STORAGE_UNAVAILABLE', 'Source storage is temporarily unavailable.');
    try {
      const original = await readPinnedOriginal(version.id, storage);
      res.set({ 'Content-Type': version.mime, 'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(version.filename)}`,
        'X-Source-Version': version.id, 'X-Source-Status': label });
      res.send(Buffer.from(original.bytes));
    } catch { throw new HttpError(503, 'STORAGE_UNAVAILABLE', 'The original could not be read. Please try again.'); }
  });
  return router;
}
