import api from './api';

const CHUNK_SIZE = 2 * 1024 * 1024; // 2MB

export interface UploadProgress {
  status: 'hashing' | 'uploading' | 'merging' | 'processing' | 'completed' | 'error';
  progress: number; // 0-100
  message?: string;
}

// Helper to run worker
const runHashWorker = (file: File, onProgress?: (progress: number) => void): Promise<string> => {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./hashWorker.ts', import.meta.url), { type: 'module' });

    worker.onmessage = (e) => {
      const { type, hash, progress, error } = e.data;
      if (type === 'complete') {
        resolve(hash);
        worker.terminate();
      } else if (type === 'progress') {
        onProgress?.(progress);
      } else if (type === 'error') {
        reject(new Error(error));
        worker.terminate();
      }
    };

    worker.onerror = (err) => {
      reject(err);
      worker.terminate();
    };

    worker.postMessage(file);
  });
};

export const uploadFile = async (
  file: File,
  onProgress: (progress: UploadProgress) => void
) => {
  try {
    // 1. Hash (Web Worker)
    onProgress({ status: 'hashing', progress: 0 });
    const hash = await runHashWorker(file, (p) => {
      onProgress({ status: 'hashing', progress: p });
    });
    onProgress({ status: 'hashing', progress: 100 });

    // 2. Check
    const { data: checkData } = await api.post('/upload/check', {
      hash,
      filename: file.name
    });

    if (checkData.exists) {
      onProgress({ status: 'completed', progress: 100, message: 'File already exists (Instant Upload)' });
      return;
    }

    // 3. Init
    let uploadId = checkData.fileId;
    const uploadedChunks = checkData.uploadedChunks || [];

    if (!uploadId) {
      const { data: initData } = await api.post('/upload/init', {
        filename: file.name,
        hash,
        size: file.size,
        type: file.type
      });
      uploadId = initData.uploadId;
    }

    // 4. Chunk Upload
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
    const chunksToUpload = [];

    for (let i = 0; i < totalChunks; i++) {
      if (!uploadedChunks.includes(i)) {
        chunksToUpload.push(i);
      }
    }

    // Initial progress if resuming
    let completedChunks = uploadedChunks.length;
    const initialProgress = Math.round((completedChunks / totalChunks) * 100);
    
    onProgress({ 
      status: 'uploading', 
      progress: initialProgress,
      message: uploadedChunks.length > 0 ? `Resuming upload (${uploadedChunks.length}/${totalChunks} chunks)...` : undefined
    });

    // Concurrency limit
    const CONCURRENCY = 3;

    // If no chunks to upload, skip
    if (chunksToUpload.length > 0) {
      const uploadChunk = async (chunkIndex: number) => {
        const start = chunkIndex * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, file.size);
        const chunk = file.slice(start, end);

        const formData = new FormData();
        formData.append('chunk', chunk);
        formData.append('uploadId', uploadId);
        formData.append('chunkIndex', chunkIndex.toString());
        formData.append('hash', hash);

        await api.post('/upload/chunk', formData, {
          headers: {
            'Content-Type': 'multipart/form-data',
          },
        });
        completedChunks++;
        const percent = Math.round((completedChunks / totalChunks) * 100);
        onProgress({ status: 'uploading', progress: percent });
      };

      // Execute with concurrency
      for (let i = 0; i < chunksToUpload.length; i += CONCURRENCY) {
        const batch = chunksToUpload.slice(i, i + CONCURRENCY);
        await Promise.all(batch.map(uploadChunk));
      }
    }

    // 5. Merge
    onProgress({ status: 'merging', progress: 0 });
    await api.post('/upload/merge', {
      uploadId,
      filename: file.name,
      hash,
      totalChunks
    });

    onProgress({ status: 'processing', progress: 0, message: 'Queued for processing...' });

  } catch (err: unknown) {
    console.error('Upload failed:', err);
    const message = err instanceof Error ? err.message : 'Upload failed';
    onProgress({ status: 'error', progress: 0, message });
    throw err;
  }
};
