import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { exportAnswerTrace, queueAnswerTrace, flushAnswerTraces } from '../server/dist/answer-telemetry.js';

test('07.3 telemetry masks content, correlates retries, ranks branches and allowlists usage', async () => {
  const original = global.fetch;
  const marker = 'FICTIONAL_SECRET_MARKER'; let exported;
  global.fetch = async (_url, options) => { exported = JSON.parse(options.body); return Response.json({}); };
  try {
    const config = { answer: { model: 'fixture/chat' }, telemetry: { baseUrl: 'https://cloud.langfuse.com', environment: 'test', publicKey: marker, secretKey: marker } };
    await exportAnswerTrace(config, { traceId: 'a'.repeat(32), attemptId: '1'.repeat(24), userMessageId: '2'.repeat(24), conversationId: '3'.repeat(24), retryId: marker,
      started: Date.now(), terminal: 'completed', timings: { retrievalMs: 10, generationMs: 20, validationMs: 2 },
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, [marker]: 123 },
      snapshot: { versions: [], keywordCandidateIds: ['opaque-chunk'], vectorCandidateIds: ['opaque-chunk'], selectedChunkIds: ['opaque-chunk'], text: marker },
      prompt: marker, response: marker, cookie: marker, signedForm: { token: marker } });
    const text = JSON.stringify(exported); assert.ok(!text.includes(marker));
    assert.ok(text.includes(createHash('sha256').update(marker).digest('hex')));
    const spans = exported.resourceSpans[0].scopeSpans[0].spans;
    assert.ok(spans.some(span => span.name === 'retrieval-keyword' && span.attributes[0].key === 'rank.1'));
    const attrs = spans[0].attributes; assert.ok(attrs.some(attr => attr.key === 'usage.total_tokens' && attr.value.doubleValue === 15));
    assert.ok(attrs.some(attr => attr.key === 'terminal.status' && attr.value.stringValue === 'completed'));
  } finally { global.fetch = original; }
});

test('07.3 telemetry failure is isolated and flush time is bounded', async () => {
  const original = global.fetch;
  global.fetch = async () => { throw new Error('Fictional outage'); };
  const config = { telemetry: { baseUrl: 'https://cloud.langfuse.com', environment: 'test', publicKey: 'test', secretKey: 'test' } };
  const trace = { traceId: 'a'.repeat(32), attemptId: '1'.repeat(24), userMessageId: '2'.repeat(24), conversationId: '3'.repeat(24), started: Date.now(), terminal: 'failed', timings: {} };
  try {
    queueAnswerTrace(config, trace); await flushAnswerTraces(100);
    global.fetch = () => new Promise(() => {});
    queueAnswerTrace(config, trace); const started = Date.now(); await flushAnswerTraces(30);
    assert.ok(Date.now() - started < 500);
  } finally { global.fetch = original; }
});
