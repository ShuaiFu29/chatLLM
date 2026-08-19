import { Module } from '@nestjs/common';
import { AuthGuard } from '../../common/guards/auth.guard';
import { AgentsController } from './agents.controller';
import { AgentsService } from './agents.service';
import { AgentToolsController } from './agent-tools.controller';
import { AgentToolsService } from './agent-tools.service';
import { AgentRunService } from './agent-run.service';
import { AgentRunsController } from './agent-runs.controller';
import { AgentRunsService } from './agent-runs.service';

@Module({
  controllers: [AgentsController, AgentToolsController, AgentRunsController],
  providers: [AuthGuard, AgentsService, AgentToolsService, AgentRunService, AgentRunsService],
  exports: [AgentsService, AgentToolsService, AgentRunService],
})
export class AgentsModule {}
