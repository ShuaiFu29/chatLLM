import { CookieSerializeOptions } from '@fastify/cookie';

const HTTP_RESPONSE = Symbol('HTTP_RESPONSE');

export interface ResponseCookie {
  action: 'set' | 'clear';
  name: string;
  value?: string;
  options?: CookieSerializeOptions;
}

export interface HttpResponseOptions {
  statusCode?: number;
  headers?: Record<string, string | number>;
  cookies?: ResponseCookie[];
}

export interface HttpResponse<T> {
  readonly [HTTP_RESPONSE]: true;
  readonly body: T;
  readonly options: HttpResponseOptions;
}

export const httpResponse = <T>(
  body: T,
  options: HttpResponseOptions = {},
): HttpResponse<T> => ({
  [HTTP_RESPONSE]: true,
  body,
  options,
});

export const isHttpResponse = (value: unknown): value is HttpResponse<unknown> => (
  typeof value === 'object'
  && value !== null
  && HTTP_RESPONSE in value
  && (value as Partial<HttpResponse<unknown>>)[HTTP_RESPONSE] === true
);
