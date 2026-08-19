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
import { AgentCreateBody, AgentsService, AgentUpdateBody } from './agents.service';

@Controller('agents')
@UseGuards(AuthGuard)
export class AgentsController {
  constructor(private readonly agentsService: AgentsService) {}

  @Get()
  list(
    @CurrentUser() user: User,
    @Query() query: Record<string, unknown>,
  ) {
    return this.agentsService.list(user.id, query);
  }

  @Get('tools/catalog')
  toolCatalog() {
    return this.agentsService.toolCatalog();
  }

  @Get(':agentId')
  get(@CurrentUser() user: User, @Param('agentId') agentId: string) {
    return this.agentsService.get(user.id, agentId);
  }

  @Get(':agentId/versions')
  versions(@CurrentUser() user: User, @Param('agentId') agentId: string) {
    return this.agentsService.versions(user.id, agentId);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ValidateMutation(mutationSchemas.agentCreate)
  create(
    @CurrentUser() user: User,
    @Body() body: AgentCreateBody,
    @RequestId() requestId?: string,
  ) {
    return this.agentsService.create(user.id, body, requestId);
  }

  @Patch(':agentId')
  @ValidateMutation(mutationSchemas.agentUpdate)
  update(
    @CurrentUser() user: User,
    @Param('agentId') agentId: string,
    @Body() body: AgentUpdateBody,
    @RequestId() requestId?: string,
  ) {
    return this.agentsService.update(user.id, agentId, body, requestId);
  }

  @Post(':agentId/publish')
  @ValidateMutation(mutationSchemas.agentPublish)
  publish(@CurrentUser() user: User, @Param('agentId') agentId: string) {
    return this.agentsService.publish(user.id, agentId);
  }

  @Post(':agentId/duplicate')
  @ValidateMutation(mutationSchemas.agentDuplicate)
  duplicate(
    @CurrentUser() user: User,
    @Param('agentId') agentId: string,
    @Body() body: { name?: string },
    @RequestId() requestId?: string,
  ) {
    return this.agentsService.duplicate(user.id, agentId, body.name, requestId);
  }

  @Patch(':agentId/status')
  @ValidateMutation(mutationSchemas.agentStatus)
  status(
    @CurrentUser() user: User,
    @Param('agentId') agentId: string,
    @Body() body: { disabled: boolean },
  ) {
    return this.agentsService.setDisabled(user.id, agentId, body.disabled);
  }

  @Delete(':agentId')
  @ValidateMutation(mutationSchemas.agentDelete)
  delete(@CurrentUser() user: User, @Param('agentId') agentId: string) {
    return this.agentsService.delete(user.id, agentId);
  }
}
