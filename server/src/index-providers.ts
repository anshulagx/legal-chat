import { setTimeout as delay } from 'node:timers/promises';
import type { Config } from './config.ts';
import { Chunk } from './index-records.ts';
import { ProcessingError } from './extraction.ts';

export type IndexConfig = NonNullable<Config['indexing']>;
export interface IndexProviders {
  embed(texts: string[], config: IndexConfig): Promise<number[][]>;
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
export function assertVectors(vectors: unknown, count: number, dimensions: number): asserts vectors is number[][] {
  if (!Array.isArray(vectors) || vectors.length !== count || vectors.some(vector => !Array.isArray(vector)
    || vector.length !== dimensions || vector.some(value => typeof value !== 'number' || !Number.isFinite(value)) || vector.every(value => value === 0))) {
    throw new ProcessingError('EMBEDDING_DIMENSIONS', 'The embedding provider returned invalid vectors or dimensions. Check the configured model and dimensions.');
  }
}

export function createIndexProviders(): IndexProviders {
  if (testProviders) return testProviders;
  return {
    async embed(texts, config) {
      let response;
      try {
        response = await fetch('https://openrouter.ai/api/v1/embeddings', {
          method: 'POST', headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: config.model, dimensions: config.dimensions, input: texts, encoding_format: 'float' }),
          signal: AbortSignal.timeout(30000),
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
        const current: any[] = await Chunk.collection.listSearchIndexes().toArray();
        for (const definition of definitions) {
          const existing = current.find(index => index.name === definition.name);
          if (!existing) {
            try { await Chunk.collection.createSearchIndex(definition); }
            catch (error) {
              const again = await Chunk.collection.listSearchIndexes(definition.name).toArray();
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
        const deadline = Date.now() + config.indexWaitMs;
        while (true) {
          const indexes: any[] = await Chunk.collection.listSearchIndexes().toArray();
          if (indexes.some(index => definitions.some(d => d.name === index.name) && index.status === 'FAILED')) throw new Error('Index build failed');
          if (definitions.every(d => indexes.some(index => index.name === d.name && index.queryable))) return;
          if (Date.now() >= deadline) throw new Error('Index readiness deadline');
          await delay(1500);
        }
      } catch { throw new ProcessingError('SEARCH_INDEX_UNAVAILABLE', 'Text and vector search indexes are not ready. Check Atlas permissions, index definitions and the cluster index quota, then retry.', true, 5000); }
    },
    async probe(versionId, generation, config, expected) {
      const deadline = Date.now() + config.indexWaitMs;
      while (true) {
        let passed = true;
        try {
          for (const chunk of expected) {
            const [keyword, vector] = await Promise.all([
              Chunk.collection.aggregate([{ $search: { index: textIndexName, compound: {
                must: [{ text: { query: chunk.text, path: 'searchText' } }],
                filter: [{ equals: { path: 'versionId', value: versionId } }, { equals: { path: 'generation', value: generation } }, { equals: { path: 'chunkId', value: chunk.id } }],
              } } }, { $limit: 2 }, { $project: { _id: 1, versionId: 1, generation: 1 } }], { maxTimeMS: 15000 }).toArray(),
              Chunk.collection.aggregate([{ $vectorSearch: { index: vectorIndexName(config.dimensions), path: vectorField(config.dimensions), queryVector: chunk.vector,
                numCandidates: 10, limit: 2, filter: { versionId, generation, chunkId: chunk.id } } }, { $project: { _id: 1, versionId: 1, generation: 1 } }], { maxTimeMS: 15000 }).toArray(),
            ]);
            if (![keyword, vector].every(rows => rows.some(row => row._id === chunk.id) && rows.every(row => row.versionId === versionId && row.generation === generation))) { passed = false; break; }
          }
        } catch { passed = false; }
        if (passed) return;
        if (Date.now() >= deadline) throw new ProcessingError('SEARCH_PROBE_FAILED', 'The version is not queryable in both filtered search branches yet. Retry after checking Atlas indexing.', true, 5000);
        await delay(1500);
      }
    },
  };
}
