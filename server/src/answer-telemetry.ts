import { randomUUID } from 'node:crypto';
import type { Config } from './config.ts';
import type { EvidenceSnapshot } from './retrieval.ts';

export async function exportAnswerTrace(config: Config, trace: { traceId: string; attemptId: string; userMessageId: string; conversationId: string;
  started: number; terminal: string; timings: Record<string, number>; snapshot?: EvidenceSnapshot }) {
  const settings = config.telemetry;
  if (!settings) return;
  // Construct a strict allowlist before serialization: never attach prompts,
  // quotations, user questions, filenames, credentials, source URLs or content.
  const stringValue = (value: string) => ({ stringValue: value });
  const attributes = [
    { key: 'langfuse.environment', value: stringValue(settings.environment) },
    { key: 'attempt.id', value: stringValue(trace.attemptId) },
    { key: 'turn.id', value: stringValue(trace.userMessageId) },
    { key: 'conversation.id', value: stringValue(trace.conversationId) },
    { key: 'terminal.status', value: stringValue(trace.terminal) },
    { key: 'model.id', value: stringValue(config.answer?.model ?? '') },
    ...Object.entries(trace.timings).map(([key, value]) => ({ key, value: { doubleValue: value } })),
  ];
  const start = BigInt(trace.started) * 1000000n;
  const rootSpanId = randomUUID().replaceAll('-', '').slice(0, 16);
  const spans: Record<string, unknown>[] = [{ traceId: trace.traceId, spanId: rootSpanId, name: 'grounded-answer', kind: 1,
    startTimeUnixNano: String(start), endTimeUnixNano: String(BigInt(Date.now()) * 1000000n), attributes }];
  for (const [branch, ids] of Object.entries({ keyword: trace.snapshot?.keywordCandidateIds ?? [], vector: trace.snapshot?.vectorCandidateIds ?? [], fusion: trace.snapshot?.selectedChunkIds ?? [] })) {
    spans.push({ traceId: trace.traceId, parentSpanId: rootSpanId, spanId: randomUUID().replaceAll('-', '').slice(0, 16), name: `retrieval-${branch}`, kind: 1,
      startTimeUnixNano: String(start), endTimeUnixNano: String(BigInt(Date.now()) * 1000000n),
      attributes: ids.map((id, rank) => ({ key: `rank.${rank + 1}`, value: stringValue(id) })) });
  }
  for (const stage of ['generation', 'validation']) {
    const duration = trace.timings[`${stage}Ms`];
    if (duration === undefined) continue;
    const stageStart = start + BigInt(trace.timings.retrievalMs ?? 0) * 1000000n;
    spans.push({ traceId: trace.traceId, parentSpanId: rootSpanId, spanId: randomUUID().replaceAll('-', '').slice(0, 16), name: stage, kind: 1,
      startTimeUnixNano: String(stageStart), endTimeUnixNano: String(stageStart + BigInt(duration) * 1000000n), attributes: [] });
  }
  const response = await fetch(`${settings.baseUrl}/api/public/otel/v1/traces`, { method: 'POST', signal: AbortSignal.timeout(5000),
    headers: { Authorization: `Basic ${Buffer.from(`${settings.publicKey}:${settings.secretKey}`).toString('base64')}`, 'Content-Type': 'application/json', 'x-langfuse-ingestion-version': '4' },
    body: JSON.stringify({ resourceSpans: [{ resource: { attributes: [{ key: 'service.name', value: stringValue('legal-support-chat') }] },
      scopeSpans: [{ scope: { name: 'legal-support-grounding' }, spans }] }] }) });
  if (!response.ok) throw new Error(`Telemetry export failed (${response.status}).`);
  const result = await response.json() as { partialSuccess?: { rejectedSpans?: number } };
  if (Number(result.partialSuccess?.rejectedSpans ?? 0)) throw new Error('Telemetry export rejected spans.');
  return { traceId: trace.traceId, accepted: true };
}
