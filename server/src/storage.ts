import { createHash } from 'node:crypto';
import { S3Client, GetBucketVersioningCommand, GetPublicAccessBlockCommand, GetBucketCorsCommand,
  HeadObjectCommand, GetObjectCommand, ListObjectVersionsCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import type { Config } from './config.ts';

export const maxOriginalBytes = 5 * 1024 * 1024;
export type Original = { versionId: string; size: number; mime: string; hash: string; uploadedAt: Date; bytes: Uint8Array };
export interface Storage {
  verify(origin: string): Promise<void>;
  form(key: string, mime: string, uploadId: string, seconds: number): Promise<{ url: string; fields: Record<string, string> }>;
  original(key: string, versionId?: string): Promise<Original | null>;
  versions(key: string): Promise<string[]>;
  remove(key: string, versionId: string): Promise<void>;
}
let testStorage: Storage | undefined;
let offset = 0;
export const uploadNow = () => new Date(Date.now() + offset);
export function setTestStorage(storage: Storage, clockOffset = 0) {
  if (process.env.NODE_ENV !== 'test') throw new Error('Storage injection requires test execution.');
  testStorage = storage;
  offset = clockOffset;
}
export function advanceTestUploadClock(milliseconds: number) {
  if (process.env.NODE_ENV !== 'test' || !Number.isSafeInteger(milliseconds) || milliseconds < 0) throw new Error('Invalid test clock.');
  offset += milliseconds;
}
export function createStorage(config: Config): Storage | undefined {
  if (testStorage) return testStorage;
  if (!config.storage) return undefined;
  const { region, bucket, credentials } = config.storage;
  const client = new S3Client({ region, credentials, maxAttempts: 2 });
  const send = <T>(command: T) => client.send(command as never, { abortSignal: AbortSignal.timeout(15000) }) as Promise<any>;
  return {
    async verify(origin) {
      const [versioning, access, cors] = await Promise.all([
        send(new GetBucketVersioningCommand({ Bucket: bucket })),
        send(new GetPublicAccessBlockCommand({ Bucket: bucket })),
        send(new GetBucketCorsCommand({ Bucket: bucket })),
      ]);
      const block = access.PublicAccessBlockConfiguration;
      if (versioning.Status !== 'Enabled' || !block?.BlockPublicAcls || !block.IgnorePublicAcls
        || !block.BlockPublicPolicy || !block.RestrictPublicBuckets
        || !cors.CORSRules?.some((rule: { AllowedOrigins?: string[]; AllowedMethods?: string[] }) =>
          rule.AllowedOrigins?.includes(origin) && rule.AllowedMethods?.includes('POST') && rule.AllowedMethods?.includes('GET'))) {
        throw new Error('Private versioned bucket and exact-origin CORS required.');
      }
    },
    form(key, mime, uploadId, seconds) {
      return createPresignedPost(client, { Bucket: bucket, Key: key, Expires: seconds,
        Fields: { 'Content-Type': mime, 'x-amz-meta-upload-id': uploadId },
        Conditions: [['content-length-range', 1, maxOriginalBytes], ['eq', '$Content-Type', mime], ['eq', '$x-amz-meta-upload-id', uploadId]],
      });
    },
    async original(key, versionId) {
      let metadata;
      try { metadata = await send(new HeadObjectCommand({ Bucket: bucket, Key: key, ...(versionId ? { VersionId: versionId } : {}) })); }
      catch (error) {
        if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return null;
        throw error;
      }
      const pinned = metadata.VersionId;
      if (!pinned || pinned === 'null' || !metadata.ContentLength || metadata.ContentLength > maxOriginalBytes) throw new Error('Invalid original metadata.');
      const read = await send(new GetObjectCommand({ Bucket: bucket, Key: key, VersionId: pinned }));
      const chunks: Uint8Array[] = [];
      let total = 0;
      for await (const chunk of read.Body) {
        total += chunk.length;
        if (total > maxOriginalBytes) { read.Body.destroy(); throw new Error('Original too large.'); }
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks);
      if (bytes.length !== metadata.ContentLength) throw new Error('Original size mismatch.');
      return { versionId: pinned, size: bytes.length, mime: metadata.ContentType,
        hash: createHash('sha256').update(bytes).digest('hex'), uploadedAt: metadata.LastModified, bytes };
    },
    async versions(key) {
      const versions: string[] = [];
      let KeyMarker: string | undefined, VersionIdMarker: string | undefined;
      do {
        const page = await send(new ListObjectVersionsCommand({ Bucket: bucket, Prefix: key, KeyMarker, VersionIdMarker }));
        for (const item of [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])]) {
          if (item.Key === key && item.VersionId && item.VersionId !== 'null') versions.push(item.VersionId);
        }
        KeyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
        VersionIdMarker = page.IsTruncated ? page.NextVersionIdMarker : undefined;
      } while (KeyMarker);
      return versions;
    },
    async remove(key, versionId) { await send(new DeleteObjectCommand({ Bucket: bucket, Key: key, VersionId: versionId })); },
  };
}
