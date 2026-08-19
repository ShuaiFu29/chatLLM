export interface RagEvalCase {
  id: string;
  question: string;
  expected_answer: string;
  expected_keywords: string[];
  expected_source_files: string[];
  evaluation_spec?: RagEvalEvaluationSpec;
}

export interface RagEvalEvaluationSpec {
  tags?: string[];
  category?: string;
  difficulty?: 'easy' | 'medium' | 'hard';
  expected_chunk_ids?: string[];
  expected_evidence?: string[];
  expected_answerable?: boolean | null;
  expected_graph_relations?: Array<{
    source: string;
    relation: string;
    target: string;
    polarity?: 'affirmative' | 'negative';
    modality?: 'asserted' | 'conditional' | 'planned_or_obligatory' | 'historical';
  }>;
  human_scores?: Partial<Record<'correctness' | 'completeness' | 'faithfulness', number>>;
}

export interface RagEvalAdvancedMetricGroup {
  applicable?: boolean;
  case_count?: number;
  average_recall_at_k?: number | null;
  average_mrr_at_k?: number | null;
  average_precision_at_k?: number | null;
  average_endpoint_only_recall_at_k?: number | null;
  average_endpoint_only_precision_at_k?: number | null;
  accuracy?: number | null;
  false_answer_rate?: number | null;
  false_abstention_rate?: number | null;
  mae?: number | null;
  agreement_rate?: number | null;
}

export interface RagEvalTokenUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export interface RagEvalAdvancedMetrics {
  latency_ms?: {
    applicable?: boolean;
    p50?: number | null;
    p95?: number | null;
    max?: number | null;
  };
  chunk_retrieval?: RagEvalAdvancedMetricGroup;
  evidence_retrieval?: RagEvalAdvancedMetricGroup;
  graph_retrieval?: RagEvalAdvancedMetricGroup;
  answerability?: RagEvalAdvancedMetricGroup;
  judge_human_calibration?: RagEvalAdvancedMetricGroup;
  token_usage?: {
    applicable?: boolean;
    answer?: RagEvalTokenUsage;
    judge?: RagEvalTokenUsage;
  };
  cost?: {
    applicable?: boolean;
    reason?: string;
  };
  confidence_intervals?: Record<string, {
    applicable?: boolean;
    case_count?: number;
    mean?: number;
    lower?: number;
    upper?: number;
    confidence_level?: number;
  }>;
  slices?: Array<{
    slice: string;
    case_count: number;
    successful_case_count: number;
    average_retrieval_score?: number | null;
    average_answer_score?: number | null;
    average_grounding_score?: number | null;
  }>;
}

export interface RagEvalMatchedSource {
  chunk_id?: string | null;
  file_id?: string | null;
  filename?: string | null;
  chunk_index?: number | string | null;
  similarity?: number;
  agentic_score?: number;
}

export interface RagEvalTraceStep {
  step_type?: string;
  status?: string;
  duration_ms?: number;
  output?: Record<string, unknown>;
}

export interface RagEvalMetricApplicability {
  retrieval?: boolean;
  answer?: boolean;
  faithfulness?: boolean;
  overall?: boolean;
  expected_answer_support?: boolean;
  keyword_retrieval?: boolean;
  correctness?: boolean;
  completeness?: boolean;
  judge_faithfulness?: boolean;
  citation_precision?: boolean;
  citation_coverage?: boolean;
  citation_f1?: boolean;
  hallucination_rate?: boolean;
}

export interface RagEvalClaimEvaluation {
  verifier_version?: string;
  claims?: Array<{
    claim_index?: number;
    text?: string;
    supported?: boolean;
    citation_labels?: number[];
    reasons?: string[];
  }>;
}

export interface RagEvalTraceSummary {
  planned_queries?: string[];
  trace_steps?: RagEvalTraceStep[];
  metric_applicability?: RagEvalMetricApplicability;
}

export interface RagEvalResult {
  id: string;
  question: string;
  actual_answer?: string;
  status: 'success' | 'failed';
  overall_score: number;
  retrieval_score: number;
  answer_score: number;
  source_score: number;
  source_recall_score?: number;
  source_precision_score?: number;
  citation_accuracy_score?: number;
  keyword_score: number;
  answer_keyword_score?: number | null;
  grounding_score?: number;
  correctness_score?: number;
  completeness_score?: number;
  faithfulness_score?: number;
  citation_precision?: number;
  citation_coverage?: number;
  citation_f1?: number;
  hallucination_rate?: number;
  prompt_version?: string;
  model_version?: string;
  judge_version?: string;
  verifier_version?: string;
  claim_evaluation?: RagEvalClaimEvaluation;
  expected_answer_support_score?: number;
  expected_answer_support_label?: string;
  verification_score?: number;
  latency_ms?: number;
  evidence_label: string;
  support_label?: string;
  risk_level?: string;
  matched_sources?: RagEvalMatchedSource[];
  trace_summary?: RagEvalTraceSummary;
  metric_applicability?: RagEvalMetricApplicability;
  error_message: string;
  advanced_metrics?: RagEvalAdvancedMetrics;
}

export interface RagEvalRun {
  id: string;
  status: 'completed' | 'failed' | 'partial' | 'running' | 'cancelled';
  case_count: number;
  failed_count: number;
  average_overall_score: number;
  average_retrieval_score: number;
  average_answer_score: number;
  average_source_score: number;
  average_source_recall_score?: number;
  average_source_precision_score?: number;
  average_citation_accuracy_score?: number;
  average_keyword_score: number;
  average_answer_keyword_score?: number | null;
  average_grounding_score?: number;
  average_judge_score?: number;
  average_expected_answer_support_score?: number;
  average_verification_score?: number;
  duration_ms: number;
  created_at: string;
  results?: RagEvalResult[];
  metric_applicability?: RagEvalMetricApplicability;
  advanced_metrics?: RagEvalAdvancedMetrics;
  execution_snapshot?: Record<string, unknown>;
  baseline_run_id?: string | null;
}

export type RagEvalQualityTrendRun = Omit<
  RagEvalRun,
  'results' | 'advanced_metrics' | 'execution_snapshot'
>;

export interface RagEvalLowScoreCase {
  result_id: string;
  run_id: string;
  question: string;
  status: 'success' | 'failed';
  overall_score: number;
  retrieval_score: number;
  answer_score: number;
  source_score: number;
  source_recall_score?: number;
  source_precision_score?: number;
  citation_accuracy_score?: number;
  keyword_score: number;
  answer_keyword_score?: number | null;
  grounding_score?: number;
  expected_answer_support_score?: number;
  expected_answer_support_label?: string;
  verification_score?: number;
  evidence_label: string;
  support_label?: string;
  error_message: string;
  metric_applicability?: RagEvalMetricApplicability;
}

export interface RagEvalQualitySummary {
  dataset_id: string;
  run_count: number;
  latest_run_id?: string | null;
  trend_delta?: number | null;
  average_overall_score: number;
  average_retrieval_score: number;
  average_answer_score: number;
  average_source_score: number;
  average_source_recall_score?: number;
  average_source_precision_score?: number;
  average_citation_accuracy_score?: number;
  average_keyword_score: number;
  average_answer_keyword_score?: number | null;
  average_grounding_score?: number;
  average_expected_answer_support_score?: number;
  average_verification_score?: number;
  trend: RagEvalQualityTrendRun[];
  low_score_cases: RagEvalLowScoreCase[];
  metric_applicability?: RagEvalMetricApplicability;
  paired_comparison?: {
    baseline_run_id: string;
    current_run_id: string;
    matched_case_count: number;
    retrieval: { case_count: number; mean_delta: number | null; wins: number; ties: number; losses: number };
    answer: { case_count: number; mean_delta: number | null; wins: number; ties: number; losses: number };
    grounding: { case_count: number; mean_delta: number | null; wins: number; ties: number; losses: number };
  } | null;
}

export interface RagEvalHistoryQuality {
  retrieval_score?: number;
  citation_score?: number;
  evidence_score?: number;
  overall_score?: number;
  evidence_label?: string;
}

export interface RagEvalHistorySource extends RagEvalMatchedSource {
  content?: string;
}

export interface RagEvalHistoryItem {
  id: string;
  conversation_id: string;
  conversation_title: string;
  project_space_id?: string | null;
  project_space_name?: string | null;
  model?: string | null;
  assistant_message_id?: string | null;
  answer_preview: string;
  answer_length: number;
  mode: string;
  query: string;
  planned_queries: string[];
  trace_steps: RagEvalTraceStep[];
  quality: RagEvalHistoryQuality;
  retrieved_sources: RagEvalHistorySource[];
  status: string;
  created_at: string;
  updated_at: string;
}

export interface RagEvalHistoryResponse {
  items: RagEvalHistoryItem[];
}

export interface RagEvalDataset {
  id: string;
  project_space_id?: string | null;
  name: string;
  description: string;
  cases: RagEvalCase[];
  runs: RagEvalRun[];
}

export type RagEvalMetric = keyof RagEvalMetricApplicability;
