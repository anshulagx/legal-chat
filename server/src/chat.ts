import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import express from 'express';
import mongoose, { Types } from 'mongoose';
import { isDuplicate } from './accounts.ts';
import { generateAnswer, type Answer } from './answer.ts';
import { requestGuard, requireSession } from './auth.ts';
import type { Config } from './config.ts';
import { Conversation, Message } from './conversations.ts';
import { HttpError } from './http.ts';

const objectId = /^[a-f0-9]{24}$/;
const invalid = (message = 'Check the request fields.') => new HttpError(400, 'INVALID_INPUT', message);
const missing = () => new HttpError(404, 'NOT_FOUND', 'This conversation could not be found.');
const conflictingKey = () => new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'This message ID was already used for different input.');
type StoredMessage = InstanceType<typeof Message>;

function parseSend(body: unknown) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid();
  const input = body as Record<string, unknown>;
  if (typeof input.message !== 'string' || !input.message.trim() || input.message.length > 8000) {
    throw invalid('Enter a question of at most 8,000 characters.');
  }
  if (input.conversationId !== undefined && (typeof input.conversationId !== 'string' || !objectId.test(input.conversationId))) throw invalid();
  if (input.clientMessageId !== undefined && (typeof input.clientMessageId !== 'string'
    || !/^[A-Za-z0-9_-]{1,128}$/.test(input.clientMessageId))) throw invalid();
  if (input.selectedDocumentVersionIds !== undefined
    && (!Array.isArray(input.selectedDocumentVersionIds) || input.selectedDocumentVersionIds.length)) {
    throw invalid('Document selection is not available yet.');
  }
  const message = input.message.trim();
  const conversationId = input.conversationId as string | undefined;
  const clientMessageId = input.clientMessageId as string | undefined ?? randomUUID();
  const requestHash = createHash('sha256').update(JSON.stringify({ message, conversationId: conversationId ?? null, selectedDocumentVersionIds: [] })).digest('hex');
  return { message, conversationId, clientMessageId, requestHash };
}

async function reserve(ownerId: string, input: ReturnType<typeof parseSend>) {
  try {
    return await mongoose.connection.transaction(async session => {
      const existing = await Message.findOne({ ownerId, role: 'user', clientMessageId: input.clientMessageId }).session(session);
      if (existing) {
        if (existing.requestHash !== input.requestHash) throw conflictingKey();
        return { user: existing, created: false };
      }

      let conversation;
      if (input.conversationId) {
        conversation = await Conversation.findOne({ _id: input.conversationId, ownerId }).session(session);
        if (!conversation) throw missing();
      } else {
        [conversation] = await Conversation.create([{ ownerId }], { session });
      }
      const userId = new Types.ObjectId();
      const attemptId = new Types.ObjectId();
      const locked = await Conversation.findOneAndUpdate({ _id: conversation!._id, ownerId, activeAttemptId: null }, {
        $set: { activeAttemptId: attemptId, updatedAt: new Date(),
          ...(conversation!.messageCount === 0 ? { title: input.message.replace(/\s+/g, ' ').slice(0, 80) } : {}) },
        $inc: { nextSequence: 2, messageCount: 2 },
      }, { new: false, session });
      if (!locked) throw new HttpError(409, 'GENERATION_ACTIVE', 'Wait for the current answer before sending another question.');
      const [user] = await Message.create([{
        _id: userId, ownerId, conversationId: locked._id, sequence: locked.nextSequence,
        role: 'user', content: input.message, clientMessageId: input.clientMessageId,
        requestHash: input.requestHash, attemptId, status: 'pending',
      }, {
        _id: attemptId, ownerId, conversationId: locked._id, sequence: locked.nextSequence + 1,
        role: 'assistant', parentTurnId: userId, status: 'generating',
      }], { session, ordered: true });
      return { user, created: true };
    }, { readPreference: 'primary', readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
  } catch (error) {
    // A concurrent first send may lose the unique-key race after creating an
    // uncommitted thread. Its entire transaction rolls back before this read.
    if (!isDuplicate(error)) throw error;
    const existing = await Message.findOne({ ownerId, role: 'user', clientMessageId: input.clientMessageId });
    if (!existing) throw error;
    if (existing.requestHash !== input.requestHash) throw conflictingKey();
    return { user: existing, created: false };
  }
}

async function finish(user: StoredMessage) {
  let answer: Answer | undefined;
  try {
    answer = await generateAnswer({ message: user.content, conversationId: String(user.conversationId), userMessageId: user.id, attemptId: String(user.attemptId) });
  } catch {
    // Keep the durable question and mark this attempt terminal on adapter failure.
  }
  await mongoose.connection.transaction(async session => {
    const locked = await Conversation.updateOne({ _id: user.conversationId, ownerId: user.ownerId, activeAttemptId: user.attemptId }, {
      $set: { activeAttemptId: null, updatedAt: new Date() },
    }, { session });
    if (!locked.modifiedCount) return;
    const status = answer ? 'completed' : 'failed';
    await Message.updateOne({ _id: user.attemptId, status: 'generating' }, {
      $set: { status, content: answer?.response ?? '', followUps: answer?.followUps ?? [],
        ...(!answer ? { failureCode: 'ANSWER_UNAVAILABLE' } : {}) },
    }, { session });
    await Message.updateOne({ _id: user._id }, { $set: { status } }, { session });
  }, { writeConcern: { w: 'majority' } });
}

async function sendResult(user: StoredMessage) {
  const attempt = await Message.findOne({ _id: user.attemptId, ownerId: user.ownerId });
  if (!attempt) throw new HttpError(503, 'UNAVAILABLE', 'The saved answer is temporarily unavailable.');
  return {
    conversationId: String(user.conversationId), userMessageId: user.id, attemptId: attempt.id,
    clientMessageId: user.clientMessageId, status: attempt.status, response: attempt.content,
    citations: attempt.citations, followUps: attempt.followUps, failureCode: attempt.failureCode,
  };
}

function summary(conversation: InstanceType<typeof Conversation>) {
  return { id: conversation.id, title: conversation.title, updatedAt: conversation.updatedAt.toISOString() };
}
function messageView(message: StoredMessage) {
  return {
    id: message.id, conversationId: String(message.conversationId), sequence: message.sequence,
    role: message.role, content: message.content, status: message.status,
    clientMessageId: message.clientMessageId, attemptId: message.role === 'assistant' ? message.id : String(message.attemptId),
    parentTurnId: message.parentTurnId ? String(message.parentTurnId) : undefined,
    citations: message.citations, followUps: message.followUps, failureCode: message.failureCode,
    createdAt: message.createdAt.toISOString(),
  };
}

// Signed cursors bind a sort position to the account and selected list. They
// never replace the owner predicate on database reads.
function pagination(req: express.Request, config: Config, scope: string) {
  const rawLimit = req.query.limit ?? '30';
  if (typeof rawLimit !== 'string' || !/^[1-9]\d*$/.test(rawLimit) || Number(rawLimit) > 100) throw invalid('Use a limit between 1 and 100.');
  const sign = (payload: string) => createHmac('sha256', config.secret).update(payload).digest('base64url');
  const encode = (position: Record<string, unknown>) => {
    const payload = Buffer.from(JSON.stringify({ scope, ...position })).toString('base64url');
    return `${payload}.${sign(payload)}`;
  };
  let position: { id: string; date: Date; sequence: number } | undefined;
  if (req.query.cursor !== undefined) {
    const cursor = req.query.cursor;
    if (typeof cursor !== 'string' || cursor.length > 2048) throw invalid('Invalid cursor.');
    try {
      const [payload, signature, extra] = cursor.split('.');
      const expected = Buffer.from(sign(payload));
      const supplied = Buffer.from(signature);
      if (extra || expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) throw new Error();
      const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString());
      const date = new Date(decoded.date);
      if (decoded.scope !== scope || !objectId.test(decoded.id) || !Number.isFinite(date.getTime())
        || !Number.isSafeInteger(decoded.sequence) || decoded.sequence < 0) throw new Error();
      position = { id: decoded.id, date, sequence: decoded.sequence };
    } catch {
      throw invalid('Invalid cursor.');
    }
  }
  return { limit: Number(rawLimit), position, encode };
}

export function chatRouter(config: Config, available: () => boolean) {
  const router = express.Router();
  router.use((req, _res, next) => {
    if (req.path === '/conversations' || req.path.startsWith('/chat/')) next();
    else next('router');
  });
  router.use(requestGuard(config, available), requireSession(config));
  router.use(express.json({ limit: '40kb' }));

  router.post('/conversations', async (_req, res) => {
    const conversation = await Conversation.create({ ownerId: res.locals.account.id });
    res.status(201).json(summary(conversation));
  });

  router.get('/conversations', async (req, res) => {
    const ownerId = res.locals.account.id as string;
    const { limit, position, encode } = pagination(req, config, `${ownerId}:conversations`);
    const filter = { ownerId, $and: [
      { $or: [{ messageCount: { $gt: 0 } }, { attachmentCount: { $gt: 0 } }] },
      ...(position ? [{ $or: [{ updatedAt: { $lt: position.date } }, { updatedAt: position.date, _id: { $lt: position.id } }] }] : []),
    ] };
    const rows = await Conversation.find(filter).sort({ updatedAt: -1, _id: -1 }).limit(limit + 1);
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    res.json({ items: items.map(summary), nextCursor: rows.length > limit && last
      ? encode({ id: last.id, date: last.updatedAt.toISOString(), sequence: 0 }) : null });
  });

  router.get('/chat/history', async (req, res) => {
    const ownerId = res.locals.account.id as string;
    if (Object.keys(req.query).some(key => !['conversationId', 'cursor', 'limit'].includes(key))) throw invalid();
    const conversationId = req.query.conversationId;
    if (conversationId !== undefined && (typeof conversationId !== 'string' || !objectId.test(conversationId))) throw invalid();
    if (conversationId && !await Conversation.exists({ _id: conversationId, ownerId })) throw missing();
    const { limit, position, encode } = pagination(req, config, `${ownerId}:history:${conversationId ?? 'all'}`);
    const filter = { ownerId, ...(conversationId ? { conversationId } : {}),
      ...(position ? conversationId ? { sequence: { $gt: position.sequence } } : {
        $or: [{ createdAt: { $gt: position.date } }, { createdAt: position.date, _id: { $gt: position.id } }],
      } : {}),
    };
    const rows = await Message.find(filter).sort(conversationId ? { sequence: 1 } : { createdAt: 1, _id: 1 }).limit(limit + 1);
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    res.json({ items: items.map(messageView), nextCursor: rows.length > limit && last
      ? encode({ id: last.id, date: last.createdAt.toISOString(), sequence: last.sequence }) : null });
  });

  router.post('/chat/send', async (req, res) => {
    const input = parseSend(req.body);
    const reserved = await reserve(res.locals.account.id, input);
    if (reserved.created) await finish(reserved.user);
    const result = await sendResult(reserved.user);
    res.status(result.status === 'generating' ? 202 : 200).json(result);
  });
  return router;
}
