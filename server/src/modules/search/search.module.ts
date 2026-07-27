import { Module } from '@nestjs/common';
import { AuthGuard } from '../../common/guards/auth.guard';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';

@Module({
  controllers: [SearchController],
  providers: [AuthGuard, SearchService],
})
export class SearchModule {}
