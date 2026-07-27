import {
  Controller,
  Get,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '../../common/guards/auth.guard';
import { AppReply, AppRequest } from '../../common/http/app-request';
import { normalizeSearchQuery, readSearchFilters } from '../../lib/searchInput';
import { toSafeError } from '../../lib/safeError';
import { searchMessagesForUser } from '../../repositories/messages';

@Controller('search')
@UseGuards(AuthGuard)
export class SearchController {
  @Get()
  async search(@Req() request: AppRequest, @Res() reply: AppReply) {
    try {
      if (!request.user) {
        return reply.code(401).send({ error: 'Unauthorized' });
      }

      const normalizedQuery = normalizeSearchQuery(request.query.q);
      if (!normalizedQuery.ok) {
        return reply
          .code(normalizedQuery.statusCode)
          .send({ error: normalizedQuery.error });
      }

      const results = await searchMessagesForUser(
        request.user.id,
        normalizedQuery.query,
        readSearchFilters(request.query),
      );
      return reply.send(results);
    } catch (error) {
      console.error(
        '[Search] Unexpected error:',
        toSafeError(error, request.requestId),
      );
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }
}
