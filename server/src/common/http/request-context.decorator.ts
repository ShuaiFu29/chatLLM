import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { IncomingMessage } from 'node:http';
import { User } from '../../types';
import { AppRequest } from './app-request';

export const readCurrentUser = (_data: unknown, context: ExecutionContext): User => {
  const request = context.switchToHttp().getRequest<AppRequest>();
  if (!request.user) {
    throw new Error('CurrentUser requires AuthGuard');
  }
  return request.user;
};

export const readRequestId = (_data: unknown, context: ExecutionContext): string | undefined => (
  context.switchToHttp().getRequest<AppRequest>().requestId
);

export const readRequestCookies = (
  _data: unknown,
  context: ExecutionContext,
): Record<string, string | undefined> => (
  context.switchToHttp().getRequest<AppRequest>().cookies ?? {}
);

export const readRequestConnection = (
  _data: unknown,
  context: ExecutionContext,
): IncomingMessage => context.switchToHttp().getRequest<AppRequest>().raw;

export const CurrentUser = createParamDecorator(readCurrentUser);
export const RequestId = createParamDecorator(readRequestId);
export const RequestCookies = createParamDecorator(readRequestCookies);
export const RequestConnection = createParamDecorator(readRequestConnection);
