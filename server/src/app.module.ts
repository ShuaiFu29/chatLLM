import { Module } from '@nestjs/common';
import { RuntimeLifecycleService } from './infrastructure/runtime-lifecycle.service';
import { OperationsController } from './modules/operations/operations.controller';

@Module({
  controllers: [OperationsController],
  providers: [RuntimeLifecycleService],
})
export class AppModule {}
