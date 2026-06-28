import multer from 'multer';

export const DOCUMENT_CHUNK_UPLOAD_LIMIT_BYTES = 2 * 1024 * 1024;
export const AVATAR_UPLOAD_LIMIT_BYTES = 5 * 1024 * 1024;

const memoryStorage = multer.memoryStorage();

export const chunkUpload = multer({
  storage: memoryStorage,
  limits: {
    fileSize: DOCUMENT_CHUNK_UPLOAD_LIMIT_BYTES,
  },
});

export const avatarUpload = multer({
  storage: memoryStorage,
  limits: {
    fileSize: AVATAR_UPLOAD_LIMIT_BYTES,
  },
});
