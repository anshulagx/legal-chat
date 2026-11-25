import mongoose, { Schema } from 'mongoose';

const conversationSchema = new Schema({
  ownerId: { type: Schema.Types.ObjectId, required: true },
  title: { type: String, default: 'New chat' },
  updatedAt: { type: Date, default: Date.now, required: true },
  nextSequence: { type: Number, default: 0, required: true },
  activeAttemptId: { type: Schema.Types.ObjectId, default: null },
  messageCount: { type: Number, default: 0 },
  attachmentCount: { type: Number, default: 0 },
});
conversationSchema.index({ ownerId: 1, updatedAt: -1, _id: -1 });
export const Conversation = mongoose.model('Conversation', conversationSchema);

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
  status: { type: String, enum: ['pending', 'generating', 'completed', 'failed'], required: true },
  citations: { type: [Schema.Types.Mixed], default: [] },
  followUps: { type: [String], default: [] },
  failureCode: String,
  createdAt: { type: Date, default: Date.now, required: true },
});
messageSchema.index({ conversationId: 1, sequence: 1 }, { unique: true });
messageSchema.index({ ownerId: 1, clientMessageId: 1 }, {
  unique: true, partialFilterExpression: { role: 'user', clientMessageId: { $type: 'string' } },
});
messageSchema.index({ ownerId: 1, createdAt: 1, _id: 1 });
export const Message = mongoose.model('Message', messageSchema);

export async function initializeConversations() {
  const topology = await mongoose.connection.db!.admin().command({ hello: 1 });
  if (!topology.setName && topology.msg !== 'isdbgrid') {
    throw new Error('Conversation transactions require a MongoDB replica set.');
  }
  await Promise.all([Conversation.init(), Message.init()]);
}
