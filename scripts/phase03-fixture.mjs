import { createHash, createHmac, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { readConfig } from '../server/dist/config.js';
import { advanceTestUploadClock, createStorage, maxOriginalBytes, setTestStorage, uploadNow } from '../server/dist/storage.js';
import { cleanupUploads, DocumentVersion, readPinnedOriginal } from '../server/dist/uploads.js';

let storage;
let emulator;
if (process.env.QA_REAL_STORAGE === 'true') storage = createStorage(readConfig(process.env));
else {
  const objects = new Map();
  const secret = randomUUID();
  const sign = value => createHmac('sha256', secret).update(value).digest('hex');
  emulator = createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(403).end(); return; }
    try {
      const request = new Request('http://localhost', { method: 'POST', headers: req.headers, body: Readable.toWeb(req), duplex: 'half' });
      const data = await request.formData();
      const policy = String(data.get('policy'));
      if (data.get('signature') !== sign(policy)) throw new Error();
      const conditions = JSON.parse(Buffer.from(policy, 'base64url').toString());
      const file = data.get('file');
      if (data.get('key') !== conditions.key || data.get('Content-Type') !== conditions.mime
        || data.get('x-amz-meta-upload-id') !== conditions.uploadId || uploadNow().getTime() >= conditions.expires
        || !(file instanceof File) || file.size < 1 || file.size > maxOriginalBytes) throw new Error();
      const bytes = Buffer.from(await file.arrayBuffer());
      const version = { versionId: randomUUID(), size: bytes.length, mime: conditions.mime,
        hash: createHash('sha256').update(bytes).digest('hex'), uploadedAt: uploadNow(), bytes };
      objects.set(conditions.key, [...(objects.get(conditions.key) ?? []), version]);
      res.writeHead(204).end();
    } catch { res.writeHead(403).end(); }
  });
  await new Promise(resolve => emulator.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${emulator.address().port}`;
  storage = {
    async verify() {},
    async form(key, mime, uploadId, seconds) {
      const policy = Buffer.from(JSON.stringify({ key, mime, uploadId, expires: uploadNow().getTime() + seconds * 1000 })).toString('base64url');
      return { url: base, fields: { key, 'Content-Type': mime, 'x-amz-meta-upload-id': uploadId, policy, signature: sign(policy) } };
    },
    async original(key, versionId) {
      const versions = objects.get(key) ?? [];
      return (versionId ? versions.find(item => item.versionId === versionId) : versions.at(-1)) ?? null;
    },
    async versions(key) { return (objects.get(key) ?? []).map(item => item.versionId); },
    async remove(key, versionId) { objects.set(key, (objects.get(key) ?? []).filter(item => item.versionId !== versionId)); },
  };
  setTestStorage(storage);
}
process.on('message', async ({ command, requestId, milliseconds, versionId }) => {
  try {
    let result;
    if (command === 'advance-clock') { advanceTestUploadClock(milliseconds); result = true; }
    if (command === 'cleanup') { await cleanupUploads(storage); result = true; }
    if (command === 'read-pinned') {
      const original = await readPinnedOriginal(versionId, storage);
      result = { hash: original.hash, size: original.size, versionId: original.versionId };
    }
    if (command === 'read-latest') {
      const version = await DocumentVersion.findById(versionId);
      const original = await storage.original(version.key);
      result = { hash: original.hash, size: original.size, versionId: original.versionId };
    }
    process.send?.({ requestId, result });
  } catch { process.send?.({ requestId, error: 'Fixture operation failed' }); }
});
process.once('SIGTERM', () => emulator?.close());
await import('../server/dist/index.js');
