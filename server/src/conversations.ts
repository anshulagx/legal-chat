import mongoose, { Schema } from 'mongoose';
import { collectionName } from './collections.ts';

const conversationSchema = new Schema({
  ownerId: { type: Schema.Types.ObjectId, required: true },
  title: { type: String, default: 'New chat' },
  updatedAt: { type: Date, default: Date.now, required: true },
  nextSequence: { type: Number, default: 0, required: true },
  activeAttemptId: { type: Schema.Types.ObjectId, default: null },
  attemptLeaseExpiresAt: Date,
  messageCount: { type: Number, default: 0 },
  attachmentCount: { type: Number, default: 0 },
});
conversationSchema.index({ ownerId: 1, updatedAt: -1, _id: -1 });
conversationSchema.index({ activeAttemptId: 1, attemptLeaseExpiresAt: 1 });
export const Conversation = mongoose.model('Conversation', conversationSchema, collectionName('conversations'));

const messageSchema = new Schema({
  conversationId: { type: Schema.Types.ObjectId, required: true },
  ownerId: { type: Schema.Types.ObjectId, required: true },
  sequence: { type: Number, required: true },
  role: { type: String, enum: ['user', 'assistant'], required: true },
  content: { type: String, default: '' },
  clientMessageId: String,
  requestHash: String,
  parentTurnId: Schema.Types.ObjectId,
  attemptId: Schema.Types.ObjectId,
  retryId: String,
  status: { type: String, enum: ['pending', 'generating', 'completed', 'failed', 'interrupted'], required: true },
  citations: { type: [Schema.Types.Mixed], default: [] },
  followUps: { type: [String], default: [] },
  paragraphs: { type: [Schema.Types.Mixed], default: [] },
  selectedDocumentVersionIds: { type: [String], default: [] },
  evidenceSnapshot: Schema.Types.Mixed, comparison: Schema.Types.Mixed,
  handoffOffer: Schema.Types.Mixed, draft: Schema.Types.Mixed, traceId: String,
  failureCode: String, retryAfterSeconds: Number, retryAvailableAt: Date,
  createdAt: { type: Date, default: Date.now, required: true },
});
messageSchema.index({ conversationId: 1, sequence: 1 }, { unique: true });
messageSchema.index({ ownerId: 1, clientMessageId: 1 }, {
  unique: true, partialFilterExpression: { role: 'user', clientMessageId: { $type: 'string' } },
});
messageSchema.index({ ownerId: 1, createdAt: 1, _id: 1 });
messageSchema.index({ parentTurnId: 1, retryId: 1 }, { unique: true, partialFilterExpression: { retryId: { $type: 'string' } } });

export const Message = mongoose.model('Message', messageSchema, collectionName('messages'));

export async function initializeConversations() {
  const topology = await mongoose.connection.db!.admin().command({ hello: 1 });
  if (!topology.setName && topology.msg !== 'isdbgrid') {
    throw new Error('Conversation transactions require a MongoDB replica set.');
  }
  await Promise.all([Conversation.init(), Message.init()]);
}
