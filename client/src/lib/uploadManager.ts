import api from './api';
import { toSafeError } from './safeError';

const CHUNK_SIZE = 2 * 1024 * 1024; // 2MB
const DIRECT_UPLOAD_CONCURRENCY = 4;
const PRESIGN_BATCH_SIZE = 100;
const MARKDOWN_EXTENSIONS = ['.md', '.markdown'];

export interface UploadProgress {
  status: 'hashing' | 'uploading' | 'merging' | 'processing' | 'completed' | 'error';
  progress: number; // 0-100
  message?: string;
}

export const isSupportedMarkdownDocument = (file: File | { name: string }) => {
  const normalizedName = file.name.trim().toLowerCase();
  return MARKDOWN_EXTENSIONS.some((extension) => normalizedName.endsWith(extension));
};

interface UploadCheckResponse {
  exists?: boolean;
  fileId?: string;
  uploadedChunks?: number[];
  uploadStrategy?: 'direct-multipart' | 'legacy-chunks';
  multipart?: MultipartUploadSession | null;
}

interface MultipartUploadSession {
  uploadId: string;
  partSize: number;
  totalParts: number;
  uploadedPartNumbers?: number[];
  expiresAt?: string;
}

interface MultipartPartUrl {
  partNumber: number;
  url: string;
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

const isEndpointMissing = (error: unknown) => {
  const maybeStatus = (error as { response?: { status?: number } })?.response?.status;
  return maybeStatus === 404 || maybeStatus === 405;
};

const uploadBlobToPresignedUrl = (
  url: string,
  blob: Blob,
  onProgress?: (loaded: number) => void
) => new Promise<void>((resolve, reject) => {
  const xhr = new XMLHttpRequest();
  xhr.open('PUT', url);

  xhr.upload.onprogress = (event) => {
    if (event.lengthComputable) {
      onProgress?.(event.loaded);
    }
  };

  xhr.onload = () => {
    if (xhr.status >= 200 && xhr.status < 300) {
      onProgress?.(blob.size);
      resolve();
      return;
    }
    reject(new Error(`Part upload failed with status ${xhr.status}`));
  };

  xhr.onerror = () => reject(new Error('Part upload failed. Check MinIO CORS and network connectivity.'));
  xhr.onabort = () => reject(new Error('Part upload was aborted'));
  xhr.send(blob);
});

const getPartSize = (file: File, partNumber: number, partSize: number, totalParts: number) => {
  if (partNumber < totalParts) return partSize;
  return file.size - ((partNumber - 1) * partSize);
};

const uploadWithDirectMultipart = async (
  file: File,
  hash: string,
  checkData: UploadCheckResponse,
  onProgress: (progress: UploadProgress) => void,
  options?: { projectSpaceId?: string | null }
) => {
  let session = checkData.multipart || null;

  if (!session) {
    const { data } = await api.post('/upload/multipart/init', {
      filename: file.name,
      hash,
      size: file.size,
      type: file.type,
      project_space_id: options?.projectSpaceId || undefined
    });

    if (data.exists) {
      onProgress({ status: 'completed', progress: 100, message: 'File already exists (Instant Upload)' });
      return;
    }

    session = {
      uploadId: data.uploadId,
      partSize: data.partSize,
      totalParts: data.totalParts,
      uploadedPartNumbers: data.uploadedPartNumbers || [],
      expiresAt: data.expiresAt,
    };
  }

  const uploadedPartNumbers = new Set(session.uploadedPartNumbers || []);
  const partsToUpload: number[] = [];
  for (let partNumber = 1; partNumber <= session.totalParts; partNumber += 1) {
    if (!uploadedPartNumbers.has(partNumber)) {
      partsToUpload.push(partNumber);
    }
  }

  let completedBytes = Array.from(uploadedPartNumbers).reduce((sum, partNumber) => (
    sum + getPartSize(file, partNumber, session.partSize, session.totalParts)
  ), 0);
  const inFlightBytes = new Map<number, number>();

  const reportProgress = (message?: string) => {
    const activeBytes = Array.from(inFlightBytes.values()).reduce((sum, value) => sum + value, 0);
    const percent = Math.min(100, Math.round(((completedBytes + activeBytes) / file.size) * 100));
    onProgress({ status: 'uploading', progress: percent, message });
  };

  reportProgress(uploadedPartNumbers.size > 0
    ? `Resuming direct upload (${uploadedPartNumbers.size}/${session.totalParts} parts)...`
    : 'Uploading directly to object storage...');

  for (let batchStart = 0; batchStart < partsToUpload.length; batchStart += PRESIGN_BATCH_SIZE) {
    const partBatch = partsToUpload.slice(batchStart, batchStart + PRESIGN_BATCH_SIZE);
    const { data } = await api.post('/upload/multipart/parts', {
      uploadId: session.uploadId,
      partNumbers: partBatch,
    });
    const urls = new Map<number, string>(
      (data.parts as MultipartPartUrl[]).map((part) => [part.partNumber, part.url])
    );

    for (let index = 0; index < partBatch.length; index += DIRECT_UPLOAD_CONCURRENCY) {
      const concurrentParts = partBatch.slice(index, index + DIRECT_UPLOAD_CONCURRENCY);
      await Promise.all(concurrentParts.map(async (partNumber) => {
        const url = urls.get(partNumber);
        if (!url) throw new Error(`Missing upload URL for part ${partNumber}`);

        const start = (partNumber - 1) * session.partSize;
        const end = Math.min(start + session.partSize, file.size);
        const blob = file.slice(start, end);

        await uploadBlobToPresignedUrl(url, blob, (loaded) => {
          inFlightBytes.set(partNumber, loaded);
          reportProgress();
        });

        inFlightBytes.delete(partNumber);
        completedBytes += blob.size;
        reportProgress();
      }));
    }
  }

  onProgress({ status: 'merging', progress: 0, message: 'Finalizing object storage upload...' });
  await api.post('/upload/multipart/complete', {
    uploadId: session.uploadId,
  });

  onProgress({ status: 'processing', progress: 0, message: 'Queued for processing...' });
};

const uploadWithLegacyChunks = async (
  file: File,
  hash: string,
  checkData: UploadCheckResponse,
  onProgress: (progress: UploadProgress) => void,
  options?: { projectSpaceId?: string | null }
) => {
  let uploadId = checkData.fileId;
  const uploadedChunks = checkData.uploadedChunks || [];

  if (!uploadId) {
    const { data: initData } = await api.post('/upload/init', {
      filename: file.name,
      hash,
      size: file.size,
      type: file.type,
      project_space_id: options?.projectSpaceId || undefined
    });
    uploadId = initData.uploadId;
  }

  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
  const chunksToUpload = [];

  for (let i = 0; i < totalChunks; i++) {
    if (!uploadedChunks.includes(i)) {
      chunksToUpload.push(i);
    }
  }

  let completedChunks = uploadedChunks.length;
  const initialProgress = Math.round((completedChunks / totalChunks) * 100);

  onProgress({
    status: 'uploading',
    progress: initialProgress,
    message: uploadedChunks.length > 0 ? `Resuming upload (${uploadedChunks.length}/${totalChunks} chunks)...` : undefined
  });

  const CONCURRENCY = 3;

  if (chunksToUpload.length > 0) {
    const uploadChunk = async (chunkIndex: number) => {
      const start = chunkIndex * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, file.size);
      const chunk = file.slice(start, end);

      const formData = new FormData();
      formData.append('chunk', chunk);
      formData.append('uploadId', uploadId || '');
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

    for (let i = 0; i < chunksToUpload.length; i += CONCURRENCY) {
      const batch = chunksToUpload.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map(uploadChunk));
    }
  }

  onProgress({ status: 'merging', progress: 0 });
  await api.post('/upload/merge', {
    uploadId,
    filename: file.name,
    hash,
    totalChunks
  });

  onProgress({ status: 'processing', progress: 0, message: 'Queued for processing...' });
};

export const uploadFile = async (
  file: File,
  onProgress: (progress: UploadProgress) => void,
  options?: { projectSpaceId?: string | null }
) => {
  try {
    if (!isSupportedMarkdownDocument(file)) {
      throw new Error('Only Markdown files (.md, .markdown) are supported');
    }

    // 1. Hash (Web Worker)
    onProgress({ status: 'hashing', progress: 0 });
    const hash = await runHashWorker(file, (p) => {
      onProgress({ status: 'hashing', progress: p });
    });
    onProgress({ status: 'hashing', progress: 100 });

    // 2. Check
    const { data: checkData } = await api.post<UploadCheckResponse>('/upload/check', {
      hash,
      filename: file.name,
      project_space_id: options?.projectSpaceId || undefined
    });

    if (checkData.exists) {
      onProgress({ status: 'completed', progress: 100, message: 'File already exists (Instant Upload)' });
      return;
    }

    if (checkData.multipart || checkData.uploadStrategy === 'direct-multipart') {
      await uploadWithDirectMultipart(file, hash, checkData, onProgress, options);
      return;
    }

    try {
      await uploadWithDirectMultipart(file, hash, checkData, onProgress, options);
    } catch (directUploadError) {
      if (!isEndpointMissing(directUploadError)) throw directUploadError;
      await uploadWithLegacyChunks(file, hash, checkData, onProgress, options);
    }

  } catch (err: unknown) {
    console.error('Upload failed:', toSafeError(err));
    onProgress({ status: 'error', progress: 0, message: 'Upload failed' });
    throw err;
  }
};
