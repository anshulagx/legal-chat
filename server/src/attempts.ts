import mongoose from 'mongoose';
import { Conversation, Message } from './conversations.ts';

// Database state fences every terminal write, including writers that outlive a
// disconnect, lease expiry or cancellation. The map only speeds local aborts.
const running = new Map<string, AbortController>();
export function trackAttempt(id: string, controller: AbortController) {
  running.set(id, controller);
  return () => running.delete(id);
}
export function abortAttempt(id: string) { running.get(id)?.abort(); }
export function abortAllAttempts() { for (const controller of running.values()) controller.abort(); }

export async function interruptAttempt(id: string, code: string, expiredBefore?: Date) {
  const changed = await mongoose.connection.transaction(async session => {
    const conversation = await Conversation.findOneAndUpdate({ activeAttemptId: id,
      ...(expiredBefore ? { $or: [{ attemptLeaseExpiresAt: { $lte: expiredBefore } }, { attemptLeaseExpiresAt: null }] } : {}),
    }, { $set: { activeAttemptId: null, updatedAt: new Date() }, $unset: { attemptLeaseExpiresAt: 1 } }, { session });
    if (!conversation) return false;
    const attempt = await Message.findOneAndUpdate({ _id: id, status: 'generating' },
      { $set: { status: 'interrupted', failureCode: code } }, { session });
    if (attempt) await Message.updateOne({ _id: attempt.parentTurnId, attemptId: attempt._id }, { $set: { status: 'interrupted' } }, { session });
    return true;
  });
  if (changed) abortAttempt(id);
}

export async function reconcileAttempts() {
  const now = new Date();
  const stale = await Conversation.find({ activeAttemptId: { $ne: null },
    $or: [{ attemptLeaseExpiresAt: { $lte: now } }, { attemptLeaseExpiresAt: null }],
  }).select('activeAttemptId').limit(100);
  for (const conversation of stale) await interruptAttempt(String(conversation.activeAttemptId), 'ATTEMPT_INTERRUPTED', now);
}
