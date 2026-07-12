const ERROR_CODE_PATTERN = /^(?:[A-Z][A-Z0-9_.-]{0,63}|[0-9][A-Z0-9]{4})$/;
const SAFE_ERROR_NAMES = new Set([
  'AbortError',
  'AggregateError',
  'AxiosError',
  'Error',
  'RangeError',
  'ReferenceError',
  'RequestError',
  'ResponseError',
  'SyntaxError',
  'SystemError',
  'TimeoutError',
  'TypeError',
  'URIError',
]);

const isObjectLike = (value) =>
  (typeof value === 'object' && value !== null) || typeof value === 'function';

const readProperty = (value, key) => {
  if (!isObjectLike(value)) return undefined;
  try {
    return Reflect.get(value, key);
  } catch {
    return undefined;
  }
};

const readStatus = (value) =>
  typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599
    ? value
    : undefined;

export const toSafeError = (error) => {
  const rawName = error instanceof Error ? error.name : readProperty(error, 'name');
  const safe = {
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

export const formatSafeError = (error) => JSON.stringify(toSafeError(error));

export const toSafeUrl = (value) => {
  try {
    const url = new URL(String(value));
    return `${url.origin}${url.pathname}`;
  } catch {
    return 'invalid-url';
  }
};
