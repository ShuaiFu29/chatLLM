import { Module } from '@nestjs/common';
import { AuthGuard } from '../../common/guards/auth.guard';
import { UsageController } from './usage.controller';

@Module({
  controllers: [UsageController],
  providers: [AuthGuard],
})
export class UsageModule {}
