// Test-only variant of the phase05 grounded fixture with a timed reader-position probe.
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { setTestGroundedProvider } from '../server/dist/answer.js';
import { setTestRetrievalBranches } from '../server/dist/retrieval.js';
import { Chunk } from '../server/dist/index-records.js';
import { setTestStorage } from '../server/dist/storage.js';

setTestStorage({ async verify() {}, async form() { throw new Error('Upload unavailable in answer fixture'); },
  async original(key, versionId) { const bytes = key.startsWith('base64:') ? Buffer.from(key.slice(7), 'base64') : Buffer.from(key);return { bytes, size: bytes.length, mime: key.startsWith('base64:') ? 'application/pdf' : 'text/plain',
    hash: createHash('sha256').update(bytes).digest('hex'), uploadedAt: new Date(), versionId }; },
  async versions() { return []; }, async remove() {} });
const branch = async (_query, versions) => versions.length ? Chunk.find({ $or: versions.map(version => ({ versionId: version.versionId, generation: version.generation })) }).lean() : [];
setTestRetrievalBranches({ keyword: branch, vector: branch });
setTestGroundedProvider({
  async plan(request, versions) {
    const selected = request.selectedDocumentVersionIds ?? [];
    const privateVersions = versions.filter(version => version.scope === 'private');
    return /compare|changed/i.test(request.message)
      ? { mode: selected.length === 2 || privateVersions.length === 2 ? 'comparison' : 'clarification', selectedVersionIds: selected.length ? selected : privateVersions.length === 2 ? privateVersions.map(v => v.versionId) : [] }
      : { mode: 'answer', selectedVersionIds: selected };
  },
  async generate(request, context, _signal, onParagraph) {
    const followUps = ['Which exceptions apply?', 'Where can I verify this?'];
    if (request.message === 'LONG_STREAM') {
      const source = context.passages[0];
      if (!source) throw new Error('The long-stream probe requires its fictional policy.');
      const paragraphs = [];
      for (let sequence = 0; sequence < 10; sequence++) {
        request.signal?.throwIfAborted();
        const paragraph = { kind: 'supported', text: `Fictional paragraph ${sequence + 1}. ` + source.text.repeat(12), passageIds: [source.id] };
        paragraphs.push(paragraph);
        await onParagraph?.(paragraph, sequence);
        await delay(700, undefined, { signal: request.signal });
      }
      return { paragraphs, comparison: null, unresolvedQuestion: null, followUps };
    }

    if (request.message === 'INVALID_CITATION') {
      const paragraph = { kind: 'supported', text: 'Invented claim', passageIds: ['nonexistent-passage'] };
      await onParagraph?.(paragraph, 0);
      return { paragraphs: [paragraph], comparison: null, unresolvedQuestion: null, followUps };
    }
    if (context.plan.mode === 'clarification') return { paragraphs: [{ kind: 'clarification', text: 'Please select exactly two documents to compare.', passageIds: [] }], comparison: null, unresolvedQuestion: null, followUps };
    if (context.plan.mode === 'comparison') {
      const [left, right] = context.versions, lp = context.passages.find(p => p.versionId === left.versionId), rp = context.passages.find(p => p.versionId === right.versionId);
      return { paragraphs: [], comparison: { component: 'ClauseComparison', rows: [
        { term: 'Notice period', finding: 'The notice period changed from 30 days to 60 days.', left: { versionId: left.versionId, passageId: lp.id }, right: { versionId: right.versionId, passageId: rp.id } },
        { term: 'Export window', finding: 'An export window appears only in the first version.', left: { versionId: left.versionId, passageId: lp.id }, right: { versionId: right.versionId, missing: true } },
      ] }, unresolvedQuestion: null, followUps };
    }
    const passage = context.passages.find(p => p.text.includes('orchid-742')) ?? context.passages[0];
    const first = passage ? { kind: 'supported', text: passage.text, passageIds: [passage.id] } : { kind: 'gap', text: 'The documents do not answer this question.', passageIds: [] };
    await onParagraph?.(first, 0);
    if (request.message === 'RETRY_SNAPSHOT' && !request.retryId) throw new Error('Fictional failure after snapshot');
    if (request.message.startsWith('DELAYED:')) await delay(200);
    const gap = /missing|absent|liability cap/i.test(request.message);
    const paragraphs = [first];
    if (gap) { const p = { kind: 'gap', text: 'The liability cap is not covered by the available evidence. I can prepare a support email draft.', passageIds: [] };paragraphs.push(p);await onParagraph?.(p, 1); }
    return { paragraphs, comparison: null, unresolvedQuestion: gap ? 'What is the applicable liability cap?' : null, followUps };
  },
});
await import('../server/dist/index.js');
