import { S3Client, CreateBucketCommand, HeadBucketCommand, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import type { Readable } from 'node:stream';
import { config } from './config.js';

export const s3 = new S3Client({
  endpoint: config.s3.endpoint,
  region: config.s3.region,
  forcePathStyle: true,
  credentials: { accessKeyId: config.s3.accessKey, secretAccessKey: config.s3.secretKey },
});

export async function ensureBucket(log: (m: string) => void) {
  for (let attempt = 1; ; attempt++) {
    try {
      await s3.send(new HeadBucketCommand({ Bucket: config.s3.bucket }));
      return;
    } catch (e: any) {
      const status = e?.$metadata?.httpStatusCode;
      if (status === 404) {
        await s3.send(new CreateBucketCommand({ Bucket: config.s3.bucket }));
        log(`created bucket ${config.s3.bucket}`);
        return;
      }
      if (attempt >= 30) throw e;
      log(`waiting for object storage (${e?.name ?? e})`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

export async function putObject(key: string, body: Buffer, contentType: string) {
  await s3.send(new PutObjectCommand({ Bucket: config.s3.bucket, Key: key, Body: body, ContentType: contentType }));
}

export async function getObject(key: string) {
  const r = await s3.send(new GetObjectCommand({ Bucket: config.s3.bucket, Key: key }));
  return r.Body as Readable;
}

export async function deleteObject(key: string) {
  await s3.send(new DeleteObjectCommand({ Bucket: config.s3.bucket, Key: key }));
}

export async function storageHealthy() {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: config.s3.bucket }));
    return true;
  } catch {
    return false;
  }
}
