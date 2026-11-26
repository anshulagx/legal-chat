import { randomUUID, createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { readConfig } from '../server/dist/config.js';
import { exportAnswerTrace } from '../server/dist/answer-telemetry.js';
const config = readConfig(process.env);
if (!config.telemetry) throw new Error('Langfuse is not configured.');
const marker = `FICTIONAL_MASK_${randomUUID()}`, turn = randomUUID(), conversation = randomUUID();
const report = { timestamp: new Date().toISOString(), fictionalContentOnly: true, ingestion: 'BLOCKED', readback: 'BLOCKED', masking: 'BLOCKED', turnId: turn, retryHash: createHash('sha256').update(marker).digest('hex'), traces: [] };
const headers = { Authorization: `Basic ${Buffer.from(`${config.telemetry.publicKey}:${config.telemetry.secretKey}`).toString('base64')}` };
try {
  for (const terminal of ['failed', 'completed']) {
    const traceId = randomUUID().replaceAll('-', '');
    const retryId = terminal === 'completed' ? marker : undefined;
    await exportAnswerTrace(config, { traceId, attemptId: randomUUID(), userMessageId: turn, conversationId: conversation,
      retryId, started: Date.now() - 40, terminal, timings: { retrievalMs: 10, generationMs: 20, validationMs: 5, firstParagraphMs: 25 },
      usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
      snapshot: { versions: [], keywordCandidateIds: ['fictional-opaque-chunk'], vectorCandidateIds: ['fictional-opaque-chunk'], selectedChunkIds: ['fictional-opaque-chunk'] } });
    report.traces.push({ traceId, terminal, retry: !!retryId });
  }
  report.ingestion = 'PASS';
  const readbacks = [];
  for (const trace of report.traces) {
    let found;
    for (let trial = 0; trial < 24; trial++) {
      const response = await fetch(`${config.telemetry.baseUrl}/api/public/v2/observations?${new URLSearchParams({ traceId: trace.traceId, fields: 'core,basic,metadata', limit: '100', fromStartTime: new Date(Date.now() - 120000).toISOString(), toStartTime: new Date(Date.now() + 60000).toISOString() })}`, { headers, signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new Error(`Readback HTTP ${response.status}`);
      const data = await response.json();
      if ((data.data ?? []).some(item => item.traceId === trace.traceId)) { found = data.data; break; }
      await delay(1500);
    }
    if (!found) throw new Error('Trace readback timed out.');
    const serialized = JSON.stringify(found);
    const expected = ['retrieval-keyword', 'retrieval-vector', 'retrieval-fusion', 'generation', 'validation', turn, trace.terminal, 'usage.total_tokens'];
    if (trace.retry) expected.push(createHash('sha256').update(marker).digest('hex'));
    if (expected.some(value => !serialized.includes(value))) throw new Error('Readback is missing expected correlation, rank stages or usage metadata.');
    if (serialized.includes(marker)) throw new Error('Default masking failed.');
    readbacks.push(found.length);
  }
  report.readback = 'PASS'; report.masking = 'PASS'; report.observationCounts = readbacks;
} catch (error) { report.error = error instanceof Error ? error.message : 'Probe failed'; }
await writeFile(new URL('../qa/phase07-live-telemetry.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
if (report.readback !== 'PASS') process.exitCode = 1;
