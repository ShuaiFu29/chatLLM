import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'crypto';
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
  `users/${userId}/avatars/${randomUUID()}-${sanitizeFilename(filename)}`;

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

export const createMultipartObjectUpload = async (
  key: string,
  contentType = 'application/octet-stream',
  metadata?: Record<string, string>
) => {
  await ensureBucket();

  const response = await s3.send(new CreateMultipartUploadCommand({
    Bucket: S3_BUCKET,
    Key: key,
    ContentType: contentType,
    Metadata: metadata,
  }));

  if (!response.UploadId) {
    throw new Error('Storage did not return a multipart upload id');
  }

  return response.UploadId;
};

export const presignMultipartUploadParts = async (
  key: string,
  uploadId: string,
  partNumbers: number[],
  expiresIn: number,
  reservation: { partSize: number; fileSize: number }
) => {
  await ensureBucket();

  return Promise.all(partNumbers.map(async (partNumber) => {
    const partOffset = (partNumber - 1) * reservation.partSize;
    const contentLength = Math.min(reservation.partSize, reservation.fileSize - partOffset);
    if (!Number.isSafeInteger(contentLength) || contentLength <= 0) {
      throw new Error('Multipart part exceeds reserved object size');
    }

    return {
      partNumber,
      url: await getSignedUrl(
        s3,
        new UploadPartCommand({
          Bucket: S3_BUCKET,
          Key: key,
          UploadId: uploadId,
          PartNumber: partNumber,
          ContentLength: contentLength,
        }),
        { expiresIn }
      ),
    };
  }));
};

export interface MultipartObjectPart {
  partNumber: number;
  etag: string;
  size?: number;
}

export const listMultipartObjectParts = async (
  key: string,
  uploadId: string
): Promise<MultipartObjectPart[]> => {
  await ensureBucket();

  const parts: MultipartObjectPart[] = [];
  let partNumberMarker: string | undefined;

  do {
    const response = await s3.send(new ListPartsCommand({
      Bucket: S3_BUCKET,
      Key: key,
      UploadId: uploadId,
      PartNumberMarker: partNumberMarker,
    }));

    for (const part of response.Parts || []) {
      if (part.PartNumber && part.ETag) {
        parts.push({
          partNumber: part.PartNumber,
          etag: part.ETag,
          size: part.Size,
        });
      }
    }

    partNumberMarker = response.IsTruncated
      ? response.NextPartNumberMarker?.toString()
      : undefined;
  } while (partNumberMarker);

  return parts.sort((a, b) => a.partNumber - b.partNumber);
};

export const completeMultipartObjectUpload = async (
  key: string,
  uploadId: string,
  parts: MultipartObjectPart[]
) => {
  await ensureBucket();

  await s3.send(new CompleteMultipartUploadCommand({
    Bucket: S3_BUCKET,
    Key: key,
    UploadId: uploadId,
    MultipartUpload: {
      Parts: parts.map((part) => ({
        PartNumber: part.partNumber,
        ETag: part.etag,
      })),
    },
  }));
};

export const abortMultipartObjectUpload = async (
  key: string,
  uploadId: string
) => {
  await ensureBucket();

  await s3.send(new AbortMultipartUploadCommand({
    Bucket: S3_BUCKET,
    Key: key,
    UploadId: uploadId,
  }));
};

export const headObjectMetadata = async (key: string) => {
  await ensureBucket();
  const response = await s3.send(new HeadObjectCommand({
    Bucket: S3_BUCKET,
    Key: key,
  }));

  if (!Number.isSafeInteger(response.ContentLength) || Number(response.ContentLength) < 0) {
    throw new Error('Storage did not return a valid object size');
  }

  return {
    size: Number(response.ContentLength),
    metadata: response.Metadata || {},
  };
};

interface StorageServiceError {
  name?: unknown;
  code?: unknown;
  Code?: unknown;
  $metadata?: { httpStatusCode?: unknown };
}

const readStorageErrorCodes = (error: unknown) => {
  if (!error || typeof error !== 'object') return [];
  const candidate = error as StorageServiceError;
  return [candidate.name, candidate.code, candidate.Code]
    .filter((value): value is string => typeof value === 'string' && Boolean(value));
};

export const isObjectNotFoundError = (error: unknown) => {
  const codes = readStorageErrorCodes(error);
  if (codes.includes('NotFound') || codes.includes('NoSuchKey')) return true;
  if (!error || typeof error !== 'object') return false;
  return (error as StorageServiceError).$metadata?.httpStatusCode === 404;
};

export const isMultipartUploadMissingError = (error: unknown) => (
  readStorageErrorCodes(error).includes('NoSuchUpload')
);

export const isStorageClientError = (error: unknown) => {
  if (!error || typeof error !== 'object') return false;
  const status = (error as StorageServiceError).$metadata?.httpStatusCode;
  return typeof status === 'number' && status >= 400 && status < 500;
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
