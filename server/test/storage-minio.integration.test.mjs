import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const integrationEnabled = process.env.MINIO_MULTIPART_INTEGRATION === '1'
  && Boolean(process.env.S3_ENDPOINT);

test('MinIO multipart completion is verifiable and duplicate completion is classified as missing', {
  skip: integrationEnabled ? false : 'set MINIO_MULTIPART_INTEGRATION=1 and S3 configuration to run',
}, async () => {
  const storage = await import(pathToFileURL(path.join(serverRoot, 'dist', 'lib', 'storage.js')).href);
  const key = `audit-multipart/${randomUUID()}.md`;
  const body = Buffer.from('chatllm multipart integration marker', 'utf8');
  const hash = createHash('sha256').update(body).digest('hex');
  const uploadId = await storage.createMultipartObjectUpload(key, 'text/markdown', {
    sha256: hash,
    file_size: String(body.length),
  });

  try {
    const [part] = await storage.presignMultipartUploadParts(
      key,
      uploadId,
      [1],
      60,
      { partSize: 5 * 1024 * 1024, fileSize: body.length },
    );
    const uploadResponse = await fetch(part.url, {
      method: 'PUT',
      headers: { 'content-length': String(body.length) },
      body,
    });
    assert.equal(uploadResponse.ok, true, await uploadResponse.text());
    const etag = uploadResponse.headers.get('etag');
    assert.ok(etag);

    const listedParts = await storage.listMultipartObjectParts(key, uploadId);
    assert.deepEqual(listedParts.map((item) => item.partNumber), [1]);
    await storage.completeMultipartObjectUpload(key, uploadId, [{ partNumber: 1, etag }]);

    const stored = await storage.headObjectMetadata(key);
    assert.equal(stored.size, body.length);
    assert.equal(stored.metadata.sha256, hash);
    assert.equal(stored.metadata.file_size, String(body.length));

    await assert.rejects(
      storage.completeMultipartObjectUpload(key, uploadId, [{ partNumber: 1, etag }]),
      (error) => storage.isMultipartUploadMissingError(error),
    );
  } finally {
    await storage.deleteObject(key).catch(() => undefined);
    await storage.abortMultipartObjectUpload(key, uploadId).catch(() => undefined);
  }
});
