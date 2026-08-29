import { Module } from '@nestjs/common';
import { AuthGuard } from '../../common/guards/auth.guard';
import { AgentsModule } from '../agents/agents.module';
import { AgentEvalController } from './agent-eval.controller';
import { AgentEvalService } from './agent-eval.service';

@Module({
  imports: [AgentsModule],
  controllers: [AgentEvalController],
  providers: [AuthGuard, AgentEvalService],
})
export class AgentEvalModule {}
