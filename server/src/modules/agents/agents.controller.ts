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
  AgentCreateBody,
  AgentPublishBody,
  AgentsService,
  AgentUpdateBody,
} from './agents.service';
import { AgentDryRunsService } from './agent-dry-runs.service';

@Controller('agents')
@UseGuards(AuthGuard)
export class AgentsController {
  constructor(
    private readonly agentsService: AgentsService,
    private readonly agentDryRunsService: AgentDryRunsService,
  ) {}

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

  @Get(':agentId/versions/:versionId')
  version(
    @CurrentUser() user: User,
    @Param('agentId') agentId: string,
    @Param('versionId') versionId: string,
  ) {
    return this.agentsService.version(user.id, agentId, versionId);
  }

  @Get(':agentId/versions/:versionId/diff')
  versionDiff(
    @CurrentUser() user: User,
    @Param('agentId') agentId: string,
    @Param('versionId') versionId: string,
    @Query('againstVersionId') againstVersionId?: string,
  ) {
    return this.agentsService.diffVersions(user.id, agentId, versionId, againstVersionId);
  }

  @Get(':agentId/versions/:versionId/dry-runs')
  dryRuns(
    @CurrentUser() user: User,
    @Param('agentId') agentId: string,
    @Param('versionId') versionId: string,
    @Query('limit') limit?: string,
  ) {
    return this.agentDryRunsService.list(user.id, agentId, versionId, limit);
  }

  @Post(':agentId/versions/:versionId/dry-runs')
  @ValidateMutation(mutationSchemas.agentVersionDryRun)
  dryRun(
    @CurrentUser() user: User,
    @Param('agentId') agentId: string,
    @Param('versionId') versionId: string,
    @Body() body: { input: string },
    @RequestId() requestId?: string,
  ) {
    return this.agentDryRunsService.run(user.id, agentId, versionId, body.input, requestId);
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
  publish(
    @CurrentUser() user: User,
    @Param('agentId') agentId: string,
    @Body() body: AgentPublishBody,
  ) {
    return this.agentsService.publish(user.id, agentId, body);
  }

  @Post(':agentId/versions/:versionId/rollback')
  @ValidateMutation(mutationSchemas.agentVersionRollback)
  rollback(
    @CurrentUser() user: User,
    @Param('agentId') agentId: string,
    @Param('versionId') versionId: string,
  ) {
    return this.agentsService.rollback(user.id, agentId, versionId);
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
