import { describe, expect, it } from 'vitest';
import type { TFunction } from 'i18next';
import type { RagEvalDataset, RagEvalRun } from './model';
import {
  buildRagEvalRunMarkdown,
  createRagEvalRunExportFilename,
} from './report';

const run: RagEvalRun = {
  id: '12345678-1234-4123-8123-123456789abc',
  status: 'completed',
  case_count: 1,
  failed_count: 0,
  average_overall_score: 0.8,
  average_retrieval_score: 0.9,
  average_answer_score: 0.7,
  average_source_score: 1,
  average_keyword_score: 1,
  duration_ms: 120,
  created_at: '2026-08-01T00:00:00.000Z',
  metric_applicability: {
    overall: true,
    retrieval: true,
    answer: true,
    faithfulness: false,
    keyword_retrieval: true,
  },
  results: [],
};

const dataset: RagEvalDataset = {
  id: 'dataset-1',
  name: 'Release / Safety: Suite',
  description: 'Regression dataset',
  cases: [],
  runs: [run],
};

describe('RAG evaluation report', () => {
  it('creates a filesystem-safe deterministic filename', () => {
    expect(createRagEvalRunExportFilename(dataset, run, '2026-08-01T10:00:00Z'))
      .toBe('chatllm-rag-eval-2026-08-01-release-safety-suite-12345678.md');
  });

  it('preserves applicability and run metadata in Markdown', () => {
    const t = ((key: string) => key) as TFunction;
    const markdown = buildRagEvalRunMarkdown(dataset, run, t, '2026-08-01T10:00:00Z');

    expect(markdown).toContain('- Run ID: 12345678-1234-4123-8123-123456789abc');
    expect(markdown).toContain('- Retrieval score: 90%');
    expect(markdown).toContain('- Citation accuracy: N/A');
    expect(markdown.endsWith('\n')).toBe(true);
  });
});
