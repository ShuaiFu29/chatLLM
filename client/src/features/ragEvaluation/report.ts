import { getRagTraceStatusLabel, getRagTraceStepLabel } from '../../lib/ragTraceLabels';
import type {
  RagEvalAdvancedMetricGroup,
  RagEvalDataset,
  RagEvalMetric,
  RagEvalResult,
  RagEvalRun,
} from './model';

export const formatScore = (value?: number) => `${Math.round((value || 0) * 100)}%`;

export const resultMetricApplicability = (result: RagEvalResult, metric: RagEvalMetric) =>
  result.metric_applicability?.[metric] ?? result.trace_summary?.metric_applicability?.[metric];

export const runMetricApplicability = (run: RagEvalRun, metric: RagEvalMetric) => {
  const aggregate = run.metric_applicability?.[metric];
  if (typeof aggregate === 'boolean') return aggregate;
  const values = (run.results || [])
    .map((result) => resultMetricApplicability(result, metric))
    .filter((value): value is boolean => typeof value === 'boolean');
  return values.length > 0 ? values.some(Boolean) : undefined;
};

export const formatMetricScore = (value: number | undefined, applicable: boolean | undefined) =>
  applicable === true ? formatScore(value) : 'N/A';

export const formatAdvancedScore = (
  group: RagEvalAdvancedMetricGroup | undefined,
  value: number | null | undefined,
) => group?.applicable === true && typeof value === 'number' ? formatScore(value) : 'N/A';

export const formatAdvancedCount = (
  applicable: boolean | undefined,
  value: number | null | undefined,
  suffix = '',
) => applicable === true && typeof value === 'number' ? `${Math.round(value)}${suffix}` : 'N/A';

export const formatDate = (value?: string | Date) => {
  if (!value) return 'Unknown';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown';
  return date.toISOString();
};

export const createRagEvalRunExportFilename = (
  dataset: RagEvalDataset | null | undefined,
  run: RagEvalRun,
  exportedAt: string | Date = new Date(),
) => {
  const date = formatDate(exportedAt).slice(0, 10);
  const slug = (dataset?.name || 'rag-evaluation')
    .trim()
    .toLowerCase()
    .replace(/[/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || 'rag-evaluation';

  return `chatllm-rag-eval-${date}-${slug}-${run.id.slice(0, 8)}.md`;
};

export const buildRagEvalRunMarkdown = (
  dataset: RagEvalDataset | null | undefined,
  run: RagEvalRun,
  t: Parameters<typeof getRagTraceStepLabel>[0],
  exportedAt: string | Date = new Date(),
) => {
  const lines = [
    `# RAG Evaluation · ${dataset?.name || 'Untitled dataset'}`,
    '',
    `- Dataset: ${dataset?.name || 'Untitled dataset'}`,
    `- Description: ${dataset?.description || 'None'}`,
    `- Run ID: ${run.id}`,
    `- Baseline Run ID: ${run.baseline_run_id || 'N/A'}`,
    `- Status: ${run.status}`,
    `- Created: ${formatDate(run.created_at)}`,
    `- Exported: ${formatDate(exportedAt)}`,
    `- Cases: ${run.case_count}`,
    `- Failed cases: ${run.failed_count}`,
    `- Retrieval benchmark: ${formatMetricScore(run.average_overall_score, runMetricApplicability(run, 'overall'))}`,
    `- Retrieval score: ${formatMetricScore(run.average_retrieval_score, runMetricApplicability(run, 'retrieval'))}`,
    `- Answer score: ${formatMetricScore(run.average_answer_score, runMetricApplicability(run, 'answer'))}`,
    `- Source score: ${formatMetricScore(run.average_source_score, runMetricApplicability(run, 'retrieval'))}`,
    `- Source recall: ${formatMetricScore(run.average_source_recall_score ?? run.average_source_score, runMetricApplicability(run, 'retrieval'))}`,
    `- Source precision: ${formatMetricScore(run.average_source_precision_score, runMetricApplicability(run, 'retrieval'))}`,
    `- Citation accuracy: ${formatMetricScore(run.average_citation_accuracy_score, runMetricApplicability(run, 'faithfulness'))}`,
    `- Keyword score: ${formatMetricScore(run.average_keyword_score, runMetricApplicability(run, 'keyword_retrieval'))}`,
    `- Grounding score: ${formatMetricScore(run.average_grounding_score, runMetricApplicability(run, 'faithfulness'))}`,
    `- Expected answer support: ${formatMetricScore(run.average_expected_answer_support_score, runMetricApplicability(run, 'expected_answer_support'))}`,
    `- Verification score: ${formatMetricScore(run.average_verification_score, runMetricApplicability(run, 'faithfulness'))}`,
    `- Chunk Recall@K: ${formatAdvancedScore(run.advanced_metrics?.chunk_retrieval, run.advanced_metrics?.chunk_retrieval?.average_recall_at_k)}`,
    `- Evidence Recall@K: ${formatAdvancedScore(run.advanced_metrics?.evidence_retrieval, run.advanced_metrics?.evidence_retrieval?.average_recall_at_k)}`,
    `- Graph Recall@K: ${formatAdvancedScore(run.advanced_metrics?.graph_retrieval, run.advanced_metrics?.graph_retrieval?.average_recall_at_k)}`,
    `- Graph Precision@K: ${formatAdvancedScore(run.advanced_metrics?.graph_retrieval, run.advanced_metrics?.graph_retrieval?.average_precision_at_k)}`,
    `- Graph Endpoint-only Recall@K (diagnostic): ${formatAdvancedScore(run.advanced_metrics?.graph_retrieval, run.advanced_metrics?.graph_retrieval?.average_endpoint_only_recall_at_k)}`,
    `- Graph Endpoint-only Precision@K (diagnostic): ${formatAdvancedScore(run.advanced_metrics?.graph_retrieval, run.advanced_metrics?.graph_retrieval?.average_endpoint_only_precision_at_k)}`,
    `- Answerability accuracy: ${formatAdvancedScore(run.advanced_metrics?.answerability, run.advanced_metrics?.answerability?.accuracy)}`,
    `- Judge-human MAE: ${formatAdvancedScore(run.advanced_metrics?.judge_human_calibration, run.advanced_metrics?.judge_human_calibration?.mae)}`,
    `- Latency P50/P95: ${formatAdvancedCount(run.advanced_metrics?.latency_ms?.applicable, run.advanced_metrics?.latency_ms?.p50, 'ms')} / ${formatAdvancedCount(run.advanced_metrics?.latency_ms?.applicable, run.advanced_metrics?.latency_ms?.p95, 'ms')}`,
    `- Token usage: ${run.advanced_metrics?.token_usage?.applicable === true ? (run.advanced_metrics.token_usage.answer?.total_tokens || 0) + (run.advanced_metrics.token_usage.judge?.total_tokens || 0) : 'N/A'}`,
    '- Currency cost: N/A unless provider pricing is explicitly configured',
    `- Duration: ${run.duration_ms}ms`,
    '',
  ];

  if (run.execution_snapshot && Object.keys(run.execution_snapshot).length > 0) {
    lines.push('## Execution Snapshot', '', '```json');
    lines.push(JSON.stringify(run.execution_snapshot, null, 2), '```', '');
  }

  lines.push('---', '');

  for (const result of run.results || []) {
    const traceSteps = result.trace_summary?.trace_steps || [];
    const plannedQueries = result.trace_summary?.planned_queries || [];
    const matchedSources = result.matched_sources || [];
    const applicability = result.trace_summary?.metric_applicability;

    lines.push(`## ${result.question}`, '', `- Status: ${result.status}`);
    lines.push(`- Overall: ${formatMetricScore(result.overall_score, applicability?.overall)}`);
    lines.push(`- Retrieval: ${formatMetricScore(result.retrieval_score, applicability?.retrieval)}`);
    lines.push(`- Answer: ${formatMetricScore(result.answer_score, applicability?.answer)}`);
    lines.push(`- Correctness: ${formatMetricScore(result.correctness_score, applicability?.correctness)}`);
    lines.push(`- Completeness: ${formatMetricScore(result.completeness_score, applicability?.completeness)}`);
    lines.push(`- Judge faithfulness: ${formatMetricScore(result.faithfulness_score, applicability?.judge_faithfulness)}`);
    lines.push(`- Sources: ${formatMetricScore(result.source_score, applicability?.retrieval)}`);
    lines.push(`- Source recall: ${formatMetricScore(result.source_recall_score ?? result.source_score, applicability?.retrieval)}`);
    lines.push(`- Source precision: ${formatMetricScore(result.source_precision_score, applicability?.retrieval)}`);
    lines.push(`- Citation accuracy: ${formatMetricScore(result.citation_accuracy_score, applicability?.faithfulness)}`);
    lines.push(`- Citation precision: ${formatMetricScore(result.citation_precision, applicability?.citation_precision)}`);
    lines.push(`- Citation coverage: ${formatMetricScore(result.citation_coverage, applicability?.citation_coverage)}`);
    lines.push(`- Citation F1: ${formatMetricScore(result.citation_f1, applicability?.citation_f1)}`);
    lines.push(`- Hallucination rate: ${formatMetricScore(result.hallucination_rate, applicability?.hallucination_rate)}`);
    lines.push(`- Keywords: ${formatMetricScore(result.keyword_score, applicability?.keyword_retrieval)}`);
    lines.push(`- Grounding: ${formatMetricScore(result.grounding_score, applicability?.faithfulness)}`);
    lines.push(`- Expected answer support: ${formatMetricScore(result.expected_answer_support_score, applicability?.expected_answer_support)}`);
    lines.push(`- Verification: ${formatMetricScore(result.verification_score, applicability?.faithfulness)}`);
    lines.push(`- Latency: ${result.latency_ms ?? 0}ms`);
    lines.push(`- Evidence: ${result.evidence_label}`);
    lines.push(`- Expected answer support label: ${result.expected_answer_support_label || 'unknown'}`);
    lines.push(`- Support: ${result.support_label || 'unknown'}`);
    if (result.error_message) lines.push(`- Error: ${result.error_message}`);
    lines.push('');

    if (result.actual_answer) lines.push('### Actual Answer', '', result.actual_answer, '');
    if (plannedQueries.length > 0) {
      lines.push('### Planned Queries');
      plannedQueries.forEach((query, index) => lines.push(`${index + 1}. ${query}`));
      lines.push('');
    }
    if (matchedSources.length > 0) {
      lines.push('### Matched Sources');
      matchedSources.forEach((source, index) => {
        const sourceName = source.filename || source.file_id || source.chunk_id || 'Unknown source';
        const score = formatScore(source.agentic_score ?? source.similarity ?? 0);
        const chunk = source.chunk_index !== undefined && source.chunk_index !== null ? ` · chunk ${source.chunk_index}` : '';
        lines.push(`${index + 1}. ${sourceName}${chunk} · ${score}`);
      });
      lines.push('');
    }
    if (traceSteps.length > 0) {
      lines.push('### Trace Steps');
      traceSteps.forEach((step, index) => {
        lines.push(`${index + 1}. ${getRagTraceStepLabel(t, step.step_type)} · ${getRagTraceStatusLabel(t, step.status)} · ${step.duration_ms ?? 0}ms`);
      });
      lines.push('');
    }
  }

  return `${lines.join('\n').trimEnd()}\n`;
};
