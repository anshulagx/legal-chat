import { setTestAnswerAdapter } from '../server/dist/answer.js';

let paused = process.env.QA_PAUSE_ANSWERS === 'true';
let failNext = false;
const waiting = new Set();
process.on('message', command => {
  if (command === 'pause-answers') paused = true;
  if (command === 'fail-next-answer') failNext = true;
  if (command === 'release-answers') {
    paused = false;
    for (const resolve of waiting) resolve();
    waiting.clear();
  }
  process.send?.({ event: 'control', command });
});
setTestAnswerAdapter(async request => {
  process.send?.({ event: 'generation', attemptId: request.attemptId });
  if (paused) await new Promise(resolve => waiting.add(resolve));
  if (failNext) { failNext = false; throw new Error('Fictional QA failure'); }
  return { response: `Fixture answer: ${request.message}`, followUps: [] };
});
await import('../server/dist/index.js');
