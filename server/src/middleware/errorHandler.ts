import { ErrorRequestHandler } from 'express';
import { toSafeError } from '../lib/safeError';

type HttpError = Error & {
  status?: unknown;
  statusCode?: unknown;
};

const isError = (error: unknown): error is Error => error instanceof Error;

const isCorsError = (error: unknown) => isError(error) && error.message === 'Not allowed by CORS';

const toValidStatusCode = (value: unknown): number | null => {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null;
  return value >= 400 && value < 600 ? value : null;
};

const getStatusCode = (error: unknown): number => {
  if (isCorsError(error)) return 403;

  const httpError = error as HttpError;
  return toValidStatusCode(httpError.statusCode) ?? toValidStatusCode(httpError.status) ?? 500;
};

const getErrorMessage = (error: unknown, statusCode: number): string => {
  if (isCorsError(error)) return 'Origin is not allowed';
  if (statusCode >= 500) return 'Internal server error';
  if (statusCode === 400) return 'Bad request';
  if (statusCode === 401) return 'Unauthorized';
  if (statusCode === 403) return 'Forbidden';
  if (statusCode === 404) return 'Route not found';
  if (statusCode === 409) return 'Conflict';
  if (statusCode === 413) return 'Request body too large';
  if (statusCode === 422) return 'Unprocessable request';
  if (statusCode === 429) return 'Too many requests';
  return 'Request failed';
};

export const errorHandlerMiddleware: ErrorRequestHandler = (error, _req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }

  const statusCode = getStatusCode(error);
  const requestId = typeof res.locals.requestId === 'string' ? res.locals.requestId : undefined;

  console.error(JSON.stringify({
    event: 'http_error',
    request_id: requestId,
    status_code: statusCode,
    error: toSafeError(error, requestId),
  }));

  res.status(statusCode).json({
    error: getErrorMessage(error, statusCode),
    requestId,
  });
};
