import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import { toSafeError } from './safe-error.mjs';

const repositoryRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (value) => value.slice(1))), '..');
const serverRequire = createRequire(path.join(repositoryRoot, 'server', 'package.json'));

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const fileSha256 = (filePath) => sha256(fs.readFileSync(filePath));

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export function validateQuestionManifest(manifest) {
  if (!manifest || manifest.answerDataUsedDuringGeneration !== false) {
    throw new Error('Question manifest must explicitly prove that answer data is not used during generation');
  }
  if (!Array.isArray(manifest.cases) || manifest.cases.length === 0) {
    throw new Error('Question manifest has no cases');
  }
  const allowedKeys = new Set(['id', 'question']);
  const ids = new Set();
  return manifest.cases.map((item) => {
    const keys = Object.keys(item || {});
    if (keys.some((key) => !allowedKeys.has(key))) {
      throw new Error('Question manifest contains expectation fields');
    }
    const id = String(item?.id || '').trim();
    const question = String(item?.question || '').trim();
    if (!id || !question) throw new Error('Question manifest contains an empty id or question');
    if (ids.has(id)) throw new Error(`Question manifest contains duplicate id: ${id}`);
    ids.add(id);
    return { id, question };
  });
}

export function parseSseEvents(text) {
  const events = [];
  const blocks = String(text || '').replace(/\r\n/g, '\n').split(/\n\n+/);
  for (const block of blocks) {
    const payload = block.split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
      .trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      events.push(JSON.parse(payload));
    } catch {
      events.push({ parseError: true });
    }
  }
  return events;
}

export function summarizeSseEvents(events) {
  let answer = '';
  let ragRunId = null;
  let retrievedSources = [];
  let finalSources = [];
  let traceSummary = null;
  let qualitySummary = null;
  let answerGrounding = null;
  let ragError = null;
  const warnings = [];

  for (const event of events || []) {
    if (typeof event.content === 'string') answer += event.content;
    if (event.ragRunId) {
      ragRunId = event.ragRunId;
      if (Array.isArray(event.sources)) retrievedSources = event.sources;
      traceSummary = event.traceSummary || traceSummary;
      qualitySummary = event.qualitySummary || qualitySummary;
    }
    if (event.answerGrounding) {
      answerGrounding = event.answerGrounding;
      if (Array.isArray(event.sources)) finalSources = event.sources;
      traceSummary = event.traceSummary || traceSummary;
      qualitySummary = event.qualitySummary || qualitySummary;
    }
    if (event.rag_warning) warnings.push(String(event.rag_warning));
    if (event.ragError) {
      ragError = {
        code: String(event.ragError.code || 'rag_retrieval_unavailable'),
        retryable: event.ragError.retryable !== false,
      };
      warnings.push(ragError.code);
    }
    if (event.ragSkipped) warnings.push('rag_skipped');
    if (event.error) warnings.push(String(event.error));
    if (event.parseError) warnings.push('invalid_sse_json');
  }

  const contextStep = (traceSummary?.trace_steps || []).find((step) => step.step_type === 'answer_context_pack');
  const promptSourceMap = Array.isArray(contextStep?.output?.source_map) ? contextStep.output.source_map : [];

  return {
    answer,
    ragRunId,
    retrievedSources,
    finalSources,
    traceSummary,
    qualitySummary,
    answerGrounding,
    ragError,
    promptSourceMap,
    modelCitedLabels: answerGrounding?.model_cited_labels || [],
    preVerificationCitedSources: answerGrounding?.pre_verification_cited_sources || [],
    citationDecisions: answerGrounding?.citation_decisions || [],
    warnings: [...new Set(warnings)],
  };
}

export const prepareResumeResults = (results) => (results || []).filter((item) => !item.error);

const listFilesRecursive = (directory) => {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listFilesRecursive(fullPath));
    else if (entry.isFile()) files.push(fullPath);
  }
  return files;
};

const corpusManifest = (corpusDirectory) => {
  const root = path.resolve(corpusDirectory);
  const files = listFilesRecursive(root)
    .filter((filePath) => path.extname(filePath).toLowerCase() === '.md')
    .map((filePath) => ({
      filename: path.relative(root, filePath).replace(/\\/g, '/'),
      sha256: fileSha256(filePath),
    }))
    .sort((left, right) => left.filename.localeCompare(right.filename));
  return {
    directory: root,
    count: files.length,
    sha256: sha256(JSON.stringify(files)),
    files,
  };
};

const parseArgs = (argv) => {
  const args = {
    serverUrl: 'http://127.0.0.1:3000',
    timeoutMs: 120000,
    delayMs: 250,
    limit: Number.POSITIVE_INFINITY,
    resume: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--questions') args.questions = argv[++index];
    else if (item === '--state') args.state = argv[++index];
    else if (item === '--output') args.output = argv[++index];
    else if (item === '--corpus-dir') args.corpusDir = argv[++index];
    else if (item === '--server-url') args.serverUrl = argv[++index];
    else if (item === '--server-env') args.serverEnv = argv[++index];
    else if (item === '--model') args.model = argv[++index];
    else if (item === '--timeout-ms') args.timeoutMs = Number(argv[++index]);
    else if (item === '--delay-ms') args.delayMs = Number(argv[++index]);
    else if (item === '--limit') args.limit = Number(argv[++index]);
    else if (item === '--ids') args.ids = new Set(String(argv[++index] || '').split(',').map((id) => id.trim()).filter(Boolean));
    else if (item === '--resume') args.resume = true;
    else throw new Error(`Unknown argument: ${item}`);
  }
  if (!args.questions || !args.state || !args.output || !args.corpusDir) {
    throw new Error('Usage: node scripts/rag-answer-run.mjs --questions <questions.json> --state <state.json> --corpus-dir <corpus> --output <actual.json> [--model <model>] [--resume]');
  }
  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs < 1000) throw new Error('--timeout-ms must be at least 1000');
  if (!Number.isFinite(args.delayMs) || args.delayMs < 0) throw new Error('--delay-ms must be non-negative');
  if (!(args.limit > 0)) throw new Error('--limit must be positive');
  return args;
};

const atomicWriteJson = (filePath, value) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, filePath);
};

const request = async (url, options, timeoutMs) => {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
    const body = await response.text();
    if (response.status === 429 && attempt < 3) {
      const retryAfterSeconds = Number(response.headers.get('retry-after'));
      const retryAfterMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
        ? retryAfterSeconds * 1000
        : Math.min(60000, 5000 * (2 ** attempt));
      process.stderr.write(`[rag-answer-run] rate limited; retrying in ${Math.ceil(retryAfterMs / 1000)}s\n`);
      await sleep(retryAfterMs + 250);
      continue;
    }
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${body.slice(0, 300)}`);
    }
    return { response, body };
  }
  throw new Error('HTTP 429: retry limit exhausted');
};

const apiJson = async (baseUrl, route, method, cookie, body, timeoutMs) => {
  const result = await request(`${baseUrl}${route}`, {
    method,
    headers: {
      Cookie: cookie,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, timeoutMs);
  return result.body ? JSON.parse(result.body) : null;
};

const loadRuntime = (args) => {
  const dotenv = serverRequire('dotenv');
  const jwt = serverRequire('jsonwebtoken');
  const envPath = path.resolve(args.serverEnv || path.join(repositoryRoot, 'server', '.env'));
  dotenv.config({ path: envPath, quiet: true });
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is missing from Server environment');

  const state = JSON.parse(fs.readFileSync(path.resolve(args.state), 'utf8'));
  if (!state.userId || !state.spaceId || !state.username || !Number.isFinite(Number(state.githubId))) {
    throw new Error('State file must contain userId, spaceId, username, and githubId');
  }
  const token = jwt.sign({
    id: state.userId,
    github_id: Number(state.githubId),
    username: state.username,
    avatar_url: '',
    display_name: '',
  }, process.env.JWT_SECRET, { expiresIn: '15m' });
  return { state, cookie: `access_token=${token}` };
};

const runCase = async (testCase, args, runtime) => {
  const startedAt = Date.now();
  let conversationId = null;
  try {
    const conversation = await apiJson(
      args.serverUrl,
      '/api/chat/conversations',
      'POST',
      runtime.cookie,
      { title: `RAG answer eval ${testCase.id}`, project_space_id: runtime.state.spaceId },
      args.timeoutMs
    );
    conversationId = conversation.id;
    const updates = { temperature: 0, enable_rag: true };
    if (args.model) updates.model = args.model;
    const configured = await apiJson(
      args.serverUrl,
      `/api/chat/conversations/${conversationId}`,
      'PATCH',
      runtime.cookie,
      updates,
      args.timeoutMs
    );
    const stream = await request(`${args.serverUrl}/api/chat/conversations/${conversationId}/messages`, {
      method: 'POST',
      headers: {
        Cookie: runtime.cookie,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: testCase.question }),
    }, args.timeoutMs);
    const summary = summarizeSseEvents(parseSseEvents(stream.body));
    return {
      id: testCase.id,
      question: testCase.question,
      conversationId,
      model: configured.model || null,
      ...summary,
      durationMs: Date.now() - startedAt,
      error: '',
    };
  } catch (error) {
    return {
      id: testCase.id,
      question: testCase.question,
      conversationId,
      answer: '',
      retrievedSources: [],
      finalSources: [],
      answerGrounding: null,
      warnings: [],
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (conversationId) {
      try {
        await apiJson(
          args.serverUrl,
          `/api/chat/conversations/${conversationId}`,
          'DELETE',
          runtime.cookie,
          undefined,
          Math.min(args.timeoutMs, 15000)
        );
      } catch {
        // The result still records the conversation id so cleanup can be retried explicitly.
      }
    }
  }
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const questionPath = path.resolve(args.questions);
  const outputPath = path.resolve(args.output);
  const questionManifest = JSON.parse(fs.readFileSync(questionPath, 'utf8'));
  const questions = validateQuestionManifest(questionManifest)
    .filter((item) => !args.ids || args.ids.has(item.id))
    .slice(0, args.limit);
  if (questions.length === 0) throw new Error('No question cases matched the requested selection');
  const runtime = loadRuntime(args);
  const corpus = corpusManifest(args.corpusDir);
  if (corpus.count === 0) throw new Error('Corpus directory has no Markdown files');

  let output = {
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    config: {
      serverUrl: args.serverUrl,
      projectSpaceId: runtime.state.spaceId,
      temperature: 0,
      model: args.model || null,
      timeoutMs: args.timeoutMs,
      delayMs: args.delayMs,
      oneConversationPerCase: true,
    },
    isolation: {
      answerDataUsedDuringGeneration: false,
      generationInputFields: ['id', 'question'],
      questionManifestSha256: fileSha256(questionPath),
      corpusCount: corpus.count,
      corpusManifestSha256: corpus.sha256,
      corpusFiles: corpus.files,
    },
    results: [],
  };
  if (args.resume && fs.existsSync(outputPath)) {
    const existing = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    if (existing?.isolation?.questionManifestSha256 !== output.isolation.questionManifestSha256) {
      throw new Error('Cannot resume with a different question manifest');
    }
    output = existing;
    output.results = prepareResumeResults(output.results);
  }

  const completed = new Set(output.results.map((item) => item.id));
  for (const testCase of questions) {
    if (completed.has(testCase.id)) continue;
    process.stderr.write(`[rag-answer-run] ${testCase.id}\n`);
    const result = await runCase(testCase, args, runtime);
    output.results.push(result);
    output.updatedAt = new Date().toISOString();
    atomicWriteJson(outputPath, output);
    if (args.delayMs) await sleep(args.delayMs);
  }

  const failures = output.results.filter((item) => item.error).length;
  process.stdout.write(`${JSON.stringify({ output: outputPath, cases: output.results.length, failures })}\n`);
  if (failures > 0) process.exitCode = 1;
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isCli) {
  main().catch((error) => {
    console.error('[rag-answer-run]', toSafeError(error));
    process.exitCode = 1;
  });
}
