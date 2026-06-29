import { RequestHandler } from 'express';

type NotFoundError = Error & {
  statusCode: number;
};

export const notFoundMiddleware: RequestHandler = (_req, _res, next) => {
  const error = new Error('Route not found') as NotFoundError;
  error.statusCode = 404;
  next(error);
};
