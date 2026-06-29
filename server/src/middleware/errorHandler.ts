import { ErrorRequestHandler } from 'express';

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
  if (statusCode >= 500 && process.env.NODE_ENV === 'production') return 'Internal server error';
  if (isError(error) && error.message) return error.message;
  return 'Internal server error';
};

export const errorHandlerMiddleware: ErrorRequestHandler = (error, _req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }

  const statusCode = getStatusCode(error);
  const requestId = typeof res.locals.requestId === 'string' ? res.locals.requestId : undefined;
  const shouldLogStack = statusCode >= 500 && process.env.NODE_ENV !== 'production' && isError(error);

  console.error(JSON.stringify({
    event: 'http_error',
    request_id: requestId,
    status_code: statusCode,
    message: isError(error) ? error.message : String(error),
    stack: shouldLogStack ? error.stack : undefined,
  }));

  res.status(statusCode).json({
    error: getErrorMessage(error, statusCode),
    requestId,
  });
};
