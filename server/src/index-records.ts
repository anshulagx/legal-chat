import mongoose, { Schema } from 'mongoose';
import { collectionName } from './collections.ts';

const passageSchema = new Schema({
  _id: String, versionId: { type: String, required: true }, ordinal: { type: Number, required: true },
  text: { type: String, required: true }, page: Number, start: Number, end: Number,
  heading: String, clauseRef: String, pageHeader: Boolean, extractorVersion: { type: String, required: true },
});
passageSchema.index({ versionId: 1, ordinal: 1 }, { unique: true });
export const Passage = mongoose.model('Passage', passageSchema, collectionName('passages'));
const chunkSchema = new Schema({
  _id: String, chunkId: String, versionId: { type: String, required: true }, generation: { type: String, required: true },
  ordinal: Number, passageIds: [String], anchors: [Schema.Types.Mixed], heading: String, clauseRef: String,
  searchText: String, tokenCount: Number, vectors: Schema.Types.Mixed,
});
chunkSchema.index({ versionId: 1, generation: 1, ordinal: 1 }, { unique: true });
export const Chunk = mongoose.model('Chunk', chunkSchema, collectionName('chunks'));
export const Generation = mongoose.model('IndexGeneration', new Schema({
  _id: String, model: String, dimensions: Number, extractorVersion: String, chunkingVersion: String,
  createdAt: { type: Date, default: Date.now },
}), collectionName('indexgenerations'));
export const IndexSetting = mongoose.model('IndexSetting', new Schema({ _id: String, generation: String }), collectionName('indexsettings'));
export const EmbeddingCache = mongoose.model('EmbeddingCache', new Schema({
  _id: String, scope: String, model: String, dimensions: Number, processingVersion: String,
  contentHash: String, vector: [Number], createdAt: { type: Date, default: Date.now },
}), collectionName('embeddingcaches'));
export const AdminEvent = mongoose.model('AdminEvent', new Schema({
  actorId: Schema.Types.ObjectId, action: { type: String, required: true }, documentId: Schema.Types.ObjectId,
  versionId: Schema.Types.ObjectId, requestId: String, timestamp: { type: Date, default: Date.now },
}), collectionName('adminevents'));
export async function initializeIndexRecords() {
  await Promise.all([Passage.init(), Chunk.init(), Generation.init(), IndexSetting.init(), EmbeddingCache.init(), AdminEvent.init()]);
}
