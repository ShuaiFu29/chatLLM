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
import { RateLimitScope } from '../../common/guards/rate-limit.guard';
import { CurrentUser, RequestId } from '../../common/http/request-context.decorator';
import { ValidateMutation } from '../../common/interceptors/mutation-validation.interceptor';
import { mutationSchemas } from '../../lib/mutationSchemas';
import { serverEnv } from '../../lib/env';
import { User } from '../../types';
import {
  AgentToolCreateBody,
  AgentToolDiagnosticBody,
  AgentToolOpenApiImportBody,
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

  @Post('imports/openapi')
  @HttpCode(HttpStatus.OK)
  @RateLimitScope({
    keyPrefix: 'agent-tool-openapi-import',
    max: serverEnv.RAG_EVAL_RATE_LIMIT_MAX,
    message: 'Too many OpenAPI import requests',
  })
  @ValidateMutation(mutationSchemas.agentToolOpenApiImport)
  importOpenApi(@Body() body: AgentToolOpenApiImportBody) {
    return this.agentToolsService.importOpenApi(body);
  }

  @Get(':toolId')
  get(@CurrentUser() user: User, @Param('toolId') toolId: string) {
    return this.agentToolsService.get(user.id, toolId);
  }

  @Get(':toolId/versions')
  versions(@CurrentUser() user: User, @Param('toolId') toolId: string) {
    return this.agentToolsService.versions(user.id, toolId);
  }

  @Get(':toolId/versions/:versionId')
  version(
    @CurrentUser() user: User,
    @Param('toolId') toolId: string,
    @Param('versionId') versionId: string,
    @Query('againstVersionId') againstVersionId?: string,
  ) {
    if (againstVersionId) {
      return this.agentToolsService.diffVersions(
        user.id,
        toolId,
        versionId,
        againstVersionId,
      );
    }
    return this.agentToolsService.version(user.id, toolId, versionId);
  }

  @Get(':toolId/diagnostics')
  diagnostics(
    @CurrentUser() user: User,
    @Param('toolId') toolId: string,
    @Query() query: Record<string, unknown>,
  ) {
    return this.agentToolsService.listDiagnostics(user.id, toolId, query);
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

  @Post(':toolId/secrets/rotate')
  @ValidateMutation(mutationSchemas.agentToolRotateSecrets)
  rotateSecrets(
    @CurrentUser() user: User,
    @Param('toolId') toolId: string,
    @RequestId() requestId?: string,
  ) {
    return this.agentToolsService.rotateSecrets(user.id, toolId, requestId);
  }

  @Post(':toolId/diagnostics')
  @HttpCode(HttpStatus.OK)
  @RateLimitScope({
    keyPrefix: 'agent-tool-diagnostics',
    max: serverEnv.RAG_EVAL_RATE_LIMIT_MAX,
    message: 'Too many Agent tool diagnostic requests',
  })
  @ValidateMutation(mutationSchemas.agentToolDiagnostic)
  diagnose(
    @CurrentUser() user: User,
    @Param('toolId') toolId: string,
    @Body() body: AgentToolDiagnosticBody,
  ) {
    return this.agentToolsService.diagnose(user.id, toolId, body);
  }

  @Delete(':toolId')
  @ValidateMutation(mutationSchemas.agentToolDelete)
  delete(@CurrentUser() user: User, @Param('toolId') toolId: string) {
    return this.agentToolsService.delete(user.id, toolId);
  }
}
