import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import express from 'express';
import mongoose, { Types } from 'mongoose';
import { isDuplicate } from './accounts.ts';
import { generateAnswer, type Answer } from './answer.ts';
import { requestGuard, requireSession } from './auth.ts';
import type { Config } from './config.ts';
import { Conversation, Message } from './conversations.ts';
import { HttpError } from './http.ts';
import { Document, DocumentVersion } from './uploads.ts';

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
    && (!Array.isArray(input.selectedDocumentVersionIds) || input.selectedDocumentVersionIds.length > 5
      || input.selectedDocumentVersionIds.some(id => typeof id !== 'string' || !objectId.test(id))
      || new Set(input.selectedDocumentVersionIds).size !== input.selectedDocumentVersionIds.length)) throw invalid('Select up to five distinct documents.');
  const selectedDocumentVersionIds = (input.selectedDocumentVersionIds ?? []) as string[];
  const message = input.message.trim();
  const conversationId = input.conversationId as string | undefined;
  const clientMessageId = input.clientMessageId as string | undefined ?? randomUUID();
  const requestHash = createHash('sha256').update(JSON.stringify({ message, conversationId: conversationId ?? null, selectedDocumentVersionIds })).digest('hex');
  return { message, conversationId, clientMessageId, requestHash, selectedDocumentVersionIds };
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
        requestHash: input.requestHash, selectedDocumentVersionIds: input.selectedDocumentVersionIds, attemptId, status: 'pending',
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

type Emit = (event: string, data: unknown) => void;
async function finish(user: StoredMessage, config: Config, emit?: Emit) {
  let answer: Answer | undefined;
  try {
    emit?.('progress', { stage: 'retrieval' });
    answer = await generateAnswer({ message: user.content, ownerId: String(user.ownerId),
      conversationId: String(user.conversationId), userMessageId: user.id, attemptId: String(user.attemptId),
      selectedDocumentVersionIds: user.selectedDocumentVersionIds, config,
      onProgress: stage => { emit?.('progress', { stage }); },
      onSnapshot: async snapshot => {
        await Message.updateOne({ _id: user.attemptId, status: 'generating' }, { $set: { evidenceSnapshot: snapshot } });
      },
      onParagraph: async paragraph => {
        const saved = await Message.updateOne({ _id: user.attemptId, status: 'generating', 'paragraphs.sequence': { $ne: paragraph.sequence } }, {
          $push: { paragraphs: paragraph, citations: { $each: paragraph.citations } },
        });
        if (saved.modifiedCount) emit?.('paragraph', paragraph);
      },
    });
  } catch {
    // Preserve the durable question and any validated partial paragraphs.
  }
  await mongoose.connection.transaction(async session => {
    const locked = await Conversation.updateOne({ _id: user.conversationId, ownerId: user.ownerId, activeAttemptId: user.attemptId }, {
      $set: { activeAttemptId: null, updatedAt: new Date() },
    }, { session });
    if (!locked.modifiedCount) return;
    const status = answer ? 'completed' : 'failed';
    await Message.updateOne({ _id: user.attemptId, status: 'generating' }, {
      $set: { status, ...(answer ? { content: answer.response, followUps: answer.followUps,
        paragraphs: answer.paragraphs ?? [], citations: answer.citations ?? [], comparison: answer.comparison,
        evidenceSnapshot: answer.evidenceSnapshot, handoffOffer: answer.handoffOffer, traceId: answer.traceId } : { failureCode: 'ANSWER_UNAVAILABLE' }) },
    }, { session });
    await Message.updateOne({ _id: user._id }, { $set: { status } }, { session });
  }, { writeConcern: { w: 'majority' } });
  if (answer?.comparison) emit?.('comparison', answer.comparison);
}

async function sendResult(user: StoredMessage) {
  const attempt = await Message.findOne({ _id: user.attemptId, ownerId: user.ownerId });
  if (!attempt) throw new HttpError(503, 'UNAVAILABLE', 'The saved answer is temporarily unavailable.');
  return {
    conversationId: String(user.conversationId), userMessageId: user.id, attemptId: attempt.id,
    clientMessageId: user.clientMessageId, status: attempt.status, response: attempt.content,
    citations: attempt.citations, paragraphs: attempt.paragraphs, comparison: attempt.comparison,
    handoffOffer: attempt.handoffOffer, draft: attempt.draft, followUps: attempt.followUps, failureCode: attempt.failureCode,
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
    citations: message.citations, paragraphs: message.paragraphs, comparison: message.comparison,
    handoffOffer: message.handoffOffer, draft: message.draft, followUps: message.followUps, failureCode: message.failureCode,
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

  router.post('/chat/messages/:id/email-draft', async (req, res) => {
    const id = String(req.params.id);
    if (!objectId.test(id)) throw missing();
    const message = await Message.findOne({ _id: id, ownerId: res.locals.account.id, role: 'assistant', status: 'completed' });
    if (!message) throw missing();
    if (!message.handoffOffer?.unresolvedQuestion) throw new HttpError(409, 'NO_HANDOFF_OFFER', 'This reply has no support draft offer.');
    const followUps = ['Which parts are confirmed by the documents?', 'What should I ask support to clarify?'];
    const confirmed = message.citations.slice(0, 6).map(citation => `${String(citation.filename ?? 'Source')}: ${String(citation.quote ?? '')}`).join('\n');
    const draft = { subject: 'Clarification requested about my agreement',
      body: `Hello Support,\n\nPlease clarify the following question, which the available documents do not fully answer:\n\n${String(message.handoffOffer.unresolvedQuestion)}${confirmed ? `\n\nAvailable source excerpts:\n${confirmed}` : ''}\n\nPlease identify the applicable clause and version in your reply.\n\nThank you.` };
    const saved = await Message.findOneAndUpdate({ _id: id, ownerId: res.locals.account.id, draft: { $exists: false } },
      { $set: { draft, followUps } }, { new: true }) ?? await Message.findById(id);
    res.json({ draft: saved!.draft, followUps: saved!.followUps });
  });

  router.post('/chat/send', async (req, res) => {
    const input = parseSend(req.body);
    const existing = await Message.findOne({ ownerId: res.locals.account.id, role: 'user', clientMessageId: input.clientMessageId }).select('requestHash');
    if (existing && existing.requestHash !== input.requestHash) throw conflictingKey();
    // A selector is a scope restriction, never a grant of source access.
    // Replays retain their original snapshot even after a source is replaced.
    if (input.selectedDocumentVersionIds.length && !existing) {
      const ownerId = res.locals.account.id as string;
      const active = await Document.find({ scope: 'shared', archivedAt: null }).select('activeVersionId');
      const allowed = await DocumentVersion.find({ _id: { $in: input.selectedDocumentVersionIds }, state: 'ready', activeIndexGeneration: { $type: 'string' },
        $or: [{ scope: 'shared', _id: { $in: active.map(doc => doc.activeVersionId) } },
          ...(input.conversationId ? [{ scope: 'private', ownerId, conversationId: input.conversationId }] : [])] }).select('_id');
      if (allowed.length !== input.selectedDocumentVersionIds.length) throw invalid('Selected documents are unavailable in this chat.');
    }
    const reserved = await reserve(res.locals.account.id, input);
    if (!req.accepts(['text/event-stream', 'application/json']) || !req.get('Accept')?.includes('text/event-stream')) {
      if (reserved.created) await finish(reserved.user, config);
      const result = await sendResult(reserved.user);
      return res.status(result.status === 'generating' ? 202 : 200).json(result);
    }
    res.status(200).set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no', Connection: 'keep-alive' });
    res.flushHeaders();
    const emit: Emit = (event, data) => { if (!res.destroyed && !res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
    emit('accepted', { conversationId: String(reserved.user.conversationId), userMessageId: reserved.user.id, attemptId: String(reserved.user.attemptId) });
    const heartbeat = setInterval(() => { if (!res.destroyed) res.write(': heartbeat\n\n'); }, 10000).unref();
    try {
      if (reserved.created) await finish(reserved.user, config, emit);
      const result = await sendResult(reserved.user);
      if (!reserved.created) {
        for (const paragraph of result.paragraphs ?? []) emit('paragraph', paragraph);
        if (result.comparison) emit('comparison', result.comparison);
      }
      if (result.status === 'failed') emit('error', { code: result.failureCode, attemptId: result.attemptId, retryable: true });
      else if (result.status === 'generating') emit('progress', { stage: 'generation' });
      else emit('complete', result);
    } finally { clearInterval(heartbeat); res.end(); }
  });
  return router;
}
