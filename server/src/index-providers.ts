import { setTimeout as delay } from 'node:timers/promises';
import type { Config } from './config.ts';
import { Chunk } from './index-records.ts';
import { ProcessingError } from './extraction.ts';

export type IndexConfig = NonNullable<Config['indexing']>;
export interface IndexProviders {
  embed(texts: string[], config: IndexConfig, signal?: AbortSignal): Promise<number[][]>;
  ensure(config: IndexConfig): Promise<void>;
  probe(versionId: string, generation: string, config: IndexConfig, expected: { id: string; text: string; vector: number[] }[]): Promise<void>;
}
let testProviders: IndexProviders | undefined;
export function setTestIndexProviders(providers: IndexProviders) {
  if (process.env.NODE_ENV !== 'test') throw new Error('Index provider injection requires test execution.');
  testProviders = providers;
}
export const vectorField = (dimensions: number) => `vectors.d${dimensions}`;
export const vectorIndexName = (dimensions: number) => `legal_vector_${dimensions}`;
export const textIndexName = 'legal_text';
async function withinBudget<T>(deadline: number, run: (milliseconds: number, signal: AbortSignal) => Promise<T>): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error('Index readiness deadline.');
  const signal = AbortSignal.timeout(remaining);
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([run(remaining, signal), new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(signal.reason);
      if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
    })]);
  } finally { if (onAbort) signal.removeEventListener('abort', onAbort); }
}
export function assertVectors(vectors: unknown, count: number, dimensions: number): asserts vectors is number[][] {
  if (!Array.isArray(vectors) || vectors.length !== count || vectors.some(vector => !Array.isArray(vector)
    || vector.length !== dimensions || vector.some(value => typeof value !== 'number' || !Number.isFinite(value)) || vector.every(value => value === 0))) {
    throw new ProcessingError('EMBEDDING_DIMENSIONS', 'The embedding provider returned invalid vectors or dimensions. Check the configured model and dimensions.');
  }
}

export function createIndexProviders(): IndexProviders {
  if (testProviders) return testProviders;
  return {
    async embed(texts, config, signal) {
      let response;
      try {
        response = await fetch('https://openrouter.ai/api/v1/embeddings', {
          method: 'POST', headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: config.model, dimensions: config.dimensions, input: texts, encoding_format: 'float' }),
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
        });
      } catch { throw new ProcessingError('EMBEDDING_UNAVAILABLE', 'The embedding provider could not be reached. Retry this pinned version shortly.', true, 5000); }
      if (!response.ok) {
        const raw = response.headers.get('retry-after');
        const seconds = raw ? Number(raw) : NaN;
        const when = raw && !Number.isFinite(seconds) ? Date.parse(raw) : NaN;
        const retryAfterMs = Number.isFinite(seconds) ? Math.max(1000, seconds * 1000) : Number.isFinite(when) ? Math.max(1000, when - Date.now()) : 5000;
        const representable = Number.isFinite(retryAfterMs) && Date.now() + retryAfterMs <= 8640000000000000;
        throw new ProcessingError('EMBEDDING_UNAVAILABLE', 'The embedding provider rejected the request. Check model access or quota, then retry this version.',
          (response.status === 429 || response.status >= 500) && representable, representable ? retryAfterMs : 0);
      }
      let payload;
      try { payload = await response.json() as { data?: { index: number; embedding: number[] }[] }; }
      catch { throw new ProcessingError('EMBEDDING_RESPONSE', 'The embedding provider returned an unreadable response.', true, 5000); }
      const data = Array.isArray(payload.data) ? payload.data.sort((a, b) => a.index - b.index) : payload.data;
      if (!Array.isArray(data) || data.length !== texts.length || data.some((item, i) => item.index !== i)) {
        throw new ProcessingError('EMBEDDING_RESPONSE', 'The embedding provider returned incomplete or unordered results.');
      }
      const vectors = data.map(item => item.embedding);
      assertVectors(vectors, texts.length, config.dimensions);
      return vectors;
    },
    async ensure(config) {
      const deadline = Date.now() + config.indexWaitMs;
      const list = (name?: string) => withinBudget(deadline, async (remaining, signal) => {
        const options = { maxTimeMS: Math.min(15000, remaining), timeoutMS: remaining, signal };
        const cursor = name ? Chunk.collection.listSearchIndexes(name, options) : Chunk.collection.listSearchIndexes(options);
        try { return await cursor.toArray() as any[]; }
        finally { void Promise.resolve(cursor.close()).catch(() => undefined); }
      });
      const definitions = [
        { name: textIndexName, type: 'search' as const, definition: { mappings: { dynamic: false, fields: {
          searchText: { type: 'string' }, versionId: { type: 'token' }, generation: { type: 'token' }, chunkId: { type: 'token' },
        } } } },
        { name: vectorIndexName(config.dimensions), type: 'vectorSearch' as const, definition: { fields: [
          { type: 'vector', path: vectorField(config.dimensions), numDimensions: config.dimensions, similarity: 'cosine' },
          { type: 'filter', path: 'versionId' }, { type: 'filter', path: 'generation' }, { type: 'filter', path: 'chunkId' },
        ] } },
      ];
      try {
        const current = await list();
        for (const definition of definitions) {
          const existing = current.find(index => index.name === definition.name);
          if (!existing) {
            // The installed driver's createSearchIndex API has no operation
            // options. Bound the await; cursor reads below also receive native
            // server/client deadlines and cancellation signals.
            try { await withinBudget(deadline, () => Chunk.collection.createSearchIndex(definition)); }
            catch (error) {
              const again = await list(definition.name);
              if (!again.length) throw error;
            }
          } else {
            const actual = existing.latestDefinition ?? existing.definition;
            if (actual && JSON.stringify(actual) !== JSON.stringify(definition.definition)) {
              // Atlas can reorder properties; compare the behavior-relevant paths.
              if (definition.type === 'vectorSearch') {
                const fields = actual.fields ?? [];
                if (!fields.some((field: any) => field.type === 'vector' && field.path === vectorField(config.dimensions) && field.numDimensions === config.dimensions)
                  || !['versionId', 'generation', 'chunkId'].every(path => fields.some((field: any) => field.type === 'filter' && field.path === path))) throw new Error('Index definition mismatch');
              } else if (actual.mappings?.fields?.versionId?.type !== 'token' || actual.mappings?.fields?.generation?.type !== 'token'
                || actual.mappings?.fields?.chunkId?.type !== 'token' || actual.mappings?.fields?.searchText?.type !== 'string') throw new Error('Index definition mismatch');
            }
          }
        }
        while (true) {
          const indexes = await list();
          if (indexes.some(index => definitions.some(d => d.name === index.name) && index.status === 'FAILED')) throw new Error('Index build failed');
          if (Date.now() >= deadline) throw new Error('Index readiness deadline');
          if (definitions.every(d => indexes.some(index => index.name === d.name && index.queryable))) return;
          await delay(Math.min(1500, Math.max(1, deadline - Date.now())));
        }
      } catch { throw new ProcessingError('SEARCH_INDEX_UNAVAILABLE', 'Text and vector search indexes are not ready. Check Atlas permissions, index definitions and the cluster index quota, then retry.', true, 5000); }
    },
    async probe(versionId, generation, config, expected) {
      const deadline = Date.now() + config.indexWaitMs;
      while (true) {
        let passed = true;
        try {
          for (const chunk of expected) {
            const remaining = deadline - Date.now();
            if (remaining <= 0) { passed = false; break; }
            const signal = AbortSignal.timeout(remaining);
            const cursors = [
              Chunk.collection.aggregate([{ $search: { index: textIndexName, compound: {
                must: [{ text: { query: chunk.text, path: 'searchText' } }],
                filter: [{ equals: { path: 'versionId', value: versionId } }, { equals: { path: 'generation', value: generation } }, { equals: { path: 'chunkId', value: chunk.id } }],
              } } }, { $limit: 2 }, { $project: { _id: 1, versionId: 1, generation: 1 } }], { maxTimeMS: Math.min(15000, remaining), signal }),
              Chunk.collection.aggregate([{ $vectorSearch: { index: vectorIndexName(config.dimensions), path: vectorField(config.dimensions), queryVector: chunk.vector,
                numCandidates: 10, limit: 2, filter: { versionId, generation, chunkId: chunk.id } } }, { $project: { _id: 1, versionId: 1, generation: 1 } }], { maxTimeMS: Math.min(15000, remaining), signal }),
            ];
            let onAbort: (() => void) | undefined;
            let rows: any[][];
            try {
              rows = await Promise.race([Promise.all(cursors.map(cursor => cursor.toArray())), new Promise<never>((_resolve, reject) => {
                onAbort = () => reject(signal.reason);
                if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
              })]);
            } finally {
              if (onAbort) signal.removeEventListener('abort', onAbort);
              for (const cursor of cursors) void Promise.resolve(cursor.close()).catch(() => undefined);
            }
            const [keyword, vector] = rows;
            if (![keyword, vector].every(rows => rows.some(row => row._id === chunk.id) && rows.every(row => row.versionId === versionId && row.generation === generation))) { passed = false; break; }
          }
        } catch { passed = false; }
        if (passed && Date.now() < deadline) return;
        if (Date.now() >= deadline) throw new ProcessingError('SEARCH_PROBE_FAILED', 'The version is not queryable in both filtered search branches yet. Retry after checking Atlas indexing.', true, 5000);
        await delay(Math.min(1500, Math.max(1, deadline - Date.now())));
      }
    },
  };
}
