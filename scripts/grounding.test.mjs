import test from 'node:test';
import assert from 'node:assert/strict';
import { completedParagraphs } from '../server/dist/answer-provider.js';
import { comparisonCatalogId, followUpQuestions, validateGroundedOutput, validateParagraph } from '../server/dist/answer.js';
import { exportAnswerTrace } from '../server/dist/answer-telemetry.js';
import { fuseHits } from '../server/dist/retrieval.js';

const passages = [
  { id: 'p1', versionId: 'v1', text: 'At least 30 days of written notice.', filename: 'Agreement.pdf', page: 2 },
  { id: 'p2', versionId: 'v2', text: 'At least 60 days of written notice.', filename: 'Amendment.txt', start: 10, end: 45 },
];
const versions = [{ versionId: 'v1', generation: 'g1' }, { versionId: 'v2', generation: 'g2' }];
const paragraph = { text: 'Notice requires 30 days.', kind: 'supported', passageIds: ['p1'] };
const output = (changes = {}) => ({ paragraphs: [paragraph], comparison: null, unresolvedQuestion: null, followUps: ['What exceptions apply?', 'Where is this stated?'], ...changes });
const comparison = () => ({ component: 'ClauseComparison', rows: [{ term: 'Notice', finding: 'The notice changes from 30 to 60 days.',
  left: { versionId: 'v1', passageId: 'p1', missing: false }, right: { versionId: 'v2', passageId: 'p2', missing: false } }] });

test('structured streaming scanner handles every byte boundary, quoted braces, escaped slashes, emoji and nested arrays', () => {
  const paragraphs = [paragraph, { text: 'A {quoted} "value" \\ path 😀', kind: 'gap', passageIds: [] }];
  const encoded = new TextEncoder().encode(JSON.stringify({ paragraphs, comparison: null }));
  for (let split = 1; split < encoded.length; split++) {
    const decoder = new TextDecoder();
    const first = decoder.decode(encoded.slice(0, split), { stream: true });
    assert.ok(completedParagraphs(first).length <= 2);
    assert.deepEqual(completedParagraphs(first + decoder.decode(encoded.slice(split))), paragraphs);
  }
});

test('paragraph anchors are resolved from server evidence, with duplicate IDs collapsed', () => {
  const resolved = validateParagraph({ ...paragraph, passageIds: ['p1', 'p1'], quote: 'A forged quote', filename: 'forged.txt' }, passages, 3);
  assert.equal(resolved.sequence, 3);
  assert.equal(resolved.citations.length, 1);
  assert.equal(resolved.citations[0].quote, passages[0].text);
  assert.equal(resolved.citations[0].filename, passages[0].filename);
  assert.equal(resolved.citations[0].page, 2);
});

test('passage IDs echoed into prose are removed while citations stay resolved', () => {
  const id = '9d4acb9413704d5e3da2d9c3';
  const resolved = validateParagraph({ ...paragraph, text: `Open Settings (${id}:p:2). Export stays available for 14 days (${id}:p:4, ${id}:p:15) after ${id}:p:9 termination.` }, passages, 0);
  assert.equal(resolved.text, 'Open Settings. Export stays available for 14 days after termination.');
  assert.equal(resolved.citations[0].passageId, 'p1');
  assert.throws(() => validateParagraph({ ...paragraph, text: `[${id}:p:2]` }, passages, 0));
});

test('unknown, absent and unsupported paragraph anchors are rejected before persistence', () => {
  assert.throws(() => validateParagraph({ ...paragraph, passageIds: ['private-from-another-thread'] }, passages, 0));
  assert.throws(() => validateParagraph({ ...paragraph, passageIds: [] }, passages, 0));
  assert.throws(() => validateParagraph({ ...paragraph, kind: 'gap' }, passages, 0));
  assert.throws(() => validateParagraph({ ...paragraph, kind: 'invented' }, passages, 0));
});

test('comparison resolves selected left and right sources into actual pinned A2UI messages', () => {
  const answer = validateGroundedOutput(output({ comparison: comparison() }), passages, versions, 'attempt', { mode: 'comparison' });
  assert.equal(answer.comparison.messages[0].surfaceUpdate.components[0].component.ClauseComparison.rows[0].left.citation.quote, passages[0].text);
  assert.equal(answer.comparison.messages[1].beginRendering.catalogId, comparisonCatalogId);
  assert.equal(answer.comparison.messages[1].beginRendering.root, 'comparison');
  assert.equal(answer.comparison.protocolVersion, 'v0.8');
  assert.equal(answer.citations.length, 2);
});

test('comparison rejects swapped versions, cross-side anchors and unknown components', () => {
  let raw = comparison(); raw.rows[0].left.versionId = 'v2';
  assert.throws(() => validateGroundedOutput(output({ comparison: raw }), passages, versions, 'a'));
  raw = comparison(); raw.rows[0].left.passageId = 'p2';
  assert.throws(() => validateGroundedOutput(output({ comparison: raw }), passages, versions, 'a'));
  raw = comparison(); raw.component = 'ArbitraryScript';
  assert.throws(() => validateGroundedOutput(output({ comparison: raw }), passages, versions, 'a'));
  assert.throws(() => validateGroundedOutput(output({ comparison: comparison() }), passages, versions, 'a', { mode: 'answer' }));
});

test('comparison missing side is explicit and cannot simultaneously claim a passage', () => {
  const raw = comparison(); raw.rows[0].right = { versionId: 'v2', passageId: null, missing: true };
  const answer = validateGroundedOutput(output({ comparison: raw }), passages, versions, 'a');
  assert.equal(answer.comparison.rows[0].right.missing, true);
  assert.equal(answer.comparison.rows[0].right.citation, undefined);
  raw.rows[0].right.passageId = 'p2';
  assert.throws(() => validateGroundedOutput(output({ comparison: raw }), passages, versions, 'a'));
  raw.rows[0].right.passageId = null; raw.rows[0].left = { versionId: 'v1', passageId: null, missing: true };
  assert.throws(() => validateGroundedOutput(output({ comparison: raw }), passages, versions, 'a'));
});

test('ambiguous-pair clarification cannot carry factual paragraphs or a comparison', () => {
  assert.throws(() => validateGroundedOutput(output(), passages, versions, 'a', { mode: 'clarification' }));
  const answer = validateGroundedOutput(output({ paragraphs: [{ text: 'Which two versions should I compare?', kind: 'clarification', passageIds: [] }] }), passages, versions, 'a', { mode: 'clarification' });
  assert.equal(answer.citations.length, 0);
});

test('all answer modes restore exactly two contextual fallback suggestions', () => {
  for (const value of [undefined, [], ['one'], ['same', 'same'], [' same', 'same '], [42, null], ['', 'valid']]) {
    assert.equal(followUpQuestions(value).length, 2);
    assert.equal(followUpQuestions(value, true).length, 2);
    assert.equal(followUpQuestions(value, false, true).length, 2);
  }
});

test('RRF fails closed if either branch contains unauthorized version or stale generation before fusion', () => {
  const hit = { _id: 'c1', versionId: 'v1', generation: 'g1', passageIds: ['p1'] };
  assert.deepEqual(fuseHits([hit], [hit], versions), [hit]);
  assert.throws(() => fuseHits([hit], [{ ...hit, versionId: 'other' }], versions));
  assert.throws(() => fuseHits([{ ...hit, generation: 'stale' }], [], versions));
});

test('telemetry exports only masked IDs, timings and model metadata with linked stage spans', async () => {
  const original = globalThis.fetch;
  let body;
  globalThis.fetch = async (_url, options) => { body = JSON.parse(options.body); return new Response('{}', { status: 200 }); };
  try {
    const result = await exportAnswerTrace({ answer: { model: 'fixture/model' }, telemetry: { baseUrl: 'https://cloud.langfuse.com', publicKey: 'pk', secretKey: 'secret', environment: 'test' } },
      { traceId: 'a'.repeat(32), attemptId: 'opaque-attempt', userMessageId: 'opaque-user-turn', conversationId: 'opaque-thread', started: Date.now() - 10, terminal: 'completed',
        timings: { retrievalMs: 4, generationMs: 5, validationMs: 1 }, snapshot: { versions: [{ filename: 'SECRET_NAME', text: 'SECRET_QUOTATION', key: 'SECRET_S3' }],
          keywordCandidateIds: ['v1'], vectorCandidateIds: ['v2'], selectedChunkIds: ['c1'] }, message: 'SECRET_QUESTION', response: 'SECRET_ANSWER' });
    assert.equal(result.accepted, true);
    const serialized = JSON.stringify(body);
    assert.ok(!serialized.includes('SECRET_'));
    const spans = body.resourceSpans[0].scopeSpans[0].spans;
    assert.ok(spans.some(span => span.name === 'generation'));
    assert.ok(spans.some(span => span.name === 'validation'));
    assert.ok(spans.slice(1).every(span => span.parentSpanId === spans[0].spanId));
    globalThis.fetch = async () => new Response('{}', { status: 503 });
    await assert.rejects(exportAnswerTrace({ telemetry: { baseUrl: 'https://cloud.langfuse.com' } }, { traceId: 'a', attemptId: 'a', userMessageId: 'a', conversationId: 'a', started: Date.now(), terminal: 'failed', timings: {} }));
  } finally { globalThis.fetch = original; }
});

test('bounded correction keeps earlier streamed paragraphs stable and persists no invalid anchor', async () => {
  process.env.NODE_ENV = 'test';
  const { Conversation, Message } = await import('../server/dist/conversations.js');
  const { Document, DocumentVersion } = await import('../server/dist/uploads.js');
  const { Passage } = await import('../server/dist/index-records.js');
  const { generateAnswer, setTestGroundedProvider } = await import('../server/dist/answer.js');
  const { setTestRetrievalBranches } = await import('../server/dist/retrieval.js');
  const originals = { exists: Conversation.exists, documents: Document.find, versions: DocumentVersion.find, messages: Message.find, passages: Passage.find };
  Conversation.exists = async () => true;
  Document.find = () => ({ select: () => ({ lean: async () => [] }) });
  DocumentVersion.find = () => ({ lean: async () => [{ _id: 'v1', activeIndexGeneration: 'g1', embeddingModel: 'fixture/embed', dimensions: 2, filename: 'Agreement.pdf', scope: 'private' }] });
  Message.find = () => ({ sort: () => ({ limit: () => ({ lean: async () => [] }) }) });
  Passage.find = () => ({ lean: async () => passages.map(passage => ({ ...passage, _id: passage.id })) });
  const hit = { _id: 'c1', versionId: 'v1', generation: 'g1', passageIds: ['p1'] };
  setTestRetrievalBranches({ keyword: async () => [hit], vector: async () => [hit] });
  const second = { text: 'The same notice is written.', kind: 'supported', passageIds: ['p1'] };
  let calls = 0;
  const emitted = [];
  const request = { ownerId: 'owner', conversationId: 'thread', userMessageId: 'turn', attemptId: 'attempt', message: 'What notice is required?',
    config: { answer: { model: 'fixture/model', apiKey: 'fixture', deadlineMs: 10000 } }, onParagraph: async paragraph => emitted.push(paragraph) };
  try {
    setTestGroundedProvider({ plan: async () => ({ mode: 'answer', selectedVersionIds: [] }), generate: async (_request, context, _signal, onParagraph) => {
      calls++;
      if (!context.correction) {
        await onParagraph(paragraph, 0);
        const invalid = { ...second, passageIds: ['foreign-private'] };
        await onParagraph(invalid, 1);
        return output({ paragraphs: [paragraph, invalid] });
      }
      return output({ paragraphs: [paragraph, second] });
    } });
    const answer = await generateAnswer(request);
    assert.equal(calls, 2);
    assert.deepEqual(emitted.map(item => item.sequence), [0, 1]);
    assert.ok(!JSON.stringify(emitted).includes('foreign-private'));
    assert.equal(answer.paragraphs.length, 2);

    calls = 0; emitted.length = 0;
    setTestGroundedProvider({ plan: async () => ({ mode: 'answer', selectedVersionIds: [] }), generate: async (_request, context, _signal, onParagraph) => {
      calls++;
      if (!context.correction) {
        await onParagraph(paragraph, 0);
        return output({ paragraphs: [paragraph, { ...second, passageIds: ['foreign-private'] }] });
      }
      return output({ paragraphs: [{ ...paragraph, text: 'A changed already emitted claim.' }, second] });
    } });
    await assert.rejects(generateAnswer(request), /already emitted/);
    assert.equal(calls, 2);
    assert.deepEqual(emitted.map(item => item.text), [paragraph.text]);

    calls = 0; emitted.length = 0;
    setTestGroundedProvider({ plan: async () => ({ mode: 'answer', selectedVersionIds: [] }), generate: async (_request, context, _signal, onParagraph) => {
      calls++;
      if (!context.correction) {
        await onParagraph(paragraph, 0); await onParagraph(second, 1);
        return output({ paragraphs: [paragraph, second, { ...second, passageIds: ['foreign-private'] }] });
      }
      return output({ paragraphs: [paragraph] });
    } });
    await assert.rejects(generateAnswer(request), /already emitted/);
    assert.equal(calls, 2);
    assert.deepEqual(emitted.map(item => item.sequence), [0, 1]);

    setTestGroundedProvider({ plan: async () => ({ mode: 'answer', selectedVersionIds: ['v1', 'v1'] }), generate: async () => { throw new Error('Generation must never run for duplicate selection.'); } });
    await assert.rejects(generateAnswer(request), /Invalid evidence selection/);
  } finally {
    Conversation.exists = originals.exists; Document.find = originals.documents; DocumentVersion.find = originals.versions;
    Message.find = originals.messages; Passage.find = originals.passages;
    setTestGroundedProvider(undefined); setTestRetrievalBranches(undefined);
  }
});

test('query embedding request honors an already expired answer deadline', async () => {
  const { createIndexProviders } = await import('../server/dist/index-providers.js');
  const previousFetch = globalThis.fetch;
  const deadline = new AbortController();
  deadline.abort(new Error('Fictional answer deadline'));
  let observedSignal;
  globalThis.fetch = async (_url, options) => {
    observedSignal = options.signal;
    options.signal.throwIfAborted();
    throw new Error('An expired request must not reach the provider.');
  };
  try {
    await assert.rejects(createIndexProviders().embed(['fictional query'], { apiKey: 'fixture-key', model: 'fixture/embed', dimensions: 2 }, deadline.signal), /embedding provider could not be reached/i);
    assert.equal(observedSignal.aborted, true);
    assert.equal(observedSignal.reason, deadline.signal.reason);
  } finally { globalThis.fetch = previousFetch; }
});
