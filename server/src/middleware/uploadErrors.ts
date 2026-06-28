import { ErrorRequestHandler } from 'express';
import multer from 'multer';

export const handleUploadError: ErrorRequestHandler = (err, _req, res, next) => {
  if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
    res.status(413).json({ error: 'Uploaded file is too large' });
    return;
  }

  next(err);
};
