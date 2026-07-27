import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { FastifyReply } from 'fastify';
import { Observable, map } from 'rxjs';
import { isHttpResponse } from '../http/http-response';

@Injectable()
export class HttpResponseInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const reply = context.switchToHttp().getResponse<FastifyReply>();
    return next.handle().pipe(map((result: unknown) => {
      if (!isHttpResponse(result)) return result;

      const { body, options } = result;
      if (options.statusCode !== undefined) reply.status(options.statusCode);
      for (const [name, value] of Object.entries(options.headers ?? {})) {
        reply.header(name, value);
      }
      for (const cookie of options.cookies ?? []) {
        if (cookie.action === 'clear') {
          reply.clearCookie(cookie.name, cookie.options);
        } else {
          reply.setCookie(cookie.name, cookie.value ?? '', cookie.options);
        }
      }
      return body;
    }));
  }
}
