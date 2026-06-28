import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import fs from 'fs-extra';
import path from 'path';
import { Readable } from 'stream';
import { serverEnv } from './env';

export const S3_BUCKET = serverEnv.S3_BUCKET;

export const s3 = new S3Client({
  endpoint: serverEnv.S3_ENDPOINT,
  region: serverEnv.S3_REGION,
  forcePathStyle: serverEnv.S3_FORCE_PATH_STYLE,
  credentials: {
    accessKeyId: serverEnv.S3_ACCESS_KEY,
    secretAccessKey: serverEnv.S3_SECRET_KEY,
  },
});

let bucketReady: Promise<void> | null = null;

export const ensureBucket = async () => {
  if (bucketReady) return bucketReady;

  bucketReady = (async () => {
    try {
      await s3.send(new HeadBucketCommand({ Bucket: S3_BUCKET }));
    } catch {
      await s3.send(new CreateBucketCommand({ Bucket: S3_BUCKET }));
    }
  })();

  return bucketReady;
};

export const sanitizeFilename = (filename: string) =>
  path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_');

export const buildDocumentKey = (userId: string, fileId: string, filename: string) =>
  `users/${userId}/files/${fileId}/${sanitizeFilename(filename)}`;

export const buildAvatarKey = (userId: string, filename: string) =>
  `users/${userId}/avatars/${Date.now()}-${sanitizeFilename(filename)}`;

export const uploadFilePath = async (
  key: string,
  filePath: string,
  contentType = 'application/octet-stream'
) => {
  await ensureBucket();

  const upload = new Upload({
    client: s3,
    params: {
      Bucket: S3_BUCKET,
      Key: key,
      Body: fs.createReadStream(filePath),
      ContentType: contentType,
    },
  });

  await upload.done();
};

export const uploadBuffer = async (
  key: string,
  buffer: Buffer,
  contentType = 'application/octet-stream'
) => {
  await ensureBucket();

  await s3.send(new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: key,
    Body: buffer,
    ContentType: contentType,
  }));
};

export const deleteObject = async (key?: string | null) => {
  if (!key) return;
  await ensureBucket();
  await s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: key }));
};

export const getObjectStream = async (key: string) => {
  await ensureBucket();
  const response = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }));
  return {
    stream: response.Body as Readable,
    contentType: response.ContentType,
  };
};

export const getObjectBuffer = async (key: string) => {
  const { stream } = await getObjectStream(key);
  const chunks: Buffer[] = [];

  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
};

export const getPresignedUrl = async (key: string, expiresIn = 60 * 5) => {
  await ensureBucket();
  return getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }),
    { expiresIn }
  );
};
