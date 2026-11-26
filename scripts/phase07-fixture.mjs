import { setTimeout as delay } from 'node:timers/promises';
import { setTestAnswerAdapter } from '../server/dist/answer.js';
import { HttpError } from '../server/dist/http.js';
setTestAnswerAdapter(async request => {
  if (!request.retryId && request.message === 'FAIL_EARLY') throw new Error('Fictional early failure');
  if (!request.retryId && request.message === 'THROTTLE') throw new HttpError(429, 'PROVIDER_THROTTLED', 'Fictional busy provider', undefined, 1);
  await request.onSnapshot?.({ versions: [], keywordCandidateIds: [], vectorCandidateIds: [], selectedChunkIds: [] });
  const paragraph = { sequence: 0, text: 'Fictional validated partial reply.', citations: [] };
  await request.onParagraph?.(paragraph);
  if (!request.retryId && request.message === 'FAIL_PARTIAL') throw new Error('Fictional late failure');
  if (request.message === 'WAIT' || request.retryId) await delay(request.retryId ? 200 : 20000, undefined, { signal: request.signal });
  return { response: paragraph.text, paragraphs: [paragraph], followUps: ['Which exceptions apply?', 'Where can I verify this?'] };
});
await import('../server/dist/index.js');
