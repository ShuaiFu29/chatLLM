import { Module } from '@nestjs/common';
import { AuthGuard } from '../../common/guards/auth.guard';
import { AgentsController } from './agents.controller';
import { AgentsService } from './agents.service';
import { AgentToolsController } from './agent-tools.controller';
import { AgentToolsService } from './agent-tools.service';
import { AgentRunService } from './agent-run.service';
import { AgentRunsController } from './agent-runs.controller';
import { AgentRunsService } from './agent-runs.service';
import { AgentMemoriesController } from './agent-memories.controller';
import { AgentMemoriesService } from './agent-memories.service';

@Module({
  controllers: [AgentsController, AgentToolsController, AgentRunsController, AgentMemoriesController],
  providers: [
    AuthGuard,
    AgentsService,
    AgentToolsService,
    AgentRunService,
    AgentRunsService,
    AgentMemoriesService,
  ],
  exports: [AgentsService, AgentToolsService, AgentRunService, AgentMemoriesService],
})
export class AgentsModule {}
