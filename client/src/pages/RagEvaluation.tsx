import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  Ban,
  BarChart3,
  ClipboardCheck,
  Download,
  Eye,
  Loader2,
  MessageSquare,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Save,
  Trash2,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import api from '../lib/api';
import Modal from '../components/Modal';
import SelectField from '../components/SelectField';
import { useProjectSpaceStore } from '../stores/useProjectSpaceStore';
import { downloadTextFile } from '../lib/exportConversation';

interface RagEvalCase {
  id: string;
  question: string;
  expected_answer: string;
  expected_keywords: string[];
  expected_source_files: string[];
}

interface RagEvalMatchedSource {
  chunk_id?: string | null;
  file_id?: string | null;
  filename?: string | null;
  chunk_index?: number | string | null;
  similarity?: number;
  agentic_score?: number;
}

interface RagEvalTraceStep {
  step_type?: string;
  status?: string;
  duration_ms?: number;
  output?: Record<string, unknown>;
}

interface RagEvalTraceSummary {
  planned_queries?: string[];
  trace_steps?: RagEvalTraceStep[];
}

interface RagEvalResult {
  id: string;
  question: string;
  status: 'success' | 'failed';
  overall_score: number;
  retrieval_score: number;
  answer_score: number;
  source_score: number;
  keyword_score: number;
  evidence_label: string;
  matched_sources?: RagEvalMatchedSource[];
  trace_summary?: RagEvalTraceSummary;
  error_message: string;
}

interface RagEvalRun {
  id: string;
  status: 'completed' | 'failed' | 'partial' | 'running' | 'cancelled';
  case_count: number;
  failed_count: number;
  average_overall_score: number;
  average_retrieval_score: number;
  average_answer_score: number;
  average_source_score: number;
  average_keyword_score: number;
  duration_ms: number;
  created_at: string;
  results?: RagEvalResult[];
}

interface RagEvalQualityTrendRun {
  id: string;
  status: RagEvalRun['status'];
  case_count: number;
  failed_count: number;
  average_overall_score: number;
  average_retrieval_score: number;
  average_answer_score: number;
  average_source_score: number;
  average_keyword_score: number;
  duration_ms: number;
  created_at: string;
}

interface RagEvalLowScoreCase {
  result_id: string;
  run_id: string;
  question: string;
  status: 'success' | 'failed';
  overall_score: number;
  retrieval_score: number;
  answer_score: number;
  source_score: number;
  keyword_score: number;
  evidence_label: string;
  error_message: string;
}

interface RagEvalQualitySummary {
  dataset_id: string;
  run_count: number;
  latest_run_id?: string | null;
  trend_delta?: number | null;
  average_overall_score: number;
  average_retrieval_score: number;
  average_answer_score: number;
  average_source_score: number;
  average_keyword_score: number;
  trend: RagEvalQualityTrendRun[];
  low_score_cases: RagEvalLowScoreCase[];
}

interface RagEvalHistoryQuality {
  retrieval_score?: number;
  citation_score?: number;
  evidence_score?: number;
  overall_score?: number;
  evidence_label?: string;
}

interface RagEvalHistorySource extends RagEvalMatchedSource {
  content?: string;
}

interface RagEvalHistoryItem {
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

interface RagEvalHistoryResponse {
  items: RagEvalHistoryItem[];
}

interface RagEvalDataset {
  id: string;
  project_space_id?: string | null;
  name: string;
  description: string;
  cases: RagEvalCase[];
  runs: RagEvalRun[];
}

const emptyDatasetDraft = {
  name: '',
  description: '',
  project_space_id: '',
};

const emptyCaseDraft = {
  question: '',
  expected_answer: '',
  expected_keywords: '',
  expected_source_files: '',
};

const MAX_RAG_EVAL_CASES_PER_DATASET = 50;

type DatasetModalMode = 'create' | 'edit' | null;

const splitList = (value: string) => value
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);

const formatScore = (value?: number) => `${Math.round((value || 0) * 100)}%`;

const formatDate = (value?: string | Date) => {
  if (!value) return 'Unknown';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown';
  return date.toISOString();
};

const createRagEvalRunExportFilename = (
  dataset: RagEvalDataset | null | undefined,
  run: RagEvalRun,
  exportedAt: string | Date = new Date()
) => {
  const date = formatDate(exportedAt).slice(0, 10);
  const slug = (dataset?.name || 'rag-evaluation')
    .trim()
    .toLowerCase()
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || 'rag-evaluation';

  return `chatllm-rag-eval-${date}-${slug}-${run.id.slice(0, 8)}.md`;
};

const buildRagEvalRunMarkdown = (
  dataset: RagEvalDataset | null | undefined,
  run: RagEvalRun,
  exportedAt: string | Date = new Date()
) => {
  const lines = [
    `# RAG Evaluation · ${dataset?.name || 'Untitled dataset'}`,
    '',
    `- Dataset: ${dataset?.name || 'Untitled dataset'}`,
    `- Description: ${dataset?.description || 'None'}`,
    `- Run ID: ${run.id}`,
    `- Status: ${run.status}`,
    `- Created: ${formatDate(run.created_at)}`,
    `- Exported: ${formatDate(exportedAt)}`,
    `- Cases: ${run.case_count}`,
    `- Failed cases: ${run.failed_count}`,
    `- Overall score: ${formatScore(run.average_overall_score)}`,
    `- Retrieval score: ${formatScore(run.average_retrieval_score)}`,
    `- Answer score: ${formatScore(run.average_answer_score)}`,
    `- Source score: ${formatScore(run.average_source_score)}`,
    `- Keyword score: ${formatScore(run.average_keyword_score)}`,
    `- Duration: ${run.duration_ms}ms`,
    '',
    '---',
    '',
  ];

  for (const result of run.results || []) {
    const traceSteps = result.trace_summary?.trace_steps || [];
    const plannedQueries = result.trace_summary?.planned_queries || [];
    const matchedSources = result.matched_sources || [];

    lines.push(`## ${result.question}`);
    lines.push('');
    lines.push(`- Status: ${result.status}`);
    lines.push(`- Overall: ${formatScore(result.overall_score)}`);
    lines.push(`- Retrieval: ${formatScore(result.retrieval_score)}`);
    lines.push(`- Answer: ${formatScore(result.answer_score)}`);
    lines.push(`- Sources: ${formatScore(result.source_score)}`);
    lines.push(`- Keywords: ${formatScore(result.keyword_score)}`);
    lines.push(`- Evidence: ${result.evidence_label}`);
    if (result.error_message) lines.push(`- Error: ${result.error_message}`);
    lines.push('');

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
        lines.push(`${index + 1}. ${step.step_type || 'step'} · ${step.status || '-'} · ${step.duration_ms ?? 0}ms`);
      });
      lines.push('');
    }
  }

  return lines.join('\n').trimEnd() + '\n';
};

export default function RagEvaluationPage() {
  const { t } = useTranslation();
  const { projectSpaces, fetchProjectSpaces } = useProjectSpaceStore();
  const [datasets, setDatasets] = useState<RagEvalDataset[]>([]);
  const [selectedDatasetId, setSelectedDatasetId] = useState<string | null>(null);
  const [datasetDraft, setDatasetDraft] = useState(emptyDatasetDraft);
  const [caseDraft, setCaseDraft] = useState(emptyCaseDraft);
  const [datasetModalMode, setDatasetModalMode] = useState<DatasetModalMode>(null);
  const [datasetToDelete, setDatasetToDelete] = useState<RagEvalDataset | null>(null);
  const [isCaseModalOpen, setIsCaseModalOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [runningDatasetId, setRunningDatasetId] = useState<string | null>(null);
  const [cancellingRunId, setCancellingRunId] = useState<string | null>(null);
  const [selectedRun, setSelectedRun] = useState<RagEvalRun | null>(null);
  const [isRunModalOpen, setIsRunModalOpen] = useState(false);
  const [isLoadingRun, setIsLoadingRun] = useState(false);
  const [qualitySummary, setQualitySummary] = useState<RagEvalQualitySummary | null>(null);
  const [isQualityLoading, setIsQualityLoading] = useState(false);
  const [historyItems, setHistoryItems] = useState<RagEvalHistoryItem[]>([]);
  const [isHistoryLoading, setIsHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [selectedHistoryItem, setSelectedHistoryItem] = useState<RagEvalHistoryItem | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selectedDataset = useMemo(
    () => datasets.find((dataset) => dataset.id === selectedDatasetId) || datasets[0] || null,
    [datasets, selectedDatasetId]
  );
  const hasRunningRuns = useMemo(
    () => datasets.some((dataset) => (dataset.runs || []).some((run) => run.status === 'running')),
    [datasets]
  );
  const selectedDatasetCaseCount = selectedDataset?.cases.length || 0;
  const isSelectedDatasetAtCaseLimit = selectedDatasetCaseCount >= MAX_RAG_EVAL_CASES_PER_DATASET;
  const isSelectedDatasetRunning = !!selectedDataset?.runs?.some((run) => run.status === 'running');
  const latestRun = selectedDataset?.runs?.[0];
  const selectedQualityDatasetId = selectedDataset?.id || null;
  const latestRunRefreshKey = latestRun ? `${latestRun.id}:${latestRun.status}` : '';

  const fetchDatasets = useCallback(async (showLoading = true) => {
    if (showLoading) setIsLoading(true);
    setError(null);

    try {
      const { data } = await api.get<RagEvalDataset[]>('/rag-eval/datasets');
      setDatasets(data);
      setSelectedDatasetId((currentId) => currentId || data[0]?.id || null);
    } catch (fetchError) {
      console.error('Failed to load RAG eval datasets:', fetchError);
      setError(t('ragEval.loadFailed'));
    } finally {
      if (showLoading) setIsLoading(false);
    }
  }, [t]);

  const fetchHistory = useCallback(async () => {
    setIsHistoryLoading(true);
    setHistoryError(null);

    try {
      const { data } = await api.get<RagEvalHistoryResponse>('/rag-eval/history', {
        params: { limit: 50 },
      });
      setHistoryItems(data.items || []);
    } catch (fetchError) {
      console.error('Failed to load historical RAG runs:', fetchError);
      setHistoryError(t('ragEval.historyLoadFailed'));
    } finally {
      setIsHistoryLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void fetchProjectSpaces();
    void fetchDatasets();
    void fetchHistory();
  }, [fetchDatasets, fetchHistory, fetchProjectSpaces]);

  useEffect(() => {
    if (!hasRunningRuns) return undefined;

    const intervalId = window.setInterval(() => {
      void fetchDatasets(false);
    }, 3000);

    return () => window.clearInterval(intervalId);
  }, [fetchDatasets, hasRunningRuns]);

  useEffect(() => {
    if (!selectedQualityDatasetId) {
      setQualitySummary(null);
      return undefined;
    }

    let isCancelled = false;
    setIsQualityLoading(true);

    api.get<RagEvalQualitySummary>(`/rag-eval/datasets/${selectedQualityDatasetId}/quality`)
      .then(({ data }) => {
        if (!isCancelled) setQualitySummary(data);
      })
      .catch((qualityError) => {
        console.error('Failed to load RAG eval quality summary:', qualityError);
        if (!isCancelled) {
          setQualitySummary(null);
          setError(t('ragEval.qualityLoadFailed'));
        }
      })
      .finally(() => {
        if (!isCancelled) setIsQualityLoading(false);
      });

    return () => {
      isCancelled = true;
    };
  }, [selectedQualityDatasetId, latestRunRefreshKey, t]);

  const getWorkspaceName = (projectSpaceId?: string | null) => {
    if (!projectSpaceId) return t('ragEval.allWorkspaces');
    return projectSpaces.find((space) => space.id === projectSpaceId)?.name || t('workspace.fallbackName');
  };

  const getRunStatusLabel = (status: RagEvalRun['status']) => {
    if (status === 'running') return t('ragEval.runningStatus');
    if (status === 'completed') return t('ragEval.completedStatus');
    if (status === 'partial') return t('ragEval.partialStatus');
    if (status === 'cancelled') return t('ragEval.cancelledStatus');
    return t('ragEval.failedStatus');
  };

  const getEvidenceLabel = (label?: string) => {
    if (label === 'strong') return t('chat.ragEvidenceStrong');
    if (label === 'partial') return t('chat.ragEvidencePartial');
    if (label === 'weak') return t('chat.ragEvidenceWeak');
    return label || t('usage.notAvailable');
  };

  const formatHistorySourceName = (source: RagEvalHistorySource) => (
    source.filename || source.file_id || source.chunk_id || t('ragEval.unknownSource')
  ).replace(/\.(?:md|markdown)$/i, '');

  const getHistoryWorkspaceName = (item: RagEvalHistoryItem) => (
    item.project_space_name || getWorkspaceName(item.project_space_id)
  );

  const getHistoryScore = (item: RagEvalHistoryItem) => item.quality?.overall_score ?? 0;

  const mergeRunIntoDatasets = (runToMerge: RagEvalRun) => {
    setDatasets((current) => current.map((dataset) => ({
      ...dataset,
      runs: (dataset.runs || []).map((run) => (run.id === runToMerge.id ? runToMerge : run)),
    })));
  };

  const openCreateDataset = () => {
    setDatasetDraft(emptyDatasetDraft);
    setError(null);
    setDatasetModalMode('create');
  };

  const openEditDataset = (dataset: RagEvalDataset) => {
    setSelectedDatasetId(dataset.id);
    setDatasetDraft({
      name: dataset.name,
      description: dataset.description || '',
      project_space_id: dataset.project_space_id || '',
    });
    setError(null);
    setDatasetModalMode('edit');
  };

  const closeDatasetModal = () => {
    if (isSaving) return;
    setDatasetModalMode(null);
    setDatasetDraft(emptyDatasetDraft);
  };

  const openCreateCaseFromHistory = (item: RagEvalHistoryItem) => {
    const targetDatasetId = selectedDatasetId || selectedDataset?.id;
    if (!targetDatasetId || isSelectedDatasetAtCaseLimit) return;

    const sourceNames = Array.from(new Set(
      (item.retrieved_sources || [])
        .map((source) => formatHistorySourceName(source))
        .filter(Boolean)
    )).slice(0, 12);

    setSelectedDatasetId(targetDatasetId);
    setCaseDraft({
      question: item.query,
      expected_answer: item.answer_preview || '',
      expected_keywords: (item.planned_queries || []).slice(0, 8).join(', '),
      expected_source_files: sourceNames.join(', '),
    });
    setIsCaseModalOpen(true);
  };

  const handleSaveDataset = async () => {
    const name = datasetDraft.name.trim();
    if (!name) {
      setError(t('ragEval.datasetNameRequired'));
      return;
    }

    setIsSaving(true);
    setError(null);

    try {
      const payload = {
        name,
        description: datasetDraft.description.trim(),
        project_space_id: datasetDraft.project_space_id || null,
      };

      if (datasetModalMode === 'edit' && selectedDatasetId) {
        const { data } = await api.patch<RagEvalDataset>(`/rag-eval/datasets/${selectedDatasetId}`, payload);
        setDatasets((current) => current.map((dataset) => (
          dataset.id === selectedDatasetId
            ? { ...dataset, ...data, cases: dataset.cases, runs: dataset.runs }
            : dataset
        )));
        setDatasetModalMode(null);
        setDatasetDraft(emptyDatasetDraft);
        return;
      }

      const { data } = await api.post<RagEvalDataset>('/rag-eval/datasets', payload);
      setDatasets((current) => [data, ...current]);
      setSelectedDatasetId(data.id);
      setDatasetDraft(emptyDatasetDraft);
      setDatasetModalMode(null);
    } catch (saveError) {
      console.error('Failed to create RAG eval dataset:', saveError);
      setError(t('ragEval.saveFailed'));
    } finally {
      setIsSaving(false);
    }
  };

  const handleCreateCase = async () => {
    if (!selectedDatasetId) return;
    if (isSelectedDatasetAtCaseLimit) {
      setError(t('ragEval.maxCasesHint', { count: MAX_RAG_EVAL_CASES_PER_DATASET }));
      return;
    }

    const question = caseDraft.question.trim();
    if (!question) {
      setError(t('ragEval.questionRequired'));
      return;
    }

    setIsSaving(true);
    setError(null);

    try {
      const { data } = await api.post<RagEvalCase>(`/rag-eval/datasets/${selectedDatasetId}/cases`, {
        question,
        expected_answer: caseDraft.expected_answer.trim(),
        expected_keywords: splitList(caseDraft.expected_keywords),
        expected_source_files: splitList(caseDraft.expected_source_files),
      });

      setDatasets((current) => current.map((dataset) => (
        dataset.id === selectedDatasetId
          ? { ...dataset, cases: [...(dataset.cases || []), data] }
          : dataset
      )));
      setCaseDraft(emptyCaseDraft);
      setIsCaseModalOpen(false);
    } catch (saveError) {
      console.error('Failed to create RAG eval case:', saveError);
      setError(t('ragEval.saveFailed'));
    } finally {
      setIsSaving(false);
    }
  };

  const handleDeleteCase = async (caseId: string) => {
    try {
      await api.delete(`/rag-eval/cases/${caseId}`);
      setDatasets((current) => current.map((dataset) => ({
        ...dataset,
        cases: (dataset.cases || []).filter((testCase) => testCase.id !== caseId),
      })));
    } catch (deleteError) {
      console.error('Failed to delete RAG eval case:', deleteError);
      setError(t('ragEval.deleteCaseFailed'));
    }
  };

  const handleDeleteDataset = async () => {
    if (!datasetToDelete) return;

    setIsSaving(true);
    setError(null);

    try {
      await api.delete(`/rag-eval/datasets/${datasetToDelete.id}`);
      setDatasets((current) => current.filter((dataset) => dataset.id !== datasetToDelete.id));
      setSelectedDatasetId((currentId) => (currentId === datasetToDelete.id ? null : currentId));
      setDatasetToDelete(null);
    } catch (deleteError) {
      console.error('Failed to delete RAG eval dataset:', deleteError);
      setError(t('ragEval.deleteDatasetFailed'));
    } finally {
      setIsSaving(false);
    }
  };

  const handleRunEval = async (datasetId: string) => {
    setRunningDatasetId(datasetId);
    setError(null);

    try {
      const { data } = await api.post<RagEvalRun>(`/rag-eval/datasets/${datasetId}/runs`);
      setDatasets((current) => current.map((dataset) => (
        dataset.id === datasetId
          ? { ...dataset, runs: [data, ...(dataset.runs || [])] }
          : dataset
      )));
      toast.success(t('ragEval.runQueued'));
    } catch (runError) {
      console.error('Failed to run RAG eval:', runError);
      setError(t('ragEval.runFailed'));
    } finally {
      setRunningDatasetId(null);
    }
  };

  const handleCancelRun = async (runId: string) => {
    setCancellingRunId(runId);
    setError(null);

    try {
      const { data } = await api.post<RagEvalRun>(`/rag-eval/runs/${runId}/cancel`);
      mergeRunIntoDatasets(data);
      setSelectedRun((current) => (current?.id === data.id ? data : current));
      toast.success(t('ragEval.cancelSuccess'));
    } catch (cancelError) {
      console.error('Failed to cancel RAG eval run:', cancelError);
      setError(t('ragEval.cancelFailed'));
      toast.error(t('ragEval.cancelFailed'));
    } finally {
      setCancellingRunId(null);
    }
  };

  const handleViewRunDetails = async (runId: string) => {
    const cachedRun = datasets
      .flatMap((dataset) => dataset.runs || [])
      .find((run) => run.id === runId);

    setIsRunModalOpen(true);
    setSelectedRun(cachedRun || null);
    setIsLoadingRun(true);
    setError(null);

    if (cachedRun?.results?.length) {
      setIsLoadingRun(false);
      return;
    }

    try {
      const { data } = await api.get<RagEvalRun>(`/rag-eval/runs/${runId}`);
      setSelectedRun(data);
      mergeRunIntoDatasets(data);
    } catch (loadError) {
      console.error('Failed to load RAG eval run:', loadError);
      setError(t('ragEval.loadRunFailed'));
      setIsRunModalOpen(false);
    } finally {
      setIsLoadingRun(false);
    }
  };

  useEffect(() => {
    if (!isRunModalOpen || !selectedRun || selectedRun.status !== 'running') return undefined;

    const intervalId = window.setInterval(() => {
      api.get<RagEvalRun>(`/rag-eval/runs/${selectedRun.id}`)
        .then(({ data }) => {
          setSelectedRun(data);
          mergeRunIntoDatasets(data);
        })
        .catch((loadError) => {
          console.error('Failed to refresh RAG eval run:', loadError);
        });
    }, 3000);

    return () => window.clearInterval(intervalId);
  }, [isRunModalOpen, selectedRun]);

  const handleExportRunReport = () => {
    if (!selectedRun) return;

    try {
      const markdown = buildRagEvalRunMarkdown(selectedDataset, selectedRun);
      const filename = createRagEvalRunExportFilename(selectedDataset, selectedRun);
      downloadTextFile(filename, markdown);
      setError(null);
      toast.success(t('ragEval.exportSuccess'));
    } catch (exportError) {
      console.error('Failed to export RAG eval run:', exportError);
      setError(t('ragEval.exportFailed'));
      toast.error(t('ragEval.exportFailed'));
    }
  };

  const qualityTrendDelta = qualitySummary?.trend_delta ?? null;
  const qualityTrendDeltaLabel = qualityTrendDelta === null
    ? t('ragEval.notEnoughRuns')
    : `${qualityTrendDelta >= 0 ? '+' : ''}${formatScore(qualityTrendDelta)}`;
  const visibleHistoryItems = historyItems.slice(0, 8);

  return (
    <div className="flex h-full flex-col bg-bg-base text-text-main">
      <div className="border-b border-border bg-bg-sidebar p-4">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="flex items-center gap-2 text-xl font-semibold">
              <ClipboardCheck className="h-5 w-5 text-primary" />
              {t('ragEval.title')}
            </h1>
            <p className="mt-1 text-sm text-text-muted">{t('ragEval.subtitle')}</p>
          </div>
          <button
            onClick={openCreateDataset}
            className="flex items-center justify-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm text-white transition-colors hover:bg-primary-hover"
          >
            <Plus className="h-4 w-4" />
            {t('ragEval.newDataset')}
          </button>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden lg:grid-cols-[320px_minmax(0,1fr)]">
        <aside className="border-b border-border bg-bg-sidebar p-4 lg:border-b-0 lg:border-r">
          <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-text-muted">{t('ragEval.benchmarkDatasets')}</div>
          {isLoading ? (
            <div className="flex items-center gap-2 text-sm text-text-muted">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t('common.loading')}
            </div>
          ) : datasets.length === 0 ? (
            <button
              onClick={openCreateDataset}
              className="w-full rounded-lg border border-dashed border-border p-4 text-center text-sm text-text-muted transition-colors hover:border-primary/60 hover:text-text-main"
            >
              {t('ragEval.emptyDatasets')}
            </button>
          ) : (
            <div className="space-y-2">
              {datasets.map((dataset) => (
                <div
                  key={dataset.id}
                  className={`rounded-lg border transition-colors ${
                    selectedDataset?.id === dataset.id
                      ? 'border-primary/60 bg-primary/10 text-text-main'
                      : 'border-border bg-bg-base text-text-muted hover:bg-bg-surface hover:text-text-main'
                  }`}
                >
                  <div className="flex items-start gap-2 p-3">
                    <button
                      onClick={() => setSelectedDatasetId(dataset.id)}
                      className="min-w-0 flex-1 text-left"
                    >
                      <div className="truncate text-sm font-medium">{dataset.name}</div>
                      <div className="mt-1 text-xs">{getWorkspaceName(dataset.project_space_id)}</div>
                      <div className="mt-2 text-[11px]">
                        {t('ragEval.caseCount', { count: dataset.cases?.length || 0 })}
                      </div>
                    </button>
                    <div className="flex shrink-0 gap-1">
                      <button
                        onClick={() => openEditDataset(dataset)}
                        className="rounded-md p-1.5 text-text-muted transition-colors hover:bg-bg-base hover:text-text-main"
                        aria-label={t('ragEval.editDataset')}
                        title={t('ragEval.editDataset')}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={() => setDatasetToDelete(dataset)}
                        className="rounded-md p-1.5 text-text-muted transition-colors hover:bg-red-500/10 hover:text-red-300"
                        aria-label={t('ragEval.deleteDataset')}
                        title={t('ragEval.deleteDataset')}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </aside>

        <main className="min-h-0 overflow-y-auto p-4 md:p-6">
          {error && (
            <div className="mb-4 flex items-center gap-2 rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-300">
              <AlertCircle className="h-4 w-4 shrink-0" />
              {error}
            </div>
          )}

          <div className="mx-auto max-w-6xl space-y-4">
            <section className="rounded-lg border border-border bg-bg-sidebar p-4">
              <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <h2 className="flex items-center gap-2 font-semibold">
                    <MessageSquare className="h-4 w-4 text-primary" />
                    {t('ragEval.historyTitle')}
                  </h2>
                  <p className="mt-1 text-xs text-text-muted">{t('ragEval.historyHint')}</p>
                </div>
                <button
                  onClick={fetchHistory}
                  disabled={isHistoryLoading}
                  className="inline-flex items-center justify-center gap-2 rounded-lg border border-border px-3 py-2 text-sm text-text-muted transition-colors hover:bg-bg-base hover:text-text-main disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <RefreshCw className={`h-4 w-4 ${isHistoryLoading ? 'animate-spin' : ''}`} />
                  {t('usage.refresh')}
                </button>
              </div>

              {historyError && (
                <div className="mb-3 flex items-center gap-2 rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-300">
                  <AlertCircle className="h-4 w-4 shrink-0" />
                  {historyError}
                </div>
              )}

              {isHistoryLoading ? (
                <div className="flex min-h-28 items-center justify-center gap-2 text-sm text-text-muted">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t('common.loading')}
                </div>
              ) : visibleHistoryItems.length === 0 ? (
                <div className="flex min-h-28 flex-col items-center justify-center gap-2 text-center text-sm text-text-muted">
                  <MessageSquare className="h-8 w-8 opacity-30" />
                  <p>{t('ragEval.historyEmpty')}</p>
                </div>
              ) : (
                <div className="grid gap-3 xl:grid-cols-2">
                  {visibleHistoryItems.map((item) => {
                    const retrievedSources = item.retrieved_sources || [];
                    const plannedQueries = item.planned_queries || [];
                    const score = getHistoryScore(item);

                    return (
                      <div key={item.id} className="min-w-0 rounded-lg border border-border bg-bg-base p-4">
                        <div className="mb-3 flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px] text-text-muted">
                              <span className="rounded border border-primary/30 bg-primary/10 px-2 py-0.5 uppercase text-primary">
                                {item.mode}
                              </span>
                              <span className="rounded border border-border px-2 py-0.5">
                                {getEvidenceLabel(item.quality?.evidence_label)}
                              </span>
                              <span className="rounded border border-border px-2 py-0.5">
                                {formatScore(score)}
                              </span>
                            </div>
                            <p className="line-clamp-2 break-words text-sm font-medium">{item.query}</p>
                          </div>
                          <span className="shrink-0 text-xs text-text-muted">{formatDate(item.created_at).slice(0, 10)}</span>
                        </div>

                        <p className="line-clamp-2 break-words text-xs leading-5 text-text-muted">
                          {item.answer_preview || t('usage.notAvailable')}
                        </p>

                        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-text-muted">
                          <span>{t('ragEval.historyConversation')}: {item.conversation_title || t('sidebar.newChat')}</span>
                          <span>{t('usage.workspace')}: {getHistoryWorkspaceName(item)}</span>
                          <span>{t('ragEval.historySources')}: {retrievedSources.length}</span>
                          <span>{t('ragEval.historyTrace')}: {plannedQueries.length}</span>
                        </div>

                        <div className="mt-3 flex flex-wrap gap-2">
                          <button
                            onClick={() => setSelectedHistoryItem(item)}
                            className="inline-flex items-center justify-center gap-2 rounded-lg border border-border px-3 py-2 text-xs text-text-muted transition-colors hover:bg-bg-sidebar hover:text-text-main"
                          >
                            <Eye className="h-3.5 w-3.5" />
                            {t('ragEval.historyOpenDetails')}
                          </button>
                          <button
                            onClick={() => openCreateCaseFromHistory(item)}
                            disabled={!selectedDataset || isSelectedDatasetAtCaseLimit}
                            className="inline-flex items-center justify-center gap-2 rounded-lg border border-border px-3 py-2 text-xs text-text-muted transition-colors hover:bg-bg-sidebar hover:text-text-main disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            <Plus className="h-3.5 w-3.5" />
                            {t('ragEval.historyAddToDataset')}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>

            {!selectedDataset ? (
              <section className="flex min-h-60 flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border bg-bg-sidebar p-8 text-center text-text-muted">
                <ClipboardCheck className="h-12 w-12 opacity-30" />
                <h2 className="text-base font-semibold text-text-main">{t('ragEval.benchmarkTitle')}</h2>
                <p className="max-w-xl text-sm">{t('ragEval.emptyState')}</p>
              </section>
            ) : (
              <>
              <section className="rounded-lg border border-border bg-bg-sidebar p-4">
                <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                  <div>
                    <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-text-muted">
                      {t('ragEval.benchmarkTitle')}
                    </p>
                    <h2 className="text-lg font-semibold">{selectedDataset.name}</h2>
                    <p className="mt-1 text-sm text-text-muted">
                      {selectedDataset.description || t('ragEval.noDescription')}
                    </p>
                    <p className="mt-1 text-xs text-text-muted">{t('ragEval.benchmarkHint')}</p>
                    <p className="mt-2 text-xs text-text-muted">{getWorkspaceName(selectedDataset.project_space_id)}</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={() => openEditDataset(selectedDataset)}
                      className="flex items-center justify-center gap-2 rounded-lg border border-border px-3 py-2 text-sm text-text-muted transition-colors hover:text-text-main"
                    >
                      <Pencil className="h-4 w-4" />
                      {t('common.edit')}
                    </button>
                    <button
                      onClick={() => setDatasetToDelete(selectedDataset)}
                      className="flex items-center justify-center gap-2 rounded-lg border border-red-500/30 px-3 py-2 text-sm text-red-300 transition-colors hover:bg-red-500/10"
                    >
                      <Trash2 className="h-4 w-4" />
                      {t('common.delete')}
                    </button>
                    <button
                      onClick={() => setIsCaseModalOpen(true)}
                      disabled={isSelectedDatasetAtCaseLimit}
                      className="flex items-center justify-center gap-2 rounded-lg border border-border px-3 py-2 text-sm text-text-muted transition-colors hover:text-text-main disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <Plus className="h-4 w-4" />
                      {t('ragEval.addCase')}
                    </button>
                    <button
                      onClick={() => handleRunEval(selectedDataset.id)}
                      disabled={runningDatasetId === selectedDataset.id || isSelectedDatasetRunning || selectedDataset.cases.length === 0}
                      className="flex items-center justify-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm text-white transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {runningDatasetId === selectedDataset.id || isSelectedDatasetRunning
                        ? <Loader2 className="h-4 w-4 animate-spin" />
                        : <Play className="h-4 w-4" />}
                      {runningDatasetId === selectedDataset.id || isSelectedDatasetRunning
                        ? t('ragEval.runningStatus')
                        : t('ragEval.runEval')}
                    </button>
                  </div>
                </div>
                {isSelectedDatasetAtCaseLimit && (
                  <p className="mt-3 rounded-lg border border-amber-500/20 bg-amber-500/10 p-3 text-xs text-amber-200">
                    {t('ragEval.maxCasesHint', { count: MAX_RAG_EVAL_CASES_PER_DATASET })}
                  </p>
                )}
              </section>

              <section className="rounded-lg border border-border bg-bg-sidebar p-4">
                <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <h3 className="flex items-center gap-2 font-semibold">
                      <BarChart3 className="h-4 w-4 text-primary" />
                      {t('ragEval.qualityDashboard')}
                    </h3>
                    <p className="mt-1 text-xs text-text-muted">{t('ragEval.qualityDashboardHint')}</p>
                  </div>
                  {isQualityLoading && (
                    <div className="flex items-center gap-2 text-xs text-text-muted">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      {t('common.loading')}
                    </div>
                  )}
                </div>

                <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_360px]">
                  <div className="space-y-3">
                    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                      <div className="rounded-lg border border-border bg-bg-base p-3">
                        <p className="text-xs text-text-muted">{t('ragEval.evaluatedRuns')}</p>
                        <p className="mt-1 text-lg font-semibold">{qualitySummary?.run_count || 0}</p>
                      </div>
                      <div className="rounded-lg border border-border bg-bg-base p-3">
                        <p className="text-xs text-text-muted">{t('ragEval.latestOverall')}</p>
                        <p className="mt-1 text-lg font-semibold">{formatScore(qualitySummary?.average_overall_score)}</p>
                      </div>
                      <div className="rounded-lg border border-border bg-bg-base p-3">
                        <p className="text-xs text-text-muted">{t('ragEval.retrievalScore')}</p>
                        <p className="mt-1 text-lg font-semibold">{formatScore(qualitySummary?.average_retrieval_score)}</p>
                      </div>
                      <div className="rounded-lg border border-border bg-bg-base p-3">
                        <p className="text-xs text-text-muted">{t('ragEval.trendDelta')}</p>
                        <p className={`mt-1 text-lg font-semibold ${
                          qualityTrendDelta === null
                            ? 'text-text-muted'
                            : qualityTrendDelta >= 0
                              ? 'text-emerald-300'
                              : 'text-red-300'
                        }`}
                        >
                          {qualityTrendDeltaLabel}
                        </p>
                      </div>
                    </div>

                    <div className="rounded-lg border border-border bg-bg-base p-3">
                      <div className="mb-3 flex items-center justify-between gap-3">
                        <p className="text-xs font-semibold uppercase tracking-wide text-text-muted">
                          {t('ragEval.trendChart')}
                        </p>
                        <span className="text-xs text-text-muted">{t('ragEval.overallScore')}</span>
                      </div>
                      {qualitySummary?.trend?.length ? (
                        <div className="space-y-2">
                          {qualitySummary.trend.map((run, index) => (
                            <div key={run.id} className="grid grid-cols-[64px_minmax(0,1fr)_48px] items-center gap-2 text-xs">
                              <span className="text-text-muted">#{index + 1}</span>
                              <div className="h-2 overflow-hidden rounded-full bg-bg-surface">
                                <div
                                  className="h-full rounded-full bg-primary"
                                  style={{ width: `${Math.max(Math.round(run.average_overall_score * 100), 4)}%` }}
                                />
                              </div>
                              <span className="text-right text-text-muted">{formatScore(run.average_overall_score)}</span>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="text-sm text-text-muted">{t('ragEval.noRunResults')}</p>
                      )}
                    </div>
                  </div>

                  <div className="rounded-lg border border-border bg-bg-base p-3">
                    <div className="mb-3 flex items-center justify-between gap-3">
                      <p className="text-xs font-semibold uppercase tracking-wide text-text-muted">
                        {t('ragEval.lowScoreCases')}
                      </p>
                    </div>
                    {qualitySummary?.low_score_cases?.length ? (
                      <div className="space-y-3">
                        {qualitySummary.low_score_cases.map((testCase) => (
                          <button
                            key={testCase.result_id}
                            onClick={() => handleViewRunDetails(testCase.run_id)}
                            className="w-full rounded-lg border border-border p-3 text-left transition-colors hover:border-primary/50 hover:bg-bg-sidebar"
                          >
                            <div className="flex items-start justify-between gap-3">
                              <p className="line-clamp-2 text-sm font-medium">{testCase.question}</p>
                              <span className="shrink-0 rounded-full border border-border px-2 py-1 text-xs text-text-muted">
                                {formatScore(testCase.overall_score)}
                              </span>
                            </div>
                            <div className="mt-2 grid grid-cols-2 gap-2 text-[11px] text-text-muted">
                              <span>{t('ragEval.retrievalScore')}: {formatScore(testCase.retrieval_score)}</span>
                              <span>{t('ragEval.answerScore')}: {formatScore(testCase.answer_score)}</span>
                              <span>{t('ragEval.sourceScore')}: {formatScore(testCase.source_score)}</span>
                              <span>{t('ragEval.keywordScore')}: {formatScore(testCase.keyword_score)}</span>
                            </div>
                          </button>
                        ))}
                      </div>
                    ) : (
                      <p className="text-sm text-text-muted">{t('ragEval.noLowScoreCases')}</p>
                    )}
                  </div>
                </div>
              </section>

              {latestRun && (
                <section className="rounded-lg border border-border bg-bg-sidebar p-4">
                  <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <h3 className="font-semibold">{t('ragEval.latestRuns')}</h3>
                    <div className="flex flex-wrap gap-2">
                      {latestRun.status === 'running' && (
                        <button
                          onClick={() => handleCancelRun(latestRun.id)}
                          disabled={cancellingRunId === latestRun.id}
                          className="inline-flex items-center justify-center gap-2 rounded-lg border border-red-500/30 px-3 py-2 text-sm text-red-300 transition-colors hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {cancellingRunId === latestRun.id
                            ? <Loader2 className="h-4 w-4 animate-spin" />
                            : <Ban className="h-4 w-4" />}
                          {t('ragEval.cancelRun')}
                        </button>
                      )}
                      <button
                        onClick={() => handleViewRunDetails(latestRun.id)}
                        className="inline-flex items-center justify-center gap-2 rounded-lg border border-border px-3 py-2 text-sm text-text-muted transition-colors hover:bg-bg-base hover:text-text-main"
                      >
                        <Eye className="h-4 w-4" />
                        {t('ragEval.viewRunDetails')}
                      </button>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
                    <div className="rounded-lg border border-border bg-bg-base p-3">
                      <p className="text-xs text-text-muted">{t('ragEval.overallScore')}</p>
                      <p className="mt-1 text-lg font-semibold">{formatScore(latestRun.average_overall_score)}</p>
                    </div>
                    <div className="rounded-lg border border-border bg-bg-base p-3">
                      <p className="text-xs text-text-muted">{t('ragEval.retrievalScore')}</p>
                      <p className="mt-1 text-lg font-semibold">{formatScore(latestRun.average_retrieval_score)}</p>
                    </div>
                    <div className="rounded-lg border border-border bg-bg-base p-3">
                      <p className="text-xs text-text-muted">{t('ragEval.answerScore')}</p>
                      <p className="mt-1 text-lg font-semibold">{formatScore(latestRun.average_answer_score)}</p>
                    </div>
                    <div className="rounded-lg border border-border bg-bg-base p-3">
                      <p className="text-xs text-text-muted">{t('ragEval.sourceScore')}</p>
                      <p className="mt-1 text-lg font-semibold">{formatScore(latestRun.average_source_score)}</p>
                    </div>
                    <div className="rounded-lg border border-border bg-bg-base p-3">
                      <p className="text-xs text-text-muted">{t('ragEval.keywordScore')}</p>
                      <p className="mt-1 text-lg font-semibold">{formatScore(latestRun.average_keyword_score)}</p>
                    </div>
                    <div className="rounded-lg border border-border bg-bg-base p-3">
                      <p className="text-xs text-text-muted">{t('ragEval.failedCases')}</p>
                      <p className="mt-1 text-lg font-semibold">{latestRun.failed_count}/{latestRun.case_count}</p>
                    </div>
                  </div>
                  {latestRun.results && latestRun.results.length > 0 && (
                    <div className="mt-4 overflow-hidden rounded-lg border border-border">
                      <table className="w-full table-fixed text-sm">
                        <thead className="bg-bg-base text-xs text-text-muted">
                          <tr>
                            <th className="w-[45%] px-3 py-2 text-left">{t('ragEval.question')}</th>
                            <th className="px-3 py-2 text-left">{t('ragEval.overallScore')}</th>
                            <th className="px-3 py-2 text-left">{t('ragEval.evidence')}</th>
                            <th className="px-3 py-2 text-left">{t('ragEval.status')}</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                          {latestRun.results.map((result) => (
                            <tr key={result.id || result.question}>
                              <td className="truncate px-3 py-2">{result.question}</td>
                              <td className="px-3 py-2">{formatScore(result.overall_score)}</td>
                              <td className="px-3 py-2">{result.evidence_label}</td>
                              <td className="px-3 py-2">{result.status}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </section>
              )}

              {selectedDataset.runs.length > 0 && (
                <section className="rounded-lg border border-border bg-bg-sidebar p-4">
                  <h3 className="mb-3 font-semibold">{t('ragEval.runHistory')}</h3>
                  <div className="overflow-hidden rounded-lg border border-border">
                    <table className="w-full table-fixed text-sm">
                      <thead className="bg-bg-base text-xs text-text-muted">
                        <tr>
                          <th className="w-[28%] px-3 py-2 text-left">{t('ragEval.createdAt')}</th>
                          <th className="px-3 py-2 text-left">{t('ragEval.overallScore')}</th>
                          <th className="px-3 py-2 text-left">{t('ragEval.failedCases')}</th>
                          <th className="px-3 py-2 text-left">{t('ragEval.status')}</th>
                          <th className="w-[132px] px-3 py-2 text-right">{t('common.actions')}</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {selectedDataset.runs.map((run) => (
                          <tr key={run.id}>
                            <td className="truncate px-3 py-2 text-xs text-text-muted">{formatDate(run.created_at)}</td>
                            <td className="px-3 py-2">{formatScore(run.average_overall_score)}</td>
                            <td className="px-3 py-2">{run.failed_count}/{run.case_count}</td>
                            <td className="px-3 py-2">{getRunStatusLabel(run.status)}</td>
                            <td className="px-3 py-2 text-right">
                              {run.status === 'running' && (
                                <button
                                  onClick={() => handleCancelRun(run.id)}
                                  disabled={cancellingRunId === run.id}
                                  className="mr-1 inline-flex items-center justify-center rounded-lg p-2 text-red-300 transition-colors hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-50"
                                  aria-label={t('ragEval.cancelRun')}
                                  title={t('ragEval.cancelRun')}
                                >
                                  {cancellingRunId === run.id
                                    ? <Loader2 className="h-4 w-4 animate-spin" />
                                    : <Ban className="h-4 w-4" />}
                                </button>
                              )}
                              <button
                                onClick={() => handleViewRunDetails(run.id)}
                                className="inline-flex items-center justify-center rounded-lg p-2 text-text-muted transition-colors hover:bg-bg-base hover:text-text-main"
                                aria-label={t('ragEval.viewRunDetails')}
                                title={t('ragEval.viewRunDetails')}
                              >
                                <Eye className="h-4 w-4" />
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              )}

              <section className="rounded-lg border border-border bg-bg-sidebar">
                <div className="flex items-center justify-between border-b border-border p-4">
                  <div>
                    <h3 className="font-semibold">{t('ragEval.cases')}</h3>
                    <p className="mt-1 text-xs text-text-muted">{t('ragEval.casesHint')}</p>
                  </div>
                </div>
                {selectedDataset.cases.length === 0 ? (
                  <div className="p-8 text-center text-sm text-text-muted">{t('ragEval.emptyCases')}</div>
                ) : (
                  <div className="divide-y divide-border">
                    {selectedDataset.cases.map((testCase) => (
                      <div key={testCase.id} className="flex items-start gap-3 p-4">
                        <div className="min-w-0 flex-1">
                          <p className="break-words text-sm font-medium">{testCase.question}</p>
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            {testCase.expected_keywords.map((keyword) => (
                              <span key={keyword} className="rounded-full bg-bg-base px-2 py-1 text-[11px] text-text-muted">
                                {keyword}
                              </span>
                            ))}
                            {testCase.expected_source_files.map((source) => (
                              <span key={source} className="rounded-full border border-border px-2 py-1 text-[11px] text-text-muted">
                                {source}
                              </span>
                            ))}
                          </div>
                        </div>
                        <button
                          onClick={() => handleDeleteCase(testCase.id)}
                          className="rounded-lg p-2 text-text-muted transition-colors hover:bg-red-500/10 hover:text-red-300"
                          aria-label={t('ragEval.deleteCase')}
                          title={t('ragEval.deleteCase')}
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </section>
              </>
            )}
          </div>
        </main>
      </div>

      <Modal
        isOpen={!!selectedHistoryItem}
        onClose={() => setSelectedHistoryItem(null)}
        title={t('ragEval.historyDetails')}
        maxWidth="3xl"
        footer={
          <button
            onClick={() => setSelectedHistoryItem(null)}
            className="rounded-lg bg-primary px-4 py-2 text-sm text-white transition-colors hover:bg-primary-hover"
          >
            {t('common.close')}
          </button>
        }
      >
        {selectedHistoryItem && (
          <div className="max-h-[70vh] space-y-4 overflow-y-auto pr-1">
            <div>
              <p className="text-xs font-medium text-text-muted">{t('ragEval.question')}</p>
              <p className="mt-1 whitespace-pre-wrap break-words text-base font-semibold">
                {selectedHistoryItem.query}
              </p>
            </div>

            <div className="grid grid-cols-2 gap-3 text-xs md:grid-cols-4">
              <div className="rounded-lg border border-border bg-bg-base p-3">
                <p className="text-text-muted">{t('ragEval.historyConversation')}</p>
                <p className="mt-1 truncate text-text-main">
                  {selectedHistoryItem.conversation_title || t('sidebar.newChat')}
                </p>
              </div>
              <div className="rounded-lg border border-border bg-bg-base p-3">
                <p className="text-text-muted">{t('usage.workspace')}</p>
                <p className="mt-1 truncate text-text-main">{getHistoryWorkspaceName(selectedHistoryItem)}</p>
              </div>
              <div className="rounded-lg border border-border bg-bg-base p-3">
                <p className="text-text-muted">{t('ragEval.overallScore')}</p>
                <p className="mt-1 text-text-main">{formatScore(selectedHistoryItem.quality?.overall_score)}</p>
              </div>
              <div className="rounded-lg border border-border bg-bg-base p-3">
                <p className="text-text-muted">{t('ragEval.evidence')}</p>
                <p className="mt-1 text-text-main">{getEvidenceLabel(selectedHistoryItem.quality?.evidence_label)}</p>
              </div>
              <div className="rounded-lg border border-border bg-bg-base p-3">
                <p className="text-text-muted">{t('usage.model')}</p>
                <p className="mt-1 truncate text-text-main">{selectedHistoryItem.model || t('usage.notAvailable')}</p>
              </div>
              <div className="rounded-lg border border-border bg-bg-base p-3">
                <p className="text-text-muted">{t('ragEval.status')}</p>
                <p className="mt-1 text-text-main">{selectedHistoryItem.status}</p>
              </div>
              <div className="rounded-lg border border-border bg-bg-base p-3">
                <p className="text-text-muted">{t('ragEval.createdAt')}</p>
                <p className="mt-1 text-text-main">{formatDate(selectedHistoryItem.created_at).slice(0, 19)}</p>
              </div>
              <div className="rounded-lg border border-border bg-bg-base p-3">
                <p className="text-text-muted">{t('ragEval.historySources')}</p>
                <p className="mt-1 text-text-main">{selectedHistoryItem.retrieved_sources?.length || 0}</p>
              </div>
            </div>

            <div>
              <p className="mb-2 text-xs font-medium text-text-muted">{t('ragEval.historyAnswerPreview')}</p>
              <p className="whitespace-pre-wrap break-words rounded-lg border border-border bg-bg-base p-3 text-sm leading-6 text-text-muted">
                {selectedHistoryItem.answer_preview || t('usage.notAvailable')}
              </p>
            </div>

            <div className="grid gap-3 lg:grid-cols-2">
              <div className="rounded-lg border border-border bg-bg-base p-3">
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-muted">
                  {t('ragEval.historySources')}
                </p>
                {selectedHistoryItem.retrieved_sources?.length ? (
                  <div className="space-y-2">
                    {selectedHistoryItem.retrieved_sources.slice(0, 8).map((source, index) => (
                      <div key={`${source.file_id || source.chunk_id || source.filename || index}`} className="text-xs">
                        <div className="truncate text-text-main">{formatHistorySourceName(source)}</div>
                        <div className="mt-1 text-text-muted">
                          {source.chunk_index !== undefined && source.chunk_index !== null ? `#${source.chunk_index} · ` : ''}
                          {formatScore(source.agentic_score ?? source.similarity ?? 0)}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-text-muted">{t('ragEval.noMatchedSources')}</p>
                )}
              </div>

              <div className="rounded-lg border border-border bg-bg-base p-3">
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-muted">
                  {t('ragEval.historyTrace')}
                </p>
                {selectedHistoryItem.planned_queries?.length ? (
                  <div className="mb-3 flex flex-wrap gap-1.5">
                    {selectedHistoryItem.planned_queries.map((query, index) => (
                      <span key={`${selectedHistoryItem.id}-planned-${index}`} className="max-w-full truncate rounded-full bg-bg-sidebar px-2 py-1 text-[11px] text-text-muted">
                        {query}
                      </span>
                    ))}
                  </div>
                ) : null}
                {selectedHistoryItem.trace_steps?.length ? (
                  <div className="space-y-1.5">
                    {selectedHistoryItem.trace_steps.map((step, index) => (
                      <div key={`${step.step_type || 'step'}-${index}`} className="flex items-center justify-between gap-3 text-xs">
                        <span className="truncate text-text-main">{step.step_type || t('ragEval.traceStep')}</span>
                        <span className="shrink-0 text-text-muted">
                          {step.status || '-'} · {step.duration_ms ?? 0}ms
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-text-muted">{t('ragEval.noTraceSteps')}</p>
                )}
              </div>
            </div>
          </div>
        )}
      </Modal>

      <Modal
        isOpen={!!datasetModalMode}
        onClose={closeDatasetModal}
        title={datasetModalMode === 'edit' ? t('ragEval.editDataset') : t('ragEval.newDataset')}
        footer={
          <>
            <button
              onClick={closeDatasetModal}
              disabled={isSaving}
              className="rounded-lg border border-border px-4 py-2 text-sm text-text-muted transition-colors hover:text-text-main disabled:opacity-50"
            >
              {t('common.cancel')}
            </button>
            <button
              onClick={handleSaveDataset}
              disabled={isSaving}
              className="flex items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm text-white transition-colors hover:bg-primary-hover disabled:opacity-50"
            >
              {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              {isSaving ? t('common.saving') : t('common.save')}
            </button>
          </>
        }
      >
        <div className="space-y-4">
          <input
            value={datasetDraft.name}
            onChange={(event) => setDatasetDraft((draft) => ({ ...draft, name: event.target.value }))}
            className="w-full rounded-lg border border-border bg-bg-base px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
            placeholder={t('ragEval.datasetName')}
          />
          <textarea
            value={datasetDraft.description}
            onChange={(event) => setDatasetDraft((draft) => ({ ...draft, description: event.target.value }))}
            className="min-h-24 w-full rounded-lg border border-border bg-bg-base px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
            placeholder={t('ragEval.datasetDescription')}
          />
          <SelectField
            value={datasetDraft.project_space_id}
            onChange={(event) => setDatasetDraft((draft) => ({ ...draft, project_space_id: event.target.value }))}
            className="w-full"
          >
            <option value="">{t('ragEval.allWorkspaces')}</option>
            {projectSpaces.map((space) => (
              <option key={space.id} value={space.id}>{space.name}</option>
            ))}
          </SelectField>
        </div>
      </Modal>

      <Modal
        isOpen={isCaseModalOpen}
        onClose={() => setIsCaseModalOpen(false)}
        title={t('ragEval.addCase')}
        maxWidth="2xl"
        footer={
          <>
            <button
              onClick={() => setIsCaseModalOpen(false)}
              disabled={isSaving}
              className="rounded-lg border border-border px-4 py-2 text-sm text-text-muted transition-colors hover:text-text-main disabled:opacity-50"
            >
              {t('common.cancel')}
            </button>
            <button
              onClick={handleCreateCase}
              disabled={isSaving || isSelectedDatasetAtCaseLimit}
              className="rounded-lg bg-primary px-4 py-2 text-sm text-white transition-colors hover:bg-primary-hover disabled:opacity-50"
            >
              {isSaving ? t('common.saving') : t('common.save')}
            </button>
          </>
        }
      >
        <div className="space-y-4">
          {isSelectedDatasetAtCaseLimit && (
            <p className="rounded-lg border border-amber-500/20 bg-amber-500/10 p-3 text-xs text-amber-200">
              {t('ragEval.maxCasesHint', { count: MAX_RAG_EVAL_CASES_PER_DATASET })}
            </p>
          )}
          <textarea
            value={caseDraft.question}
            onChange={(event) => setCaseDraft((draft) => ({ ...draft, question: event.target.value }))}
            className="min-h-24 w-full rounded-lg border border-border bg-bg-base px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
            placeholder={t('ragEval.questionPlaceholder')}
          />
          <input
            value={caseDraft.expected_keywords}
            onChange={(event) => setCaseDraft((draft) => ({ ...draft, expected_keywords: event.target.value }))}
            className="w-full rounded-lg border border-border bg-bg-base px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
            placeholder={t('ragEval.expectedKeywords')}
          />
          <input
            value={caseDraft.expected_source_files}
            onChange={(event) => setCaseDraft((draft) => ({ ...draft, expected_source_files: event.target.value }))}
            className="w-full rounded-lg border border-border bg-bg-base px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
            placeholder={t('ragEval.expectedSources')}
          />
          <textarea
            value={caseDraft.expected_answer}
            onChange={(event) => setCaseDraft((draft) => ({ ...draft, expected_answer: event.target.value }))}
            className="min-h-20 w-full rounded-lg border border-border bg-bg-base px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
            placeholder={t('ragEval.expectedAnswer')}
          />
        </div>
      </Modal>

      <Modal
        isOpen={!!datasetToDelete}
        onClose={() => {
          if (!isSaving) setDatasetToDelete(null);
        }}
        title={t('ragEval.deleteDatasetTitle')}
        footer={
          <>
            <button
              onClick={() => setDatasetToDelete(null)}
              disabled={isSaving}
              className="rounded-lg border border-border px-4 py-2 text-sm text-text-muted transition-colors hover:text-text-main disabled:opacity-50"
            >
              {t('common.cancel')}
            </button>
            <button
              onClick={handleDeleteDataset}
              disabled={isSaving}
              className="flex items-center justify-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm text-white transition-colors hover:bg-red-500 disabled:opacity-50"
            >
              {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              {t('common.delete')}
            </button>
          </>
        }
      >
        <p className="text-sm text-text-muted">
          {t('ragEval.deleteDatasetConfirm', { name: datasetToDelete?.name || '' })}
        </p>
      </Modal>

      <Modal
        isOpen={isRunModalOpen}
        onClose={() => {
          setIsRunModalOpen(false);
          setSelectedRun(null);
        }}
        title={t('ragEval.runDetails')}
        maxWidth="3xl"
        footer={
          <>
            {selectedRun?.status === 'running' && (
              <button
                onClick={() => handleCancelRun(selectedRun.id)}
                disabled={cancellingRunId === selectedRun.id}
                className="flex items-center justify-center gap-2 rounded-lg border border-red-500/30 px-4 py-2 text-sm text-red-300 transition-colors hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {cancellingRunId === selectedRun.id
                  ? <Loader2 className="h-4 w-4 animate-spin" />
                  : <Ban className="h-4 w-4" />}
                {t('ragEval.cancelRun')}
              </button>
            )}
            <button
              onClick={handleExportRunReport}
              disabled={!selectedRun || isLoadingRun || selectedRun.status === 'running'}
              className="flex items-center justify-center gap-2 rounded-lg border border-border px-4 py-2 text-sm text-text-muted transition-colors hover:text-text-main disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Download className="h-4 w-4" />
              {t('ragEval.exportRunReport')}
            </button>
            <button
              onClick={() => {
                setIsRunModalOpen(false);
                setSelectedRun(null);
              }}
              className="rounded-lg bg-primary px-4 py-2 text-sm text-white transition-colors hover:bg-primary-hover"
            >
              {t('common.close')}
            </button>
          </>
        }
      >
        {isLoadingRun ? (
          <div className="flex min-h-32 items-center justify-center gap-2 text-sm text-text-muted">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('common.loading')}
          </div>
        ) : selectedRun ? (
          <div className="max-h-[70vh] space-y-4 overflow-y-auto pr-1">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
              <div className="rounded-lg border border-border bg-bg-base p-3">
                <p className="text-xs text-text-muted">{t('ragEval.overallScore')}</p>
                <p className="mt-1 text-lg font-semibold">{formatScore(selectedRun.average_overall_score)}</p>
              </div>
              <div className="rounded-lg border border-border bg-bg-base p-3">
                <p className="text-xs text-text-muted">{t('ragEval.retrievalScore')}</p>
                <p className="mt-1 text-lg font-semibold">{formatScore(selectedRun.average_retrieval_score)}</p>
              </div>
              <div className="rounded-lg border border-border bg-bg-base p-3">
                <p className="text-xs text-text-muted">{t('ragEval.answerScore')}</p>
                <p className="mt-1 text-lg font-semibold">{formatScore(selectedRun.average_answer_score)}</p>
              </div>
              <div className="rounded-lg border border-border bg-bg-base p-3">
                <p className="text-xs text-text-muted">{t('ragEval.sourceScore')}</p>
                <p className="mt-1 text-lg font-semibold">{formatScore(selectedRun.average_source_score)}</p>
              </div>
              <div className="rounded-lg border border-border bg-bg-base p-3">
                <p className="text-xs text-text-muted">{t('ragEval.keywordScore')}</p>
                <p className="mt-1 text-lg font-semibold">{formatScore(selectedRun.average_keyword_score)}</p>
              </div>
              <div className="rounded-lg border border-border bg-bg-base p-3">
                <p className="text-xs text-text-muted">{t('ragEval.duration')}</p>
                <p className="mt-1 text-lg font-semibold">{selectedRun.duration_ms}ms</p>
              </div>
            </div>

            {selectedRun.status === 'running' ? (
              <div className="flex min-h-32 items-center justify-center gap-2 rounded-lg border border-border bg-bg-base p-4 text-sm text-text-muted">
                <Loader2 className="h-4 w-4 animate-spin" />
                {t('ragEval.runningStatus')}
              </div>
            ) : selectedRun.status === 'cancelled' ? (
              <p className="rounded-lg border border-border bg-bg-base p-4 text-sm text-text-muted">
                {t('ragEval.cancelledStatus')}
              </p>
            ) : selectedRun.results && selectedRun.results.length > 0 ? (
              <div className="space-y-3">
                {selectedRun.results.map((result) => {
                  const matchedSources = result.matched_sources || [];
                  const plannedQueries = result.trace_summary?.planned_queries || [];
                  const traceSteps = result.trace_summary?.trace_steps || [];

                  return (
                    <div key={result.id || result.question} className="rounded-lg border border-border bg-bg-base p-4">
                      <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
                        <div className="min-w-0">
                          <p className="break-words text-sm font-medium">{result.question}</p>
                          {result.error_message && (
                            <p className="mt-1 text-xs text-red-300">{result.error_message}</p>
                          )}
                        </div>
                        <div className="flex shrink-0 flex-wrap gap-2 text-xs text-text-muted">
                          <span className="rounded-full border border-border px-2 py-1">
                            {t('ragEval.overallScore')}: {formatScore(result.overall_score)}
                          </span>
                          <span className="rounded-full border border-border px-2 py-1">
                            {t('ragEval.answerScore')}: {formatScore(result.answer_score)}
                          </span>
                          <span className="rounded-full border border-border px-2 py-1">
                            {t('ragEval.evidence')}: {result.evidence_label}
                          </span>
                          <span className="rounded-full border border-border px-2 py-1">
                            {t('ragEval.status')}: {result.status}
                          </span>
                        </div>
                      </div>

                      <div className="mt-3 grid gap-3 lg:grid-cols-2">
                        <div className="rounded-lg border border-border p-3">
                          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-muted">
                            {t('ragEval.matchedSources')}
                          </p>
                          {matchedSources.length > 0 ? (
                            <div className="space-y-2">
                              {matchedSources.slice(0, 5).map((source, index) => (
                                <div key={`${source.file_id || source.chunk_id || source.filename || index}`} className="text-xs">
                                  <div className="truncate text-text-main">
                                    {source.filename || source.file_id || source.chunk_id || t('ragEval.unknownSource')}
                                  </div>
                                  <div className="mt-1 text-text-muted">
                                    {source.chunk_index !== undefined && source.chunk_index !== null
                                      ? `#${source.chunk_index} · `
                                      : ''}
                                    {formatScore(source.agentic_score ?? source.similarity ?? 0)}
                                  </div>
                                </div>
                              ))}
                            </div>
                          ) : (
                            <p className="text-xs text-text-muted">{t('ragEval.noMatchedSources')}</p>
                          )}
                        </div>

                        <div className="rounded-lg border border-border p-3">
                          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-muted">
                            {t('ragEval.traceSteps')}
                          </p>
                          {plannedQueries.length > 0 && (
                            <div className="mb-3 flex flex-wrap gap-1.5">
                              {plannedQueries.map((query) => (
                                <span key={query} className="rounded-full bg-bg-sidebar px-2 py-1 text-[11px] text-text-muted">
                                  {query}
                                </span>
                              ))}
                            </div>
                          )}
                          {traceSteps.length > 0 ? (
                            <div className="space-y-1.5">
                              {traceSteps.map((step, index) => (
                                <div key={`${step.step_type || 'step'}-${index}`} className="flex items-center justify-between gap-3 text-xs">
                                  <span className="truncate text-text-main">{step.step_type || t('ragEval.traceStep')}</span>
                                  <span className="shrink-0 text-text-muted">
                                    {step.status || '-'} · {step.duration_ms ?? 0}ms
                                  </span>
                                </div>
                              ))}
                            </div>
                          ) : (
                            <p className="text-xs text-text-muted">{t('ragEval.noTraceSteps')}</p>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="rounded-lg border border-border bg-bg-base p-4 text-sm text-text-muted">
                {t('ragEval.noRunResults')}
              </p>
            )}
          </div>
        ) : (
          <p className="text-sm text-text-muted">{t('ragEval.noRunResults')}</p>
        )}
      </Modal>
    </div>
  );
}
