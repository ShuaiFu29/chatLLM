export const MAX_SEARCH_QUERY_LENGTH = 200;

type ValidSearchQuery = {
  ok: true;
  query: string;
};

type InvalidSearchQuery = {
  ok: false;
  statusCode: 400 | 413;
  error: string;
};

type SearchQueryValues = Record<string, unknown>;

const readString = (value: unknown, maxLength = 128) => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : undefined;
};

const readBoolean = (value: unknown) => value === 'true' || value === '1';

const readLimit = (value: unknown) => {
  if (typeof value !== 'string') return undefined;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return undefined;
  return Math.min(Math.max(parsed, 1), 50);
};

export const normalizeSearchQuery = (value: unknown): ValidSearchQuery | InvalidSearchQuery => {
  if (typeof value !== 'string') {
    return {
      ok: false,
      statusCode: 400,
      error: 'Search query is required',
    };
  }

  const query = value.trim();
  if (!query) {
    return {
      ok: false,
      statusCode: 400,
      error: 'Search query is required',
    };
  }

  if (query.length > MAX_SEARCH_QUERY_LENGTH) {
    return {
      ok: false,
      statusCode: 413,
      error: `Search query exceeds ${MAX_SEARCH_QUERY_LENGTH} characters`,
    };
  }

  return { ok: true, query };
};

export const readSearchFilters = (query: SearchQueryValues) => ({
  projectSpaceId: readString(query.projectSpaceId || query.project_space_id),
  hasSources: readBoolean(query.hasSources || query.has_sources),
  model: readString(query.model, 80),
  favoriteOnly: readBoolean(query.favoriteOnly || query.favorite_only),
  tag: readString(query.tag, 80),
  includeArchived: readBoolean(query.includeArchived || query.include_archived),
  limit: readLimit(query.limit),
});
