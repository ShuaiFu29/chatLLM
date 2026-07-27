import {
  Controller,
  Delete,
  Get,
  Patch,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  createProjectSpace,
  deleteProjectSpace,
  listProjectSpaces,
  updateProjectSpace,
} from '../../controllers/projectSpaces';
import { AuthGuard } from '../../common/guards/auth.guard';
import { AppReply, AppRequest } from '../../common/http/app-request';
import { ValidateMutation } from '../../common/interceptors/mutation-validation.interceptor';
import { mutationSchemas } from '../../lib/mutationSchemas';

@Controller('project-spaces')
@UseGuards(AuthGuard)
export class ProjectSpacesController {
  @Get()
  list(@Req() request: AppRequest, @Res() reply: AppReply) {
    return listProjectSpaces(request, reply);
  }

  @Post()
  @ValidateMutation(mutationSchemas.projectSpaceCreate)
  create(@Req() request: AppRequest, @Res() reply: AppReply) {
    return createProjectSpace(request, reply);
  }

  @Patch(':projectSpaceId')
  @ValidateMutation(mutationSchemas.projectSpaceUpdate)
  update(@Req() request: AppRequest, @Res() reply: AppReply) {
    return updateProjectSpace(request, reply);
  }

  @Delete(':projectSpaceId')
  @ValidateMutation(mutationSchemas.projectSpaceDelete)
  delete(@Req() request: AppRequest, @Res() reply: AppReply) {
    return deleteProjectSpace(request, reply);
  }
}
