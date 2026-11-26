import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { parseEnv } from 'node:util';
import mongoose from 'mongoose';

const real = Boolean(process.env.QA_INDEX_ENV_FILE);
const supplied = real ? parseEnv(await readFile(process.env.QA_INDEX_ENV_FILE, 'utf8')) : {};
process.env.NODE_ENV = 'test';
const run = randomUUID().replaceAll('-', '');
const database = real ? supplied.MONGODB_DB_NAME : `qa04_${run.slice(0,16)}`;
const mongoUri = real ? supplied.MONGODB_URI : process.env.QA_MONGODB_URI ?? 'mongodb://127.0.0.1:27028/?replicaSet=legalChatQA';
if (real) process.env.MONGODB_COLLECTION_PREFIX = `qa04_${run}_`;
else delete process.env.MONGODB_COLLECTION_PREFIX;
const prefix = real ? `${supplied.S3_KEY_PREFIX}suite/${run}/` : `qa04/${run}/`;
const { initializeAccounts, User } = await import('../server/dist/accounts.js');
const { initializeConversations } = await import('../server/dist/conversations.js');
const { Document, DocumentVersion, IndexJob, initializeUploads, pin } = await import('../server/dist/uploads.js');
const { Passage, Chunk, Generation, EmbeddingCache, AdminEvent, IndexSetting, initializeIndexRecords } = await import('../server/dist/index-records.js');
const { IndexWorker, LeaseLost, generationId } = await import('../server/dist/index-worker.js');
const { extractOriginal, buildChunks, ProcessingError } = await import('../server/dist/extraction.js');
const { createStorage, uploadNow, advanceTestUploadClock } = await import('../server/dist/storage.js');
const { createIndexProviders } = await import('../server/dist/index-providers.js');
const { bootstrapKnowledge } = await import('../server/dist/bootstrap.js');
const { readConfig } = await import('../server/dist/config.js');
const hash = value => createHash('sha256').update(value).digest('hex');
const bytes = value => new TextEncoder().encode(value);
const fixture = name => readFile(new URL(`./fixtures/phase04/${name}`, import.meta.url));
const env = { NODE_ENV:'test',APP_ORIGIN: supplied.APP_ORIGIN ?? 'http://localhost:3000', PORT:'3000',MONGODB_URI:mongoUri,MONGODB_DB_NAME:database,
  JWT_SECRET:randomBytes(32).toString('hex'),JWT_ISSUER:'qa04',JWT_AUDIENCE:'qa04',JWT_TTL_SECONDS:'900',
  ADMIN_SEED_EMAIL:'admin@example.test',ADMIN_SEED_PASSWORD:randomBytes(24).toString('hex'),AUTH_LOGIN_LIMIT:'100',AUTH_LOGIN_WINDOW_SECONDS:'60',
  AWS_REGION:supplied.AWS_REGION ?? 'us-east-1', AWS_ACCESS_KEY_ID:supplied.AWS_ACCESS_KEY_ID ?? 'fixture-key',AWS_SECRET_ACCESS_KEY:supplied.AWS_SECRET_ACCESS_KEY ?? 'fixture-secret',
  AWS_SESSION_TOKEN:supplied.AWS_SESSION_TOKEN ?? '',S3_BUCKET:supplied.S3_BUCKET ?? 'fixture-bucket',S3_KEY_PREFIX:prefix,
  UPLOAD_RESERVATION_LIMIT:'100',UPLOAD_RESERVATION_WINDOW_SECONDS:'60',INDEXING_ENABLED:'true',
  OPENROUTER_API_KEY:supplied.OPENROUTER_API_KEY ?? 'fixture-key',OPENROUTER_EMBEDDING_MODEL:supplied.OPENROUTER_EMBEDDING_MODEL ?? 'fixture/embedding',
  OPENROUTER_EMBEDDING_DIMENSIONS:supplied.OPENROUTER_EMBEDDING_DIMENSIONS ?? '8' };
const config=readConfig(env), localConfig={...config.indexing,apiKey:'fixture-only',model:'fixture/embedding',dimensions:8,leaseMs:30000,indexWaitMs:1000};
let storage, emulator, admin;
const objects=new Map();
const fakeProviders={
  async embed(texts,cfg){return texts.map(text=>Array.from({length:cfg.dimensions},(_,i)=>(createHash('sha256').update(text).digest()[i%32]+1)/256));},
  async ensure(){},
  async probe(versionId,generation,cfg,expected){
    for(const expectedChunk of expected){const chunk=await Chunk.findById(expectedChunk.id);assert.equal(chunk.versionId,versionId);assert.equal(chunk.generation,generation);assert.equal(chunk.vectors[`d${cfg.dimensions}`].length,cfg.dimensions);}
  }
};
async function seed(text,{mime='text/plain',document,scope='shared',revision=1}={}) {
  const original=typeof text==='string'?bytes(text):text;
  const doc=document ?? await Document.create({ownerId:admin._id,scope,title:'Fictional QA policy',revisionCounter:revision});
  const version=await DocumentVersion.create({documentId:doc._id,scope,ownerId:admin._id,revision,baseVersionId:doc.activeVersionId ?? null,
    filename:mime==='application/pdf'?'fixture.pdf':'fixture.txt',mime,size:original.length,clientUploadId:randomUUID(),requestHash:hash(original),
    key:`${prefix}originals/${randomUUID()}`,expiresAt:new Date(uploadNow().getTime()+300000),state:'reserved'});
  const form=await storage.form(version.key,mime,version.id,300);
  const data=new FormData();for(const [name,value]of Object.entries(form.fields))data.append(name,value);data.append('file',new Blob([original],{type:mime}),version.filename);
  const response=await fetch(form.url,{method:'POST',body:data,headers:{Origin:config.origin},signal:AbortSignal.timeout(30000)});assert.ok(response.ok,'Fixture original upload accepted');
  return pin(version,storage);
}
async function runVersion(worker,versionId){
  const job=await worker.claim();assert.ok(job,'Expected queued job');assert.equal(job.versionId,String(versionId));await worker.process(job,false);return DocumentVersion.findById(versionId);
}
async function resetDesired(worker){await IndexSetting.updateOne({_id:'configuration'},{$set:{generation:worker.generation}},{upsert:true});}

test(`Phase 04 indexing and publication (${real?'live Atlas/OpenRouter/S3':'isolated MongoDB and deterministic providers'})`,{timeout:900000},async t=>{
  if(real){assert.match(process.env.MONGODB_COLLECTION_PREFIX,/^qa04_[a-z0-9]{8,40}_$/);for(const model of Object.values(mongoose.connection.models))assert.ok(model.collection.name.startsWith(process.env.MONGODB_COLLECTION_PREFIX),'All live models use isolated collections');}
  await mongoose.connect(mongoUri,{dbName:database,serverSelectionTimeoutMS:12000});
  try{
    await initializeAccounts(config);await initializeConversations();await initializeUploads();await initializeIndexRecords();
    admin=await User.findOne({emailNormalized:config.adminEmail});
    if(real) storage=createStorage(config);
    else{
      emulator=createServer(async(req,res)=>{
        try{const request=new Request('http://localhost',{method:'POST',headers:req.headers,body:Readable.toWeb(req),duplex:'half'});const form=await request.formData();
          const key=String(form.get('key')),file=form.get('file'),value=new Uint8Array(await file.arrayBuffer());
          const original={versionId:randomUUID(),bytes:value,size:value.length,mime:String(form.get('Content-Type')),hash:hash(value),uploadedAt:uploadNow()};
          objects.set(key,[...(objects.get(key)??[]),original]);res.writeHead(204).end();}catch{res.writeHead(400).end();}
      });await new Promise(resolve=>emulator.listen(0,'127.0.0.1',resolve));
      storage={async verify(){},async form(key,mime){return{url:`http://127.0.0.1:${emulator.address().port}`,fields:{key,'Content-Type':mime}};},
        async original(key,versionId){const rows=objects.get(key)??[];return(versionId?rows.find(row=>row.versionId===versionId):rows.at(-1))??null;},
        async versions(key){return(objects.get(key)??[]).map(row=>row.versionId);},async remove(key,id){objects.set(key,(objects.get(key)??[]).filter(row=>row.versionId!==id));}};
    }
    await storage.verify(config.origin);
    const worker=new IndexWorker(localConfig,storage,fakeProviders);await resetDesired(worker);
    await t.test('04.1 cross-page PDF and exact UTF-16 emoji anchors, literal tokens and bounded overlap',async()=>{
      const pdf=await extractOriginal(await fixture('cross-page.pdf'),'application/pdf');
      assert.ok(pdf.some(p=>p.page===1&&p.text.includes('written notice. The notice must be received at least')));
      assert.ok(pdf.some(p=>p.page===2&&p.text.includes('30 days before the requested termination date.')));
      const chunks=buildChunks(pdf.map(p=>({...p,id:`p${p.ordinal}`})));
      assert.ok(chunks.some(c=>c.anchors.some(a=>pdf[Number(a.passageId.slice(1))].page===1)&&c.anchors.some(a=>pdf[Number(a.passageId.slice(1))].page===2)),'Cross-page clause stays together in search');
      const emoji=await fixture('emoji.txt'),decoded=new TextDecoder().decode(emoji),passages=await extractOriginal(emoji,'text/plain');
      for(const p of passages)assert.equal(decoded.slice(p.start,p.end),p.text);
      const target=passages.find(p=>p.text==='The notice period is 30 days.');assert.equal(target.start,80);assert.equal(target.end,109);
      const literals=await extractOriginal(bytes('Continued obligations\n\nKeep <|endoftext|> as literal source text.'),'text/plain');
      assert.ok(buildChunks(literals.map(p=>({...p,id:`literal${p.ordinal}`}))).some(c=>c.searchText.includes('Continued obligations')&&c.searchText.includes('<|endoftext|>')));
      const long=await extractOriginal(bytes(('This clause preserves the exact notice exception and its qualification. ').repeat(600)),'text/plain');
      const longChunks=buildChunks(long.map(p=>({...p,id:`long${p.ordinal}`})));assert.ok(longChunks.length>3);assert.ok(longChunks.every(c=>c.tokenCount<=700));
      assert.ok(longChunks.slice(1).some((chunk,i)=>chunk.anchors.some(a=>longChunks[i].anchors.some(b=>a.passageId===b.passageId&&a.start<b.end&&a.end>b.start))),'Long-clause fragments retain positive overlap');
      assert.equal((await extractOriginal(bytes(Array.from({length:10000},(_,i)=>`Heading ${i}`).join('\n')),'text/plain')).length,10000);
    });
    await t.test('filtered search readiness rejects even successful query results after the overall probe deadline',async()=>{
      const original=Chunk.collection.aggregate;let closed=0,calls=0;
      Chunk.collection.aggregate=function(pipeline,options){
        const scope=pipeline[0].$search?.compound.filter;
        const id=scope?scope.find(item=>item.equals.path==='chunkId').equals.value:pipeline[0].$vectorSearch.filter.chunkId;
        assert.ok(options.maxTimeMS<=40);assert.ok(options.signal instanceof AbortSignal);calls++;
        return{async toArray(){await delay(25);return[{_id:id,versionId:'probe-version',generation:'probe-generation'}];},async close(){closed++;}};
      };
      const started=Date.now();
      try{await assert.rejects(createIndexProviders().probe('probe-version','probe-generation',{...localConfig,indexWaitMs:40},Array.from({length:5},(_,i)=>({id:`chunk${i}`,text:'query',vector:[1]}))),error=>error.code==='SEARCH_PROBE_FAILED');}
      finally{Chunk.collection.aggregate=original;}
      assert.ok(Date.now()-started<120,'Probe aborts outstanding reads instead of waiting for all five pairs');assert.ok(calls<10);assert.equal(closed,calls);
    });
    await t.test('search index metadata visibility cannot return success after its readiness window',async()=>{
      const original=Chunk.collection.listSearchIndexes;let closed=0;
      Chunk.collection.listSearchIndexes=function(options){assert.ok(options.signal instanceof AbortSignal);return{async toArray(){await delay(60);return[{name:'legal_text',queryable:true},{name:'legal_vector_8',queryable:true}];},async close(){closed++;}};};
      const started=Date.now();try{await assert.rejects(createIndexProviders().ensure({...localConfig,indexWaitMs:40}),error=>error.code==='SEARCH_INDEX_UNAVAILABLE');}finally{Chunk.collection.listSearchIndexes=original;}
      assert.ok(Date.now()-started<100);await delay(30);assert.equal(closed,1);
    });
    await t.test('04.2 malformed files, encrypted, image-only, 51-page PDFs and invalid UTF-8 fail actionably',async()=>{
      for(const [name,code]of [['malformed.pdf','MALFORMED_PDF'],['encrypted.pdf','ENCRYPTED_PDF'],['image-only.pdf','NO_TEXT'],['fifty-one-pages.pdf','PDF_PAGE_LIMIT']]){
        const version=await seed(await fixture(name),{mime:'application/pdf'});const result=await runVersion(worker,version.id);assert.equal(result.state,'failed',name);assert.equal(result.failureCode,code,name);assert.ok(result.failureReason.length>10);assert.equal(await Passage.countDocuments({versionId:version.id}),0);
      }
      const version=await seed(new Uint8Array([0xff,0xfe]));const failed=await runVersion(worker,version.id);assert.equal(failed.failureCode,'INVALID_UTF8');
    });
    await t.test('bounded passage batches preserve more than 32 immutable passages through the full pipeline',async()=>{
      const version=await seed(Array.from({length:40},()=> 'A repeated source paragraph is still independently anchored.').join('\n\n'));
      const ready=await runVersion(worker,version.id);assert.equal(ready.state,'ready');assert.equal(await Passage.countDocuments({versionId:version.id}),40);
      const chunks=await Chunk.find({versionId:version.id,generation:worker.generation});assert.ok(chunks.length>0);assert.ok(chunks.every(chunk=>chunk.tokenCount<=700));
    });
    await t.test('04.2 transient embedding failure honors retry deadline and same pinned version recovers without duplicate passages',async()=>{
      const version=await seed('1. Notice\n\nThe notice period is thirty days.');let fail=true;
      const providers={...fakeProviders,async embed(texts,cfg){if(fail)throw new ProcessingError('EMBEDDING_UNAVAILABLE','Fictional transient outage',true,10000);return fakeProviders.embed(texts,cfg);}};
      const started=uploadNow().getTime();const retryWorker=new IndexWorker(localConfig,storage,providers);const first=await runVersion(retryWorker,version.id);assert.equal(first.state,'queued');assert.equal((await IndexJob.findOne({versionId:version._id})).retryAt.getTime()>=started+10000,true);assert.equal(await retryWorker.claim(),null);
      const pointer=first.s3VersionId;fail=false;advanceTestUploadClock(10001);const ready=await runVersion(retryWorker,version.id);assert.equal(ready.state,'ready');assert.equal(ready.s3VersionId,pointer);const count=await Passage.countDocuments({versionId:version.id});assert.ok(count>0);
      await IndexJob.updateOne({versionId:version._id},{$set:{state:'queued',retryAt:uploadNow()}});await runVersion(retryWorker,version.id);assert.equal(await Passage.countDocuments({versionId:version.id}),count);
    });
    await t.test('04.3 expired and stale worker leases survive process death and fence late writes',async()=>{
      const version=await seed('1. Lease\n\nThis original survives a worker crash.');
      const child=fork(new URL('./phase04-claim-fixture.mjs',import.meta.url),{execArgv:[],env:{NODE_ENV:'test',QA_MONGODB_URI:mongoUri,QA_DATABASE:database,QA_INDEX_CONFIG:JSON.stringify({...localConfig,apiKey:'fixture-only'}),...(process.env.MONGODB_COLLECTION_PREFIX?{MONGODB_COLLECTION_PREFIX:process.env.MONGODB_COLLECTION_PREFIX}:{})},stdio:['ignore','ignore','ignore','ipc']});
      const [{job:old}]=await once(child,'message',{signal:AbortSignal.timeout(15000)});assert.equal(old.versionId,version.id);const exit=once(child,'exit');child.kill('SIGKILL');await exit;
      advanceTestUploadClock(localConfig.leaseMs+1);const next=await worker.claim();assert.ok(next);assert.notEqual(next.token,old.token);await worker.process(next,false);
      await assert.rejects(worker.fenced(old,async session=>{await DocumentVersion.updateOne({_id:version._id},{$set:{failureReason:'stale-write'}},{session});}),LeaseLost);
      assert.equal((await DocumentVersion.findById(version.id)).state,'ready');assert.equal((await DocumentVersion.findById(version.id)).failureReason,undefined);
    });
    await t.test('04.4 failed replacement retains V1 and replacement races activate only one eligible winner',async()=>{
      const v1=await seed('1. Notice\n\nNotice is thirty days.');await runVersion(worker,v1.id);let document=await Document.findById(v1.documentId);assert.equal(String(document.activeVersionId),v1.id);
      const bad=await seed(await fixture('malformed.pdf'),{mime:'application/pdf',document,revision:2});await runVersion(worker,bad.id);assert.equal(String((await Document.findById(document.id)).activeVersionId),v1.id);
      const left=await seed('1. Notice\n\nNotice is sixty days.',{document,revision:3});const right=await seed('1. Notice\n\nNotice is ninety days.',{document,revision:4});
      assert.equal(String((await Document.findById(document.id)).activeVersionId),v1.id);
      const leftJob=await worker.claim(),rightJob=await worker.claim();await Promise.all([worker.process(leftJob,false),worker.process(rightJob,false)]);
      document=await Document.findById(document.id);assert.ok([left.id,right.id].includes(String(document.activeVersionId)));
      const results=await DocumentVersion.find({_id:{$in:[left._id,right._id]}});assert.equal(results.filter(v=>v.state==='ready').length,1);assert.equal(results.filter(v=>v.failureCode==='PUBLICATION_CONFLICT').length,1);
      assert.equal(await AdminEvent.countDocuments({documentId:document._id,action:'publish'}),2);
    });
    await t.test('04.4 archive during indexing prevents publication and stale worker output',async()=>{
      const version=await seed('1. Archive\n\nThis document is archived during indexing.');let enter,release;
      const entered=new Promise(resolve=>enter=resolve),blocked=new Promise(resolve=>release=resolve);
      const paused=new IndexWorker(localConfig,storage,{...fakeProviders,async embed(texts,cfg){enter();await blocked;return fakeProviders.embed(texts,cfg);}});
      const job=await paused.claim(),running=paused.process(job,false);await entered;
      await mongoose.connection.transaction(async session=>{await Document.updateOne({_id:version.documentId},{$set:{archivedAt:uploadNow()}},{session});await AdminEvent.create([{actorId:admin._id,action:'archive',documentId:version.documentId}],{session});});
      release();await running;assert.equal((await DocumentVersion.findById(version.id)).failureCode,'DOCUMENT_ARCHIVED');assert.equal((await Document.findById(version.documentId)).activeVersionId,null);
    });
    await t.test('model/dimension migration retains ready availability, immutable anchors and reclaims expired old generation',async()=>{
      const version=await seed('1. Migration\n\nA stable citation passage stays unchanged.');await runVersion(worker,version.id);const before=await Passage.find({versionId:version.id}).lean();
      const nextConfig={...localConfig,dimensions:localConfig.dimensions+1,model:'fixture/next'};
      const next=new IndexWorker(nextConfig,storage,fakeProviders);await next.scheduleMigrations(true);assert.equal((await DocumentVersion.findById(version.id)).state,'ready');assert.equal((await DocumentVersion.findById(version.id)).activeIndexGeneration,worker.generation);assert.equal(await worker.claim(),null);
      // Finish other already-published versions first if they also need migration.
      while((await DocumentVersion.findById(version.id)).activeIndexGeneration!==next.generation){assert.ok(await next.runOnce());}
      assert.deepEqual(await Passage.find({versionId:version.id}).lean(),before);
      assert.equal(String((await Document.findById(version.documentId)).activeVersionId),version.id);
      await resetDesired(worker);const pending=await seed('1. Pending\n\nAn old generation worker crashes here.');const old=await worker.claim();assert.equal(old.versionId,pending.id);
      advanceTestUploadClock(localConfig.leaseMs+1);await next.scheduleMigrations(true);let reclaimed;
      do{reclaimed=await next.claim();assert.ok(reclaimed);assert.equal(reclaimed.generation,next.generation);await next.process(reclaimed,false);}while(reclaimed.versionId!==pending.id);
      await assert.rejects(worker.fenced(old,async()=>{}),LeaseLost);await resetDesired(worker);
    });
    await t.test('04.1 bootstrap twice is idempotent, and historical V1 migration never republishes over V2',async()=>{
      const one=await bootstrapKnowledge(config,storage,worker),counts={passages:await Passage.countDocuments({}),chunks:await Chunk.countDocuments({})};
      assert.equal(one.documents,2);assert.equal(one.versions,3);assert.deepEqual(await bootstrapKnowledge(config,storage,worker),one);assert.equal(await Passage.countDocuments({}),counts.passages);assert.equal(await Chunk.countDocuments({}),counts.chunks);
      const newer=new IndexWorker({...localConfig,model:'fixture/bootstrap-next',dimensions:localConfig.dimensions+2},storage,fakeProviders);
      const changed=await bootstrapKnowledge({...config,indexing:newer.config},storage,newer);assert.deepEqual(changed.active,one.active);assert.equal(changed.versions,3);
    });
    if(real)await t.test('04.1 live model dimensions and real filtered Atlas keyword/vector visibility precede ready',async()=>{
      // Deterministic cases above deliberately use provider doubles. Remove
      // their isolated metadata/cache before the real-provider bootstrap gate.
      for(const model of Object.values(mongoose.connection.models))if(model!==User&&model.modelName!=='Session')await model.deleteMany({});
      const actualProviders=createIndexProviders();let actualEmbeddingCalls=0;
      const live=new IndexWorker(config.indexing,storage,{...actualProviders,async embed(texts,cfg){actualEmbeddingCalls++;return actualProviders.embed(texts,cfg);}});await resetDesired(live);
      const bootstrap=await bootstrapKnowledge(config,storage,live);const counts={passages:await Passage.countDocuments({}),chunks:await Chunk.countDocuments({})};
      assert.deepEqual(await bootstrapKnowledge(config,storage,live),bootstrap);assert.equal(await Passage.countDocuments({}),counts.passages);assert.equal(await Chunk.countDocuments({}),counts.chunks);assert.equal(bootstrap.documents,2);assert.equal(bootstrap.versions,3);
      assert.ok(actualEmbeddingCalls>0,'The actual OpenRouter adapter was called for the fresh real bootstrap');
      // Only this explicit live case provisions indexes or calls OpenRouter.
      const version=await seed('1. Export verification\n\nThe fictional export option remains available for fourteen days after termination.');
      const job=await live.claim();assert.equal(job.versionId,version.id);await live.process(job);const ready=await DocumentVersion.findById(version.id);assert.equal(ready.state,'ready');assert.equal(ready.dimensions,Number(supplied.OPENROUTER_EMBEDDING_DIMENSIONS));assert.equal(ready.embeddingModel,supplied.OPENROUTER_EMBEDDING_MODEL);
      const expected=await Chunk.find({versionId:version.id,generation:live.generation}).lean();assert.ok(expected.length>0);
      // Same text/vector, but wrong version or generation: both must be excluded.
      const source=expected[0];await Chunk.collection.insertMany([{...source,_id:`${source._id}:decoy-version`,versionId:'excluded-version'}, {...source,_id:`${source._id}:decoy-generation`,generation:'excluded-generation'}]);
      await live.providers.probe(version.id,live.generation,live.config,expected.map(c=>({id:c._id,text:c.searchText,vector:c.vectors[`d${live.config.dimensions}`]})));
      const tied=Array.from({length:26},(_,i)=>({...source,_id:`${source._id}:tie:${i}`,chunkId:`${source._id}:tie:${i}`,ordinal:1000+i}));
      await Chunk.collection.insertMany(tied);
      await live.providers.probe(version.id,live.generation,live.config,tied.map(c=>({id:c._id,text:c.searchText,vector:c.vectors[`d${live.config.dimensions}`]})));
      assert.equal(ready.activeIndexGeneration,live.generation);
    });
  }finally{
    if(real){
      const {S3Client,ListObjectVersionsCommand,DeleteObjectCommand}=await import('@aws-sdk/client-s3');const s3=new S3Client({region:env.AWS_REGION,credentials:{accessKeyId:env.AWS_ACCESS_KEY_ID,secretAccessKey:env.AWS_SECRET_ACCESS_KEY,sessionToken:env.AWS_SESSION_TOKEN||undefined}});
      try{let KeyMarker,VersionIdMarker;do{const page=await s3.send(new ListObjectVersionsCommand({Bucket:env.S3_BUCKET,Prefix:prefix,KeyMarker,VersionIdMarker}));for(const object of [...(page.Versions??[]),...(page.DeleteMarkers??[])])if(object.Key?.startsWith(prefix)&&object.VersionId)await s3.send(new DeleteObjectCommand({Bucket:env.S3_BUCKET,Key:object.Key,VersionId:object.VersionId}));KeyMarker=page.IsTruncated?page.NextKeyMarker:undefined;VersionIdMarker=page.IsTruncated?page.NextVersionIdMarker:undefined;}while(KeyMarker);}finally{s3.destroy();}
      assert.match(process.env.MONGODB_COLLECTION_PREFIX,/^qa04_[a-z0-9]{8,40}_$/);
      const names=await mongoose.connection.db.listCollections({name:{$regex:`^${process.env.MONGODB_COLLECTION_PREFIX}`}}, {nameOnly:true}).toArray();
      for(const {name}of names){assert.ok(name.startsWith(process.env.MONGODB_COLLECTION_PREFIX));await mongoose.connection.db.collection(name).drop();}
    }else await mongoose.connection.db.dropDatabase();
    await mongoose.disconnect();if(emulator)await new Promise(resolve=>emulator.close(resolve));
  }
});
