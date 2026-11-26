import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setup, json, stream } from './phase05-harness.mjs';

test('Phase 06 comparisons and explicit support handoff', { timeout: 90000 }, async t => {
  const app = await setup(t), conversationId = await app.conversation();
  const left = await app.seed('The notice period is 30 days. An export window of 14 days applies.', { conversationId, filename: 'agreement.txt' });
  const right = await app.seed('The notice period is 60 days.', { conversationId, filename: 'amendment.txt' });
  const body = (message, selectedDocumentVersionIds) => ({ message, conversationId, clientMessageId: randomUUID(), ...(selectedDocumentVersionIds ? { selectedDocumentVersionIds } : {}) });
  let comparison;
  await t.test('06.1 one complete pinned A2UI comparison verifies both sides and explicit missing evidence', async () => {
    const events = await stream(await app.call('/chat/send', { cookie: app.a.cookie, accept: 'text/event-stream', body: body('What changed in the notice period?') }));
    const surfaces = events.filter(event => event.event === 'comparison');assert.equal(surfaces.length, 1);
    comparison = surfaces[0].data;
    assert.equal(comparison.protocolVersion, 'v0.8');assert.equal(comparison.catalogVersion, 'legal-support/1');assert.equal(comparison.component, 'ClauseComparison');
    assert.equal(comparison.messages.length, 2);assert.ok(comparison.messages[0].surfaceUpdate);assert.ok(comparison.messages[1].beginRendering);
    assert.equal(comparison.messages[1].beginRendering.catalogId, comparison.catalogId);
    const notice = comparison.rows.find(row => row.term === 'Notice period');
    assert.equal(notice.left.versionId, left.versionId);assert.equal(notice.right.versionId, right.versionId);
    assert.equal(notice.left.citation.quote, left.text);assert.equal(notice.right.citation.quote, right.text);
    assert.ok(comparison.rows.find(row => row.term === 'Export window').right.missing);
    const completed = events.at(-1).data;assert.equal(events.at(-1).event, 'complete');assert.equal(completed.followUps.length, 2);
    assert.deepEqual(completed.comparison, comparison);
    for (const side of [notice.left, notice.right]) {
      const passage = await json(await app.call(`/sources/${side.versionId}/passages/${side.passageId}`, { cookie: app.a.cookie }));assert.equal(passage.quote, side.citation.quote);
    }
  });
  await t.test('06.2 ambiguous three-file comparison asks for a pair; selected IDs constrain separate branches and restore on history', async () => {
    await app.seed('The notice period is 90 days.', { conversationId, filename: 'other-agreement.txt' });
    const ambiguous = await json(await app.call('/chat/send', { cookie: app.a.cookie, body: body('Compare what changed.') }));
    assert.equal(ambiguous.comparison, undefined);assert.match(ambiguous.response, /select exactly two/i);
    const selected = await json(await app.call('/chat/send', { cookie: app.a.cookie, body: body('Compare what changed.', [left.versionId, right.versionId]) }));
    const ids = new Set(selected.comparison.rows.flatMap(row => [row.left.versionId, row.right.versionId]));assert.deepEqual([...ids], [left.versionId, right.versionId]);
    const stored = await app.db.collection('messages').findOne({ role: 'assistant', content: selected.response, comparison: { $exists: true }, _id: new (await import('mongodb')).ObjectId(selected.attemptId) });
    for (const candidates of [stored.evidenceSnapshot.keywordCandidateIds, stored.evidenceSnapshot.vectorCandidateIds]) assert.ok(candidates.every(id => ids.has(id)));
    const history = await json(await app.call(`/chat/history?conversationId=${conversationId}`, { cookie: app.a.cookie }));
    const saved = history.items.find(item => item.id === selected.attemptId);assert.deepEqual(saved.comparison, selected.comparison);assert.deepEqual(saved.followUps, selected.followUps);
  });
  await t.test('06.3 supported paragraph and named gap offer draft; accepting twice returns one persisted copyable draft', async () => {
    const result = await json(await app.call('/chat/send', { cookie: app.a.cookie, body: body('What notice applies and what is the absent liability cap?') }));
    assert.ok(result.paragraphs.some(paragraph => paragraph.citations.length));assert.ok(result.paragraphs.some(paragraph => !paragraph.citations.length && /liability cap/i.test(paragraph.text)));
    assert.match(result.handoffOffer.unresolvedQuestion, /liability cap/i);assert.equal(result.draft, undefined);
    const path = `/chat/messages/${result.attemptId}/email-draft`;
    const [first, repeated] = await Promise.all([1, 2].map(async () => json(await app.call(path, { cookie: app.a.cookie, method: 'POST' }))));
    assert.deepEqual(repeated, first);assert.ok(first.draft.subject);assert.match(first.draft.body, /liability cap/i);assert.equal(first.followUps.length, 2);
    assert.ok(result.citations.some(citation => first.draft.body.includes(citation.quote)), 'The draft includes verified source facts as well as the unresolved term');
    const history = await json(await app.call(`/chat/history?conversationId=${conversationId}`, { cookie: app.a.cookie }));
    assert.deepEqual(history.items.find(item => item.id === result.attemptId).draft, first.draft);
    for (const cookie of [app.b.cookie, app.admin.cookie]) assert.equal((await app.call(path, { cookie, method: 'POST' })).status, 404);
    // Draft composition is local and durable: no delivery route or transport is exposed.
    assert.equal((await app.call(`${path}/send`, { cookie: app.a.cookie, method: 'POST' })).status, 404);
  });
});
