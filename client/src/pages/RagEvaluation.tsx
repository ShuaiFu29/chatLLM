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
import { toSafeError } from '../lib/safeError';
import Modal from '../components/Modal';
import SelectField from '../components/SelectField';
import { useProjectSpaceStore } from '../stores/useProjectSpaceStore';
import { useShallow } from 'zustand/react/shallow';
import { downloadTextFile } from '../lib/exportConversation';
import { getRagTraceStatusLabel, getRagTraceStepLabel } from '../lib/ragTraceLabels';
import {
  createCompletionPoller,
  isRequestAbortError,
  RequestGenerationGuard,
} from '../stores/requestGeneration';
import type {
  RagEvalCase,
  RagEvalDataset,
  RagEvalEvaluationSpec,
  RagEvalHistoryItem,
  RagEvalHistoryResponse,
  RagEvalHistorySource,
  RagEvalQualitySummary,
  RagEvalRun,
} from '../features/ragEvaluation/model';
import {
  buildRagEvalRunMarkdown,
  createRagEvalRunExportFilename,
  formatAdvancedCount,
  formatAdvancedScore,
  formatDate,
  formatMetricScore,
  formatScore,
  resultMetricApplicability,
  runMetricApplicability,
} from '../features/ragEvaluation/report';

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
  tags: '',
  category: '',
  difficulty: 'unknown' as 'unknown' | 'easy' | 'medium' | 'hard',
  expected_chunk_ids: '',
  expected_evidence: '',
  expected_answerable: 'unknown' as 'unknown' | 'true' | 'false',
  expected_graph_relations: '',
  human_correctness: '',
  human_completeness: '',
  human_faithfulness: '',
};

const MAX_RAG_EVAL_CASES_PER_DATASET = 500;

type DatasetModalMode = 'create' | 'edit' | null;

const splitList = (value: string) => value
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);

const splitLines = (value: string) => value
  .split(/\r?\n/)
  .map((item) => item.trim())
  .filter(Boolean);

const parseGraphRelations = (value: string) => splitLines(value).map((line) => {
  const parts = line.split('|').map((part) => part.trim());
  if (![3, 5].includes(parts.length) || parts.some((part) => !part)) return null;
  const polarity = parts[3] || 'affirmative';
  const modality = parts[4] || 'asserted';
  if (!['affirmative', 'negative'].includes(polarity)) return null;
  if (!['asserted', 'conditional', 'planned_or_obligatory', 'historical'].includes(modality)) return null;
  return {
    source: parts[0],
    relation: parts[1],
    target: parts[2],
    polarity: polarity as 'affirmative' | 'negative',
    modality: modality as 'asserted' | 'conditional' | 'planned_or_obligatory' | 'historical',
  };
});

const parseOptionalScore = (value: string) => {
  if (!value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : null;
};

export default function RagEvaluationPage() {
  const { t } = useTranslation();
  const { projectSpaces, fetchProjectSpaces } = useProjectSpaceStore(useShallow((state) => ({
    projectSpaces: state.projectSpaces,
    fetchProjectSpaces: state.fetchProjectSpaces,
  })));
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
  const [isHistoryBrowserOpen, setIsHistoryBrowserOpen] = useState(false);
  const [isBenchmarkModalOpen, setIsBenchmarkModalOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requestGuard] = useState(() => new RequestGenerationGuard());

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
    const ticket = requestGuard.begin('datasets');
    if (showLoading) setIsLoading(true);
    setError(null);

    try {
      const { data } = await api.get<RagEvalDataset[]>('/rag-eval/datasets', {
        signal: ticket.controller.signal,
      });
      if (!requestGuard.isCurrent(ticket)) return;
      setDatasets(data);
      setSelectedDatasetId((currentId) => currentId || data[0]?.id || null);
    } catch (fetchError) {
      if (requestGuard.isCurrent(ticket) && !isRequestAbortError(fetchError)) {
        console.error('Failed to load RAG eval datasets:', toSafeError(fetchError));
        setError(t('ragEval.loadFailed'));
      }
    } finally {
      if (requestGuard.finish(ticket)) setIsLoading(false);
    }
  }, [requestGuard, t]);

  const fetchHistory = useCallback(async () => {
    const ticket = requestGuard.begin('history');
    setIsHistoryLoading(true);
    setHistoryError(null);

    try {
      const { data } = await api.get<RagEvalHistoryResponse>('/rag-eval/history', {
        params: { limit: 50 },
        signal: ticket.controller.signal,
      });
      if (requestGuard.isCurrent(ticket)) setHistoryItems(data.items || []);
    } catch (fetchError) {
      if (requestGuard.isCurrent(ticket) && !isRequestAbortError(fetchError)) {
        console.error('Failed to load historical RAG runs:', toSafeError(fetchError));
        setHistoryError(t('ragEval.historyLoadFailed'));
      }
    } finally {
      if (requestGuard.finish(ticket)) setIsHistoryLoading(false);
    }
  }, [requestGuard, t]);

  useEffect(() => {
    void fetchProjectSpaces();
    void fetchDatasets();
    void fetchHistory();
  }, [fetchDatasets, fetchHistory, fetchProjectSpaces]);

  useEffect(() => {
    if (!hasRunningRuns) return undefined;

    const poller = createCompletionPoller(() => fetchDatasets(false), 3_000);
    poller.start();

    return () => poller.stop();
  }, [fetchDatasets, hasRunningRuns]);

  useEffect(() => {
    if (!selectedQualityDatasetId) {
      setQualitySummary(null);
      setIsQualityLoading(false);
      return undefined;
    }

    const ticket = requestGuard.begin('quality');
    setIsQualityLoading(true);

    api.get<RagEvalQualitySummary>(`/rag-eval/datasets/${selectedQualityDatasetId}/quality`, {
      signal: ticket.controller.signal,
    })
      .then(({ data }) => {
        if (requestGuard.isCurrent(ticket)) setQualitySummary(data);
      })
      .catch((qualityError) => {
        if (requestGuard.isCurrent(ticket) && !isRequestAbortError(qualityError)) {
          console.error('Failed to load RAG eval quality summary:', toSafeError(qualityError));
          setQualitySummary(null);
          setError(t('ragEval.qualityLoadFailed'));
        }
      })
      .finally(() => {
        if (requestGuard.finish(ticket)) setIsQualityLoading(false);
      });

    return () => {
      requestGuard.abort('quality');
    };
  }, [latestRunRefreshKey, requestGuard, selectedQualityDatasetId, t]);

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

  const getSupportLabel = (label?: string) => {
    if (label === 'supported') return t('chat.ragSupportSupported');
    if (label === 'partial') return t('chat.ragSupportPartial');
    if (label === 'unsupported') return t('chat.ragSupportUnsupported');
    if (label === 'not_applicable') return t('usage.notAvailable');
    return label || t('usage.notAvailable');
  };

  const getHistoryStatusClass = (status?: string) => {
    const normalized = (status || '').toLowerCase();
    if (normalized === 'success' || normalized === 'completed') return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300';
    if (normalized === 'running' || normalized === 'processing') return 'border-blue-500/30 bg-blue-500/10 text-blue-300';
    if (normalized === 'partial') return 'border-amber-500/30 bg-amber-500/10 text-amber-200';
    if (normalized === 'failed' || normalized === 'error') return 'border-red-500/30 bg-red-500/10 text-red-300';
    return 'border-border bg-bg-sidebar text-text-muted';
  };

  const getEvidenceStatusClass = (label?: string) => {
    const normalized = (label || '').toLowerCase();
    if (normalized === 'strong') return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300';
    if (normalized === 'partial') return 'border-amber-500/30 bg-amber-500/10 text-amber-200';
    if (normalized === 'weak') return 'border-red-500/30 bg-red-500/10 text-red-300';
    return 'border-border bg-bg-sidebar text-text-muted';
  };

  const getResultStatusClass = (status?: string) => getHistoryStatusClass(status);

  const getResultStatusLabel = (status?: string) => {
    if (status === 'success') return t('ragEval.completedStatus');
    if (status === 'failed') return t('ragEval.failedStatus');
    return status || t('usage.notAvailable');
  };

  const formatHistorySourceName = (source: RagEvalHistorySource) => (
    source.filename || source.file_id || source.chunk_id || t('ragEval.unknownSource')
  ).replace(/\.(?:md|markdown)$/i, '');

  const getHistoryWorkspaceName = (item: RagEvalHistoryItem) => (
    item.project_space_name || getWorkspaceName(item.project_space_id)
  );

  const getHistoryScore = (item: RagEvalHistoryItem) => item.quality?.overall_score ?? 0;

  const mergeRunIntoDatasets = useCallback((runToMerge: RagEvalRun) => {
    setDatasets((current) => current.map((dataset) => ({
      ...dataset,
      runs: (dataset.runs || []).map((run) => (run.id === runToMerge.id ? runToMerge : run)),
    })));
  }, []);

  const invalidateDatasetRequests = useCallback(() => {
    requestGuard.abort('datasets');
    setIsLoading(false);
  }, [requestGuard]);

  const closeRunDetails = () => {
    requestGuard.abort('selected-run');
    setIsRunModalOpen(false);
    setSelectedRun(null);
    setIsLoadingRun(false);
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
        .map((source) => source.file_id || formatHistorySourceName(source))
        .filter(Boolean)
    )).slice(0, 12);

    setSelectedDatasetId(targetDatasetId);
    setCaseDraft({
      question: item.query,
      expected_answer: item.answer_preview || '',
      expected_keywords: (item.planned_queries || []).slice(0, 8).join(', '),
      expected_source_files: sourceNames.join(', '),
      tags: '',
      category: '',
      difficulty: 'unknown',
      expected_chunk_ids: '',
      expected_evidence: '',
      expected_answerable: 'unknown',
      expected_graph_relations: '',
      human_correctness: '',
      human_completeness: '',
      human_faithfulness: '',
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
        invalidateDatasetRequests();
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
      invalidateDatasetRequests();
      setDatasets((current) => [data, ...current]);
      setSelectedDatasetId(data.id);
      setDatasetDraft(emptyDatasetDraft);
      setDatasetModalMode(null);
    } catch (saveError) {
      console.error('Failed to create RAG eval dataset:', toSafeError(saveError));
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

    const graphRelations = parseGraphRelations(caseDraft.expected_graph_relations);
    if (graphRelations.some((relation) => relation === null)) {
      setError(t('ragEval.invalidGraphRelations'));
      return;
    }
    const humanScores = {
      correctness: parseOptionalScore(caseDraft.human_correctness),
      completeness: parseOptionalScore(caseDraft.human_completeness),
      faithfulness: parseOptionalScore(caseDraft.human_faithfulness),
    };
    if (Object.values(humanScores).some((score) => score === null)) {
      setError(t('ragEval.invalidHumanScores'));
      return;
    }

    const evaluationSpec: RagEvalEvaluationSpec = {};
    const tags = splitList(caseDraft.tags);
    if (tags.length > 0) evaluationSpec.tags = tags;
    if (caseDraft.category.trim()) evaluationSpec.category = caseDraft.category.trim();
    if (caseDraft.difficulty !== 'unknown') evaluationSpec.difficulty = caseDraft.difficulty;
    const expectedChunkIds = splitList(caseDraft.expected_chunk_ids);
    const expectedEvidence = splitLines(caseDraft.expected_evidence);
    if (expectedChunkIds.length > 0) evaluationSpec.expected_chunk_ids = expectedChunkIds;
    if (expectedEvidence.length > 0) evaluationSpec.expected_evidence = expectedEvidence;
    if (caseDraft.expected_answerable !== 'unknown') {
      evaluationSpec.expected_answerable = caseDraft.expected_answerable === 'true';
    }
    if (graphRelations.length > 0) {
      evaluationSpec.expected_graph_relations = graphRelations.filter(
        (relation): relation is NonNullable<typeof relation> => relation !== null,
      );
    }
    const normalizedHumanScores = Object.fromEntries(
      Object.entries(humanScores).filter(([, score]) => typeof score === 'number'),
    ) as RagEvalEvaluationSpec['human_scores'];
    if (Object.keys(normalizedHumanScores || {}).length > 0) {
      evaluationSpec.human_scores = normalizedHumanScores;
    }

    setIsSaving(true);
    setError(null);

    try {
      const { data } = await api.post<RagEvalCase>(`/rag-eval/datasets/${selectedDatasetId}/cases`, {
        question,
        expected_answer: caseDraft.expected_answer.trim(),
        expected_keywords: splitList(caseDraft.expected_keywords),
        expected_source_files: splitList(caseDraft.expected_source_files),
        evaluation_spec: evaluationSpec,
      });

      invalidateDatasetRequests();
      setDatasets((current) => current.map((dataset) => (
        dataset.id === selectedDatasetId
          ? { ...dataset, cases: [...(dataset.cases || []), data] }
          : dataset
      )));
      setCaseDraft(emptyCaseDraft);
      setIsCaseModalOpen(false);
    } catch (saveError) {
      console.error('Failed to create RAG eval case:', toSafeError(saveError));
      setError(t('ragEval.saveFailed'));
    } finally {
      setIsSaving(false);
    }
  };

  const handleDeleteCase = async (caseId: string) => {
    try {
      await api.delete(`/rag-eval/cases/${caseId}`);
      invalidateDatasetRequests();
      setDatasets((current) => current.map((dataset) => ({
        ...dataset,
        cases: (dataset.cases || []).filter((testCase) => testCase.id !== caseId),
      })));
    } catch (deleteError) {
      console.error('Failed to delete RAG eval case:', toSafeError(deleteError));
      setError(t('ragEval.deleteCaseFailed'));
    }
  };

  const handleDeleteDataset = async () => {
    if (!datasetToDelete) return;

    setIsSaving(true);
    setError(null);

    try {
      await api.delete(`/rag-eval/datasets/${datasetToDelete.id}`);
      invalidateDatasetRequests();
      setDatasets((current) => current.filter((dataset) => dataset.id !== datasetToDelete.id));
      setSelectedDatasetId((currentId) => (currentId === datasetToDelete.id ? null : currentId));
      setDatasetToDelete(null);
    } catch (deleteError) {
      console.error('Failed to delete RAG eval dataset:', toSafeError(deleteError));
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
      invalidateDatasetRequests();
      setDatasets((current) => current.map((dataset) => (
        dataset.id === datasetId
          ? { ...dataset, runs: [data, ...(dataset.runs || [])] }
          : dataset
      )));
      toast.success(t('ragEval.runQueued'));
    } catch (runError) {
      console.error('Failed to run RAG eval:', toSafeError(runError));
      setError(t('ragEval.runFailed'));
    } finally {
      setRunningDatasetId(null);
    }
  };

  const handleCancelRun = async (runId: string) => {
    setCancellingRunId(runId);
    setError(null);
    requestGuard.abort('selected-run');
    const ticket = requestGuard.begin('cancel-run');

    try {
      const { data } = await api.post<RagEvalRun>(`/rag-eval/runs/${runId}/cancel`, undefined, {
        signal: ticket.controller.signal,
      });
      if (!requestGuard.isCurrent(ticket)) return;
      invalidateDatasetRequests();
      mergeRunIntoDatasets(data);
      setSelectedRun((current) => (current?.id === data.id ? data : current));
      toast.success(t('ragEval.cancelSuccess'));
    } catch (cancelError) {
      if (requestGuard.isCurrent(ticket) && !isRequestAbortError(cancelError)) {
        console.error('Failed to cancel RAG eval run:', toSafeError(cancelError));
        setError(t('ragEval.cancelFailed'));
        toast.error(t('ragEval.cancelFailed'));
      }
    } finally {
      if (requestGuard.finish(ticket)) setCancellingRunId(null);
    }
  };

  const handleViewRunDetails = async (runId: string) => {
    requestGuard.abort('selected-run');
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

    const ticket = requestGuard.begin('selected-run');
    try {
      const { data } = await api.get<RagEvalRun>(`/rag-eval/runs/${runId}`, {
        signal: ticket.controller.signal,
      });
      if (!requestGuard.isCurrent(ticket)) return;
      setSelectedRun(data);
      mergeRunIntoDatasets(data);
    } catch (loadError) {
      if (requestGuard.isCurrent(ticket) && !isRequestAbortError(loadError)) {
        console.error('Failed to load RAG eval run:', toSafeError(loadError));
        setError(t('ragEval.loadRunFailed'));
        setIsRunModalOpen(false);
      }
    } finally {
      if (requestGuard.finish(ticket)) setIsLoadingRun(false);
    }
  };

  useEffect(() => {
    if (
      !isRunModalOpen
      || !selectedRun
      || selectedRun.status !== 'running'
      || cancellingRunId === selectedRun.id
    ) return undefined;

    const runId = selectedRun.id;
    const poller = createCompletionPoller(async () => {
      const ticket = requestGuard.begin('selected-run');
      try {
        const { data } = await api.get<RagEvalRun>(`/rag-eval/runs/${runId}`, {
          signal: ticket.controller.signal,
        });
        if (requestGuard.isCurrent(ticket)) {
          setSelectedRun(data);
          mergeRunIntoDatasets(data);
        }
      } catch (loadError) {
        if (requestGuard.isCurrent(ticket) && !isRequestAbortError(loadError)) {
          console.error('Failed to refresh RAG eval run:', toSafeError(loadError));
        }
      } finally {
        requestGuard.finish(ticket);
      }
    }, 3_000);
    poller.start();

    return () => {
      poller.stop();
      requestGuard.abort('selected-run');
    };
  }, [cancellingRunId, isRunModalOpen, mergeRunIntoDatasets, requestGuard, selectedRun]);

  useEffect(() => () => requestGuard.abortAll(), [requestGuard]);

  const handleExportRunReport = () => {
    if (!selectedRun) return;

    try {
      const markdown = buildRagEvalRunMarkdown(selectedDataset, selectedRun, t);
      const filename = createRagEvalRunExportFilename(selectedDataset, selectedRun);
      downloadTextFile(filename, markdown);
      setError(null);
      toast.success(t('ragEval.exportSuccess'));
    } catch (exportError) {
      console.error('Failed to export RAG eval run:', toSafeError(exportError));
      setError(t('ragEval.exportFailed'));
      toast.error(t('ragEval.exportFailed'));
    }
  };

  const qualityTrendDelta = qualitySummary?.trend_delta ?? null;
  const qualityTrendDeltaLabel = qualityTrendDelta === null
    ? t('ragEval.notEnoughRuns')
    : `${qualityTrendDelta >= 0 ? '+' : ''}${formatScore(qualityTrendDelta)}`;
  const historyAverageScore = historyItems.length
    ? historyItems.reduce((sum, item) => sum + getHistoryScore(item), 0) / historyItems.length
    : 0;
  const latestHistoryItem = historyItems[0] || null;
  const benchmarkCaseCount = selectedDataset?.cases.length || 0;
  const benchmarkRunCount = selectedDataset?.runs.length || 0;

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
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <h2 className="flex items-center gap-2 font-semibold">
                    <MessageSquare className="h-4 w-4 text-primary" />
                    {t('ragEval.historyTitle')}
                  </h2>
                  <p className="mt-1 text-xs text-text-muted">{t('ragEval.historyHint')}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={fetchHistory}
                    disabled={isHistoryLoading}
                    className="inline-flex items-center justify-center gap-2 rounded-lg border border-border px-3 py-2 text-sm text-text-muted transition-colors hover:bg-bg-base hover:text-text-main disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <RefreshCw className={`h-4 w-4 ${isHistoryLoading ? 'animate-spin' : ''}`} />
                    {t('usage.refresh')}
                  </button>
                  <button
                    onClick={() => setIsHistoryBrowserOpen(true)}
                    className="inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm text-white transition-colors hover:bg-primary-hover"
                  >
                    <Eye className="h-4 w-4" />
                    {t('ragEval.openHistoryBrowser')}
                  </button>
                </div>
              </div>

              {historyError && (
                <div className="mt-3 flex items-center gap-2 rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-300">
                  <AlertCircle className="h-4 w-4 shrink-0" />
                  {historyError}
                </div>
              )}

              <div className="mt-4 grid gap-3 md:grid-cols-3">
                <div className="rounded-lg border border-border bg-bg-base p-3">
                  <p className="text-xs text-text-muted">{t('ragEval.historyTitle')}</p>
                  <p className="mt-1 text-lg font-semibold">{isHistoryLoading ? '-' : historyItems.length}</p>
                </div>
                <div className="rounded-lg border border-border bg-bg-base p-3">
                  <p className="text-xs text-text-muted">{t('ragEval.overallScore')}</p>
                  <p className="mt-1 text-lg font-semibold">{isHistoryLoading ? '-' : formatScore(historyAverageScore)}</p>
                </div>
                <div className="min-w-0 rounded-lg border border-border bg-bg-base p-3">
                  <p className="text-xs text-text-muted">{t('ragEval.question')}</p>
                  <p className="mt-1 truncate text-sm font-medium">
                    {isHistoryLoading
                      ? t('common.loading')
                      : latestHistoryItem?.query || t('ragEval.historyEmpty')}
                  </p>
                </div>
              </div>
              <p className="mt-3 text-xs text-text-muted">
                {isHistoryLoading ? t('common.loading') : t('ragEval.historySummary', { count: historyItems.length })}
              </p>
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
                  <div className="min-w-0">
                    <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-text-muted">
                      {t('ragEval.benchmarkTitle')}
                    </p>
                    <h2 className="truncate text-lg font-semibold">{selectedDataset.name}</h2>
                    <p className="mt-1 text-sm text-text-muted">
                      {selectedDataset.description || t('ragEval.noDescription')}
                    </p>
                    <p className="mt-2 text-xs text-text-muted">
                      {t('ragEval.benchmarkSummary', { cases: benchmarkCaseCount, runs: benchmarkRunCount })}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={() => setIsBenchmarkModalOpen(true)}
                      className="inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm text-white transition-colors hover:bg-primary-hover"
                    >
                      <Eye className="h-4 w-4" />
                      {t('ragEval.openBenchmarkLab')}
                    </button>
                    <button
                      onClick={() => handleRunEval(selectedDataset.id)}
                      disabled={runningDatasetId === selectedDataset.id || isSelectedDatasetRunning || selectedDataset.cases.length === 0}
                      className="inline-flex items-center justify-center gap-2 rounded-lg border border-border px-3 py-2 text-sm text-text-muted transition-colors hover:bg-bg-base hover:text-text-main disabled:cursor-not-allowed disabled:opacity-50"
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
                <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
                  <div className="rounded-lg border border-border bg-bg-base p-3">
                    <p className="text-xs text-text-muted">{t('ragEval.cases')}</p>
                    <p className="mt-1 text-lg font-semibold">{benchmarkCaseCount}</p>
                  </div>
                  <div className="rounded-lg border border-border bg-bg-base p-3">
                    <p className="text-xs text-text-muted">{t('ragEval.runHistory')}</p>
                    <p className="mt-1 text-lg font-semibold">{benchmarkRunCount}</p>
                  </div>
                  <div className="rounded-lg border border-border bg-bg-base p-3">
                    <p className="text-xs text-text-muted">{t('ragEval.latestOverall')}</p>
                    <p className="mt-1 text-lg font-semibold">{formatMetricScore(qualitySummary?.average_overall_score, qualitySummary?.metric_applicability?.overall)}</p>
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
              </section>

              <Modal
                isOpen={isBenchmarkModalOpen}
                onClose={() => setIsBenchmarkModalOpen(false)}
                title={t('ragEval.benchmarkTitle')}
                maxWidth="5xl"
                footer={
                  <button
                    onClick={() => setIsBenchmarkModalOpen(false)}
                    className="rounded-lg bg-primary px-4 py-2 text-sm text-white transition-colors hover:bg-primary-hover"
                  >
                    {t('common.close')}
                  </button>
                }
              >
                <div className="space-y-4">
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
                        <p className="mt-1 text-lg font-semibold">{formatMetricScore(qualitySummary?.average_overall_score, qualitySummary?.metric_applicability?.overall)}</p>
                      </div>
                      <div className="rounded-lg border border-border bg-bg-base p-3">
                        <p className="text-xs text-text-muted">{t('ragEval.retrievalScore')}</p>
                        <p className="mt-1 text-lg font-semibold">{formatMetricScore(qualitySummary?.average_retrieval_score, qualitySummary?.metric_applicability?.retrieval)}</p>
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
                                  style={{
                                    width: run.metric_applicability?.overall === false
                                      ? '0%'
                                      : `${Math.max(Math.round(run.average_overall_score * 100), 4)}%`,
                                  }}
                                />
                              </div>
                              <span className="text-right text-text-muted">{formatMetricScore(run.average_overall_score, run.metric_applicability?.overall)}</span>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="text-sm text-text-muted">{t('ragEval.noRunResults')}</p>
                      )}
                    </div>
                    {qualitySummary?.paired_comparison && (
                      <div className="rounded-lg border border-border bg-bg-base p-3">
                        <p className="text-xs font-semibold uppercase tracking-wide text-text-muted">
                          {t('ragEval.pairedComparison')}
                        </p>
                        <div className="mt-2 grid gap-2 text-xs sm:grid-cols-3">
                          {(['retrieval', 'answer', 'grounding'] as const).map((metric) => {
                            const comparison = qualitySummary.paired_comparison?.[metric];
                            return (
                              <div key={metric} className="rounded border border-border bg-bg-sidebar p-2">
                                <p className="font-medium">{t(`ragEval.pairedMetric.${metric}`)}</p>
                                <p className="mt-1 text-text-muted">
                                  {comparison?.mean_delta === null || comparison?.mean_delta === undefined
                                    ? 'N/A'
                                    : `${comparison.mean_delta >= 0 ? '+' : ''}${Math.round(comparison.mean_delta * 100)}%`}
                                  {' · '}{comparison?.wins || 0}/{comparison?.ties || 0}/{comparison?.losses || 0}
                                </p>
                              </div>
                            );
                          })}
                        </div>
                        <p className="mt-2 text-[11px] text-text-muted">
                          {t('ragEval.pairedComparisonHint', { count: qualitySummary.paired_comparison.matched_case_count })}
                        </p>
                      </div>
                    )}
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
                                {formatMetricScore(testCase.overall_score, testCase.metric_applicability?.overall)}
                              </span>
                            </div>
                            <div className="mt-2 grid grid-cols-2 gap-2 text-[11px] text-text-muted">
                              <span>{t('ragEval.retrievalScore')}: {formatMetricScore(testCase.retrieval_score, testCase.metric_applicability?.retrieval)}</span>
                              <span>{t('ragEval.answerScore')}: {formatMetricScore(testCase.answer_score, testCase.metric_applicability?.answer)}</span>
                              <span>{t('ragEval.sourceScore')}: {formatMetricScore(testCase.source_score, testCase.metric_applicability?.retrieval)}</span>
                              <span>{t('ragEval.keywordScore')}: {formatMetricScore(testCase.keyword_score, testCase.metric_applicability?.keyword_retrieval)}</span>
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
                      <p className="mt-1 text-lg font-semibold">{formatMetricScore(latestRun.average_overall_score, runMetricApplicability(latestRun, 'overall'))}</p>
                    </div>
                    <div className="rounded-lg border border-border bg-bg-base p-3">
                      <p className="text-xs text-text-muted">{t('ragEval.retrievalScore')}</p>
                      <p className="mt-1 text-lg font-semibold">{formatMetricScore(latestRun.average_retrieval_score, runMetricApplicability(latestRun, 'retrieval'))}</p>
                    </div>
                    <div className="rounded-lg border border-border bg-bg-base p-3">
                      <p className="text-xs text-text-muted">{t('ragEval.answerScore')}</p>
                      <p className="mt-1 text-lg font-semibold">{formatMetricScore(latestRun.average_answer_score, runMetricApplicability(latestRun, 'answer'))}</p>
                    </div>
                    <div className="rounded-lg border border-border bg-bg-base p-3">
                      <p className="text-xs text-text-muted">{t('ragEval.sourceScore')}</p>
                      <p className="mt-1 text-lg font-semibold">{formatMetricScore(latestRun.average_source_score, runMetricApplicability(latestRun, 'retrieval'))}</p>
                    </div>
                    <div className="rounded-lg border border-border bg-bg-base p-3">
                      <p className="text-xs text-text-muted">{t('ragEval.keywordScore')}</p>
                      <p className="mt-1 text-lg font-semibold">{formatMetricScore(latestRun.average_keyword_score, runMetricApplicability(latestRun, 'keyword_retrieval'))}</p>
                    </div>
                    <div className="rounded-lg border border-border bg-bg-base p-3">
                      <p className="text-xs text-text-muted">{t('ragEval.expectedAnswerSupportScore')}</p>
                      <p className="mt-1 text-lg font-semibold">{formatMetricScore(latestRun.average_expected_answer_support_score, runMetricApplicability(latestRun, 'expected_answer_support'))}</p>
                    </div>
                    <div className="rounded-lg border border-border bg-bg-base p-3">
                      <p className="text-xs text-text-muted">{t('ragEval.verificationScore')}</p>
                      <p className="mt-1 text-lg font-semibold">{formatMetricScore(latestRun.average_verification_score, runMetricApplicability(latestRun, 'faithfulness'))}</p>
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
                              <td className="px-3 py-2">{formatMetricScore(result.overall_score, resultMetricApplicability(result, 'overall'))}</td>
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
                            <td className="px-3 py-2">{formatMetricScore(run.average_overall_score, runMetricApplicability(run, 'overall'))}</td>
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
                            {(testCase.evaluation_spec?.tags || []).map((tag) => (
                              <span key={`tag:${tag}`} className="rounded-full border border-sky-500/30 px-2 py-1 text-[11px] text-sky-300">
                                #{tag}
                              </span>
                            ))}
                            {testCase.evaluation_spec?.category && (
                              <span className="rounded-full border border-sky-500/30 px-2 py-1 text-[11px] text-sky-300">
                                {testCase.evaluation_spec.category}
                              </span>
                            )}
                            {testCase.evaluation_spec?.difficulty && (
                              <span className="rounded-full border border-amber-500/30 px-2 py-1 text-[11px] text-amber-200">
                                {t(`ragEval.difficulty.${testCase.evaluation_spec.difficulty}`)}
                              </span>
                            )}
                            {(testCase.evaluation_spec?.expected_chunk_ids?.length || 0) > 0 && (
                              <span className="rounded-full border border-primary/30 px-2 py-1 text-[11px] text-primary">
                                {t('ragEval.chunkGoldCount', { count: testCase.evaluation_spec?.expected_chunk_ids?.length || 0 })}
                              </span>
                            )}
                            {(testCase.evaluation_spec?.expected_evidence?.length || 0) > 0 && (
                              <span className="rounded-full border border-primary/30 px-2 py-1 text-[11px] text-primary">
                                {t('ragEval.evidenceGoldCount', { count: testCase.evaluation_spec?.expected_evidence?.length || 0 })}
                              </span>
                            )}
                            {typeof testCase.evaluation_spec?.expected_answerable === 'boolean' && (
                              <span className="rounded-full border border-primary/30 px-2 py-1 text-[11px] text-primary">
                                {testCase.evaluation_spec.expected_answerable
                                  ? t('ragEval.answerable')
                                  : t('ragEval.unanswerable')}
                              </span>
                            )}
                            {(testCase.evaluation_spec?.expected_graph_relations?.length || 0) > 0 && (
                              <span className="rounded-full border border-primary/30 px-2 py-1 text-[11px] text-primary">
                                {t('ragEval.graphGoldCount', { count: testCase.evaluation_spec?.expected_graph_relations?.length || 0 })}
                              </span>
                            )}
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
                </div>
              </Modal>
              </>
            )}
          </div>
        </main>
      </div>

      <Modal
        isOpen={isHistoryBrowserOpen}
        onClose={() => setIsHistoryBrowserOpen(false)}
        title={t('ragEval.historyTitle')}
        maxWidth="5xl"
        footer={
          <button
            onClick={() => setIsHistoryBrowserOpen(false)}
            className="rounded-lg bg-primary px-4 py-2 text-sm text-white transition-colors hover:bg-primary-hover"
          >
            {t('common.close')}
          </button>
        }
      >
        <div className="space-y-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-text-muted">
              {t('ragEval.historySummary', { count: historyItems.length })}
            </p>
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
            <div className="flex items-center gap-2 rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-300">
              <AlertCircle className="h-4 w-4 shrink-0" />
              {historyError}
            </div>
          )}

          {isHistoryLoading ? (
            <div className="flex min-h-40 items-center justify-center gap-2 text-sm text-text-muted">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t('common.loading')}
            </div>
          ) : historyItems.length === 0 ? (
            <div className="flex min-h-40 flex-col items-center justify-center gap-2 text-center text-sm text-text-muted">
              <MessageSquare className="h-8 w-8 opacity-30" />
              <p>{t('ragEval.historyEmpty')}</p>
            </div>
          ) : (
            <div className="grid gap-3 xl:grid-cols-2">
              {historyItems.map((item) => {
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
                          <span className={`rounded border px-2 py-0.5 ${getEvidenceStatusClass(item.quality?.evidence_label)}`}>
                            {getEvidenceLabel(item.quality?.evidence_label)}
                          </span>
                          <span className="rounded border border-border px-2 py-0.5">
                            {formatScore(score)}
                          </span>
                          <span className={`rounded border px-2 py-0.5 ${getHistoryStatusClass(item.status)}`}>
                            {item.status || t('usage.notAvailable')}
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
                      <span>{t('usage.model')}: {item.model || t('ragEval.defaultModel')}</span>
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
        </div>
      </Modal>

      <Modal
        isOpen={!!selectedHistoryItem}
        onClose={() => setSelectedHistoryItem(null)}
        title={t('ragEval.historyDetails')}
        maxWidth="4xl"
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

            <div className="grid grid-cols-1 gap-3 text-xs sm:grid-cols-2 xl:grid-cols-4">
              <div className="rounded-lg border border-border bg-bg-base p-3">
                <p className="text-text-muted">{t('ragEval.historyConversation')}</p>
                <p className="mt-1 break-words text-text-main">
                  {selectedHistoryItem.conversation_title || t('sidebar.newChat')}
                </p>
              </div>
              <div className="rounded-lg border border-border bg-bg-base p-3">
                <p className="text-text-muted">{t('usage.workspace')}</p>
                <p className="mt-1 break-words text-text-main">{getHistoryWorkspaceName(selectedHistoryItem)}</p>
              </div>
              <div className="rounded-lg border border-border bg-bg-base p-3">
                <p className="text-text-muted">{t('ragEval.overallScore')}</p>
                <p className="mt-1 font-semibold text-text-main">{formatScore(selectedHistoryItem.quality?.overall_score)}</p>
              </div>
              <div className="rounded-lg border border-border bg-bg-base p-3">
                <p className="text-text-muted">{t('ragEval.evidence')}</p>
                <p className="mt-1 text-text-main">{getEvidenceLabel(selectedHistoryItem.quality?.evidence_label)}</p>
              </div>
              <div className="rounded-lg border border-border bg-bg-base p-3">
                <p className="text-text-muted">{t('usage.model')}</p>
                <p className="mt-1 break-words text-text-main">{selectedHistoryItem.model || t('ragEval.defaultModel')}</p>
              </div>
              <div className="rounded-lg border border-border bg-bg-base p-3">
                <p className="text-text-muted">{t('ragEval.status')}</p>
                <p className="mt-1">
                  <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold uppercase tracking-wide ${getHistoryStatusClass(selectedHistoryItem.status)}`}>
                    {selectedHistoryItem.status || t('usage.notAvailable')}
                  </span>
                </p>
              </div>
              <div className="rounded-lg border border-border bg-bg-base p-3">
                <p className="text-text-muted">{t('ragEval.createdAt')}</p>
                <p className="mt-1 break-words text-text-main">{formatDate(selectedHistoryItem.created_at).slice(0, 19)}</p>
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
                        <div className="break-words text-text-main">{formatHistorySourceName(source)}</div>
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
                      <span key={`${selectedHistoryItem.id}-planned-${index}`} className="max-w-full break-words rounded-full bg-bg-sidebar px-2 py-1 text-[11px] text-text-muted">
                        {query}
                      </span>
                    ))}
                  </div>
                ) : null}
                {selectedHistoryItem.trace_steps?.length ? (
                  <div className="space-y-1.5">
                    {selectedHistoryItem.trace_steps.map((step, index) => (
                      <div key={`${step.step_type || 'step'}-${index}`} className="flex items-center justify-between gap-3 rounded border border-border bg-bg-sidebar px-2 py-1 text-xs">
                        <span className="min-w-0 break-words text-text-main">{getRagTraceStepLabel(t, step.step_type)}</span>
                        <span className={`shrink-0 rounded-full border px-2 py-0.5 ${getHistoryStatusClass(step.status)}`}>
                          {getRagTraceStatusLabel(t, step.status)} · {step.duration_ms ?? 0}ms
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
          <div className="rounded-lg border border-border bg-bg-base p-3">
            <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-text-muted">
              {t('ragEval.advancedGold')}
            </p>
            <div className="space-y-3">
              <input
                value={caseDraft.tags}
                onChange={(event) => setCaseDraft((draft) => ({ ...draft, tags: event.target.value }))}
                className="w-full rounded-lg border border-border bg-bg-sidebar px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
                placeholder={t('ragEval.tags')}
              />
              <div className="grid gap-3 sm:grid-cols-2">
                <input
                  value={caseDraft.category}
                  onChange={(event) => setCaseDraft((draft) => ({ ...draft, category: event.target.value }))}
                  className="w-full rounded-lg border border-border bg-bg-sidebar px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
                  placeholder={t('ragEval.category')}
                />
                <SelectField
                  value={caseDraft.difficulty}
                  onChange={(event) => setCaseDraft((draft) => ({
                    ...draft,
                    difficulty: event.target.value as typeof draft.difficulty,
                  }))}
                  className="w-full"
                  selectClassName="bg-bg-sidebar"
                  aria-label={t('ragEval.difficultyLabel')}
                >
                  <option value="unknown">{t('ragEval.difficulty.unknown')}</option>
                  <option value="easy">{t('ragEval.difficulty.easy')}</option>
                  <option value="medium">{t('ragEval.difficulty.medium')}</option>
                  <option value="hard">{t('ragEval.difficulty.hard')}</option>
                </SelectField>
              </div>
              <input
                value={caseDraft.expected_chunk_ids}
                onChange={(event) => setCaseDraft((draft) => ({ ...draft, expected_chunk_ids: event.target.value }))}
                className="w-full rounded-lg border border-border bg-bg-sidebar px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
                placeholder={t('ragEval.expectedChunkIds')}
              />
              <textarea
                value={caseDraft.expected_evidence}
                onChange={(event) => setCaseDraft((draft) => ({ ...draft, expected_evidence: event.target.value }))}
                className="min-h-20 w-full rounded-lg border border-border bg-bg-sidebar px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
                placeholder={t('ragEval.expectedEvidence')}
              />
              <label className="block text-xs text-text-muted">
                <span className="mb-1 block">{t('ragEval.expectedAnswerable')}</span>
                <SelectField
                  value={caseDraft.expected_answerable}
                  onChange={(event) => setCaseDraft((draft) => ({
                    ...draft,
                    expected_answerable: event.target.value as typeof draft.expected_answerable,
                  }))}
                  className="w-full"
                  selectClassName="bg-bg-sidebar"
                >
                  <option value="unknown">{t('ragEval.notLabeled')}</option>
                  <option value="true">{t('ragEval.answerable')}</option>
                  <option value="false">{t('ragEval.unanswerable')}</option>
                </SelectField>
              </label>
              <textarea
                value={caseDraft.expected_graph_relations}
                onChange={(event) => setCaseDraft((draft) => ({ ...draft, expected_graph_relations: event.target.value }))}
                className="min-h-20 w-full rounded-lg border border-border bg-bg-sidebar px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
                placeholder={t('ragEval.expectedGraphRelations')}
              />
              <div>
                <p className="mb-2 text-xs text-text-muted">{t('ragEval.humanScores')}</p>
                <div className="grid gap-2 sm:grid-cols-3">
                  {(['correctness', 'completeness', 'faithfulness'] as const).map((dimension) => (
                    <input
                      key={dimension}
                      type="number"
                      min="0"
                      max="1"
                      step="0.01"
                      value={caseDraft[`human_${dimension}`]}
                      onChange={(event) => setCaseDraft((draft) => ({
                        ...draft,
                        [`human_${dimension}`]: event.target.value,
                      }))}
                      className="w-full rounded-lg border border-border bg-bg-sidebar px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
                      placeholder={t(`ragEval.${dimension}HumanScore`)}
                    />
                  ))}
                </div>
              </div>
              <p className="text-xs leading-5 text-text-muted">{t('ragEval.advancedGoldHint')}</p>
            </div>
          </div>
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
        onClose={closeRunDetails}
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
              onClick={closeRunDetails}
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
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
                <div className="rounded-lg border border-border bg-bg-base p-3">
                  <p className="text-xs text-text-muted">{t('ragEval.overallScore')}</p>
                  <p className="mt-1 text-lg font-semibold">{formatMetricScore(selectedRun.average_overall_score, runMetricApplicability(selectedRun, 'overall'))}</p>
              </div>
              <div className="rounded-lg border border-border bg-bg-base p-3">
                <p className="text-xs text-text-muted">{t('ragEval.retrievalScore')}</p>
                <p className="mt-1 text-lg font-semibold">{formatMetricScore(selectedRun.average_retrieval_score, runMetricApplicability(selectedRun, 'retrieval'))}</p>
              </div>
              <div className="rounded-lg border border-border bg-bg-base p-3">
                <p className="text-xs text-text-muted">{t('ragEval.answerScore')}</p>
                <p className="mt-1 text-lg font-semibold">{formatMetricScore(selectedRun.average_answer_score, runMetricApplicability(selectedRun, 'answer'))}</p>
              </div>
                <div className="rounded-lg border border-border bg-bg-base p-3">
                  <p className="text-xs text-text-muted">{t('ragEval.sourceScore')}</p>
                  <p className="mt-1 text-lg font-semibold">{formatMetricScore(selectedRun.average_source_score, runMetricApplicability(selectedRun, 'retrieval'))}</p>
                </div>
                <div className="rounded-lg border border-border bg-bg-base p-3">
                  <p className="text-xs text-text-muted">{t('ragEval.sourceRecallScore')}</p>
                  <p className="mt-1 text-lg font-semibold">{formatMetricScore(selectedRun.average_source_recall_score ?? selectedRun.average_source_score, runMetricApplicability(selectedRun, 'retrieval'))}</p>
                </div>
                <div className="rounded-lg border border-border bg-bg-base p-3">
                  <p className="text-xs text-text-muted">{t('ragEval.citationAccuracyScore')}</p>
                  <p className="mt-1 text-lg font-semibold">{formatMetricScore(selectedRun.average_citation_accuracy_score, runMetricApplicability(selectedRun, 'faithfulness'))}</p>
                </div>
                <div className="rounded-lg border border-border bg-bg-base p-3">
                  <p className="text-xs text-text-muted">{t('ragEval.keywordScore')}</p>
                  <p className="mt-1 text-lg font-semibold">{formatMetricScore(selectedRun.average_keyword_score, runMetricApplicability(selectedRun, 'keyword_retrieval'))}</p>
                </div>
                <div className="rounded-lg border border-border bg-bg-base p-3">
                  <p className="text-xs text-text-muted">{t('ragEval.groundingScore')}</p>
                  <p className="mt-1 text-lg font-semibold">{formatMetricScore(selectedRun.average_grounding_score, runMetricApplicability(selectedRun, 'faithfulness'))}</p>
                </div>
                <div className="rounded-lg border border-border bg-bg-base p-3">
                  <p className="text-xs text-text-muted">{t('ragEval.expectedAnswerSupportScore')}</p>
                  <p className="mt-1 text-lg font-semibold">{formatMetricScore(selectedRun.average_expected_answer_support_score, runMetricApplicability(selectedRun, 'expected_answer_support'))}</p>
                </div>
                <div className="rounded-lg border border-border bg-bg-base p-3">
                  <p className="text-xs text-text-muted">{t('ragEval.verificationScore')}</p>
                  <p className="mt-1 text-lg font-semibold">{formatMetricScore(selectedRun.average_verification_score, runMetricApplicability(selectedRun, 'faithfulness'))}</p>
                </div>
                <div className="rounded-lg border border-border bg-bg-base p-3">
                  <p className="text-xs text-text-muted">{t('ragEval.duration')}</p>
                  <p className="mt-1 text-lg font-semibold">{selectedRun.duration_ms}ms</p>
              </div>
            </div>

            {(selectedRun.baseline_run_id || Object.keys(selectedRun.execution_snapshot || {}).length > 0) && (
              <details className="rounded-lg border border-border bg-bg-base p-4">
                <summary className="cursor-pointer text-sm font-semibold text-text-main">
                  {t('ragEval.executionSnapshot')}
                </summary>
                <p className="mt-2 text-xs leading-5 text-text-muted">
                  {t('ragEval.executionSnapshotHint')}
                </p>
                <div className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
                  <p className="break-all rounded border border-border bg-bg-sidebar p-2">
                    <span className="text-text-muted">{t('ragEval.runId')}:</span> {selectedRun.id}
                  </p>
                  <p className="break-all rounded border border-border bg-bg-sidebar p-2">
                    <span className="text-text-muted">{t('ragEval.baselineRunId')}:</span> {selectedRun.baseline_run_id || 'N/A'}
                  </p>
                </div>
                {Object.keys(selectedRun.execution_snapshot || {}).length > 0 && (
                  <pre className="mt-3 max-h-72 overflow-auto rounded border border-border bg-bg-sidebar p-3 text-[11px] leading-5 text-text-muted">
                    {JSON.stringify(selectedRun.execution_snapshot, null, 2)}
                  </pre>
                )}
              </details>
            )}

            <div className="rounded-lg border border-border bg-bg-base p-4">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h4 className="text-sm font-semibold">{t('ragEval.advancedMetrics')}</h4>
                  <p className="mt-1 text-xs text-text-muted">{t('ragEval.advancedMetricsHint')}</p>
                </div>
                <span className="rounded-full border border-border px-2 py-1 text-xs text-text-muted">
                  {t('ragEval.cost')}: {selectedRun.advanced_metrics?.cost?.applicable === true ? t('ragEval.available') : 'N/A'}
                </span>
              </div>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
                <div className="rounded-lg border border-border bg-bg-sidebar p-3">
                  <p className="text-xs font-medium">{t('ragEval.chunkRetrieval')}</p>
                  <p className="mt-2 text-sm">Recall@K: {formatAdvancedScore(
                    selectedRun.advanced_metrics?.chunk_retrieval,
                    selectedRun.advanced_metrics?.chunk_retrieval?.average_recall_at_k,
                  )}</p>
                  <p className="text-xs text-text-muted">MRR@K: {formatAdvancedScore(
                    selectedRun.advanced_metrics?.chunk_retrieval,
                    selectedRun.advanced_metrics?.chunk_retrieval?.average_mrr_at_k,
                  )}</p>
                </div>
                <div className="rounded-lg border border-border bg-bg-sidebar p-3">
                  <p className="text-xs font-medium">{t('ragEval.evidenceRetrieval')}</p>
                  <p className="mt-2 text-sm">Recall@K: {formatAdvancedScore(
                    selectedRun.advanced_metrics?.evidence_retrieval,
                    selectedRun.advanced_metrics?.evidence_retrieval?.average_recall_at_k,
                  )}</p>
                  <p className="text-xs text-text-muted">MRR@K: {formatAdvancedScore(
                    selectedRun.advanced_metrics?.evidence_retrieval,
                    selectedRun.advanced_metrics?.evidence_retrieval?.average_mrr_at_k,
                  )}</p>
                </div>
                <div className="rounded-lg border border-border bg-bg-sidebar p-3">
                  <p className="text-xs font-medium">{t('ragEval.graphRetrieval')}</p>
                  <p className="mt-2 text-sm">Recall@K: {formatAdvancedScore(
                    selectedRun.advanced_metrics?.graph_retrieval,
                    selectedRun.advanced_metrics?.graph_retrieval?.average_recall_at_k,
                  )}</p>
                  <p className="text-xs text-text-muted">Precision@K: {formatAdvancedScore(
                    selectedRun.advanced_metrics?.graph_retrieval,
                    selectedRun.advanced_metrics?.graph_retrieval?.average_precision_at_k,
                  )}</p>
                </div>
                <div className="rounded-lg border border-border bg-bg-sidebar p-3">
                  <p className="text-xs font-medium">{t('ragEval.answerability')}</p>
                  <p className="mt-2 text-sm">{t('ragEval.accuracy')}: {formatAdvancedScore(
                    selectedRun.advanced_metrics?.answerability,
                    selectedRun.advanced_metrics?.answerability?.accuracy,
                  )}</p>
                  <p className="text-xs text-text-muted">{t('ragEval.falseAnswerRate')}: {formatAdvancedScore(
                    selectedRun.advanced_metrics?.answerability,
                    selectedRun.advanced_metrics?.answerability?.false_answer_rate,
                  )}</p>
                </div>
                <div className="rounded-lg border border-border bg-bg-sidebar p-3">
                  <p className="text-xs font-medium">{t('ragEval.judgeCalibration')}</p>
                  <p className="mt-2 text-sm">MAE: {formatAdvancedScore(
                    selectedRun.advanced_metrics?.judge_human_calibration,
                    selectedRun.advanced_metrics?.judge_human_calibration?.mae,
                  )}</p>
                  <p className="text-xs text-text-muted">{t('ragEval.agreementRate')}: {formatAdvancedScore(
                    selectedRun.advanced_metrics?.judge_human_calibration,
                    selectedRun.advanced_metrics?.judge_human_calibration?.agreement_rate,
                  )}</p>
                </div>
              </div>
              <div className="mt-3 grid gap-3 text-xs text-text-muted sm:grid-cols-2">
                <p>
                  {t('ragEval.latencyPercentiles')}: P50 {formatAdvancedCount(
                    selectedRun.advanced_metrics?.latency_ms?.applicable,
                    selectedRun.advanced_metrics?.latency_ms?.p50,
                    'ms',
                  )} · P95 {formatAdvancedCount(
                    selectedRun.advanced_metrics?.latency_ms?.applicable,
                    selectedRun.advanced_metrics?.latency_ms?.p95,
                    'ms',
                  )}
                </p>
                <p>
                  {t('ragEval.tokenUsage')}: {selectedRun.advanced_metrics?.token_usage?.applicable === true
                    ? `${t('ragEval.answerTokens')} ${selectedRun.advanced_metrics.token_usage.answer?.total_tokens || 0} · ${t('ragEval.judgeTokens')} ${selectedRun.advanced_metrics.token_usage.judge?.total_tokens || 0}`
                    : 'N/A'}
                </p>
                <p>
                  {t('ragEval.retrievalConfidenceInterval')}: {selectedRun.advanced_metrics?.confidence_intervals?.retrieval_score?.applicable === true
                    ? `${formatScore(selectedRun.advanced_metrics.confidence_intervals.retrieval_score.lower)} – ${formatScore(selectedRun.advanced_metrics.confidence_intervals.retrieval_score.upper)}`
                    : 'N/A'}
                </p>
              </div>
              {(selectedRun.advanced_metrics?.slices?.length || 0) > 0 && (
                <div className="mt-3 overflow-x-auto rounded-lg border border-border">
                  <table className="min-w-full text-xs">
                    <thead className="bg-bg-sidebar text-text-muted">
                      <tr>
                        <th className="px-3 py-2 text-left">{t('ragEval.slice')}</th>
                        <th className="px-3 py-2 text-right">N</th>
                        <th className="px-3 py-2 text-right">{t('ragEval.retrievalScore')}</th>
                        <th className="px-3 py-2 text-right">{t('ragEval.answerScore')}</th>
                        <th className="px-3 py-2 text-right">{t('ragEval.groundingScore')}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {selectedRun.advanced_metrics?.slices?.map((slice) => (
                        <tr key={slice.slice}>
                          <td className="px-3 py-2 font-medium">{slice.slice}</td>
                          <td className="px-3 py-2 text-right text-text-muted">{slice.case_count}</td>
                          <td className="px-3 py-2 text-right">{formatMetricScore(slice.average_retrieval_score ?? undefined, slice.average_retrieval_score != null)}</td>
                          <td className="px-3 py-2 text-right">{formatMetricScore(slice.average_answer_score ?? undefined, slice.average_answer_score != null)}</td>
                          <td className="px-3 py-2 text-right">{formatMetricScore(slice.average_grounding_score ?? undefined, slice.average_grounding_score != null)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
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
                   const applicability = result.trace_summary?.metric_applicability;
                   const claims = result.claim_evaluation?.claims || [];

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
                            {t('ragEval.overallScore')}: {formatMetricScore(result.overall_score, applicability?.overall)}
                          </span>
                              <span className="rounded-full border border-border px-2 py-1">
                                {t('ragEval.answerScore')}: {formatMetricScore(result.answer_score, applicability?.answer)}
                              </span>
                              <span className="rounded-full border border-border px-2 py-1">
                                {t('ragEval.correctnessScore')}: {formatMetricScore(result.correctness_score, applicability?.correctness)}
                              </span>
                              <span className="rounded-full border border-border px-2 py-1">
                                {t('ragEval.completenessScore')}: {formatMetricScore(result.completeness_score, applicability?.completeness)}
                              </span>
                              <span className="rounded-full border border-border px-2 py-1">
                                {t('ragEval.faithfulnessScore')}: {formatMetricScore(result.faithfulness_score, applicability?.judge_faithfulness)}
                              </span>
                              <span className="rounded-full border border-border px-2 py-1">
                                {t('ragEval.sourceRecallScore')}: {formatMetricScore(result.source_recall_score ?? result.source_score, applicability?.retrieval)}
                              </span>
                              <span className="rounded-full border border-border px-2 py-1">
                                {t('ragEval.sourcePrecisionScore')}: {formatMetricScore(result.source_precision_score, applicability?.retrieval)}
                              </span>
                              <span className="rounded-full border border-border px-2 py-1">
                                {t('ragEval.citationAccuracyScore')}: {formatMetricScore(result.citation_accuracy_score, applicability?.faithfulness)}
                              </span>
                              <span className="rounded-full border border-border px-2 py-1">
                                {t('ragEval.citationPrecision')}: {formatMetricScore(result.citation_precision, applicability?.citation_precision)}
                              </span>
                              <span className="rounded-full border border-border px-2 py-1">
                                {t('ragEval.citationCoverage')}: {formatMetricScore(result.citation_coverage, applicability?.citation_coverage)}
                              </span>
                              <span className="rounded-full border border-border px-2 py-1">
                                {t('ragEval.citationF1')}: {formatMetricScore(result.citation_f1, applicability?.citation_f1)}
                              </span>
                              <span className="rounded-full border border-border px-2 py-1">
                                {t('ragEval.hallucinationRate')}: {formatMetricScore(result.hallucination_rate, applicability?.hallucination_rate)}
                              </span>
                              <span className="rounded-full border border-border px-2 py-1">
                                {t('ragEval.groundingScore')}: {formatMetricScore(result.grounding_score, applicability?.faithfulness)}
                              </span>
                              <span className="rounded-full border border-border px-2 py-1">
                                {t('ragEval.expectedAnswerSupportScore')}: {formatMetricScore(result.expected_answer_support_score, applicability?.expected_answer_support)}
                              </span>
                              <span className="rounded-full border border-border px-2 py-1">
                                {t('ragEval.verificationScore')}: {formatMetricScore(result.verification_score, applicability?.faithfulness)}
                              </span>
                              <span className="rounded-full border border-border px-2 py-1">
                                {t('ragEval.expectedAnswerSupportLabel')}: {getSupportLabel(result.expected_answer_support_label)}
                              </span>
                              <span className="rounded-full border border-border px-2 py-1">
                                {t('ragEval.supportStatus')}: {getSupportLabel(result.support_label)}
                              </span>
                              <span className={`rounded-full border px-2 py-1 font-semibold ${getEvidenceStatusClass(result.evidence_label)}`}>
                                {t('ragEval.evidence')}: {getEvidenceLabel(result.evidence_label)}
                              </span>
                          <span className={`rounded-full border px-2 py-1 font-semibold ${getResultStatusClass(result.status)}`}>
                            {t('ragEval.status')}: {getResultStatusLabel(result.status)}
                          </span>
                        </div>
                      </div>

                      {result.actual_answer && (
                        <div className="mt-3 rounded-lg border border-border p-3">
                          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-muted">
                            {t('ragEval.actualAnswer')}
                          </p>
                          <p className="whitespace-pre-wrap break-words text-sm text-text-main">{result.actual_answer}</p>
                        </div>
                      )}

                      {(result.prompt_version || result.model_version || result.judge_version || result.verifier_version) && (
                        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-text-muted">
                          {result.prompt_version && <span>{t('ragEval.promptVersion')}: {result.prompt_version}</span>}
                          {result.model_version && <span>{t('ragEval.modelVersion')}: {result.model_version}</span>}
                          {result.judge_version && <span>{t('ragEval.judgeVersion')}: {result.judge_version}</span>}
                          {result.verifier_version && <span>{t('ragEval.verifierVersion')}: {result.verifier_version}</span>}
                        </div>
                      )}

                      {claims.length > 0 && (
                        <div className="mt-3 rounded-lg border border-border p-3">
                          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-muted">
                            {t('ragEval.claimCitationMapping')}
                          </p>
                          <div className="space-y-2">
                            {claims.map((claim, claimIndex) => (
                              <div key={`${claim.claim_index || claimIndex}-${claim.text || ''}`} className="text-xs">
                                <div className="flex items-start gap-2">
                                  <span className={claim.supported ? 'text-emerald-300' : 'text-red-300'}>
                                    {claim.supported ? t('ragEval.claimSupported') : t('ragEval.claimUnsupported')}
                                  </span>
                                  <span className="min-w-0 break-words text-text-main">{claim.text}</span>
                                </div>
                                <p className="mt-1 text-text-muted">
                                  {t('ragEval.citationLabels')}: {claim.citation_labels?.length ? claim.citation_labels.map((label) => `[Source ${label}]`).join(', ') : 'N/A'}
                                  {claim.reasons?.length ? ` · ${claim.reasons.join(', ')}` : ''}
                                </p>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      <div className="mt-3 grid gap-3 lg:grid-cols-2">
                        <div className="rounded-lg border border-border p-3">
                          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-muted">
                            {t('ragEval.matchedSources')}
                          </p>
                          {matchedSources.length > 0 ? (
                            <div className="space-y-2">
                              {matchedSources.slice(0, 5).map((source, index) => (
                                <div key={`${source.file_id || source.chunk_id || source.filename || index}`} className="text-xs">
                                  <div className="break-words text-text-main">
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
                                <span key={query} className="max-w-full break-words rounded-md bg-bg-sidebar px-2 py-1 text-[11px] text-text-muted">
                                  {query}
                                </span>
                              ))}
                            </div>
                          )}
                          {traceSteps.length > 0 ? (
                            <div className="space-y-1.5">
                              {traceSteps.map((step, index) => (
                                <div key={`${step.step_type || 'step'}-${index}`} className="flex items-center justify-between gap-3 text-xs">
                                  <span className="truncate text-text-main">{getRagTraceStepLabel(t, step.step_type)}</span>
                                  <span className={`shrink-0 rounded-full border px-2 py-0.5 ${getResultStatusClass(step.status)}`}>
                                    {getRagTraceStatusLabel(t, step.status)} · {step.duration_ms ?? 0}ms
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
