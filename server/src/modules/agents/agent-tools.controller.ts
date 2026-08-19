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
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '../../common/guards/auth.guard';
import { CurrentUser, RequestId } from '../../common/http/request-context.decorator';
import { ValidateMutation } from '../../common/interceptors/mutation-validation.interceptor';
import { mutationSchemas } from '../../lib/mutationSchemas';
import { User } from '../../types';
import {
  AgentToolCreateBody,
  AgentToolsService,
  AgentToolUpdateBody,
} from './agent-tools.service';

@Controller('agent-tools')
@UseGuards(AuthGuard)
export class AgentToolsController {
  constructor(private readonly agentToolsService: AgentToolsService) {}

  @Get()
  list(@CurrentUser() user: User, @Query() query: Record<string, unknown>) {
    return this.agentToolsService.list(user.id, query);
  }

  @Get(':toolId')
  get(@CurrentUser() user: User, @Param('toolId') toolId: string) {
    return this.agentToolsService.get(user.id, toolId);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ValidateMutation(mutationSchemas.agentToolCreate)
  create(
    @CurrentUser() user: User,
    @Body() body: AgentToolCreateBody,
    @RequestId() requestId?: string,
  ) {
    return this.agentToolsService.create(user.id, body, requestId);
  }

  @Patch(':toolId')
  @ValidateMutation(mutationSchemas.agentToolUpdate)
  update(
    @CurrentUser() user: User,
    @Param('toolId') toolId: string,
    @Body() body: AgentToolUpdateBody,
    @RequestId() requestId?: string,
  ) {
    return this.agentToolsService.update(user.id, toolId, body, requestId);
  }

  @Delete(':toolId')
  @ValidateMutation(mutationSchemas.agentToolDelete)
  delete(@CurrentUser() user: User, @Param('toolId') toolId: string) {
    return this.agentToolsService.delete(user.id, toolId);
  }
}
