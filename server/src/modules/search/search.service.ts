import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { normalizeSearchQuery, readSearchFilters } from '../../lib/searchInput';
import { toSafeError } from '../../lib/safeError';
import { searchMessagesForUser } from '../../repositories/messages';

@Injectable()
export class SearchService {
  async search(
    userId: string,
    query: Record<string, unknown>,
    requestId?: string,
  ) {
    const normalizedQuery = normalizeSearchQuery(query.q);
    if (!normalizedQuery.ok) {
      throw new HttpException(
        { error: normalizedQuery.error },
        normalizedQuery.statusCode,
      );
    }

    try {
      return await searchMessagesForUser(
        userId,
        normalizedQuery.query,
        readSearchFilters(query),
      );
    } catch (error) {
      console.error(
        '[Search] Unexpected error:',
        toSafeError(error, requestId),
      );
      throw new HttpException(
        { error: 'Internal server error' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
