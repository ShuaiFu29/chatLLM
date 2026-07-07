type Translate = (key: string, options?: Record<string, unknown>) => unknown;

const stepLabelKeys: Record<string, string> = {
  intent_route: 'ragTrace.steps.intent_route',
  metadata_lookup: 'ragTrace.steps.metadata_lookup',
  question_classify: 'ragTrace.steps.question_classify',
  retriever_route: 'ragTrace.steps.retriever_route',
  query_rewrite: 'ragTrace.steps.query_rewrite',
  retrieve: 'ragTrace.steps.retrieve',
  retrieve_retry: 'ragTrace.steps.retrieve_retry',
  rerank: 'ragTrace.steps.rerank',
  evidence_check: 'ragTrace.steps.evidence_check',
};

const statusLabelKeys: Record<string, string> = {
  success: 'ragTrace.statuses.success',
  partial: 'ragTrace.statuses.partial',
  failed: 'ragTrace.statuses.failed',
  running: 'ragTrace.statuses.running',
  cancelled: 'ragTrace.statuses.cancelled',
  pending: 'ragTrace.statuses.pending',
};

const normalizeTraceToken = (value?: string | null) => String(value || '').trim().toLowerCase();

const humanizeTraceToken = (value?: string | null) => {
  const normalized = normalizeTraceToken(value)
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return normalized || '-';
};

export const getRagTraceStepLabel = (t: Translate, stepType?: string | null) => {
  const normalized = normalizeTraceToken(stepType);
  const labelKey = stepLabelKeys[normalized];

  return String(labelKey ? t(labelKey) : t('ragTrace.steps.unknown', { step: humanizeTraceToken(stepType) }));
};

export const getRagTraceStatusLabel = (t: Translate, status?: string | null) => {
  const normalized = normalizeTraceToken(status);
  const labelKey = statusLabelKeys[normalized];

  return String(labelKey ? t(labelKey) : t('ragTrace.statuses.unknown', { status: humanizeTraceToken(status) }));
};
