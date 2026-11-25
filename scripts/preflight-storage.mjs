import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export async function probeS3(env, production, requireThat) {
  const {
    S3Client, GetBucketVersioningCommand, GetPublicAccessBlockCommand, GetBucketCorsCommand,
    ListObjectsV2Command, HeadObjectCommand, GetObjectCommand, DeleteObjectCommand,
  } = await import('@aws-sdk/client-s3');
  const s3 = new S3Client({
    region: env.AWS_REGION,
    maxAttempts: 1,
    credentials: {
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      sessionToken: env.AWS_SESSION_TOKEN || undefined,
    },
  });
  const bucket = { Bucket: env.S3_BUCKET };
  const send = command => s3.send(command, { abortSignal: AbortSignal.timeout(12_000) });
  try {
    const [versioning, access, cors] = await Promise.all([
      send(new GetBucketVersioningCommand(bucket)),
      send(new GetPublicAccessBlockCommand(bucket)),
      send(new GetBucketCorsCommand(bucket)),
      send(new ListObjectsV2Command({ ...bucket, Prefix: env.S3_KEY_PREFIX, MaxKeys: 1 })),
    ]);
    requireThat(versioning.Status === 'Enabled', 'Bucket versioning must be enabled.');
    const block = access.PublicAccessBlockConfiguration;
    requireThat(block?.BlockPublicAcls && block.IgnorePublicAcls && block.BlockPublicPolicy
      && block.RestrictPublicBuckets, 'All bucket Block Public Access settings must be enabled.');
    requireThat(cors.CORSRules?.some(rule => rule.AllowedOrigins?.includes(env.APP_ORIGIN)
      && rule.AllowedMethods?.includes('POST') && rule.AllowedMethods?.includes('GET')), 'The exact app origin needs GET and POST in S3 CORS.');
    if (production) return `${env.S3_BUCKET} settings and scoped prefix read passed.`;

    const { createPresignedPost } = await import('@aws-sdk/s3-presigned-post');
    const object = { ...bucket, Key: `${env.S3_KEY_PREFIX}preflight/${randomUUID()}.txt` };
    const post = await createPresignedPost(s3, {
      ...object, Expires: 300,
      Fields: { 'Content-Type': 'text/plain' },
      Conditions: [['content-length-range', 1, 5 * 1024 * 1024], ['eq', '$Content-Type', 'text/plain']],
    });
    const corsResponse = await fetch(post.url, {
      method: 'OPTIONS', redirect: 'error', signal: AbortSignal.timeout(12_000),
      headers: { Origin: env.APP_ORIGIN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
    });
    requireThat(corsResponse.ok && corsResponse.headers.get('access-control-allow-origin') === env.APP_ORIGIN
      && corsResponse.headers.get('access-control-allow-methods')?.includes('POST'), 'S3 rejected the browser CORS preflight.');
    const fixture = 'Fictional legal-chat storage preflight fixture.';
    const data = new FormData();
    for (const [name, value] of Object.entries(post.fields)) data.append(name, value);
    data.append('file', new Blob([fixture], { type: 'text/plain' }), 'preflight.txt');
    let versionId;
    try {
      const upload = await fetch(post.url, {
        method: 'POST', body: data, headers: { Origin: env.APP_ORIGIN },
        redirect: 'error', signal: AbortSignal.timeout(12_000),
      });
      requireThat(upload.ok, `Presigned S3 POST returned HTTP ${upload.status}.`);
      versionId = upload.headers.get('x-amz-version-id') ?? (await send(new HeadObjectCommand(object))).VersionId;
      requireThat(versionId && versionId !== 'null', 'Upload did not produce a pinned version ID.');
      requireThat(upload.headers.get('access-control-allow-origin') === env.APP_ORIGIN, 'S3 upload response omitted the required CORS origin.');
      const read = await send(new GetObjectCommand({ ...object, VersionId: versionId }));
      requireThat(await read.Body.transformToString() === fixture, 'Version-specific S3 read did not match the fixture.');
    } finally {
      if (versionId && versionId !== 'null') await send(new DeleteObjectCommand({ ...object, VersionId: versionId }));
    }
    return `${env.S3_BUCKET} settings, CORS, signed upload and pinned read passed. Fixture removed.`;
  } finally {
    s3.destroy();
  }
}

async function waitForIndexes(collection, requireThat) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const indexes = await collection.listSearchIndexes().toArray();
    requireThat(!indexes.some(index => index.status === 'FAILED'), 'Atlas reported a failed search index build.');
    if (['text', 'vector'].every(name => indexes.some(index => index.name === name && index.queryable))) return;
    await delay(3_000);
  }
  requireThat(false, 'Atlas search indexes did not become queryable within two minutes.');
}

export async function probeAtlas(env, production, embedding, requireThat, blocked) {
  const { MongoClient } = await import('mongodb');
  const client = new MongoClient(env.MONGODB_URI, { serverSelectionTimeoutMS: 12_000, socketTimeoutMS: 15_000 });
  const db = client.db(env.MONGODB_DB_NAME);
  const namespace = `preflight_${randomUUID().replaceAll('-', '')}`;
  const collections = [];
  try {
    await client.connect();
    await db.command({ ping: 1 });
    if (production) {
      await db.listCollections({}, { nameOnly: true }).hasNext();
      return `${env.MONGODB_DB_NAME} ping and read-only database access passed.`;
    }
    if (!embedding) throw blocked('Atlas ping passed. Transaction and index probes need the measured OpenRouter embedding.');
    const first = await db.createCollection(namespace);
    collections.push(first);
    const second = await db.createCollection(`${namespace}_txn`);
    collections.push(second);
    const session = client.startSession();
    try {
      session.startTransaction();
      await first.insertOne({ _id: 'rollback' }, { session });
      await second.insertOne({ _id: 'rollback' }, { session });
      await session.abortTransaction();
    } finally {
      await session.endSession();
    }
    const rolledBack = await Promise.all(collections.map(collection => collection.countDocuments({ _id: 'rollback' })));
    requireThat(rolledBack.every(count => count === 0), 'Atlas transaction rollback verification failed.');

    const fixture = { body: 'The fictional notice period is thirty days.', version: 'allowed', generation: 'current', embedding };
    await first.insertMany([
      { ...fixture, _id: 'expected' },
      { ...fixture, _id: 'wrong-version', version: 'excluded' },
      { ...fixture, _id: 'wrong-generation', generation: 'excluded' },
    ]);
    await first.createSearchIndexes([
      { name: 'text', type: 'search', definition: { mappings: { dynamic: false, fields: {
        body: { type: 'string' }, version: { type: 'token' }, generation: { type: 'token' },
      } } } },
      { name: 'vector', type: 'vectorSearch', definition: { fields: [
        { type: 'vector', path: 'embedding', numDimensions: embedding.length, similarity: 'cosine' },
        { type: 'filter', path: 'version' }, { type: 'filter', path: 'generation' },
      ] } },
    ]);
    await waitForIndexes(first, requireThat);
    const [text, vector] = await Promise.all([
      first.aggregate([{ $search: { index: 'text', compound: {
        must: [{ text: { query: 'notice', path: 'body' } }],
        filter: [
          { equals: { path: 'version', value: 'allowed' } },
          { equals: { path: 'generation', value: 'current' } },
        ],
      } } }, { $project: { _id: 1 } }]).toArray(),
      first.aggregate([{ $vectorSearch: {
        index: 'vector', path: 'embedding', queryVector: embedding, limit: 3, numCandidates: 60,
        filter: { version: 'allowed', generation: 'current' },
      } }, { $project: { _id: 1 } }]).toArray(),
    ]);
    requireThat([text, vector].every(rows => rows.length === 1 && rows[0]._id === 'expected'),
      'Atlas text or vector results did not exclude both out-of-scope fixtures.');
    return `${env.MONGODB_DB_NAME} transaction rollback and filtered text/vector queries passed. Probe collections removed.`;
  } finally {
    const cleanup = await Promise.allSettled(collections.map(collection => collection.drop()));
    await client.close();
    requireThat(cleanup.every(result => result.status === 'fulfilled' && result.value), 'Atlas probe collection cleanup failed.');
  }
}
