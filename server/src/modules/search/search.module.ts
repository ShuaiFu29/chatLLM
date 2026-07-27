import { Module } from '@nestjs/common';
import { AuthGuard } from '../../common/guards/auth.guard';
import { SearchController } from './search.controller';

@Module({
  controllers: [SearchController],
  providers: [AuthGuard],
})
export class SearchModule {}
