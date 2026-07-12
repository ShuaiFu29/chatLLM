export interface SafeError {
  name: string;
  code?: string;
  status?: number;
}


const ERROR_CODE_PATTERN = /^(?:[A-Z][A-Z0-9_.-]{0,63}|[0-9][A-Z0-9]{4})$/;
const SAFE_ERROR_NAMES = new Set([
  'AbortError',
  'AggregateError',
  'AxiosError',
  'Error',
  'NetworkError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'TimeoutError',
  'TypeError',
  'URIError',
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

const readStatus = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599
    ? value
    : undefined;

export const toSafeError = (error: unknown): SafeError => {
  const rawName = error instanceof Error ? error.name : readProperty(error, 'name');
  const safe: SafeError = {
    name: typeof rawName === 'string' && SAFE_ERROR_NAMES.has(rawName)
      ? rawName
      : 'UnknownError',
  };

  const rawCode = readProperty(error, 'code');
  const code = typeof rawCode === 'number' && Number.isInteger(rawCode)
    ? String(rawCode)
    : typeof rawCode === 'string'
      ? rawCode
      : undefined;
  if (code && ERROR_CODE_PATTERN.test(code)) safe.code = code;

  const status = readStatus(readProperty(error, 'statusCode'))
    ?? readStatus(readProperty(error, 'status'))
    ?? readStatus(readProperty(readProperty(error, 'response'), 'status'));
  if (status !== undefined) safe.status = status;

  return safe;
};
