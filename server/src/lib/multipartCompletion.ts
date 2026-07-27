export class MultipartCompletionIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MultipartCompletionIntegrityError';
  }
}

export const assertCompletedMultipartObject = (
  object: { size: number; metadata: Record<string, string | undefined> },
  upload: { file_hash: string; file_size?: number | string | null }
) => {
  const expectedSize = Number(upload.file_size);
  const expectedHash = String(upload.file_hash || '').toLowerCase();
  const metadataHash = object.metadata.sha256?.toLowerCase();
  const metadataSize = Number(object.metadata.size);

  if (!Number.isSafeInteger(expectedSize) || object.size !== expectedSize) {
    throw new MultipartCompletionIntegrityError(
      `Completed multipart object size mismatch: expected ${expectedSize}, got ${object.size}`
    );
  }
  if (metadataHash !== expectedHash) {
    throw new MultipartCompletionIntegrityError('Completed multipart object hash metadata mismatch');
  }
  if (!Number.isSafeInteger(metadataSize) || metadataSize !== expectedSize) {
    throw new MultipartCompletionIntegrityError('Completed multipart object size metadata mismatch');
  }

  return object.size;
};
