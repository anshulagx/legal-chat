import mongoose from 'mongoose';
import { IndexWorker } from '../server/dist/index-worker.js';
await mongoose.connect(process.env.QA_MONGODB_URI, { dbName: process.env.QA_DATABASE });
const worker = new IndexWorker(JSON.parse(process.env.QA_INDEX_CONFIG), { verify: async()=>{}, form: async()=>({}), original: async()=>null, versions: async()=>[], remove: async()=>{} });
process.send?.({ job: await worker.claim() });
// The parent deliberately kills this process to leave a durable expired lease.
process.on('message', ()=>{});
