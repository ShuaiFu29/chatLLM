const POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807n;
const POSITIVE_DECIMAL_INTEGER = /^[1-9]\d*$/;

export const normalizeGithubId = (value: unknown): string => {
  if (typeof value !== 'string' || !POSITIVE_DECIMAL_INTEGER.test(value)) {
    throw new Error('GitHub user id must be a positive decimal string');
  }

  const parsed = BigInt(value);
  if (parsed > POSTGRES_BIGINT_MAX) {
    throw new Error('GitHub user id exceeds the PostgreSQL bigint range');
  }
  return parsed.toString(10);
};

export const normalizeNullableGithubId = (value: unknown): string | null => (
  value === null ? null : normalizeGithubId(value)
);

const quoteJsonIntegerTokens = (input: string) => {
  let output = '';
  let inString = false;
  let escaped = false;

  for (let index = 0; index < input.length;) {
    const current = input[index];
    if (inString) {
      output += current;
      if (escaped) escaped = false;
      else if (current === '\\') escaped = true;
      else if (current === '"') inString = false;
      index += 1;
      continue;
    }

    if (current === '"') {
      inString = true;
      output += current;
      index += 1;
      continue;
    }

    if (current === '-' || /\d/.test(current)) {
      const numberMatch = input.slice(index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
      if (numberMatch) {
        const token = numberMatch[0];
        output += /[.eE]/.test(token) ? token : JSON.stringify(token);
        index += token.length;
        continue;
      }
    }

    output += current;
    index += 1;
  }
  return output;
};

export const parseJsonPreservingIntegers = (input: string): unknown => (
  JSON.parse(quoteJsonIntegerTokens(input))
);
