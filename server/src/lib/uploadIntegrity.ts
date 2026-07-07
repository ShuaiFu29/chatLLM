import { createHash } from 'crypto';
import fs from 'fs';

export interface UploadDigest {
  hash: string;
  size: number;
}

export interface UploadIntegrityExpectation {
  expectedHash?: string | null;
  expectedSize?: number | string | null;
}

export const computeFileSha256 = (filePath: string): Promise<UploadDigest> => (
  new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    let size = 0;
    const stream = fs.createReadStream(filePath);

    stream.on('data', (chunk: Buffer) => {
      size += chunk.length;
      hash.update(chunk);
    });
    stream.on('error', reject);
    stream.on('end', () => {
      resolve({
        hash: hash.digest('hex'),
        size,
      });
    });
  })
);

export const verifyMergedUploadFile = async (
  filePath: string,
  expectation: UploadIntegrityExpectation
) => {
  const digest = await computeFileSha256(filePath);
  const expectedHash = expectation.expectedHash?.trim().toLowerCase();
  const expectedSize = expectation.expectedSize === undefined || expectation.expectedSize === null
    ? null
    : Number(expectation.expectedSize);

  if (expectedHash && digest.hash !== expectedHash) {
    throw new Error(`Merged upload hash mismatch: expected ${expectedHash}, got ${digest.hash}`);
  }

  if (Number.isFinite(expectedSize) && expectedSize !== null && digest.size !== expectedSize) {
    throw new Error(`Merged upload size mismatch: expected ${expectedSize}, got ${digest.size}`);
  }

  return digest;
};
