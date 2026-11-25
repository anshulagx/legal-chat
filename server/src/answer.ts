export type AnswerRequest = { message: string; conversationId: string; userMessageId: string; attemptId: string };
export type Answer = { response: string; followUps: string[] };
type AnswerAdapter = (request: AnswerRequest) => Promise<Answer>;

// Replaced with retrieval-grounded generation in Phase 05.
let adapter: AnswerAdapter = async () => ({
  response: 'Your question is saved. Answers from support documents will be available here soon.',
  followUps: [],
});

// Only a test process can install an adapter; no request or hosted client can select one.
export function setTestAnswerAdapter(testAdapter: AnswerAdapter) {
  if (process.env.NODE_ENV !== 'test') throw new Error('Answer injection requires test execution.');
  adapter = testAdapter;
}

export async function generateAnswer(request: AnswerRequest) {
  const result = await adapter(request);
  if (typeof result.response !== 'string' || !result.response.trim() || result.response.length > 20000
    || !Array.isArray(result.followUps) || result.followUps.some(value => typeof value !== 'string')) {
    throw new Error('Invalid answer adapter output.');
  }
  return result;
}
