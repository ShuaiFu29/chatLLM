import { Module } from '@nestjs/common';
import { AuthGuard } from '../../common/guards/auth.guard';
import { ProjectSpacesController } from './project-spaces.controller';
import { ProjectSpacesService } from './project-spaces.service';

@Module({
  controllers: [ProjectSpacesController],
  providers: [AuthGuard, ProjectSpacesService],
})
export class ProjectSpacesModule {}
