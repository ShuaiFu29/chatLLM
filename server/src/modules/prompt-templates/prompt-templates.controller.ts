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
  PromptTemplateCreateBody,
  PromptTemplatesService,
  PromptTemplateUpdateBody,
} from './prompt-templates.service';

@Controller('prompt-templates')
@UseGuards(AuthGuard)
export class PromptTemplatesController {
  constructor(private readonly promptTemplatesService: PromptTemplatesService) {}

  @Get()
  list(
    @CurrentUser() user: User,
    @RequestId() requestId?: string,
  ) {
    return this.promptTemplatesService.list(user.id, requestId);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ValidateMutation(mutationSchemas.promptTemplateCreate)
  create(
    @CurrentUser() user: User,
    @Body() body: PromptTemplateCreateBody,
    @RequestId() requestId?: string,
  ) {
    return this.promptTemplatesService.create(user.id, body, requestId);
  }

  @Patch(':templateId')
  @ValidateMutation(mutationSchemas.promptTemplateUpdate)
  update(
    @CurrentUser() user: User,
    @Param('templateId') templateId: string,
    @Body() body: PromptTemplateUpdateBody,
    @RequestId() requestId?: string,
  ) {
    return this.promptTemplatesService.update(
      user.id,
      templateId,
      body,
      requestId,
    );
  }

  @Delete(':templateId')
  @ValidateMutation(mutationSchemas.promptTemplateDelete)
  delete(
    @CurrentUser() user: User,
    @Param('templateId') templateId: string,
    @RequestId() requestId?: string,
  ) {
    return this.promptTemplatesService.delete(user.id, templateId, requestId);
  }
}
