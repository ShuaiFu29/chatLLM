import { NextFunction, Request, RequestHandler, Response } from 'express';
import { z } from 'zod';

export interface MutationSchema {
  body: z.ZodType;
  params?: z.ZodType;
}

export class HttpValidationError extends Error {
  readonly issues: readonly unknown[];

  constructor(issues: readonly unknown[]) {
    super('Request validation failed');
    this.name = 'HttpValidationError';
    this.issues = [...issues];
  }
}

const parseInput = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new HttpValidationError(result.error.issues);
  }
  return result.data;
};
export const parseBody = <T>(schema: z.ZodType<T>, body: unknown): T => (
  parseInput(schema, body === undefined ? {} : body)
);

export const parseParams = <T>(schema: z.ZodType<T>, params: unknown): T => (
  parseInput(schema, params === undefined ? {} : params)
);

const handleValidationError = (
  error: unknown,
  res: Response,
  next: NextFunction
) => {
  if (error instanceof HttpValidationError) {
    res.status(400).json({ error: 'Invalid request', code: 'validation_error' });
    return;
  }
  next(error);
};

export const validateBody = (schema: z.ZodType): RequestHandler => (req, res, next) => {
  try {
    req.body = parseBody(schema, req.body);
    next();
  } catch (error) {
    handleValidationError(error, res, next);
  }
};

export const validateParams = (schema: z.ZodType): RequestHandler => (req, res, next) => {
  try {
    req.params = parseParams(schema, req.params) as Request['params'];
    next();
  } catch (error) {
    handleValidationError(error, res, next);
  }
};

export const validateMutation = (schema: MutationSchema): RequestHandler => (req, res, next) => {
  try {
    const body = parseBody(schema.body, req.body);
    const params = schema.params ? parseParams(schema.params, req.params) : req.params;

    req.body = body;
    if (schema.params) {
      req.params = params as Request['params'];
    }
    next();
  } catch (error) {
    handleValidationError(error, res, next);
  }
};
