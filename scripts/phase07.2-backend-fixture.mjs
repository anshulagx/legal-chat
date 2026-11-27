// Test-only fault injection exercises transport failures without production controls.
import { setTestAnswerAdapter } from '../server/dist/answer.js';
import { Message } from '../server/dist/conversations.js';
setTestAnswerAdapter(async request => {
  const paragraph = { sequence: 0, text: 'Fictional saved reply.', citations: [] };
  if (request.message === 'LOOKUP_FAIL_LATE') await request.onParagraph?.(paragraph);
  const findOne = Message.findOne;
  Message.findOne = function (filter, ...args) {
    if (String(filter?._id) === request.attemptId) {
      Message.findOne = findOne;
      throw new Error('Fictional terminal result lookup failure');
    }
    return findOne.call(this, filter, ...args);
  };
  return { response: paragraph.text, paragraphs: request.message === 'LOOKUP_FAIL_LATE' ? [paragraph] : [], followUps: ['Which exceptions apply?', 'Where can I verify this?'] };
});
await import('../server/dist/index.js');
