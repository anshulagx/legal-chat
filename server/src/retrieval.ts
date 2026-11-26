import type { Config } from './config.ts';
import { Conversation, Message } from './conversations.ts';
import { Chunk, Passage } from './index-records.ts';
import { createIndexProviders, textIndexName, vectorField, vectorIndexName } from './index-providers.ts';
import { Document, DocumentVersion } from './uploads.ts';
import { HttpError } from './http.ts';

export type SnapshotVersion = { versionId: string; generation: string; model: string; dimensions: number; filename: string; scope: string };
export type EvidenceSnapshot = { versions: SnapshotVersion[]; keywordCandidateIds: string[]; vectorCandidateIds: string[]; selectedChunkIds: string[] };
export type EvidencePassage = { id: string; versionId: string; text: string; filename: string; page?: number; start?: number; end?: number };
export type SearchHit = { _id: string; versionId: string; generation: string; passageIds: string[]; searchText?: string };
export type RetrievalResult = { snapshot: EvidenceSnapshot; passages: EvidencePassage[]; history: { role: string; content: string }[] };
export type RetrievalMode = 'keyword' | 'vector' | 'hybrid';
type Branch = (query: string, versions: SnapshotVersion[], config: Config, signal?: AbortSignal) => Promise<SearchHit[]>;
let testBranches: { keyword: Branch; vector: Branch } | undefined;
export function setTestRetrievalBranches(branches: typeof testBranches) {
  if (process.env.NODE_ENV !== 'test') throw new Error('Retrieval injection requires test execution.');
  testBranches = branches;
}
export async function snapshotVersions(ownerId: string, conversationId: string, selected: string[] = []) {
  if (!await Conversation.exists({ _id: conversationId, ownerId })) throw new HttpError(404, 'NOT_FOUND', 'This conversation could not be found.');
  const shared = await Document.find({ scope: 'shared', archivedAt: null, activeVersionId: { $ne: null } }).select('activeVersionId').lean();
  const active = shared.map(document => document.activeVersionId);
  const versions = await DocumentVersion.find({ state: 'ready', activeIndexGeneration: { $type: 'string' }, $or: [
    { scope: 'shared', _id: { $in: active } }, { scope: 'private', ownerId, conversationId },
  ] }).lean();
  const result = versions.map(version => ({ versionId: String(version._id), generation: version.activeIndexGeneration!,
    model: version.embeddingModel!, dimensions: version.dimensions!, filename: version.filename, scope: version.scope }));
  if (selected.some(id => !result.some(version => version.versionId === id))) throw new HttpError(404, 'NOT_FOUND', 'A selected source could not be found in this chat.');
  return result;
}
export function fuseHits(keyword: SearchHit[], vector: SearchHit[], versions: SnapshotVersion[], limit = 6) {
  const allowed = (hit: SearchHit) => versions.some(version => version.versionId === hit.versionId && version.generation === hit.generation);
  const scores = new Map<string, { hit: SearchHit; score: number }>();
  for (const branch of [keyword, vector]) {
    const seen = new Set<string>();
    branch.slice(0, 20).forEach((hit, index) => {
      if (!allowed(hit)) throw new Error('Search returned a source outside the evidence snapshot.');
      if (seen.has(hit._id)) return;
      seen.add(hit._id);
      const current = scores.get(hit._id) ?? { hit, score: 0 };
      current.score += 1 / (60 + index + 1);
      scores.set(hit._id, current);
    });
  }
  return [...scores.values()].sort((a, b) => b.score - a.score || a.hit._id.localeCompare(b.hit._id)).slice(0, limit).map(item => item.hit);
}
async function keyword(query: string, versions: SnapshotVersion[], _config: Config, signal?: AbortSignal): Promise<SearchHit[]> {
  if (!versions.length) return [];
  const filters = versions.map(version => ({ compound: { filter: [
    { equals: { path: 'versionId', value: version.versionId } }, { equals: { path: 'generation', value: version.generation } },
  ] } }));
  const phrases = [...query.matchAll(/"([^"\n]{2,120})"/g)].map(match => match[1]);
  const identifiers = query.match(/\b\d+(?:\.\d+)+\b/g) ?? [];
  const should = [...phrases, ...identifiers].map(term => ({ phrase: { path: 'searchText', query: term, score: { boost: { value: 3 } } } }));
  const cursor = Chunk.collection.aggregate<SearchHit>([{ $search: { index: textIndexName, compound: {
    must: [{ text: { path: 'searchText', query } }], filter: [{ compound: { should: filters, minimumShouldMatch: 1 } }], ...(should.length ? { should } : {}),
  } } }, { $limit: 20 }, { $project: { _id: 1, versionId: 1, generation: 1, passageIds: 1 } }], { maxTimeMS: 15000, signal });
  try { return await cursor.toArray(); } finally { await cursor.close(); }
}
async function vector(query: string, versions: SnapshotVersion[], config: Config, signal?: AbortSignal): Promise<SearchHit[]> {
  if (!versions.length) return [];
  const embeddingConfig = config.indexing ?? config.queryEmbedding;
  if (!embeddingConfig) throw new Error('Query embeddings are not configured.');
  const groups = new Map<string, SnapshotVersion[]>();
  for (const version of versions) {
    const key = `${version.model}:${version.dimensions}`;
    groups.set(key, [...groups.get(key) ?? [], version]);
  }
  const results = await Promise.all([...groups.values()].map(async group => {
    const first = group[0];
    if (!first.model || !Number.isSafeInteger(first.dimensions)) throw new Error('The snapshot embedding configuration is invalid.');
    const [embedding] = await createIndexProviders().embed([query], { ...embeddingConfig, model: first.model, dimensions: first.dimensions }, signal);
    signal?.throwIfAborted();
    const cursor = Chunk.collection.aggregate<SearchHit>([{ $vectorSearch: { index: vectorIndexName(first.dimensions), path: vectorField(first.dimensions), queryVector: embedding,
      numCandidates: 100, limit: 20, filter: { $or: group.map(version => ({ $and: [{ versionId: { $eq: version.versionId } }, { generation: { $eq: version.generation } }] })) } } },
    { $project: { _id: 1, versionId: 1, generation: 1, passageIds: 1 } }], { maxTimeMS: 15000, signal });
    try { return await cursor.toArray(); } finally { await cursor.close(); }
  }));
  // Interleave generation branches; each model has a different similarity scale.
  return Array.from({ length: 20 }, (_, rank) => results.flatMap(rows => rows[rank] ? [rows[rank]] : [])).flat().slice(0, 20);
}
export async function retrieveEvidence(request: { ownerId: string; conversationId: string; message: string; selectedDocumentVersionIds?: string[]; config: Config; signal?: AbortSignal;
  onSnapshot?: (snapshot: EvidenceSnapshot) => Promise<void>; authorizedVersions?: SnapshotVersion[] }, mode: RetrievalMode = 'hybrid'): Promise<RetrievalResult> {
  const versions = request.authorizedVersions ?? await snapshotVersions(request.ownerId, request.conversationId, request.selectedDocumentVersionIds);
  const snapshot: EvidenceSnapshot = { versions, keywordCandidateIds: [], vectorCandidateIds: [], selectedChunkIds: [] };
  await request.onSnapshot?.(snapshot);
  const previous = await Message.find({ ownerId: request.ownerId, conversationId: request.conversationId, status: 'completed' }).sort({ sequence: -1 }).limit(6).lean();
  const history = previous.reverse().map(message => ({ role: message.role!, content: message.content.slice(0, 1000) }));
  // Keep original terms first; only expand pronoun/ellipsis references with bounded user context.
  const references = /\b(it|that|those|this|they|them|same|previous|earlier)\b/i.test(request.message);
  const query = [request.message, ...(references ? history.filter(item => item.role === 'user').slice(-2).map(item => item.content) : [])].join('\n').slice(0, 4000);
  const branches = testBranches ?? { keyword, vector };
  const selected = request.selectedDocumentVersionIds?.length ? request.selectedDocumentVersionIds.map(id => versions.find(version => version.versionId === id)!) : versions;
  // Separate searches reserve a fair evidence budget for each comparison side.
  const scopes = request.selectedDocumentVersionIds?.length === 2 ? selected.map(version => [version]) : [selected];
  const all = await Promise.all(scopes.map(async scope => {
    const [words, vectors] = await Promise.all([mode === 'vector' ? [] : branches.keyword(query, scope, request.config, request.signal), mode === 'keyword' ? [] : branches.vector(query, scope, request.config, request.signal)]);
    snapshot.keywordCandidateIds.push(...words.map(hit => hit.versionId)); snapshot.vectorCandidateIds.push(...vectors.map(hit => hit.versionId));
    return fuseHits(words, vectors, scope, scopes.length === 2 ? 3 : 6);
  }));
  const chunks = all.flat(); snapshot.selectedChunkIds = chunks.map(chunk => chunk._id);
  const ids = [...new Set(chunks.flatMap(chunk => chunk.passageIds))];
  const stored = await Passage.find({ _id: { $in: ids }, versionId: { $in: selected.map(version => version.versionId) } }).lean();
  const byId = new Map(stored.map(passage => [passage._id, passage]));
  let characters = 0;
  const passages: EvidencePassage[] = [];
  for (const id of ids) {
    const passage = byId.get(id);
    if (!passage || characters + passage.text.length > 26000) continue;
    characters += passage.text.length;
    passages.push({ id: passage._id!, versionId: passage.versionId, text: passage.text,
      filename: versions.find(version => version.versionId === passage.versionId)!.filename,
      ...(passage.page != null ? { page: passage.page } : {}), ...(passage.start != null ? { start: passage.start, end: passage.end ?? undefined } : {}) });
  }
  await request.onSnapshot?.(snapshot);
  return { snapshot, passages, history };
}
