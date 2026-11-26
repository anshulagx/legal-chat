import mongoose from 'mongoose';
import { readConfig } from '../server/dist/config.js';
import { initializeAccounts } from '../server/dist/accounts.js';
import { initializeConversations } from '../server/dist/conversations.js';
import { initializeUploads } from '../server/dist/uploads.js';
import { initializeIndexRecords } from '../server/dist/index-records.js';
import { IndexWorker } from '../server/dist/index-worker.js';
import { createStorage } from '../server/dist/storage.js';
import { bootstrapKnowledge } from '../server/dist/bootstrap.js';
const config = readConfig(process.env);
const storage = createStorage(config);
if (!storage || !config.indexing) throw new Error('Set INDEXING_ENABLED=true and complete storage/model configuration.');
try {
  await mongoose.connect(config.mongoUri, { dbName: config.database });
  await initializeAccounts(config); await initializeConversations(); await initializeUploads(); await initializeIndexRecords();
  await storage.verify(config.origin);
  const result = await bootstrapKnowledge(config, storage, new IndexWorker(config.indexing, storage));
  console.log(JSON.stringify({ event: 'bootstrap_ready', ...result }));
} catch (error) { console.error(JSON.stringify({ event: 'bootstrap_failed', message: error.name })); process.exitCode = 1; }
finally { await mongoose.disconnect(); }
