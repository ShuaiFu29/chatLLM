import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
} from '@nestjs/common';
import { FastifyReply } from 'fastify';
import { HttpValidationError } from '../../lib/validation';
import { toSafeError } from '../../lib/safeError';
import { AppRequest } from '../http/app-request';

type StatusError = Error & {
  code?: unknown;
  status?: unknown;
  statusCode?: unknown;
};

const toValidStatusCode = (value: unknown): number | null => (
  typeof value === 'number'
  && Number.isInteger(value)
  && value >= 400
  && value < 600
    ? value
    : null
);

const getStatusCode = (error: unknown) => {
  if (error instanceof HttpValidationError) return 400;
  if (error instanceof HttpException) return error.getStatus();

  const statusError = error as StatusError;
  if (statusError?.code === 'FST_REQ_FILE_TOO_LARGE') return 413;
  if (statusError?.message === 'Not allowed by CORS') return 403;
  return toValidStatusCode(statusError?.statusCode)
    ?? toValidStatusCode(statusError?.status)
    ?? 500;
};

const getDefaultMessage = (error: unknown, statusCode: number) => {
  if ((error as StatusError)?.message === 'Not allowed by CORS') return 'Origin is not allowed';
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

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const http = host.switchToHttp();
    const request = http.getRequest<AppRequest>();
    const reply = http.getResponse<FastifyReply>();

    if (reply.sent || reply.raw.headersSent) return;

    if (error instanceof HttpValidationError) {
      reply.code(400).send({ error: 'Invalid request', code: 'validation_error' });
      return;
    }

    const statusCode = getStatusCode(error);
    const requestId = request.requestId;
    const httpResponse = error instanceof HttpException ? error.getResponse() : null;
    const explicitBody = typeof httpResponse === 'object' && httpResponse !== null
      ? httpResponse as Record<string, unknown>
      : null;

    console.error(JSON.stringify({
      event: 'http_error',
      request_id: requestId,
      status_code: statusCode,
      error: toSafeError(error, requestId),
    }));

    if (explicitBody?.error && typeof explicitBody.error === 'string') {
      reply.code(statusCode).send(explicitBody);
      return;
    }

    reply.code(statusCode).send({
      error: getDefaultMessage(error, statusCode),
      requestId,
    });
  }
}
