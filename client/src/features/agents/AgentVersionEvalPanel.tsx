import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  BarChart3,
  CheckCircle2,
  CircleStop,
  Database,
  FlaskConical,
  LoaderCircle,
  Play,
  Plus,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import SelectField from '../../components/SelectField';
import api from '../../lib/api';
import { readApiErrorMessage } from '../../lib/apiError';
import { isRequestCancellation } from '../../lib/requestCancellation';
import type {
  AgentEvalCase,
  AgentEvalDataset,
  AgentEvalRun,
  AgentVersion,
} from './types';
import { buildAgentEvalEvaluationSpec } from './agentEvalCase';

interface AgentVersionEvalPanelProps {
  agentId: string;
  candidateVersionId: string;
  versions: AgentVersion[];
}

interface CaseDraft {
  name: string;
  input: string;
  expectedOutput: string;
  forbiddenOutput: string;
  expectedToolCalls: string;
  forbiddenToolKeys: string;
  groundingEvidence: string;
  expectedCitations: string;
}

const emptyCaseDraft: CaseDraft = {
  name: '',
  input: '',
  expectedOutput: '',
  forbiddenOutput: '',
  expectedToolCalls: '',
  forbiddenToolKeys: '',
  groundingEvidence: '',
  expectedCitations: '',
};

const activeStatuses = new Set<AgentEvalRun['status']>(['queued', 'running']);
const statusClasses: Record<AgentEvalRun['status'], string> = {
  queued: 'border-sky-500/30 bg-sky-500/10 text-sky-200',
  running: 'border-amber-500/30 bg-amber-500/10 text-amber-200',
  completed: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200',
  partial: 'border-orange-500/30 bg-orange-500/10 text-orange-200',
  failed: 'border-red-500/30 bg-red-500/10 text-red-200',
  cancelled: 'border-border bg-bg-base text-text-muted',
};

const readMetric = (value: unknown) => (
  typeof value === 'number' && Number.isFinite(value) ? value : null
);

const formatScore = (value: unknown, percent = true) => {
  const score = readMetric(value);
  if (score === null) return 'N/A';
  return percent ? `${Math.round(score * 100)}%` : score.toFixed(3);
};

export default function AgentVersionEvalPanel({
  agentId,
  candidateVersionId,
  versions,
}: AgentVersionEvalPanelProps) {
  const { t, i18n } = useTranslation();
  const [datasets, setDatasets] = useState<AgentEvalDataset[]>([]);
  const [selectedDatasetId, setSelectedDatasetId] = useState('');
  const [baselineVersionId, setBaselineVersionId] = useState('');
  const [datasetName, setDatasetName] = useState('');
  const [datasetDescription, setDatasetDescription] = useState('');
  const [caseDraft, setCaseDraft] = useState<CaseDraft>(emptyCaseDraft);
  const [selectedRun, setSelectedRun] = useState<AgentEvalRun | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingDataset, setSavingDataset] = useState(false);
  const [savingCase, setSavingCase] = useState(false);
  const [queueing, setQueueing] = useState(false);
  const [loadError, setLoadError] = useState('');
  const loadAbortRef = useRef<AbortController | null>(null);

  const selectedDataset = useMemo(
    () => datasets.find((dataset) => dataset.id === selectedDatasetId) || datasets[0] || null,
    [datasets, selectedDatasetId],
  );
  const versionById = useMemo(
    () => new Map(versions.map((version) => [version.id, version.version])),
    [versions],
  );
  const activeRunKey = useMemo(
    () => datasets.flatMap((dataset) => dataset.runs || [])
      .filter((run) => activeStatuses.has(run.status))
      .map((run) => run.id)
      .sort((left, right) => left.localeCompare(right))
      .join(','),
    [datasets],
  );
  const dateFormatter = useMemo(() => new Intl.DateTimeFormat(i18n.language, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }), [i18n.language]);

  useEffect(() => {
    loadAbortRef.current?.abort();
    const controller = new AbortController();
    loadAbortRef.current = controller;
    setLoading(true);
    setLoadError('');
    void api.get<AgentEvalDataset[]>('/agent-eval/datasets', { signal: controller.signal })
      .then(({ data }) => {
        setDatasets(data);
        setSelectedDatasetId((current) => (
          data.some((dataset) => dataset.id === current) ? current : data[0]?.id || ''
        ));
      })
      .catch((error: unknown) => {
        if (!isRequestCancellation(error)) {
          setLoadError(readApiErrorMessage(error, t('agents.evalLoadFailed')));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [t]);

  useEffect(() => {
    if (!activeRunKey) return undefined;
    const activeRunIds = activeRunKey.split(',');
    let disposed = false;
    let timer: number | undefined;
    const refresh = async () => {
      try {
        const settled = await Promise.allSettled(
          activeRunIds.map((runId) => api.get<AgentEvalRun>(`/agent-eval/runs/${runId}`)),
        );
        if (disposed) return;
        const refreshed = settled.flatMap((result) => (
          result.status === 'fulfilled' ? [result.value.data] : []
        ));
        if (refreshed.length > 0) {
          const byId = new Map(refreshed.map((run) => [run.id, run]));
          setDatasets((current) => current.map((dataset) => ({
            ...dataset,
            runs: dataset.runs.map((run) => byId.get(run.id) || run),
          })));
          setSelectedRun((current) => current ? byId.get(current.id) || current : current);
        }
      } finally {
        if (!disposed) timer = window.setTimeout(() => void refresh(), 1500);
      }
    };
    void refresh();
    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [activeRunKey]);

  const createDataset = async () => {
    const name = datasetName.trim();
    if (!name || savingDataset) return;
    setSavingDataset(true);
    try {
      const { data } = await api.post<AgentEvalDataset>('/agent-eval/datasets', {
        name,
        description: datasetDescription.trim(),
      });
      setDatasets((current) => [data, ...current]);
      setSelectedDatasetId(data.id);
      setSelectedRun(null);
      setDatasetName('');
      setDatasetDescription('');
      toast.success(t('agents.evalDatasetCreated'));
    } catch (error) {
      toast.error(readApiErrorMessage(error, t('agents.evalDatasetCreateFailed')));
    } finally {
      setSavingDataset(false);
    }
  };

  const deleteDataset = async () => {
    if (!selectedDataset || !window.confirm(t('agents.evalDeleteDatasetConfirm', {
      name: selectedDataset.name,
    }))) return;
    try {
      await api.delete(`/agent-eval/datasets/${selectedDataset.id}`);
      setDatasets((current) => current.filter((dataset) => dataset.id !== selectedDataset.id));
      setSelectedDatasetId('');
      setSelectedRun(null);
    } catch (error) {
      toast.error(readApiErrorMessage(error, t('agents.evalDatasetDeleteFailed')));
    }
  };

  const createCase = async () => {
    if (!selectedDataset || !caseDraft.input.trim() || savingCase) return;
    try {
      const spec = buildAgentEvalEvaluationSpec(caseDraft);
      if (!spec) {
        toast.error(t('agents.evalOracleRequired'));
        return;
      }
      setSavingCase(true);
      const { data } = await api.post<AgentEvalCase>(
        `/agent-eval/datasets/${selectedDataset.id}/cases`,
        { name: caseDraft.name.trim(), input: caseDraft.input.trim(), evaluation_spec: spec },
      );
      setDatasets((current) => current.map((dataset) => (
        dataset.id === selectedDataset.id
          ? { ...dataset, revision: Number(dataset.revision) + 1, cases: [...dataset.cases, data] }
          : dataset
      )));
      setCaseDraft(emptyCaseDraft);
      toast.success(t('agents.evalCaseCreated'));
    } catch (error) {
      toast.error(error instanceof SyntaxError
        ? t('agents.evalToolJsonInvalid')
        : readApiErrorMessage(error, t('agents.evalCaseCreateFailed')));
    } finally {
      setSavingCase(false);
    }
  };

  const deleteCase = async (caseId: string) => {
    if (!selectedDataset || !window.confirm(t('agents.evalDeleteCaseConfirm'))) return;
    try {
      await api.delete(`/agent-eval/cases/${caseId}`);
      setDatasets((current) => current.map((dataset) => (
        dataset.id === selectedDataset.id
          ? {
            ...dataset,
            revision: Number(dataset.revision) + 1,
            cases: dataset.cases.filter((testCase) => testCase.id !== caseId),
          }
          : dataset
      )));
    } catch (error) {
      toast.error(readApiErrorMessage(error, t('agents.evalCaseDeleteFailed')));
    }
  };

  const queueRun = async () => {
    if (!selectedDataset || selectedDataset.cases.length === 0 || queueing) return;
    setQueueing(true);
    try {
      const { data } = await api.post<AgentEvalRun>(
        `/agent-eval/datasets/${selectedDataset.id}/runs`,
        {
          agent_id: agentId,
          candidate_version_id: candidateVersionId,
          baseline_version_id: baselineVersionId || null,
        },
      );
      setDatasets((current) => current.map((dataset) => (
        dataset.id === selectedDataset.id
          ? { ...dataset, runs: [data, ...dataset.runs.filter((run) => run.id !== data.id)] }
          : dataset
      )));
      setSelectedRun(data);
      toast.success(t('agents.evalRunQueued'));
    } catch (error) {
      toast.error(readApiErrorMessage(error, t('agents.evalRunFailed')));
    } finally {
      setQueueing(false);
    }
  };

  const loadRun = async (run: AgentEvalRun) => {
    setSelectedRun(run);
    if (run.results) return;
    try {
      const { data } = await api.get<AgentEvalRun>(`/agent-eval/runs/${run.id}`);
      setSelectedRun(data);
      setDatasets((current) => current.map((dataset) => ({
        ...dataset,
        runs: dataset.runs.map((item) => item.id === data.id ? data : item),
      })));
    } catch (error) {
      toast.error(readApiErrorMessage(error, t('agents.evalRunLoadFailed')));
    }
  };

  const cancelRun = async (run: AgentEvalRun) => {
    try {
      const { data } = await api.post<AgentEvalRun>(`/agent-eval/runs/${run.id}/cancel`);
      setDatasets((current) => current.map((dataset) => ({
        ...dataset,
        runs: dataset.runs.map((item) => item.id === data.id ? data : item),
      })));
      setSelectedRun((current) => current?.id === data.id ? data : current);
    } catch (error) {
      toast.error(readApiErrorMessage(error, t('agents.evalCancelFailed')));
    }
  };

  const formatDate = (value: string) => dateFormatter.format(new Date(value));

  const candidateMetrics = selectedRun?.aggregate_metrics?.candidate || {};
  const baselineMetrics = selectedRun?.aggregate_metrics?.baseline || null;
  const deltaMetrics = selectedRun?.aggregate_metrics?.delta || null;

  return (
    <section className="space-y-4 rounded-xl border border-border bg-bg-base p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h4 className="flex items-center gap-2 text-sm font-semibold text-text-main">
            <BarChart3 className="h-4 w-4 text-primary" /> {t('agents.evalTitle')}
          </h4>
          <p className="mt-1 max-w-3xl text-xs leading-5 text-text-muted">{t('agents.evalHint')}</p>
        </div>
        <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-[11px] text-emerald-200">
          <ShieldCheck className="h-3.5 w-3.5" /> {t('agents.evalFixtureOnly')}
        </span>
      </div>

      <p className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-[11px] leading-5 text-amber-100">
        {t('agents.evalIsolationNotice')}
      </p>

      {loadError ? (
        <p className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">
          <AlertCircle className="h-4 w-4 shrink-0" /> {loadError}
        </p>
      ) : null}

      {loading ? (
        <p className="flex items-center justify-center gap-2 py-8 text-sm text-text-muted">
          <LoaderCircle className="h-4 w-4 animate-spin" /> {t('common.loading')}
        </p>
      ) : (
        <>
          <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(260px,0.55fr)]">
            <div className="space-y-2 rounded-xl border border-border bg-bg-surface p-3">
              <div className="flex items-center justify-between gap-3">
                <h5 className="flex items-center gap-2 text-xs font-semibold text-text-main">
                  <Database className="h-3.5 w-3.5 text-primary" /> {t('agents.evalDataset')}
                </h5>
                {selectedDataset ? (
                  <button type="button" onClick={() => void deleteDataset()} className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[10px] text-text-muted hover:bg-red-500/10 hover:text-red-300">
                    <Trash2 className="h-3 w-3" /> {t('agents.evalDeleteDataset')}
                  </button>
                ) : null}
              </div>
              <SelectField
                className="w-full"
                value={selectedDataset?.id || ''}
                onChange={(event) => {
                  setSelectedDatasetId(event.target.value);
                  setSelectedRun(null);
                }}
              >
                <option value="">{t('agents.evalSelectDataset')}</option>
                {datasets.map((dataset) => (
                  <option key={dataset.id} value={dataset.id}>
                    {dataset.name} · r{dataset.revision} · {dataset.cases.length}
                  </option>
                ))}
              </SelectField>
              {selectedDataset?.description ? (
                <p className="text-[11px] leading-5 text-text-muted">{selectedDataset.description}</p>
              ) : null}
            </div>
            <div className="space-y-2 rounded-xl border border-border bg-bg-surface p-3">
              <h5 className="text-xs font-semibold text-text-main">{t('agents.evalNewDataset')}</h5>
              <input value={datasetName} onChange={(event) => setDatasetName(event.target.value)} maxLength={120} placeholder={t('agents.evalDatasetName')} className="h-9 w-full rounded-lg border border-border bg-bg-base px-3 text-xs text-text-main outline-none focus:border-primary/60" />
              <input value={datasetDescription} onChange={(event) => setDatasetDescription(event.target.value)} maxLength={1000} placeholder={t('agents.evalDatasetDescription')} className="h-9 w-full rounded-lg border border-border bg-bg-base px-3 text-xs text-text-main outline-none focus:border-primary/60" />
              <button type="button" disabled={!datasetName.trim() || savingDataset} onClick={() => void createDataset()} className="inline-flex h-9 w-full items-center justify-center gap-2 rounded-lg border border-primary/40 text-xs font-medium text-primary hover:bg-primary/10 disabled:opacity-50">
                {savingDataset ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                {t('agents.evalCreateDataset')}
              </button>
            </div>
          </div>

          {selectedDataset ? (
            <div className="grid gap-4 xl:grid-cols-[minmax(300px,0.8fr)_minmax(0,1.2fr)]">
              <div className="space-y-3 rounded-xl border border-border bg-bg-surface p-3">
                <h5 className="text-xs font-semibold text-text-main">{t('agents.evalAddCase')}</h5>
                <input value={caseDraft.name} onChange={(event) => setCaseDraft((current) => ({ ...current, name: event.target.value }))} maxLength={120} placeholder={t('agents.evalCaseName')} className="h-9 w-full rounded-lg border border-border bg-bg-base px-3 text-xs text-text-main outline-none focus:border-primary/60" />
                <textarea value={caseDraft.input} onChange={(event) => setCaseDraft((current) => ({ ...current, input: event.target.value }))} rows={3} maxLength={16000} placeholder={t('agents.evalCaseInput')} className="w-full resize-y rounded-lg border border-border bg-bg-base px-3 py-2 text-xs leading-5 text-text-main outline-none focus:border-primary/60" />
                <div className="grid gap-2 md:grid-cols-2">
                  <textarea value={caseDraft.expectedOutput} onChange={(event) => setCaseDraft((current) => ({ ...current, expectedOutput: event.target.value }))} rows={3} placeholder={t('agents.evalExpectedOutput')} className="w-full resize-y rounded-lg border border-border bg-bg-base px-3 py-2 text-xs leading-5 text-text-main outline-none focus:border-primary/60" />
                  <textarea value={caseDraft.forbiddenOutput} onChange={(event) => setCaseDraft((current) => ({ ...current, forbiddenOutput: event.target.value }))} rows={3} placeholder={t('agents.evalForbiddenOutput')} className="w-full resize-y rounded-lg border border-border bg-bg-base px-3 py-2 text-xs leading-5 text-text-main outline-none focus:border-primary/60" />
                  <textarea value={caseDraft.groundingEvidence} onChange={(event) => setCaseDraft((current) => ({ ...current, groundingEvidence: event.target.value }))} rows={3} placeholder={t('agents.evalGroundingEvidence')} className="w-full resize-y rounded-lg border border-border bg-bg-base px-3 py-2 text-xs leading-5 text-text-main outline-none focus:border-primary/60" />
                  <textarea value={caseDraft.expectedCitations} onChange={(event) => setCaseDraft((current) => ({ ...current, expectedCitations: event.target.value }))} rows={3} placeholder={t('agents.evalExpectedCitations')} className="w-full resize-y rounded-lg border border-border bg-bg-base px-3 py-2 text-xs leading-5 text-text-main outline-none focus:border-primary/60" />
                </div>
                <textarea value={caseDraft.expectedToolCalls} onChange={(event) => setCaseDraft((current) => ({ ...current, expectedToolCalls: event.target.value }))} rows={5} placeholder={t('agents.evalExpectedTools')} className="w-full resize-y rounded-lg border border-border bg-bg-base px-3 py-2 font-mono text-[11px] leading-5 text-text-main outline-none focus:border-primary/60" />
                <textarea value={caseDraft.forbiddenToolKeys} onChange={(event) => setCaseDraft((current) => ({ ...current, forbiddenToolKeys: event.target.value }))} rows={2} placeholder={t('agents.evalForbiddenTools')} className="w-full resize-y rounded-lg border border-border bg-bg-base px-3 py-2 text-xs leading-5 text-text-main outline-none focus:border-primary/60" />
                <button type="button" disabled={!caseDraft.input.trim() || savingCase} onClick={() => void createCase()} className="inline-flex h-9 w-full items-center justify-center gap-2 rounded-lg bg-primary text-xs font-medium text-white hover:bg-primary/90 disabled:opacity-50">
                  {savingCase ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                  {t('agents.evalSaveCase')}
                </button>
              </div>

              <div className="space-y-3">
                <div className="rounded-xl border border-border bg-bg-surface p-3">
                  <div className="flex flex-wrap items-end gap-3">
                    <div className="min-w-48 flex-1">
                      <p className="mb-1.5 text-[11px] text-text-muted">{t('agents.evalCandidate')}</p>
                      <p className="flex h-10 items-center rounded-lg border border-border bg-bg-base px-3 text-sm text-text-main">
                        v{versionById.get(candidateVersionId) || '?'}
                      </p>
                    </div>
                    <label className="min-w-48 flex-1">
                      <span className="mb-1.5 block text-[11px] text-text-muted">{t('agents.evalBaseline')}</span>
                      <SelectField className="w-full" value={baselineVersionId} onChange={(event) => setBaselineVersionId(event.target.value)}>
                        <option value="">{t('agents.evalNoBaseline')}</option>
                        {versions.filter((version) => version.id !== candidateVersionId).map((version) => (
                          <option key={version.id} value={version.id}>v{version.version}</option>
                        ))}
                      </SelectField>
                    </label>
                    <button type="button" disabled={queueing || selectedDataset.cases.length === 0} onClick={() => void queueRun()} className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-primary px-4 text-xs font-medium text-white hover:bg-primary/90 disabled:opacity-50">
                      {queueing ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                      {t('agents.evalRun')}
                    </button>
                  </div>
                </div>

                <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
                  {selectedDataset.cases.length === 0 ? (
                    <p className="rounded-xl border border-dashed border-border p-6 text-center text-xs text-text-muted">{t('agents.evalNoCases')}</p>
                  ) : selectedDataset.cases.map((testCase) => (
                    <article key={testCase.id} style={{ contentVisibility: 'auto', containIntrinsicSize: '0 90px' }} className="rounded-xl border border-border bg-bg-surface p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <h6 className="truncate text-xs font-medium text-text-main">{testCase.name || t('agents.evalUnnamedCase')}</h6>
                          <p className="mt-1 line-clamp-2 text-[11px] leading-5 text-text-muted">{testCase.input_text}</p>
                        </div>
                        <button type="button" aria-label={t('agents.evalDeleteCase')} onClick={() => void deleteCase(testCase.id)} className="rounded-md p-1.5 text-text-muted hover:bg-red-500/10 hover:text-red-300">
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                      <p className="mt-2 text-[10px] text-text-muted">{Object.keys(testCase.evaluation_spec || {}).join(' · ')}</p>
                    </article>
                  ))}
                </div>
              </div>
            </div>
          ) : null}

          {selectedDataset && selectedDataset.runs.length > 0 ? (
            <div className="grid gap-4 xl:grid-cols-[minmax(260px,0.65fr)_minmax(0,1.35fr)]">
              <div className="max-h-[520px] space-y-2 overflow-y-auto pr-1">
                {selectedDataset.runs.map((run) => (
                  <button key={run.id} type="button" onClick={() => void loadRun(run)} className={`w-full rounded-xl border p-3 text-left ${selectedRun?.id === run.id ? 'border-primary/60 bg-primary/10' : 'border-border bg-bg-surface'}`}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className={`rounded border px-2 py-0.5 text-[10px] ${statusClasses[run.status]}`}>{t(`agents.evalStatuses.${run.status}`)}</span>
                      <span className="text-[10px] text-text-muted">r{run.dataset_revision}</span>
                    </div>
                    <p className="mt-2 text-xs text-text-main">v{versionById.get(run.candidate_agent_version_id) || '?'}{run.baseline_agent_version_id ? ` vs v${versionById.get(run.baseline_agent_version_id) || '?'}` : ''}</p>
                    <p className="mt-1 text-[10px] text-text-muted">{formatDate(run.created_at)} · {run.case_count} cases</p>
                  </button>
                ))}
              </div>

              {selectedRun ? (
                <div className="min-w-0 space-y-3 rounded-xl border border-border bg-bg-surface p-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="text-xs font-semibold text-text-main">{t('agents.evalReport')}</p>
                      <p className="mt-1 text-[10px] text-text-muted">{selectedRun.evaluator_version} · {selectedRun.usage.total_tokens} tokens · {t('agents.evalCostUnavailable')}</p>
                    </div>
                    {activeStatuses.has(selectedRun.status) ? (
                      <button type="button" onClick={() => void cancelRun(selectedRun)} className="inline-flex items-center gap-1.5 rounded-lg border border-red-500/30 px-3 py-1.5 text-[11px] text-red-200 hover:bg-red-500/10">
                        <CircleStop className="h-3.5 w-3.5" /> {t('common.cancel')}
                      </button>
                    ) : (
                      <span className={`rounded border px-2 py-0.5 text-[10px] ${statusClasses[selectedRun.status]}`}>{t(`agents.evalStatuses.${selectedRun.status}`)}</span>
                    )}
                  </div>

                  {selectedRun.failure_message ? (
                    <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">{selectedRun.failure_message}</p>
                  ) : null}

                  {Object.keys(candidateMetrics).length > 0 ? (
                    <div className="overflow-x-auto rounded-lg border border-border">
                      <table className="w-full min-w-[520px] text-left text-[11px]">
                        <thead className="bg-bg-base text-text-muted">
                          <tr><th className="px-3 py-2">{t('agents.evalMetric')}</th><th className="px-3 py-2">{t('agents.evalCandidate')}</th><th className="px-3 py-2">{t('agents.evalBaseline')}</th><th className="px-3 py-2">Δ</th></tr>
                        </thead>
                        <tbody>
                          {['task_success', 'overall_score', 'output_schema_validity', 'tool_selection_score', 'tool_argument_validity', 'tool_argument_correctness', 'safety_score', 'groundedness_score', 'citation_quality_score'].map((key) => (
                            <tr key={key} className="border-t border-border">
                              <td className="px-3 py-2 text-text-muted">{t(`agents.evalMetrics.${key}`)}</td>
                              <td className="px-3 py-2 text-text-main">{formatScore(candidateMetrics[key])}</td>
                              <td className="px-3 py-2 text-text-main">{baselineMetrics ? formatScore(baselineMetrics[key]) : 'N/A'}</td>
                              <td className="px-3 py-2 text-text-main">{deltaMetrics ? formatScore(deltaMetrics[key], false) : 'N/A'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p className="flex items-center justify-center gap-2 py-8 text-xs text-text-muted">
                      {activeStatuses.has(selectedRun.status) ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <FlaskConical className="h-4 w-4" />}
                      {activeStatuses.has(selectedRun.status) ? t('agents.evalRunning') : t('agents.evalNoMetrics')}
                    </p>
                  )}

                  {selectedRun.aggregate_metrics?.paired ? (
                    <p className="flex items-center gap-2 rounded-lg border border-border bg-bg-base px-3 py-2 text-[11px] text-text-muted">
                      <CheckCircle2 className="h-3.5 w-3.5 text-emerald-300" />
                      {t('agents.evalPaired', selectedRun.aggregate_metrics.paired)}
                    </p>
                  ) : null}

                  {(selectedRun.results || []).map((result) => (
                    <details key={`${result.case_id}:${result.variant}`} className="rounded-lg border border-border bg-bg-base p-3">
                      <summary className="cursor-pointer text-xs font-medium text-text-main">
                        {result.variant === 'candidate' ? t('agents.evalCandidate') : t('agents.evalBaseline')} · {formatScore(result.metrics.overall_score)} · {result.latency_ms} ms
                      </summary>
                      {result.failure_message ? <p className="mt-2 text-xs text-red-200">{result.failure_message}</p> : null}
                      {result.output_text ? <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-words text-[11px] leading-5 text-text-muted">{result.output_text}</pre> : null}
                      {result.planned_tool_calls.length > 0 ? <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-words text-[10px] leading-5 text-text-muted">{JSON.stringify(result.planned_tool_calls, null, 2)}</pre> : null}
                    </details>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
