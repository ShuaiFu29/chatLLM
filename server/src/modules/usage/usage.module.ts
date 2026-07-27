import { Module } from '@nestjs/common';
import { AuthGuard } from '../../common/guards/auth.guard';
import { UsageController } from './usage.controller';
import { UsageService } from './usage.service';

@Module({
  controllers: [UsageController],
  providers: [AuthGuard, UsageService],
})
export class UsageModule {}
