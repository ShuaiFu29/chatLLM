import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '../../common/guards/auth.guard';
import {
  CurrentUser,
  RequestId,
} from '../../common/http/request-context.decorator';
import { ValidateMutation } from '../../common/interceptors/mutation-validation.interceptor';
import { mutationSchemas } from '../../lib/mutationSchemas';
import { User } from '../../types';
import {
  ProjectSpaceCreateBody,
  ProjectSpacesService,
  ProjectSpaceUpdateBody,
} from './project-spaces.service';

@Controller('project-spaces')
@UseGuards(AuthGuard)
export class ProjectSpacesController {
  constructor(private readonly projectSpacesService: ProjectSpacesService) {}

  @Get()
  list(
    @CurrentUser() user: User,
    @RequestId() requestId?: string,
  ) {
    return this.projectSpacesService.list(user.id, requestId);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ValidateMutation(mutationSchemas.projectSpaceCreate)
  create(
    @CurrentUser() user: User,
    @Body() body: ProjectSpaceCreateBody,
    @RequestId() requestId?: string,
  ) {
    return this.projectSpacesService.create(user.id, body, requestId);
  }

  @Patch(':projectSpaceId')
  @ValidateMutation(mutationSchemas.projectSpaceUpdate)
  update(
    @CurrentUser() user: User,
    @Param('projectSpaceId') projectSpaceId: string,
    @Body() body: ProjectSpaceUpdateBody,
    @RequestId() requestId?: string,
  ) {
    return this.projectSpacesService.update(
      user.id,
      projectSpaceId,
      body,
      requestId,
    );
  }

  @Delete(':projectSpaceId')
  @HttpCode(HttpStatus.ACCEPTED)
  @ValidateMutation(mutationSchemas.projectSpaceDelete)
  delete(
    @CurrentUser() user: User,
    @Param('projectSpaceId') projectSpaceId: string,
    @RequestId() requestId?: string,
  ) {
    return this.projectSpacesService.delete(user.id, projectSpaceId, requestId);
  }
}
