import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const scriptPath = path.join(rootDir, 'scripts', 'rag-demo-suite.mjs');

test('rag demo suite script validates demo corpora end to end and cleans up safely', () => {
  assert.equal(existsSync(scriptPath), true);
  const source = readFileSync(scriptPath, 'utf8');
  const pkg = JSON.parse(readFileSync(path.join(rootDir, 'package.json'), 'utf8'));

  assert.equal(pkg.scripts['rag:demo-suite'], 'node scripts/rag-demo-suite.mjs');
  assert.match(source, /parseEvaluationCases/);
  assert.match(source, /expected_source_files/);
  assert.match(source, /\/ingest-sync/);
  assert.match(source, /\/agentic-retrieve/);
  assert.match(source, /sourceHitRate/);
  assert.match(source, /weakEvidenceCount/);
  assert.match(source, /guideTop3Count/);
  assert.match(source, /fetchJsonWithRetry/);
  assert.match(source, /maxAttempts/);
  assert.match(source, /cleanup-file/);
  assert.match(source, /DeleteObjectCommand/);
  assert.match(source, /--keep/);
  assert.match(source, /--focused/);
  assert.match(source, /selectFilesForCases/);
  assert.match(source, /console\.error/);
  assert.match(source, /delete from users where id = \$1/);
});

test('rag demo suite parser accepts Q-prefixed and domain-prefixed case ids', async () => {
  const { parseEvaluationCases } = await import(pathToFileURL(scriptPath));
  const guideText = [
    '| 编号 | 问题 | 期望来源文档 | 需要原因 |',
    '| --- | --- | --- | --- |',
    '| Q01 | 2026 年默认响应确认窗口是多少？ | 01, 02, 11 | 需识别废止规则 |',
    '| SQ02 | CPU 85% 是否一定触发自动扩容？ | 03, 05 | 需区分指标 |',
  ].join('\n');

  assert.deepEqual(parseEvaluationCases(guideText).map((item) => item.id), ['Q01', 'SQ02']);
});

test('rag demo suite recognizes the real Chinese corpus guide filename', async () => {
  const { isGuideFilename } = await import(pathToFileURL(scriptPath));

  assert.equal(isGuideFilename('00-语料索引与测试指南.md'), true);
  assert.equal(isGuideFilename('02-2026当前质保与客户索赔政策.md'), false);
});

test('rag demo suite creates filename fallback cases when a corpus has no guide table', async () => {
  const { buildFallbackEvaluationCases } = await import(pathToFileURL(scriptPath));
  const files = [
    path.join(rootDir, 'rag-demo', 'demo', 'BMS日志解读说明.md'),
    path.join(rootDir, 'rag-demo', 'demo', '质保判定手册当前版.md'),
  ];

  const cases = buildFallbackEvaluationCases(files, 2);

  assert.equal(cases.length, 2);
  assert.equal(cases[0].id, 'AUTO01');
  assert.equal(cases[0].expectedSourceFilenames[0], 'BMS日志解读说明.md');
  assert.match(cases[0].question, /BMS日志解读说明/);
  assert.equal(cases[1].expectedSourceFilenames[0], '质保判定手册当前版.md');
});

test('rag demo suite evaluator matches expected source filenames directly', async () => {
  const { evaluateCaseResult } = await import(pathToFileURL(scriptPath));
  const result = evaluateCaseResult(
    {
      id: 'AUTO01',
      question: '请概述 BMS 日志解读说明',
      expectedSourceNumbers: [],
      expectedSourceFilenames: ['BMS日志解读说明.md'],
    },
    {
      quality: { evidence_label: 'strong' },
      results: [
        { metadata: { filename: '售后专项材料目录.md' } },
        { metadata: { filename: 'BMS日志解读说明.md' } },
      ],
    },
    5
  );

  assert.equal(result.sourceHitRate, 1);
  assert.deepEqual(result.matchedSourceFilenames, ['BMS日志解读说明.md']);
});

test('rag demo suite fails when any expected source case is missed by default', async () => {
  const { buildFailureReasons } = await import(pathToFileURL(scriptPath));
  const reasons = buildFailureReasons([
    {
      suiteName: 'demo-suite',
      sourceHitRate: 0.95,
      weakEvidenceCount: 0,
      guideTop3Count: 0,
      sourceMissCount: 1,
    },
  ], {
    minSourceHitRate: 0.75,
    maxWeakEvidence: 0,
    maxGuideTop3: 0,
    maxSourceMisses: 0,
  });

  assert.deepEqual(reasons, ['demo-suite sourceMissCount 1 > 0']);
});

test('rag demo suite can skip already passing suites from a resume report', async () => {
  const { filterSuitesForResume } = await import(pathToFileURL(scriptPath));

  const pendingSuites = filterSuitesForResume(
    ['suite-a', 'suite-b', 'suite-c'],
    {
      suites: [
        {
          suiteName: 'suite-a',
          status: 'ok',
          sourceHitRate: 1,
          sourceMissCount: 0,
          weakEvidenceCount: 0,
          guideTop3Count: 0,
        },
        {
          suiteName: 'suite-b',
          status: 'failed',
          sourceHitRate: 0.5,
          sourceMissCount: 1,
          weakEvidenceCount: 0,
          guideTop3Count: 0,
        },
      ],
    },
    {
      minSourceHitRate: 1,
      maxSourceMisses: 0,
      maxWeakEvidence: 0,
      maxGuideTop3: 0,
    }
  );

  assert.deepEqual(pendingSuites, ['suite-b', 'suite-c']);
});

test('rag demo suite reports case latency percentiles and duration totals', async () => {
  const { summarizeCaseTimings } = await import(pathToFileURL(scriptPath));

  const timings = summarizeCaseTimings([
    { durationMs: 100 },
    { durationMs: 250 },
    { durationMs: 400 },
    { durationMs: 1000 },
  ]);

  assert.deepEqual(timings, {
    caseCount: 4,
    totalDurationMs: 1750,
    averageDurationMs: 437.5,
    p50DurationMs: 250,
    p95DurationMs: 1000,
    maxDurationMs: 1000,
  });
});

test('rag demo suite loads markdown corpora from a nested corpus directory', async () => {
  const { resolveSuiteMarkdownFiles } = await import(pathToFileURL(scriptPath));
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'chatllm-rag-demo-'));
  const suiteDir = path.join(tempRoot, 'nested-suite');
  const corpusDir = path.join(suiteDir, 'corpus');
  const answersDir = path.join(suiteDir, 'answers');

  mkdirSync(corpusDir, { recursive: true });
  mkdirSync(answersDir, { recursive: true });
  writeFileSync(path.join(corpusDir, '00-语料索引与测试指南.md'), '# guide\n', 'utf8');
  writeFileSync(path.join(corpusDir, '01-核心证据.md'), '# evidence\n', 'utf8');
  writeFileSync(path.join(answersDir, '01-标准答案.md'), '# answer\n', 'utf8');

  try {
    const files = resolveSuiteMarkdownFiles(suiteDir).map((file) => path.basename(file));

    assert.deepEqual(files, ['00-语料索引与测试指南.md', '01-核心证据.md']);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
