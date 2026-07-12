export interface SafeError {
  name: string;
  code?: string;
  status?: number;
  requestId?: string;
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const ERROR_CODE_PATTERN = /^(?:[A-Z][A-Z0-9_.-]{0,63}|[0-9][A-Z0-9]{4})$/;
const SAFE_ERROR_NAMES = new Set([
  'AbortError',
  'AggregateError',
  'AxiosError',
  'CompatibleApiError',
  'DatabaseError',
  'Error',
  'EvalError',
  'FetchError',
  'ModelProviderConfigurationError',
  'RangeError',
  'ReferenceError',
  'RequestError',
  'ResponseError',
  'SyntaxError',
  'SystemError',
  'TimeoutError',
  'TypeError',
  'URIError',
  'UnsupportedOfficialModelError',
]);

const isObjectLike = (value: unknown): value is object =>
  (typeof value === 'object' && value !== null) || typeof value === 'function';

const readProperty = (value: unknown, key: PropertyKey): unknown => {
  if (!isObjectLike(value)) return undefined;
  try {
    return Reflect.get(value, key);
  } catch {
    return undefined;
  }
};

const readSafeCode = (error: unknown): string | undefined => {
  const value = readProperty(error, 'code');
  const code = typeof value === 'number' && Number.isInteger(value)
    ? String(value)
    : typeof value === 'string'
      ? value
      : undefined;
  return code && ERROR_CODE_PATTERN.test(code) ? code : undefined;
};

const toHttpStatus = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599
    ? value
    : undefined;

const readSafeStatus = (error: unknown): number | undefined => {
  const direct = toHttpStatus(readProperty(error, 'statusCode'))
    ?? toHttpStatus(readProperty(error, 'status'));
  if (direct !== undefined) return direct;
  return toHttpStatus(readProperty(readProperty(error, 'response'), 'status'));
};

const readSafeName = (error: unknown): string => {
  const value = error instanceof Error ? error.name : readProperty(error, 'name');
  return typeof value === 'string' && SAFE_ERROR_NAMES.has(value)
    ? value
    : 'UnknownError';
};

export const toSafeRequestId = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const requestId = value.trim();
  return REQUEST_ID_PATTERN.test(requestId) ? requestId : undefined;
};

export const toSafeError = (error: unknown, requestId?: unknown): SafeError => {
  const safeError: SafeError = { name: readSafeName(error) };
  const code = readSafeCode(error);
  const status = readSafeStatus(error);
  const safeRequestId = toSafeRequestId(requestId);

  if (code !== undefined) safeError.code = code;
  if (status !== undefined) safeError.status = status;
  if (safeRequestId !== undefined) safeError.requestId = safeRequestId;
  return safeError;
};
