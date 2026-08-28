import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '../../common/guards/auth.guard';
import { CurrentUser, RequestId } from '../../common/http/request-context.decorator';
import { ValidateMutation } from '../../common/interceptors/mutation-validation.interceptor';
import { mutationSchemas } from '../../lib/mutationSchemas';
import { User } from '../../types';
import { AgentMemoriesService } from './agent-memories.service';

@Controller('agent-memories')
@UseGuards(AuthGuard)
export class AgentMemoriesController {
  constructor(private readonly agentMemoriesService: AgentMemoriesService) {}

  @Get()
  list(@CurrentUser() user: User, @Query() query: Record<string, unknown>) {
    return this.agentMemoriesService.list(user.id, query);
  }

  @Patch(':memoryId')
  @ValidateMutation(mutationSchemas.agentMemorySupersede)
  supersede(
    @CurrentUser() user: User,
    @Param('memoryId') memoryId: string,
    @Body() body: { superseded_by: string },
  ) {
    return this.agentMemoriesService.supersede(user.id, memoryId, body);
  }

  @Delete(':memoryId')
  @ValidateMutation(mutationSchemas.agentMemoryDelete)
  forget(
    @CurrentUser() user: User,
    @Param('memoryId') memoryId: string,
    @RequestId() requestId: string,
  ) {
    return this.agentMemoriesService.forget(user.id, memoryId, requestId);
  }
}
