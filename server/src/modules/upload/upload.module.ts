import { Module } from '@nestjs/common';
import { AuthGuard } from '../../common/guards/auth.guard';
import { UploadController } from './upload.controller';

@Module({
  controllers: [UploadController],
  providers: [AuthGuard],
})
export class UploadModule {}
