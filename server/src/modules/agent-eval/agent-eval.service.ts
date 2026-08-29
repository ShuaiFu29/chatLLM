import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { toSafeError } from '../../lib/safeError';
import {
  type AgentEvalEvaluationSpec,
  cancelAgentEvalRunForUser,
  createAgentEvalCaseForUser,
  createAgentEvalDatasetForUser,
  createAgentEvalRunForUser,
  deleteAgentEvalDatasetForUser,
  deleteAgentEvalCaseForUser,
  getAgentEvalRunForUser,
  listAgentEvalDatasetsForUser,
} from '../../repositories/agentEval';
import { recordAgentAuditEvent } from '../../repositories/agentAudit';
import { agentEvalQueue } from '../../services/agentEvalQueue';
import { AgentsService } from '../agents/agents.service';

export interface AgentEvalDatasetBody {
  name: string;
  description?: string;
}

export interface AgentEvalCaseBody {
  name?: string;
  input: string;
  evaluation_spec: AgentEvalEvaluationSpec;
}

export interface AgentEvalRunBody {
  agent_id: string;
  candidate_version_id: string;
  baseline_version_id?: string | null;
}

const requestError = (status: number, error: string) => new HttpException({ error }, status);

@Injectable()
export class AgentEvalService {
  constructor(private readonly agentsService: AgentsService) {}

  async listDatasets(userId: string, requestId?: string) {
    try {
      return await listAgentEvalDatasetsForUser(userId);
    } catch (error) {
      console.error('Failed to list Agent eval datasets:', toSafeError(error, requestId));
      throw requestError(500, 'Failed to list Agent evaluation datasets');
    }
  }

  async createDataset(userId: string, body: AgentEvalDatasetBody, requestId?: string) {
    try {
      return await createAgentEvalDatasetForUser({
        userId,
        name: body.name.trim(),
        description: body.description?.trim() || '',
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'AGENT_EVAL_DATASET_LIMIT') {
        throw requestError(HttpStatus.CONFLICT, 'Agent evaluation dataset quota reached');
      }
      console.error('Failed to create Agent eval dataset:', toSafeError(error, requestId));
      throw requestError(500, 'Failed to create Agent evaluation dataset');
    }
  }

  async deleteDataset(userId: string, datasetId: string, requestId?: string) {
    try {
      const deletion = await deleteAgentEvalDatasetForUser(datasetId, userId);
      if (!deletion.deleted) {
        throw requestError(HttpStatus.NOT_FOUND, 'Agent evaluation dataset not found');
      }
      for (const runId of deletion.activeRunIds) agentEvalQueue.abortRun(runId);
      return { success: true, cancelled_run_count: deletion.activeRunIds.length };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      console.error('Failed to delete Agent eval dataset:', toSafeError(error, requestId));
      throw requestError(500, 'Failed to delete Agent evaluation dataset');
    }
  }

  async createCase(
    userId: string,
    datasetId: string,
    body: AgentEvalCaseBody,
    requestId?: string,
  ) {
    try {
      const created = await createAgentEvalCaseForUser({
        userId,
        datasetId,
        name: body.name?.trim() || '',
        inputText: body.input.trim(),
        evaluationSpec: body.evaluation_spec,
      });
      if (!created) throw requestError(HttpStatus.NOT_FOUND, 'Agent evaluation dataset not found');
      return created;
    } catch (error) {
      if (error instanceof HttpException) throw error;
      if (error instanceof Error && error.message === 'AGENT_EVAL_CASE_LIMIT') {
        throw requestError(HttpStatus.CONFLICT, 'Agent evaluation dataset reached its case limit');
      }
      console.error('Failed to create Agent eval case:', toSafeError(error, requestId));
      throw requestError(500, 'Failed to create Agent evaluation case');
    }
  }

  async deleteCase(userId: string, caseId: string, requestId?: string) {
    try {
      const deleted = await deleteAgentEvalCaseForUser(caseId, userId);
      if (!deleted) throw requestError(HttpStatus.NOT_FOUND, 'Agent evaluation case not found');
      return { success: true };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      console.error('Failed to delete Agent eval case:', toSafeError(error, requestId));
      throw requestError(500, 'Failed to delete Agent evaluation case');
    }
  }

  async runDataset(
    userId: string,
    datasetId: string,
    body: AgentEvalRunBody,
    requestId?: string,
  ) {
    try {
      if (body.baseline_version_id === body.candidate_version_id) {
        throw requestError(HttpStatus.BAD_REQUEST, 'Baseline must be a different Agent version');
      }
      const candidate = await this.agentsService.getVersionForDryRun(
        userId,
        body.agent_id,
        body.candidate_version_id,
      );
      const baseline = body.baseline_version_id
        ? await this.agentsService.getVersionForDryRun(
          userId,
          body.agent_id,
          body.baseline_version_id,
        )
        : null;
      if (!candidate.validationReport.valid || (baseline && !baseline.validationReport.valid)) {
        throw requestError(
          HttpStatus.CONFLICT,
          'Every Agent version must pass static validation before evaluation',
        );
      }
      const validationReport = {
        valid: true,
        candidate: candidate.validationReport,
        baseline: baseline?.validationReport || null,
      };
      const run = await createAgentEvalRunForUser({
        userId,
        datasetId,
        agentId: body.agent_id,
        candidateAgentVersionId: body.candidate_version_id,
        candidateConfigurationHash: candidate.agent.configuration_hash,
        baselineAgentVersionId: body.baseline_version_id || null,
        baselineConfigurationHash: baseline?.agent.configuration_hash || null,
        validationReport,
        executionSnapshot: {
          evaluator_version: 'agent-eval-v1',
          candidate: {
            agent_id: body.agent_id,
            agent_version_id: body.candidate_version_id,
            configuration_hash: candidate.agent.configuration_hash,
            model: candidate.agent.model,
          },
          baseline: baseline ? {
            agent_id: body.agent_id,
            agent_version_id: body.baseline_version_id,
            configuration_hash: baseline.agent.configuration_hash,
            model: baseline.agent.model,
          } : null,
          temperature_override: 0,
          tool_mode: 'deterministic_fixture_replay',
          real_tool_execution: false,
          omitted_context: [
            'conversation_history',
            'persona',
            'long_term_memory',
            'project_context',
          ],
          provider_pricing: 'not_versioned_cost_unavailable',
        },
      });
      if (!run) throw requestError(HttpStatus.NOT_FOUND, 'Agent evaluation dataset not found');
      if (run.created) agentEvalQueue.trigger();
      void recordAgentAuditEvent({
        userId,
        agentId: body.agent_id,
        action: 'agent.version.evaluation.queued',
        metadata: {
          agent_eval_run_id: run.id,
          dataset_id: datasetId,
          candidate_version_id: body.candidate_version_id,
          baseline_version_id: body.baseline_version_id || null,
          dataset_revision: run.dataset_revision,
        },
      }).catch(() => undefined);
      return run;
    } catch (error) {
      if (error instanceof HttpException) throw error;
      if (error instanceof Error && error.message === 'AGENT_EVAL_DATASET_EMPTY') {
        throw requestError(HttpStatus.CONFLICT, 'Agent evaluation dataset has no cases');
      }
      if (error instanceof Error && error.message === 'AGENT_EVAL_RUN_CASE_LIMIT') {
        throw requestError(HttpStatus.CONFLICT, 'Agent evaluation dataset exceeds the run case limit');
      }
      if (error instanceof Error && error.message === 'AGENT_EVAL_ACTIVE_RUN_LIMIT') {
        throw requestError(HttpStatus.TOO_MANY_REQUESTS, 'Too many active Agent evaluations');
      }
      if (error instanceof Error && error.message === 'AGENT_EVAL_RUN_HISTORY_LIMIT') {
        throw requestError(HttpStatus.CONFLICT, 'Agent evaluation history quota reached; delete an old dataset');
      }
      console.error('Failed to queue Agent evaluation:', toSafeError(error, requestId));
      throw requestError(500, 'Failed to queue Agent evaluation');
    }
  }

  async getRun(userId: string, runId: string, requestId?: string) {
    try {
      const run = await getAgentEvalRunForUser(runId, userId);
      if (!run) throw requestError(HttpStatus.NOT_FOUND, 'Agent evaluation run not found');
      return run;
    } catch (error) {
      if (error instanceof HttpException) throw error;
      console.error('Failed to load Agent evaluation:', toSafeError(error, requestId));
      throw requestError(500, 'Failed to load Agent evaluation');
    }
  }

  async cancelRun(userId: string, runId: string, requestId?: string) {
    try {
      const run = await cancelAgentEvalRunForUser(runId, userId);
      if (!run) throw requestError(HttpStatus.NOT_FOUND, 'Running Agent evaluation not found');
      agentEvalQueue.abortRun(runId);
      return run;
    } catch (error) {
      if (error instanceof HttpException) throw error;
      console.error('Failed to cancel Agent evaluation:', toSafeError(error, requestId));
      throw requestError(500, 'Failed to cancel Agent evaluation');
    }
  }
}
