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
