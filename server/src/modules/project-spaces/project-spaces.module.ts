import { Module } from '@nestjs/common';
import { AuthGuard } from '../../common/guards/auth.guard';
import { ProjectSpacesController } from './project-spaces.controller';

@Module({
  controllers: [ProjectSpacesController],
  providers: [AuthGuard],
})
export class ProjectSpacesModule {}
