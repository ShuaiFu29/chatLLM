const readStringProperty = (value: unknown, key: string) => {
  if (!value || typeof value !== 'object') return '';
  const candidate = Reflect.get(value, key);
  return typeof candidate === 'string' ? candidate : '';
};

export const isRequestCancellation = (error: unknown) => {
  const name = error instanceof Error ? error.name : readStringProperty(error, 'name');
  const code = readStringProperty(error, 'code');
  return name === 'AbortError' || name === 'CanceledError' || code === 'ERR_CANCELED';
};
