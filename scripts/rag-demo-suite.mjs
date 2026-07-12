import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { formatSafeError, toSafeError } from './safe-error.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverRequire = createRequire(path.join(rootDir, 'server', 'package.json'));
const { Client } = serverRequire('pg');
const {
  CreateBucketCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} = serverRequire('@aws-sdk/client-s3');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseEnv(filePath) {
  const env = {};
  const content = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separatorIndex = line.indexOf('=');
    if (separatorIndex === -1) continue;
    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function readArgs(argv) {
  const args = {
    suite: 'all',
    maxCases: 0,
    limit: 12,
    sourceTopN: 12,
    ingestConcurrency: 2,
    retrieveConcurrency: 2,
    minSourceHitRate: 0.6,
    maxSourceMisses: 0,
    maxWeakEvidence: 0,
    maxGuideTop3: 0,
    keep: false,
    focused: false,
    resume: false,
    reportFile: '',
    jsonlFile: '',
    resumeFile: '',
    caseTimeoutMs: 120000,
  };
  const positional = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--suite' && next) {
      args.suite = next;
      index += 1;
    } else if (arg === '--max-cases' && next) {
      args.maxCases = Number.parseInt(next, 10);
      index += 1;
    } else if (arg === '--limit' && next) {
      args.limit = Number.parseInt(next, 10);
      index += 1;
    } else if (arg === '--source-top-n' && next) {
      args.sourceTopN = Number.parseInt(next, 10);
      index += 1;
    } else if (arg === '--ingest-concurrency' && next) {
      args.ingestConcurrency = Number.parseInt(next, 10);
      index += 1;
    } else if (arg === '--retrieve-concurrency' && next) {
      args.retrieveConcurrency = Number.parseInt(next, 10);
      index += 1;
    } else if (arg === '--min-source-hit-rate' && next) {
      args.minSourceHitRate = Number.parseFloat(next);
      index += 1;
    } else if (arg === '--max-source-misses' && next) {
      args.maxSourceMisses = Number.parseInt(next, 10);
      index += 1;
    } else if (arg === '--max-weak-evidence' && next) {
      args.maxWeakEvidence = Number.parseInt(next, 10);
      index += 1;
    } else if (arg === '--max-guide-top3' && next) {
      args.maxGuideTop3 = Number.parseInt(next, 10);
      index += 1;
    } else if (arg === '--keep') {
      args.keep = true;
    } else if (arg === '--focused') {
      args.focused = true;
    } else if (arg === '--resume') {
      args.resume = true;
    } else if (arg === '--report-file' && next) {
      args.reportFile = next;
      index += 1;
    } else if (arg === '--jsonl-file' && next) {
      args.jsonlFile = next;
      index += 1;
    } else if (arg === '--resume-file' && next) {
      args.resumeFile = next;
      index += 1;
    } else if (arg === '--case-timeout-ms' && next) {
      args.caseTimeoutMs = Number.parseInt(next, 10);
      index += 1;
    } else if (arg === '--long-timeout') {
      args.caseTimeoutMs = 300000;
    } else if (!arg.startsWith('--')) {
      positional.push(arg);
    }
  }

  if (positional[0] && args.suite === 'all') args.suite = positional[0];
  if (positional[1] && args.maxCases === 0) args.maxCases = Number.parseInt(positional[1], 10);
  if (positional[2] && args.limit === 12) args.limit = Number.parseInt(positional[2], 10);
  if (positional[3] && args.sourceTopN === 12) args.sourceTopN = Number.parseInt(positional[3], 10);
  if (positional[4] && args.ingestConcurrency === 2) args.ingestConcurrency = Number.parseInt(positional[4], 10);
  if (positional[5] && args.retrieveConcurrency === 2) args.retrieveConcurrency = Number.parseInt(positional[5], 10);
  if (positional[6] && args.minSourceHitRate === 0.6) args.minSourceHitRate = Number.parseFloat(positional[6]);

  return args;
}

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function boundedRate(value, fallback) {
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback;
}

function resolveOutputPath(value) {
  if (!value) return '';
  return path.isAbsolute(value) ? value : path.join(rootDir, value);
}

function readJsonFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`Unable to read JSON report ${filePath}: ${error.message}`);
  }
}

function ensureParentDir(filePath) {
  if (!filePath) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function writeJsonFile(filePath, payload) {
  if (!filePath) return;
  ensureParentDir(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function appendJsonl(filePath, event) {
  if (!filePath) return;
  ensureParentDir(filePath);
  fs.appendFileSync(filePath, `${JSON.stringify({ ...event, timestamp: new Date().toISOString() })}\n`, 'utf8');
}

function percentile(sortedValues, percentileRank) {
  if (sortedValues.length === 0) return 0;
  const index = Math.ceil((percentileRank / 100) * sortedValues.length) - 1;
  return sortedValues[Math.max(0, Math.min(sortedValues.length - 1, index))];
}

export function summarizeCaseTimings(caseResults) {
  const durations = caseResults
    .map((item) => Number(item.durationMs || 0))
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((left, right) => left - right);
  const totalDurationMs = durations.reduce((total, value) => total + value, 0);

  return {
    caseCount: durations.length,
    totalDurationMs,
    averageDurationMs: durations.length ? Number((totalDurationMs / durations.length).toFixed(2)) : 0,
    p50DurationMs: percentile(durations, 50),
    p95DurationMs: percentile(durations, 95),
    maxDurationMs: durations.at(-1) || 0,
  };
}

function splitMarkdownTableRow(line) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function parseExpectedSources(rawValue) {
  return [...String(rawValue || '').matchAll(/\b\d{2}\b/g)].map((match) => match[0]);
}

function parseExpectedSourceFilenames(rawValue) {
  return [...String(rawValue || '').matchAll(/(?:^|[\s,，、;；|])([^,\s，、;；|]+\.md)(?=$|[\s,，、;；|])/gi)]
    .map((match) => match[1].trim())
    .filter(Boolean);
}

export function parseEvaluationCases(guideText, maxCases = 0) {
  const cases = [];
  for (const line of guideText.split(/\r?\n/)) {
    if (!/^\|\s*(?:[A-Z]+)?Q\d+/i.test(line)) continue;
    const cells = splitMarkdownTableRow(line);
    if (cells.length < 3) continue;
    const expectedSourceNumbers = parseExpectedSources(cells[2]);
    const expectedSourceFilenames = parseExpectedSourceFilenames(cells[2]);
    if (expectedSourceNumbers.length === 0 && expectedSourceFilenames.length === 0) continue;
    cases.push({
      id: cells[0],
      question: cells[1],
      expectedSourceNumbers,
      expectedSourceFilenames,
      expected_source_files: expectedSourceNumbers,
    });
    if (maxCases > 0 && cases.length >= maxCases) break;
  }
  return cases;
}

export function buildFallbackEvaluationCases(files, maxCases = 0) {
  const selectedFiles = maxCases > 0 ? files.slice(0, maxCases) : files;
  return selectedFiles.map((file, index) => {
    const filename = path.basename(file);
    const title = filename.replace(/\.md$/i, '');
    return {
      id: `AUTO${String(index + 1).padStart(2, '0')}`,
      question: `请基于知识库原文概述《${title}》的核心内容、关键限制和需要并读的证据。`,
      expectedSourceNumbers: [],
      expectedSourceFilenames: [filename],
      expected_source_files: [filename],
      autoGenerated: true,
    };
  });
}

function findSuites(demoRoot, suiteArg) {
  if (suiteArg && suiteArg !== 'all') return [suiteArg];
  return fs.readdirSync(demoRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function listMarkdownFiles(suiteDir) {
  return fs.readdirSync(suiteDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.md$/i.test(entry.name))
    .map((entry) => path.join(suiteDir, entry.name))
    .sort((left, right) => path.basename(left).localeCompare(path.basename(right)));
}

export function resolveSuiteMarkdownFiles(suiteDir) {
  const topLevelFiles = listMarkdownFiles(suiteDir);
  if (topLevelFiles.length > 0) return topLevelFiles;

  const corpusDir = path.join(suiteDir, 'corpus');
  if (fs.existsSync(corpusDir) && fs.statSync(corpusDir).isDirectory()) {
    return listMarkdownFiles(corpusDir);
  }

  return [];
}

function findGuideFile(files) {
  return files.find((file) => /00-.*(guide|index)|evaluation-guide|test-guide/i.test(path.basename(file)))
    || files[0];
}

function fileNameForSource(sourceNumber, files) {
  const prefix = `${sourceNumber}-`;
  return path.basename(files.find((file) => path.basename(file).startsWith(prefix)) || prefix);
}

function selectFilesForCases(files, guideFile, cases) {
  const selected = new Map();
  if (guideFile) selected.set(path.basename(guideFile), guideFile);

  for (const testCase of cases) {
    for (const sourceNumber of testCase.expectedSourceNumbers) {
      const sourceFile = files.find((file) => path.basename(file).startsWith(`${sourceNumber}-`));
      if (sourceFile) selected.set(path.basename(sourceFile), sourceFile);
    }
    for (const sourceFilename of testCase.expectedSourceFilenames || []) {
      const sourceFile = files.find((file) => path.basename(file) === sourceFilename);
      if (sourceFile) selected.set(path.basename(sourceFile), sourceFile);
    }
  }

  return [...selected.values()].sort((left, right) => path.basename(left).localeCompare(path.basename(right)));
}

function isGuideFilename(filename) {
  return /guide|index|corpus-index|test-guide|evaluation-guide|评测/i.test(filename || '');
}

function resultFilename(result) {
  return String((result.metadata || {}).filename || result.filename || '');
}

function sourceMatchesExpected(filename, expectedNumber) {
  return path.basename(filename).toLowerCase().startsWith(`${expectedNumber.toLowerCase()}-`);
}

export function evaluateCaseResult(testCase, retrieveBody, sourceTopN) {
  const results = Array.isArray(retrieveBody.results) ? retrieveBody.results : [];
  const topResults = results.slice(0, sourceTopN);
  const topFilenames = topResults.map(resultFilename);
  const expectedSourceNumbers = testCase.expectedSourceNumbers || [];
  const expectedSourceFilenames = testCase.expectedSourceFilenames || [];
  const matchedSources = expectedSourceNumbers.filter((expectedNumber) => (
    topFilenames.some((filename) => sourceMatchesExpected(filename, expectedNumber))
  ));
  const normalizedTopFilenames = new Set(topFilenames.map((filename) => path.basename(filename).toLowerCase()));
  const matchedSourceFilenames = expectedSourceFilenames.filter((expectedFilename) => (
    normalizedTopFilenames.has(path.basename(expectedFilename).toLowerCase())
  ));
  const guideTop3 = results.slice(0, 3).some((result) => isGuideFilename(resultFilename(result)));
  const evidenceLabel = retrieveBody.quality?.evidence_label || 'weak';
  const expectedSourceCount = expectedSourceNumbers.length + expectedSourceFilenames.length;
  const matchedSourceCount = matchedSources.length + matchedSourceFilenames.length;

  return {
    caseId: testCase.id,
    question: testCase.question,
    expectedSourceNumbers,
    expectedSourceFilenames,
    matchedSourceNumbers: matchedSources,
    matchedSourceFilenames,
    sourceHitRate: expectedSourceCount
      ? matchedSourceCount / expectedSourceCount
      : 0,
    evidenceLabel,
    guideTop3,
    topSources: topFilenames.slice(0, 5),
    plannedQueries: retrieveBody.planned_queries || [],
  };
}

async function runPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(concurrency, 1), items.length || 1);

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  }));

  return results;
}

async function fetchJson(url, init = {}, timeoutMs = 120000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();

  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    let body = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { raw: text };
    }
    if (!response.ok) {
      throw new Error(`${response.status} ${JSON.stringify(body)}`);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

function isRetryableFetchError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /fetch failed|network|aborted|aborterror|timed out/i.test(message)
    || /^(429|5\d\d)\b/.test(message)
  );
}

async function fetchJsonWithRetry(
  url,
  init = {},
  { timeoutMs = 120000, maxAttempts = 4, retryDelayMs = 1000 } = {}
) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fetchJson(url, init, timeoutMs);
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || !isRetryableFetchError(error)) {
        throw error;
      }
      const delayMs = retryDelayMs * attempt;
      console.error(`[rag-demo-suite] retry ${attempt}/${maxAttempts}:`, toSafeError(error));
      await sleep(delayMs);
    }
  }
  throw lastError;
}

async function waitForReady(ragUrl, timeoutMs = 60000) {
  const startedAt = Date.now();
  let lastError;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      return await fetchJson(`${ragUrl}/health/ready`, {}, 5000);
    } catch (error) {
      lastError = error;
      await sleep(1000);
    }
  }
  throw lastError || new Error(`Timed out waiting for ${ragUrl}/health/ready`);
}

async function ensureBucket(s3, bucket) {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  }
}

async function createDemoUserAndSpace(db, suiteName) {
  const userId = crypto.randomUUID();
  const projectSpaceId = crypto.randomUUID();
  const githubId = Number(`${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(-12));
  const safeSuite = suiteName.replace(/[^a-z0-9-]+/gi, '-').slice(0, 64);
  await db.query('begin');
  await db.query(
    `insert into users (id, github_id, username, avatar_url, display_name)
     values ($1, $2, $3, '', 'RAG Demo Eval')`,
    [userId, githubId, `rag-demo-eval-${safeSuite}-${githubId}`]
  );
  await db.query(
    `insert into project_spaces (id, user_id, name, is_default)
     values ($1, $2, $3, true)`,
    [projectSpaceId, userId, `RAG Demo ${suiteName}`]
  );
  await db.query('commit');
  return { userId, projectSpaceId };
}

async function insertFileRow(db, file, userId, projectSpaceId, objectKey) {
  const content = fs.readFileSync(file);
  const fileId = crypto.randomUUID();
  await db.query(
    `insert into files (
       id, user_id, project_space_id, filename, file_hash, file_size, file_type, object_key,
       status, progress, max_attempts
     )
     values ($1, $2, $3, $4, $5, $6, 'text/markdown', $7, 'pending', 0, 3)`,
    [
      fileId,
      userId,
      projectSpaceId,
      path.basename(file),
      crypto.createHash('sha256').update(content).digest('hex'),
      content.length,
      objectKey,
    ]
  );
  return fileId;
}

async function cleanupSuite({ db, s3, ragUrl, bucket, userId, createdFiles, keep }) {
  if (keep) return;

  for (const file of createdFiles) {
    try {
      await fetchJson(`${ragUrl}/cleanup-file`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ file_id: file.fileId }),
      }, 30000);
    } catch (error) {
      console.warn('[rag-demo-suite] RAG cleanup failed:', toSafeError(error));
    }

    try {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: file.objectKey }));
    } catch (error) {
      console.warn('[rag-demo-suite] object cleanup failed:', toSafeError(error));
    }
  }

  if (userId) {
    await db.query('delete from users where id = $1', [userId]);
  }
}

async function ingestSuite({ db, s3, ragUrl, bucket, suiteName, suiteDir, files, userId, projectSpaceId, ingestConcurrency }) {
  const createdFiles = [];
  const runPrefix = `rag-demo/${suiteName}/${Date.now()}-${crypto.randomUUID()}`;
  console.error(`[rag-demo-suite] ${suiteName}: ingesting ${files.length} Markdown files with concurrency ${ingestConcurrency}`);

  await runPool(files, ingestConcurrency, async (file, index) => {
    const objectKey = `${runPrefix}/${path.basename(file)}`;
    const content = fs.readFileSync(file);
    console.error(`[rag-demo-suite] ${suiteName}: ingest ${index + 1}/${files.length} ${path.basename(file)}`);
    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: objectKey,
      ContentType: 'text/markdown',
      Body: content,
    }));
    const fileId = await insertFileRow(db, file, userId, projectSpaceId, objectKey);
    createdFiles.push({ fileId, objectKey, filename: path.basename(file) });
    await fetchJsonWithRetry(`${ragUrl}/ingest-sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file_id: fileId }),
    }, {
      timeoutMs: 300000,
      maxAttempts: 5,
      retryDelayMs: 1500,
      label: `ingest ${path.basename(file)}`,
    });
  });

  return {
    suiteName,
    suiteDir,
    fileCount: files.length,
    createdFiles,
  };
}

async function evaluateSuite({
  ragUrl,
  cases,
  userId,
  projectSpaceId,
  limit,
  sourceTopN,
  retrieveConcurrency,
  caseTimeoutMs,
  jsonlFile,
  suiteName,
}) {
  console.error(`[rag-demo-suite] evaluating ${cases.length} cases with concurrency ${retrieveConcurrency}`);
  const caseResults = await runPool(cases, retrieveConcurrency, async (testCase, index) => {
    console.error(`[rag-demo-suite] retrieve ${index + 1}/${cases.length} ${testCase.id}`);
    const startedAt = Date.now();
    const retrieveBody = await fetchJsonWithRetry(`${ragUrl}/agentic-retrieve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: testCase.question,
        user_id: userId,
        project_space_id: projectSpaceId,
        limit,
        threshold: 0,
      }),
    }, {
      timeoutMs: caseTimeoutMs,
      maxAttempts: 4,
      retryDelayMs: 1000,
      label: `retrieve ${testCase.id}`,
    });
    const result = {
      ...evaluateCaseResult(testCase, retrieveBody, sourceTopN),
      durationMs: Date.now() - startedAt,
    };
    appendJsonl(jsonlFile, {
      event: 'case_completed',
      suiteName,
      caseId: result.caseId,
      durationMs: result.durationMs,
      sourceHitRate: result.sourceHitRate,
      evidenceLabel: result.evidenceLabel,
      guideTop3: result.guideTop3,
    });
    return result;
  });

  const expectedSourceCount = caseResults.reduce(
    (total, item) => total + item.expectedSourceNumbers.length + item.expectedSourceFilenames.length,
    0
  );
  const matchedSourceCount = caseResults.reduce(
    (total, item) => total + item.matchedSourceNumbers.length + item.matchedSourceFilenames.length,
    0
  );
  const weakEvidenceCount = caseResults.filter((item) => item.evidenceLabel === 'weak').length;
  const guideTop3Count = caseResults.filter((item) => item.guideTop3).length;
  const sourceMissCount = caseResults.filter((item) => item.sourceHitRate < 1).length;

  return {
    caseCount: caseResults.length,
    expectedSourceCount,
    matchedSourceCount,
    sourceHitRate: expectedSourceCount ? Number((matchedSourceCount / expectedSourceCount).toFixed(4)) : 0,
    sourceMissCount,
    weakEvidenceCount,
    guideTop3Count,
    timing: summarizeCaseTimings(caseResults),
    cases: caseResults,
  };
}

async function runSuite(suiteName, context, options) {
  const suiteStartedAt = Date.now();
  const suiteDir = path.join(rootDir, 'rag-demo', suiteName);
  if (!fs.existsSync(suiteDir)) {
    throw new Error(`RAG demo suite not found: ${suiteName}`);
  }

  const allFiles = resolveSuiteMarkdownFiles(suiteDir);
  if (allFiles.length === 0) throw new Error(`RAG demo suite has no Markdown files: ${suiteName}`);

  const guideFile = findGuideFile(allFiles);
  const parsedCases = parseEvaluationCases(fs.readFileSync(guideFile, 'utf8'), options.maxCases);
  const cases = (parsedCases.length > 0 ? parsedCases : buildFallbackEvaluationCases(allFiles, options.maxCases))
    .map((testCase) => ({
      ...testCase,
      expected_source_files: [
        ...testCase.expectedSourceNumbers.map((source) => fileNameForSource(source, allFiles)),
        ...(testCase.expectedSourceFilenames || []),
      ],
    }));
  const files = options.focused ? selectFilesForCases(allFiles, guideFile, cases) : allFiles;

  if (cases.length === 0) throw new Error(`RAG demo suite has no evaluation cases: ${suiteName}`);

  const { db, s3, ragUrl, bucket } = context;
  console.error(`[rag-demo-suite] starting ${suiteName}: ${files.length}/${allFiles.length} files, ${cases.length} cases`);
  appendJsonl(options.jsonlFile, {
    event: 'suite_started',
    suiteName,
    fileCount: files.length,
    totalFileCount: allFiles.length,
    caseCount: cases.length,
    focused: options.focused,
  });
  const { userId, projectSpaceId } = await createDemoUserAndSpace(db, suiteName);
  let createdFiles = [];

  try {
    const ingestSummary = await ingestSuite({
      db,
      s3,
      ragUrl,
      bucket,
      suiteName,
      suiteDir,
      files,
      userId,
      projectSpaceId,
      ingestConcurrency: options.ingestConcurrency,
    });
    createdFiles = ingestSummary.createdFiles;
    const evalSummary = await evaluateSuite({
      ragUrl,
      cases,
      userId,
      projectSpaceId,
      limit: options.limit,
      sourceTopN: options.sourceTopN,
      retrieveConcurrency: options.retrieveConcurrency,
      caseTimeoutMs: options.caseTimeoutMs,
      jsonlFile: options.jsonlFile,
      suiteName,
    });

    const summary = {
      status: 'ok',
      suiteName,
      fileCount: files.length,
      totalFileCount: allFiles.length,
      focused: options.focused,
      caseCount: cases.length,
      projectSpaceId: options.keep ? projectSpaceId : undefined,
      userId: options.keep ? userId : undefined,
      durationMs: Date.now() - suiteStartedAt,
      ...evalSummary,
    };
    appendJsonl(options.jsonlFile, {
      event: 'suite_completed',
      suiteName,
      durationMs: summary.durationMs,
      sourceHitRate: summary.sourceHitRate,
      sourceMissCount: summary.sourceMissCount,
      weakEvidenceCount: summary.weakEvidenceCount,
      guideTop3Count: summary.guideTop3Count,
    });
    return summary;
  } finally {
    await cleanupSuite({
      db,
      s3,
      ragUrl,
      bucket,
      userId,
      createdFiles,
      keep: options.keep,
    });
  }
}

export function buildFailureReasons(summaries, options) {
  const reasons = [];
  for (const summary of summaries) {
    if (summary.sourceHitRate < options.minSourceHitRate) {
      reasons.push(
        `${summary.suiteName} sourceHitRate ${summary.sourceHitRate} < ${options.minSourceHitRate}`
      );
    }
    if ((summary.sourceMissCount || 0) > options.maxSourceMisses) {
      reasons.push(
        `${summary.suiteName} sourceMissCount ${summary.sourceMissCount || 0} > ${options.maxSourceMisses}`
      );
    }
    if (summary.weakEvidenceCount > options.maxWeakEvidence) {
      reasons.push(
        `${summary.suiteName} weakEvidenceCount ${summary.weakEvidenceCount} > ${options.maxWeakEvidence}`
      );
    }
    if (summary.guideTop3Count > options.maxGuideTop3) {
      reasons.push(
        `${summary.suiteName} guideTop3Count ${summary.guideTop3Count} > ${options.maxGuideTop3}`
      );
    }
  }
  return reasons;
}

function isPassingSuiteSummary(summary, options) {
  if (!summary || summary.status === 'failed') return false;
  return buildFailureReasons([summary], options).length === 0;
}

export function filterSuitesForResume(suites, resumeReport, options) {
  if (!resumeReport || !Array.isArray(resumeReport.suites)) return suites;
  const passedSuites = new Set(
    resumeReport.suites
      .filter((summary) => isPassingSuiteSummary(summary, options))
      .map((summary) => summary.suiteName)
  );
  return suites.filter((suiteName) => !passedSuites.has(suiteName));
}

async function main() {
  const cliOptions = readArgs(process.argv.slice(2));
  const options = {
    ...cliOptions,
    maxCases: Number.isInteger(cliOptions.maxCases) && cliOptions.maxCases > 0 ? cliOptions.maxCases : 0,
    limit: positiveInteger(cliOptions.limit, 12),
    sourceTopN: positiveInteger(cliOptions.sourceTopN, 12),
    ingestConcurrency: positiveInteger(cliOptions.ingestConcurrency, 2),
    retrieveConcurrency: positiveInteger(cliOptions.retrieveConcurrency, 2),
    minSourceHitRate: boundedRate(cliOptions.minSourceHitRate, 0.6),
    maxSourceMisses: Number.isInteger(cliOptions.maxSourceMisses) && cliOptions.maxSourceMisses >= 0
      ? cliOptions.maxSourceMisses
      : 0,
      maxWeakEvidence: Number.isInteger(cliOptions.maxWeakEvidence) && cliOptions.maxWeakEvidence >= 0
        ? cliOptions.maxWeakEvidence
        : 0,
      maxGuideTop3: Number.isInteger(cliOptions.maxGuideTop3) && cliOptions.maxGuideTop3 >= 0
        ? cliOptions.maxGuideTop3
        : 0,
      focused: Boolean(cliOptions.focused),
      resume: Boolean(cliOptions.resume),
      reportFile: resolveOutputPath(cliOptions.reportFile),
      jsonlFile: resolveOutputPath(cliOptions.jsonlFile),
      resumeFile: resolveOutputPath(cliOptions.resumeFile || cliOptions.reportFile),
      caseTimeoutMs: positiveInteger(cliOptions.caseTimeoutMs, 120000),
  };
  const serverEnv = parseEnv(path.join(rootDir, 'server', '.env'));
  const ragEnv = parseEnv(path.join(rootDir, 'rag-service', '.env'));
  const ragUrl = serverEnv.RAG_SERVICE_URL || ragEnv.RAG_SERVICE_URL || 'http://localhost:8000';
  const bucket = serverEnv.S3_BUCKET || ragEnv.S3_BUCKET || 'documents';
  const demoRoot = path.join(rootDir, 'rag-demo');
  const allSuites = findSuites(demoRoot, options.suite);
  const resumeReport = options.resume ? readJsonFile(options.resumeFile) : null;
  const suites = options.resume
    ? filterSuitesForResume(allSuites, resumeReport, options)
    : allSuites;
  const resumedSummaries = options.resume && resumeReport?.suites
    ? resumeReport.suites.filter((summary) => !suites.includes(summary.suiteName))
    : [];

  const db = new Client({ connectionString: serverEnv.DATABASE_URL || ragEnv.DATABASE_URL });
  const s3 = new S3Client({
    endpoint: serverEnv.S3_ENDPOINT || ragEnv.S3_ENDPOINT,
    region: serverEnv.S3_REGION || ragEnv.S3_REGION || 'us-east-1',
    forcePathStyle: ((serverEnv.S3_FORCE_PATH_STYLE || ragEnv.S3_FORCE_PATH_STYLE || 'true').toLowerCase() !== 'false'),
    credentials: {
      accessKeyId: serverEnv.S3_ACCESS_KEY || ragEnv.S3_ACCESS_KEY,
      secretAccessKey: serverEnv.S3_SECRET_KEY || ragEnv.S3_SECRET_KEY,
    },
  });

  await db.connect();
  try {
    await waitForReady(ragUrl);
    await ensureBucket(s3, bucket);
    const summaries = [...resumedSummaries];
    for (const skipped of resumedSummaries) {
      console.error(`[rag-demo-suite] resume skip ${skipped.suiteName}`);
      appendJsonl(options.jsonlFile, {
        event: 'suite_skipped',
        suiteName: skipped.suiteName,
        reason: 'already passing in resume report',
      });
    }
    for (const suiteName of suites) {
      try {
        summaries.push(await runSuite(suiteName, { db, s3, ragUrl, bucket }, options));
      } catch (error) {
        const failedSummary = {
          status: 'failed',
          suiteName,
          fileCount: 0,
          totalFileCount: 0,
          focused: options.focused,
          caseCount: 0,
          expectedSourceCount: 0,
          matchedSourceCount: 0,
          sourceHitRate: 0,
          sourceMissCount: 1,
          weakEvidenceCount: 1,
          guideTop3Count: 0,
          timing: summarizeCaseTimings([]),
          cases: [],
          errorMessage: formatSafeError(error),
        };
        summaries.push(failedSummary);
        appendJsonl(options.jsonlFile, {
          event: 'suite_failed',
          suiteName,
          errorMessage: formatSafeError(error),
        });
        console.error('[rag-demo-suite] suite failed:', toSafeError(error));
      }
    }

    const failureReasons = buildFailureReasons(summaries, options);
    const report = {
      status: failureReasons.length ? 'failed' : 'ok',
      options: {
        suite: options.suite,
        maxCases: options.maxCases,
        limit: options.limit,
        sourceTopN: options.sourceTopN,
        ingestConcurrency: options.ingestConcurrency,
        retrieveConcurrency: options.retrieveConcurrency,
        minSourceHitRate: options.minSourceHitRate,
        maxSourceMisses: options.maxSourceMisses,
        maxWeakEvidence: options.maxWeakEvidence,
        maxGuideTop3: options.maxGuideTop3,
        keep: options.keep,
        focused: options.focused,
        resume: options.resume,
        reportFile: options.reportFile || undefined,
        jsonlFile: options.jsonlFile || undefined,
        resumeFile: options.resumeFile || undefined,
        caseTimeoutMs: options.caseTimeoutMs,
      },
      generatedAt: new Date().toISOString(),
      suiteCount: summaries.length,
      skippedSuiteCount: resumedSummaries.length,
      suites: summaries,
      failureReasons,
    };
    writeJsonFile(options.reportFile, report);
    if (options.resumeFile && options.resumeFile !== options.reportFile) {
      writeJsonFile(options.resumeFile, report);
    }
    console.log(JSON.stringify(report, null, 2));
    if (failureReasons.length > 0) process.exitCode = 1;
  } finally {
    await db.end().catch(() => {});
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(async (error) => {
    console.error('[rag-demo-suite] failed:', toSafeError(error));
    process.exitCode = 1;
  });
}
