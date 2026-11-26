import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import mongoose from 'mongoose';
import { setup, json, stream, ObjectId } from './phase05-harness.mjs';

test('Phase 05 grounded answers, streaming and source isolation', { timeout: 120000 }, async t => {
  const app = await setup(t);
  const conversationId = await app.conversation(), fresh = await app.conversation(), bThread = await app.conversation(app.b);
  const privateSource = await app.seed('The private project code is orchid-742. The notice period is 30 days.', { conversationId });
  const sharedSource = await app.seed('To export your contracts, open Settings, select Data export, and choose Download ZIP.', { scope: 'shared' });
  const send = (message, extra = {}) => app.call('/chat/send', { cookie: app.a.cookie,
    body: { message, conversationId, clientMessageId: randomUUID(), ...extra } });
  let answer;
  await t.test('05.1 accepted/progress/paragraph/complete arrive in order; paragraph is durable before completion', async () => {
    const response = await app.call('/chat/send', { cookie: app.a.cookie, accept: 'text/event-stream',
      body: { message: 'DELAYED: What is the notice period?', conversationId, clientMessageId: randomUUID() } });
    let firstParagraphAt;let attemptId;
    const events = await stream(response, async event => {
      if (event.event === 'accepted') attemptId = event.data.attemptId;
      if (event.event === 'paragraph' && !firstParagraphAt) {
        firstParagraphAt = event.at;
        const saved = await app.db.collection('messages').findOne({ _id: new ObjectId(attemptId) });
        assert.equal(saved.status, 'generating');assert.deepEqual(saved.paragraphs[0], event.data);
      }
    });
    assert.equal(events[0].event, 'accepted');assert.equal(events.at(-1).event, 'complete');
    assert.ok(events.some(e => e.event === 'progress'));
    assert.ok(events.at(-1).at - firstParagraphAt >= 100, 'First paragraph precedes delayed completion');
    answer = events.at(-1).data;assert.equal(answer.status, 'completed');assert.equal(answer.followUps.length, 2);
    assert.ok(answer.citations.some(c => c.passageId === privateSource.passageId));
  });
  await t.test('05.2 citations resolve exact immutable TXT range and superseded/archived shared originals', async () => {
    const passage = await json(await app.call(`/sources/${privateSource.versionId}/passages/${privateSource.passageId}`, { cookie: app.a.cookie }));
    assert.equal(passage.quote, privateSource.text);assert.equal(passage.start, 0);assert.equal(passage.end, privateSource.text.length);
    const file = await app.call(`/sources/${privateSource.versionId}/file`, { cookie: app.a.cookie });
    assert.equal(file.status, 200);assert.equal(await file.text(), privateSource.text);assert.equal(file.headers.get('x-source-version'), privateSource.versionId);
    const selectedBody = { message: 'How do I export my contracts?', conversationId, clientMessageId: randomUUID(), selectedDocumentVersionIds: [sharedSource.versionId] };
    const selectedAnswer = await json(await app.call('/chat/send', { cookie: app.a.cookie, body: selectedBody }));
    assert.ok(selectedAnswer.citations.some(c => c.versionId === sharedSource.versionId));
    await app.seed('Revised export instructions.', { scope: 'shared', documentId: sharedSource.documentId, revision: 2 });
    const route = `/sources/${sharedSource.versionId}/passages/${sharedSource.passageId}`;
    assert.equal((await json(await app.call(route, { cookie: app.a.cookie }))).label, 'Superseded');
    assert.deepEqual(await json(await app.call('/chat/send', { cookie: app.a.cookie, body: selectedBody })), selectedAnswer, 'Replay retains a superseded selected version');
    await app.db.collection('documents').updateOne({ _id: new ObjectId(sharedSource.documentId) }, { $set: { archivedAt: new Date() } });
    assert.equal((await json(await app.call(route, { cookie: app.a.cookie }))).label, 'Archived');
    assert.deepEqual(await json(await app.call('/chat/send', { cookie: app.a.cookie, body: selectedBody })), selectedAnswer, 'Replay retains an archived selected version');
    const conflict = await json(await app.call('/chat/send', { cookie: app.a.cookie, body: { ...selectedBody, message: 'Changed archived-source question' } }), 409);
    assert.equal(conflict.code, 'IDEMPOTENCY_CONFLICT');
  });
  await t.test('05.2 PDF citation opens the exact page and preserves original PDF bytes', async () => {
    const pdf = await readFile(new URL('./fixtures/phase04/cross-page.pdf', import.meta.url));
    const source = await app.seed('30 days before the requested termination date.', { conversationId, filename: 'cross-page.pdf', page: 2, originalBytes: pdf });
    const passage = await json(await app.call(`/sources/${source.versionId}/passages/${source.passageId}`, { cookie: app.a.cookie }));
    assert.equal(passage.page, 2);assert.ok(passage.fileUrl.endsWith('#page=2'));assert.equal(passage.quote, source.text);
    const file = await app.call(`/sources/${source.versionId}/file`, { cookie: app.a.cookie });
    assert.equal(file.status, 200);assert.match(file.headers.get('content-type'), /application\/pdf/);assert.deepEqual(Buffer.from(await file.arrayBuffer()), pdf);
  });
  await t.test('05.4 second customer cannot read private history, passage or original file', async () => {
    for (const path of [`/chat/history?conversationId=${conversationId}`, `/sources/${privateSource.versionId}/passages/${privateSource.passageId}`, `/sources/${privateSource.versionId}/file`])
      assert.equal((await app.call(path, { cookie: app.b.cookie })).status, 404, path);
  });
  await t.test('05.4 seeded admin cannot read private history, passage or original file', async () => {
    for (const path of [`/chat/history?conversationId=${conversationId}`, `/sources/${privateSource.versionId}/passages/${privateSource.passageId}`, `/sources/${privateSource.versionId}/file`])
      assert.equal((await app.call(path, { cookie: app.admin.cookie })).status, 404, path);
  });
  await t.test('05.4 explicit selected IDs cannot grant private evidence in another or fresh thread', async () => {
    for (const [cookie, thread] of [[app.a.cookie, fresh], [app.b.cookie, bThread]]) {
      const response = await app.call('/chat/send', { cookie, body: { message: 'What is the private project code?', conversationId: thread,
        clientMessageId: randomUUID(), selectedDocumentVersionIds: [privateSource.versionId] } });
      assert.equal(response.status, 400);
    }
  });
  await t.test('05.4 history restores cited paragraphs and two suggestions; JSON and SSE have the same fields', async () => {
    const history = await json(await app.call(`/chat/history?conversationId=${conversationId}`, { cookie: app.a.cookie }));
    const saved = history.items.find(item => item.id === answer.attemptId);
    assert.deepEqual(saved.paragraphs, answer.paragraphs);assert.deepEqual(saved.citations, answer.citations);assert.deepEqual(saved.followUps, answer.followUps);
    const jsonAnswer = await json(await send('What is the notice period?'));
    assert.deepEqual(Object.keys(jsonAnswer).sort(), Object.keys(answer).sort());assert.equal(jsonAnswer.followUps.length, 2);
    const followUp = await json(await send(jsonAnswer.followUps[0]));assert.equal(followUp.status, 'completed');
    assert.equal((await app.db.collection('messages').findOne({ _id: new ObjectId(followUp.userMessageId) })).content, jsonAnswer.followUps[0]);
  });
  await t.test('05.3 invalid citation is withheld and never saved as supported output', async () => {
    const response = await app.call('/chat/send', { cookie: app.a.cookie, accept: 'text/event-stream',
      body: { message: 'INVALID_CITATION', conversationId, clientMessageId: randomUUID() } });
    const events = await stream(response);
    assert.ok(!events.some(event => event.event === 'paragraph' && event.data.text.includes('Invented claim')));
    const result = await app.db.collection('messages').findOne({ _id: new ObjectId(events[0].data.attemptId) });
    assert.ok(!JSON.stringify(result.paragraphs).includes('Invented claim'));
    assert.ok(!JSON.stringify(result.citations).includes('nonexistent-passage'));
  });
  await t.test('05.3/05.4 keyword and vector candidate scopes exclude private source before fusion', async () => {
    process.env.NODE_ENV = 'test';
    const { retrieveEvidence, setTestRetrievalBranches, fuseHits } = await import('../server/dist/retrieval.js');
    const uri = process.env.QA_MONGODB_URI ?? 'mongodb://127.0.0.1:27028/?replicaSet=legalChatQA';
    await mongoose.connect(uri, { dbName: app.db.databaseName });
    const calls = [];
    const branch = kind => async (_query, versions) => { calls.push({ kind, ids: versions.map(v => v.versionId) });
      return versions.length ? (await mongoose.connection.db.collection('chunks').find({ $or: versions.map(v => ({ versionId: v.versionId, generation: v.generation })) }).toArray()) : []; };
    setTestRetrievalBranches({ keyword: branch('keyword'), vector: branch('vector') });
    try {
      for (const [ownerId, thread, allowed] of [[app.a.id, conversationId, true], [app.a.id, fresh, false], [app.b.id, bThread, false]]) {
        calls.length = 0;
        const result = await retrieveEvidence({ ownerId, conversationId: thread, message: 'private project code', config: {} });
        for (const kind of ['keyword', 'vector']) assert.equal(calls.find(call => call.kind === kind).ids.includes(privateSource.versionId), allowed, kind);
        assert.equal(result.snapshot.keywordCandidateIds.includes(privateSource.versionId), allowed);
        assert.equal(result.snapshot.vectorCandidateIds.includes(privateSource.versionId), allowed);
      }
      assert.throws(() => fuseHits([{ _id: 'rogue', versionId: 'excluded', generation: 'fixture-gen', passageIds: [] }], [], []), /outside/);
    } finally { setTestRetrievalBranches(undefined);await mongoose.disconnect(); }
  });
});
