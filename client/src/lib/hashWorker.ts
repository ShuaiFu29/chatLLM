import { Sha256 } from '@aws-crypto/sha256-browser';

const HASH_CHUNK_SIZE = 2 * 1024 * 1024;
const byteToHex = (byte: number) => byte.toString(16).padStart(2, '0');

const digestToHex = (digest: ArrayBuffer | Uint8Array) => (
  Array.from(digest instanceof Uint8Array ? digest : new Uint8Array(digest), byteToHex).join('')
);

self.onmessage = async (event: MessageEvent<File>) => {
  try {
    const file = event.data;
    const hasher = new Sha256();
    const totalChunks = Math.max(1, Math.ceil(file.size / HASH_CHUNK_SIZE));
    self.postMessage({ type: 'progress', progress: 0 });

    for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex += 1) {
      const start = chunkIndex * HASH_CHUNK_SIZE;
      const end = Math.min(start + HASH_CHUNK_SIZE, file.size);
      const buffer = await file.slice(start, end).arrayBuffer();
      hasher.update(new Uint8Array(buffer));

      const progress = Math.min(99, Math.round(((chunkIndex + 1) / totalChunks) * 100));
      self.postMessage({ type: 'progress', progress });
    }

    const digest = await hasher.digest();
    const hash = digestToHex(digest);

    if (hash.length !== 64) {
      throw new Error('SHA-256 digest length is invalid');
    }

    self.postMessage({ type: 'complete', hash });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Hashing failed';
    self.postMessage({ type: 'error', error: message });
  }
};
