import { Module } from '@nestjs/common';
import { AuthGuard } from '../../common/guards/auth.guard';
import { UploadController } from './upload.controller';
import { UploadService } from './upload.service';

@Module({
  controllers: [UploadController],
  providers: [AuthGuard, UploadService],
})
export class UploadModule {}
