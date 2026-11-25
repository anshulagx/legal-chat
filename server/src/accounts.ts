import mongoose, { Schema } from 'mongoose';
import bcrypt from 'bcryptjs';
import type { Config } from './config.ts';

export const passwordCost = 12;
export const User = mongoose.model('User', new Schema({
  emailNormalized: { type: String, required: true, unique: true },
  passwordHash: { type: String, required: true, select: false },
  role: { type: String, enum: ['customer', 'admin'], required: true },
  createdAt: { type: Date, default: Date.now },
}));

export const Session = mongoose.model('Session', new Schema({
  userId: { type: Schema.Types.ObjectId, required: true },
  expiresAt: { type: Date, required: true, expires: 0 },
  revokedAt: { type: Date, default: null },
}));

export function isDuplicate(error: unknown) {
  return error instanceof mongoose.mongo.MongoServerError && error.code === 11000;
}

export async function initializeAccounts(config: Config) {
  await Promise.all([User.init(), Session.init()]);
  let admin = await User.findOne({ emailNormalized: config.adminEmail }).select('+passwordHash');
  if (!admin) {
    try {
      await User.create({
        emailNormalized: config.adminEmail,
        passwordHash: await bcrypt.hash(config.adminPassword, passwordCost),
        role: 'admin',
      });
      return;
    } catch (error) {
      if (!isDuplicate(error)) throw error;
      admin = await User.findOne({ emailNormalized: config.adminEmail }).select('+passwordHash');
    }
  }
  if (admin?.role !== 'admin') throw new Error('The configured admin email belongs to a customer.');
  if (!await bcrypt.compare(config.adminPassword, admin.passwordHash)) {
    admin.passwordHash = await bcrypt.hash(config.adminPassword, passwordCost);
    await admin.save();
  }
}
