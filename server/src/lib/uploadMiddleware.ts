import multer from 'multer';
import {
  AVATAR_UPLOAD_LIMIT_BYTES,
  DOCUMENT_CHUNK_UPLOAD_LIMIT_BYTES,
} from './uploadLimits';

export {
  AVATAR_UPLOAD_LIMIT_BYTES,
  DOCUMENT_CHUNK_UPLOAD_LIMIT_BYTES,
} from './uploadLimits';

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
