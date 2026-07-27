import { Module } from '@nestjs/common';
import { AuthGuard } from '../../common/guards/auth.guard';
import { AuthController } from './auth.controller';

@Module({
  controllers: [AuthController],
  providers: [AuthGuard],
})
export class AuthModule {}
