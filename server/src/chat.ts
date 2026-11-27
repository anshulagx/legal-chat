import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import { trackAttempt, interruptAttempt, reconcileAttempts } from './attempts.ts';
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

async function reserve(ownerId: string, input: ReturnType<typeof parseSend>, config: Config) {
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
        $set: { activeAttemptId: attemptId, attemptLeaseExpiresAt: new Date(Date.now() + config.attemptLeaseMs), updatedAt: new Date(),
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
async function finish(user: StoredMessage, config: Config, signal: AbortSignal, emit?: Emit) {
  let answer: Answer | undefined;
  let failureCode = 'ANSWER_UNAVAILABLE';
  let retryAfterSeconds: number | undefined;
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  const untrack = trackAttempt(String(user.attemptId), controller);
  const lease = setInterval(() => {
    void Conversation.updateOne({ _id: user.conversationId, activeAttemptId: user.attemptId,
      attemptLeaseExpiresAt: { $gt: new Date() } }, { $set: { attemptLeaseExpiresAt: new Date(Date.now() + config.attemptLeaseMs) } })
      .then(result => { if (!result.matchedCount) controller.abort(); }).catch(() => controller.abort());
  }, Math.max(250, Math.floor(config.attemptLeaseMs / 3))).unref();
  const deadline = AbortSignal.any([controller.signal, AbortSignal.timeout(config.answer?.deadlineMs ?? 90000)]);
  try {
    emit?.('progress', { stage: 'retrieval' });
    const generation = generateAnswer({ message: user.content, ownerId: String(user.ownerId),
      conversationId: String(user.conversationId), userMessageId: user.id, attemptId: String(user.attemptId),
      retryId: user.retryId ?? undefined, selectedDocumentVersionIds: user.selectedDocumentVersionIds, config, signal: deadline,
      onTrace: async traceId => { await Message.updateOne({ _id: user.attemptId, status: 'generating' }, { $set: { traceId } }); },
      onProgress: stage => { deadline.throwIfAborted(); emit?.('progress', { stage }); },
      onSnapshot: async snapshot => {
        deadline.throwIfAborted();
        await Message.updateOne({ _id: user.attemptId, status: 'generating' }, { $set: { evidenceSnapshot: snapshot } });
      },
      onParagraph: async paragraph => {
        deadline.throwIfAborted();
        const saved = await Message.updateOne({ _id: user.attemptId, status: 'generating', 'paragraphs.sequence': { $ne: paragraph.sequence } }, {
          $push: { paragraphs: paragraph, citations: { $each: paragraph.citations } },
        });
        if (saved.modifiedCount) emit?.('paragraph', paragraph);
      },
    });
    // Also bound adapters that cannot cancel their underlying operation.
    answer = await new Promise<Answer>((resolve, reject) => {
      const stopped = () => reject(deadline.reason);
      deadline.addEventListener('abort', stopped, { once: true });
      generation.then(resolve, reject).finally(() => deadline.removeEventListener('abort', stopped));
      if (deadline.aborted) stopped();
    });
    deadline.throwIfAborted();
  } catch (error) {
    answer = undefined;
    if (error instanceof HttpError && error.status === 429) {
      failureCode = 'PROVIDER_THROTTLED'; retryAfterSeconds = error.retryAfterSeconds;
    }
  } finally {
    clearInterval(lease); untrack(); signal.removeEventListener('abort', abort);
  }
  await mongoose.connection.transaction(async session => {
    const locked = await Conversation.updateOne({ _id: user.conversationId, ownerId: user.ownerId, activeAttemptId: user.attemptId,
      attemptLeaseExpiresAt: { $gt: new Date() } }, {
      $set: { activeAttemptId: null, updatedAt: new Date() }, $unset: { attemptLeaseExpiresAt: 1 },
    }, { session });
    if (!locked.modifiedCount) return;
    const status = controller.signal.aborted ? 'interrupted' : answer ? 'completed' : 'failed';
    await Message.updateOne({ _id: user.attemptId, status: 'generating' }, {
      $set: { status, ...(answer ? { content: answer.response, followUps: answer.followUps,
        paragraphs: answer.paragraphs ?? [], citations: answer.citations ?? [], comparison: answer.comparison,
        evidenceSnapshot: answer.evidenceSnapshot, handoffOffer: answer.handoffOffer, traceId: answer.traceId } : {
          failureCode: status === 'interrupted' ? 'ATTEMPT_INTERRUPTED' : failureCode,
          ...(retryAfterSeconds ? { retryAfterSeconds, retryAvailableAt: new Date(Date.now() + retryAfterSeconds * 1000) } : {}),
        }) },
    }, { session });
    await Message.updateOne({ _id: user._id, attemptId: user.attemptId }, { $set: { status } }, { session });
  }, { writeConcern: { w: 'majority' } });
  if (answer?.comparison) emit?.('comparison', answer.comparison);
}

async function reserveRetry(ownerId: string, id: string, retryId: string, config: Config) {
  const transaction = async () => mongoose.connection.transaction(async session => {
    const user = await Message.findOne({ _id: id, ownerId, role: 'user' }).session(session);
    if (!user) throw missing();
    const existing = await Message.findOne({ parentTurnId: id, retryId }).session(session);
    if (existing) { user.attemptId = existing._id; user.retryId = retryId; return { user, created: false }; }
    const previous = await Message.findOne({ _id: user.attemptId, ownerId }).session(session);
    if (!previous || !['failed', 'interrupted'].includes(previous.status)) throw new HttpError(409, 'RETRY_UNAVAILABLE', 'Only a failed or interrupted reply can be retried.');
    if (previous.retryAvailableAt && previous.retryAvailableAt.getTime() > Date.now()) {
      throw new HttpError(429, 'PROVIDER_THROTTLED', 'Please wait before retrying.', undefined, Math.ceil((previous.retryAvailableAt.getTime() - Date.now()) / 1000));
    }
    const attemptId = new Types.ObjectId();
    const locked = await Conversation.findOneAndUpdate({ _id: user.conversationId, ownerId, activeAttemptId: null }, {
      $set: { activeAttemptId: attemptId, attemptLeaseExpiresAt: new Date(Date.now() + config.attemptLeaseMs), updatedAt: new Date() },
      $inc: { nextSequence: 1, messageCount: 1 },
    }, { session });
    if (!locked) throw new HttpError(409, 'GENERATION_ACTIVE', 'Wait for the current answer before retrying.');
    await Message.create([{ _id: attemptId, ownerId, conversationId: user.conversationId, sequence: locked.nextSequence,
      role: 'assistant', parentTurnId: user._id, retryId, status: 'generating' }], { session });
    user.attemptId = attemptId; user.status = 'pending';
    await user.save({ session });
    user.retryId = retryId;
    return { user, created: true };
  });
  try { return await transaction(); }
  catch (error) { if (!isDuplicate(error)) throw error; return transaction(); }
}

async function sendResult(user: StoredMessage) {
  const attempt = await Message.findOne({ _id: user.attemptId, ownerId: user.ownerId });
  if (!attempt) throw new HttpError(503, 'UNAVAILABLE', 'The saved answer is temporarily unavailable.');
  return {
    conversationId: String(user.conversationId), userMessageId: user.id, attemptId: attempt.id,
    retryAfterSeconds: attempt.retryAfterSeconds, retryAvailableAt: attempt.retryAvailableAt,
    clientMessageId: user.clientMessageId, status: attempt.status, response: attempt.content,
    citations: attempt.citations, paragraphs: attempt.paragraphs, comparison: attempt.comparison,
    handoffOffer: attempt.handoffOffer, draft: attempt.draft, followUps: attempt.followUps, failureCode: attempt.failureCode,
  };
}

async function respond(req: express.Request, res: express.Response, reserved: { user: StoredMessage; created: boolean }, config: Config) {
  const controller = new AbortController();
  const disconnected = () => { if (!res.writableEnded) controller.abort(); };
  res.once('close', disconnected);
  if (res.destroyed) controller.abort();
  const streaming = !!req.get('Accept')?.includes('text/event-stream');
  // Missing provider configuration is rejected before starting a stream. Test
  // adapters are deliberately allowed only in test processes.
  if (reserved.created && !config.answer && process.env.NODE_ENV !== 'test') {
    await interruptAttempt(String(reserved.user.attemptId), 'ANSWER_UNAVAILABLE');
    res.removeListener('close', disconnected);
    return res.status(503).json({ ...await sendResult(reserved.user), code: 'ANSWER_UNAVAILABLE', retryable: true,
      message: 'Answers are temporarily unavailable. Your question is saved.' });
  }
  let heartbeat: NodeJS.Timeout | undefined;
  let opening: NodeJS.Timeout | undefined;
  let started = false;
  const queued: [string, unknown][] = [];
  const write: Emit = (event, data) => { if (!res.destroyed && !res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
  const start = () => {
    if (started || !streaming || res.destroyed) return;
    started = true;
    res.status(200).set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no', Connection: 'keep-alive' });
    res.flushHeaders();
    write('accepted', { conversationId: String(reserved.user.conversationId), userMessageId: reserved.user.id, attemptId: String(reserved.user.attemptId) });
    for (const [event, data] of queued.splice(0)) write(event, data);
    heartbeat = setInterval(() => { if (!res.destroyed && !res.writableEnded) res.write(': heartbeat\n\n'); }, 10000).unref();
  };
  const emit: Emit = (event, data) => {
    // Brief admission window allows immediate provider errors to retain HTTP
    // semantics. Long retrieval still flushes accepted/progress promptly.
    if (!started && event === 'paragraph') start();
    if (started) write(event, data); else queued.push([event, data]);
  };
  if (streaming) opening = setTimeout(start, 100).unref();

  try {
    if (reserved.created) await finish(reserved.user, config, controller.signal, streaming ? emit : undefined);
    const result = await sendResult(reserved.user);
    if (!streaming) {
      if (result.retryAfterSeconds) res.set('Retry-After', String(result.retryAfterSeconds));
      return res.status(result.status === 'generating' ? 202 : result.status === 'failed' ? result.failureCode === 'PROVIDER_THROTTLED' ? 429 : 503 : 200).json(result.status === 'failed' ? { ...result, code: result.failureCode, retryable: true, message: 'The reply could not be completed. Your question is saved.' } : result);
    }
    clearTimeout(opening);
    if (!started && ['failed', 'interrupted'].includes(result.status)) {
      if (result.retryAfterSeconds) res.set('Retry-After', String(result.retryAfterSeconds));
      return res.status(result.failureCode === 'PROVIDER_THROTTLED' ? 429 : 503).json({ ...result,
        code: result.failureCode, retryable: true, message: 'The reply could not be completed. Your question is saved.' });
    }
    start();
    if (!reserved.created) {
      for (const paragraph of result.paragraphs ?? []) emit('paragraph', paragraph);
      if (result.comparison) emit('comparison', result.comparison);
    }
    if (['failed', 'interrupted'].includes(result.status)) emit('error', { code: result.failureCode, ...result, retryable: true });
    else if (result.status === 'generating') emit('progress', { stage: 'generation' });
    else emit('complete', result);
  } catch {
    if (streaming && started) emit('error', { code: 'ANSWER_UNAVAILABLE', attemptId: String(reserved.user.attemptId),
      userMessageId: reserved.user.id, conversationId: String(reserved.user.conversationId), retryable: true });
    else throw new HttpError(503, 'ANSWER_UNAVAILABLE', 'The saved reply is temporarily unavailable. Retry with the same request ID.');
  } finally {
    clearTimeout(opening); clearInterval(heartbeat); res.removeListener('close', disconnected);
    // Before SSE headers are sent, let Express render a thrown HTTP error.
    // Ending here would commit an empty 200 and hide the retryable failure.
    if (streaming && started && !res.writableEnded) res.end();
  }
}

function summary(conversation: InstanceType<typeof Conversation>) {
  return { id: conversation.id, title: conversation.title, updatedAt: conversation.updatedAt.toISOString() };
}
function messageView(message: StoredMessage) {
  return {
    selectedDocumentVersionIds: message.selectedDocumentVersionIds, retryId: message.retryId,
    retryAvailableAt: message.retryAvailableAt,
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

  const generationLimit = rateLimit({ windowMs: config.generationWindowMs, limit: config.generationLimit,
    keyGenerator: (_req, res) => String(res.locals.account.id), standardHeaders: 'draft-8', legacyHeaders: false,
    skip: async (req, res) => {
      const ownerId = res.locals.account.id;
      if (req.path === '/chat/send' && typeof req.body?.clientMessageId === 'string') {
        return !!await Message.exists({ ownerId, role: 'user', clientMessageId: req.body.clientMessageId });
      }
      if (objectId.test(String(req.params.id)) && typeof req.body?.retryId === 'string') {
        return !!await Message.exists({ ownerId, parentTurnId: req.params.id, retryId: req.body.retryId });
      }
      return false;
    },
    handler: (_req, res) => {
      const seconds = Math.max(1, Math.ceil((((res.req as express.Request & { rateLimit?: { resetTime?: Date } }).rateLimit?.resetTime?.getTime() ?? Date.now() + config.generationWindowMs) - Date.now()) / 1000));
      res.set('Retry-After', String(seconds)).status(429).json({ code: 'GENERATION_LIMIT', message: 'Please wait before requesting another reply.', retryable: true, retryAfterSeconds: seconds });
    },
  });
  router.use(async (_req, _res, next) => { await reconcileAttempts(); next(); });
  router.post('/chat/messages/:id/cancel', async (req, res) => {
    if (!objectId.test(String(req.params.id))) throw missing();
    const attempt = await Message.findOne({ _id: req.params.id, ownerId: res.locals.account.id, role: 'assistant' });
    if (!attempt) throw missing();
    await interruptAttempt(attempt.id, 'ATTEMPT_CANCELLED');
    res.json({ attemptId: attempt.id, status: (await Message.findById(attempt.id))!.status });
  });
  router.post('/chat/messages/:id/retry', generationLimit, async (req, res) => {
    if (!objectId.test(String(req.params.id))) throw missing();
    if (typeof req.body?.retryId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(req.body.retryId)) throw invalid('Provide a retry ID.');
    return respond(req, res, await reserveRetry(res.locals.account.id, String(req.params.id), req.body.retryId, config), config);
  });

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

  router.post('/chat/send', generationLimit, async (req, res) => {
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
    const reserved = await reserve(res.locals.account.id, input, config);
    return respond(req, res, reserved, config);
  });
  return router;
}
