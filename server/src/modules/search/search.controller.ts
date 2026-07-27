import {
  Controller,
  Get,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '../../common/guards/auth.guard';
import {
  CurrentUser,
  RequestId,
} from '../../common/http/request-context.decorator';
import { User } from '../../types';
import { SearchService } from './search.service';

@Controller('search')
@UseGuards(AuthGuard)
export class SearchController {
  constructor(private readonly searchService: SearchService) {}

  @Get()
  search(
    @CurrentUser() user: User,
    @Query() query: Record<string, unknown>,
    @RequestId() requestId?: string,
  ) {
    return this.searchService.search(user.id, query, requestId);
  }
}
