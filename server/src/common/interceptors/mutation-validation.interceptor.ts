import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import {
  MutationSchema,
  parseBody,
  parseParams,
} from '../../lib/validation';
import { AppRequest } from '../http/app-request';

export const MUTATION_SCHEMA = Symbol('chatllm.mutation-schema');

export const ValidateMutation = (schema: MutationSchema) => (
  SetMetadata(MUTATION_SCHEMA, schema)
);

@Injectable()
export class MutationValidationInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const schema = this.reflector.getAllAndOverride<MutationSchema>(MUTATION_SCHEMA, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!schema) return next.handle();

    const request = context.switchToHttp().getRequest<AppRequest>();
    request.body = parseBody(schema.body, request.body) as AppRequest['body'];
    if (schema.params) {
      request.params = parseParams(schema.params, request.params) as AppRequest['params'];
    }
    return next.handle();
  }
}
