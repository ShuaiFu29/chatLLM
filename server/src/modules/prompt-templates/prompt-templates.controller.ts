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
  createPromptTemplate,
  deletePromptTemplate,
  listPromptTemplates,
  updatePromptTemplate,
} from '../../controllers/promptTemplates';
import { AuthGuard } from '../../common/guards/auth.guard';
import { AppReply, AppRequest } from '../../common/http/app-request';
import { ValidateMutation } from '../../common/interceptors/mutation-validation.interceptor';
import { mutationSchemas } from '../../lib/mutationSchemas';

@Controller('prompt-templates')
@UseGuards(AuthGuard)
export class PromptTemplatesController {
  @Get()
  list(@Req() request: AppRequest, @Res() reply: AppReply) {
    return listPromptTemplates(request, reply);
  }

  @Post()
  @ValidateMutation(mutationSchemas.promptTemplateCreate)
  create(@Req() request: AppRequest, @Res() reply: AppReply) {
    return createPromptTemplate(request, reply);
  }

  @Patch(':templateId')
  @ValidateMutation(mutationSchemas.promptTemplateUpdate)
  update(@Req() request: AppRequest, @Res() reply: AppReply) {
    return updatePromptTemplate(request, reply);
  }

  @Delete(':templateId')
  @ValidateMutation(mutationSchemas.promptTemplateDelete)
  delete(@Req() request: AppRequest, @Res() reply: AppReply) {
    return deletePromptTemplate(request, reply);
  }
}
