// Optional real Atlas/OpenRouter evaluation. Only disposable prefixed collections are touched.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import mongoose from 'mongoose';

assert.ok(process.env.QA_RETRIEVAL_ENV_FILE, 'Set QA_RETRIEVAL_ENV_FILE to a private QA environment file.');
const supplied = parseEnv(await readFile(process.env.QA_RETRIEVAL_ENV_FILE, 'utf8'));
process.env.NODE_ENV = 'test';
const prefix = `qa04_${randomUUID().replaceAll('-', '')}_`;
process.env.MONGODB_COLLECTION_PREFIX = prefix;
const { readConfig } = await import('../server/dist/config.js');
const { Conversation, initializeConversations } = await import('../server/dist/conversations.js');
const { Document, DocumentVersion, initializeUploads } = await import('../server/dist/uploads.js');
const { Passage, Chunk, Generation, initializeIndexRecords } = await import('../server/dist/index-records.js');
const { extractOriginal, buildChunks } = await import('../server/dist/extraction.js');
const { createIndexProviders, vectorField } = await import('../server/dist/index-providers.js');
const { retrieveEvidence } = await import('../server/dist/retrieval.js');
const config = readConfig({ ...supplied, NODE_ENV: 'test', INDEXING_ENABLED: 'true' });
const generation = 'qa-grounding-evaluation';
const providers = createIndexProviders();
const fixtures = [
  { id: 'exact-id', question: 'What does clause 7.3 require for an export?', text: '7.3 Contract export\n\nTo export your contracts, open Settings, select Data export, and choose Download ZIP.' },
  { id: 'paraphrase', question: 'How can I get a downloadable copy of all my agreements?', text: 'Agreement downloads\n\nA downloadable copy of all agreements is available from Settings, Data export, Download ZIP.' },
  { id: 'exception', question: 'Does termination notice still apply when payment is overdue?', text: 'Termination exceptions\n\nThe Customer must give 30 days of written notice. However, the Supplier may terminate immediately when payment is overdue for 45 days.' },
  { id: 'amendment', question: 'What notice period does the amendment replace clause 8.2 with?', text: 'Amendment to clause 8.2\n\nThe notice period in clause 8.2 is replaced with 60 days of written notice. All other provisions remain unchanged.' },
  { id: 'cross-page', question: 'How many days before termination must written notice be received?', pdf: true },
];
const report = { environment: 'isolated real Atlas and OpenRouter embeddings', embeddingModel: config.indexing.model, dimensions: config.indexing.dimensions, fixtures: [], metrics: {}, candidateScope: {} };
await mongoose.connect(config.mongoUri, { dbName: config.database, serverSelectionTimeoutMS: 15000 });
try {
  for (const model of Object.values(mongoose.connection.models)) assert.ok(model.collection.name.startsWith(prefix));
  await initializeConversations();await initializeUploads();await initializeIndexRecords();
  const ownerId = new mongoose.Types.ObjectId(), otherId = new mongoose.Types.ObjectId();
  const thread = await Conversation.create({ ownerId });
  await Generation.create({ _id: generation, model: config.indexing.model, dimensions: config.indexing.dimensions });
  for (const fixture of fixtures) {
    const original = fixture.pdf ? await readFile(new URL('./fixtures/phase04/cross-page.pdf', import.meta.url)) : Buffer.from(fixture.text);
    const extracted = await extractOriginal(original, fixture.pdf ? 'application/pdf' : 'text/plain');
    const doc = await Document.create({ ownerId, scope: 'private', conversationId: thread._id, title: fixture.id });
    const version = await DocumentVersion.create({ documentId: doc._id, ownerId, scope: 'private', conversationId: thread._id,
      state: 'ready', activeIndexGeneration: generation, embeddingModel: config.indexing.model, dimensions: config.indexing.dimensions,
      filename: fixture.id + (fixture.pdf ? '.pdf' : '.txt'), mime: fixture.pdf ? 'application/pdf' : 'text/plain', size: original.length,
      clientUploadId: randomUUID(), requestHash: fixture.id, key: 'fixture-original-unread', expiresAt: new Date() });
    const passages = extracted.map(p => ({ ...p, _id: `${fixture.id}:p${p.ordinal}`, id: `${fixture.id}:p${p.ordinal}`, versionId: version.id, extractorVersion: 'qa-extractor' }));
    await Passage.insertMany(passages);
    const chunks = buildChunks(passages), embeddings = await providers.embed(chunks.map(c => c.searchText), config.indexing);
    await Chunk.insertMany(chunks.map((chunk, i) => ({ ...chunk, _id: `${fixture.id}:c${i}`, chunkId: `${fixture.id}:c${i}`, versionId: version.id, generation,
      vectors: { [vectorField(config.indexing.dimensions).split('.').at(-1)]: embeddings[i] } })));
    fixture.versionId = version.id;
    fixture.expected = chunks.map((_chunk, i) => ({ id: `${fixture.id}:c${i}`, text: chunks[i].searchText, vector: embeddings[i] }));
  }
  await providers.ensure(config.indexing);
  for (const fixture of fixtures) await providers.probe(fixture.versionId, generation, config.indexing, fixture.expected);
  for (const fixture of fixtures) {
    const ranks = {};
    for (const mode of ['keyword', 'vector', 'hybrid']) {
      const result = await retrieveEvidence({ ownerId: String(ownerId), conversationId: thread.id, message: fixture.question, config }, mode);
      const index = result.snapshot.selectedChunkIds.findIndex(id => fixture.expected.some(chunk => chunk.id === id));
      ranks[mode] = { hitAtSix: index >= 0, firstRelevantRank: index >= 0 ? index + 1 : null };
    }
    report.fixtures.push({ id: fixture.id, ...ranks });
  }
  for (const mode of ['keyword', 'vector', 'hybrid']) report.metrics[mode] = { hitRateAtSix: report.fixtures.filter(f => f[mode].hitAtSix).length / fixtures.length,
    meanFirstRelevantRank: report.fixtures.reduce((sum, f) => sum + (f[mode].firstRelevantRank ?? 7), 0) / fixtures.length };
  const fresh = await Conversation.create({ ownerId }), other = await Conversation.create({ ownerId: otherId });
  for (const [name, uid, conversation] of [['original', ownerId, thread], ['fresh', ownerId, fresh], ['secondCustomer', otherId, other]]) {
    const result = await retrieveEvidence({ ownerId: String(uid), conversationId: conversation.id, message: 'written notice clause 8.2', config });
    report.candidateScope[name] = { keywordCount: result.snapshot.keywordCandidateIds.length, vectorCount: result.snapshot.vectorCandidateIds.length,
      scoped: [...result.snapshot.keywordCandidateIds, ...result.snapshot.vectorCandidateIds].every(id => name === 'original' && fixtures.some(f => f.versionId === id)) };
    assert.ok(report.candidateScope[name].scoped);
  }
  await writeFile(new URL('../qa/phase05-retrieval-evaluation.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
  assert.ok(report.fixtures.every(f => f.hybrid.hitAtSix), 'Every labeled fixture must hit expected evidence with hybrid retrieval.');
  console.log(JSON.stringify(report));
} finally {
  const collections = await mongoose.connection.db.listCollections({ name: { $regex: `^${prefix}` } }, { nameOnly: true }).toArray();
  for (const { name } of collections) { assert.ok(name.startsWith(prefix));await mongoose.connection.db.collection(name).drop(); }
  await mongoose.disconnect();
}
