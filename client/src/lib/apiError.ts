const isObjectLike = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null
);

const firstNonEmptyString = (values: unknown[]) => {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return '';
};

/**
 * Read the server's own explanation out of a failed request.
 *
 * Axios sets `error.message` to a generic "Request failed with status code 400",
 * so showing it hid every actionable reason the API returns in its body: quota
 * exceeded, tool still bound to an Agent, invalid JSON Schema, tool outside the
 * project scope. Prefer the response body, fall back to the generic message only
 * when the body carries nothing usable.
 */
export const readApiErrorMessage = (error: unknown, fallback = ''): string => {
  if (!isObjectLike(error)) return fallback;

  const response = isObjectLike(error.response) ? error.response : undefined;
  const data = response && isObjectLike(response.data) ? response.data : undefined;

  const fromBody = firstNonEmptyString([
    data?.error,
    data?.message,
    // Nest validation pipes can nest the payload one level deeper.
    isObjectLike(data?.error) ? (data.error as Record<string, unknown>).message : undefined,
  ]);
  if (fromBody) return fromBody;

  // A plain text body is still better than the generic axios message.
  if (response && typeof response.data === 'string') {
    const text = response.data.trim();
    if (text && !text.startsWith('<')) return text;
  }

  return fallback || firstNonEmptyString([error.message]) || fallback;
};
