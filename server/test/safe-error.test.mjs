import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';


const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');
const safeErrorModulePath = path.join(serverRoot, 'dist', 'lib', 'safeError.js');
const safeErrorModule = fs.existsSync(safeErrorModulePath) ? require(safeErrorModulePath) : {};
const axiosModule = require(path.join(serverRoot, 'node_modules', 'axios'));
const axios = axiosModule.default || axiosModule;

const secretFixtures = [
  'rag-token-secret-value',
  'query-secret-value',
  'body-secret-value',
  'user-secret-value',
  'exception-secret-value',
];

const makeSensitiveAxiosError = () => new axios.AxiosError(
  'exception-secret-value',
  'ERR_BAD_RESPONSE',
  {
    headers: { 'X-ChatLLM-RAG-Token': 'rag-token-secret-value' },
    url: 'https://rag.example.test/retrieve?token=query-secret-value',
    data: { prompt: 'body-secret-value', user_id: 'user-secret-value' },
  },
  null,
  {
    status: 503,
    statusText: 'Unavailable',
    headers: {},
    config: {},
    data: { detail: 'body-secret-value' },
  },
);

const assertContainsNoSecrets = (value) => {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of secretFixtures) {
    assert.doesNotMatch(serialized, new RegExp(secret));
  }
};


test('toSafeError allowlists only error class, code, status, and request id', () => {
  assert.equal(typeof safeErrorModule.toSafeError, 'function');

  const safe = safeErrorModule.toSafeError(makeSensitiveAxiosError(), 'request-id-123');
  assert.deepEqual(safe, {
    name: 'AxiosError',
    code: 'ERR_BAD_RESPONSE',
    status: 503,
    requestId: 'request-id-123',
  });
  assertContainsNoSecrets(safe);
});


test('toSafeError rejects forged names, codes, and request ids', () => {
  assert.equal(typeof safeErrorModule.toSafeError, 'function');
  const forged = Object.assign(new Error('exception-secret-value'), {
    name: 'body-secret-value',
    code: 'query-secret-value',
    config: { token: 'rag-token-secret-value', user: 'user-secret-value' },
  });

  const safe = safeErrorModule.toSafeError(forged, 'unsafe request id user-secret-value');
  assert.deepEqual(safe, { name: 'UnknownError' });
  assertContainsNoSecrets(safe);
});


test('error middleware logs and returns a sanitized 500 response', () => {
  const { errorHandlerMiddleware } = require(path.join(serverRoot, 'dist', 'middleware', 'errorHandler.js'));
  const originalConsoleError = console.error;
  const logs = [];
  console.error = (message) => logs.push(message);
  const response = {
    headersSent: false,
    locals: { requestId: 'request-id-500' },
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
  const error = Object.assign(new Error('exception-secret-value'), {
    code: 'ERR_PRIVATE_FAILURE',
    statusCode: 500,
    config: { data: 'body-secret-value' },
  });

  try {
    errorHandlerMiddleware(error, {}, response, () => undefined);
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(response.statusCode, 500);
  assert.deepEqual(response.body, {
    error: 'Internal server error',
    requestId: 'request-id-500',
  });
  assert.equal(logs.length, 1);
  assertContainsNoSecrets(logs[0]);
  const logEntry = JSON.parse(logs[0]);
  assert.deepEqual(logEntry.error, {
    name: 'Error',
    code: 'ERR_PRIVATE_FAILURE',
    status: 500,
    requestId: 'request-id-500',
  });
});


test('error middleware never echoes untrusted 4xx exception messages', () => {
  const { errorHandlerMiddleware } = require(path.join(serverRoot, 'dist', 'middleware', 'errorHandler.js'));
  const originalConsoleError = console.error;
  const logs = [];
  console.error = (message) => logs.push(message);
  const response = {
    headersSent: false,
    locals: { requestId: 'request-id-400' },
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
  const error = Object.assign(new Error('exception-secret-value'), { statusCode: 400 });

  try {
    errorHandlerMiddleware(error, {}, response, () => undefined);
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.body, {
    error: 'Bad request',
    requestId: 'request-id-400',
  });
  assert.doesNotMatch(JSON.stringify([response.body, logs]), /exception-secret-value/);
});


test('health controller never logs Axios request configuration or payloads', async () => {
  assert.equal(typeof safeErrorModule.toSafeError, 'function');
  const dbModule = require(path.join(serverRoot, 'dist', 'lib', 'db.js'));
  const healthModule = require(path.join(serverRoot, 'dist', 'lib', 'health.js'));
  const originalCheckDatabaseReady = dbModule.checkDatabaseReady;
  const originalAxiosGet = axios.get;
  const originalConsoleWarn = console.warn;
  const logs = [];
  dbModule.checkDatabaseReady = async () => true;
  axios.get = async () => { throw makeSensitiveAxiosError(); };
  console.warn = (...args) => logs.push(args);
  const response = {
    locals: { requestId: 'request-id-health' },
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };

  try {
    const handler = healthModule.createReadyHealthHandler({
      checkDatabaseReady: async () => true,
      checkRedisReady: async () => true,
    });
    await handler({}, response);
  } finally {
    dbModule.checkDatabaseReady = originalCheckDatabaseReady;
    axios.get = originalAxiosGet;
    console.warn = originalConsoleWarn;
  }

  assert.equal(response.statusCode, 503);
  assert.equal(logs.length, 1);
  assert.deepEqual(logs[0][1], {
    name: 'AxiosError',
    code: 'ERR_BAD_RESPONSE',
    status: 503,
    requestId: 'request-id-health',
  });
  assertContainsNoSecrets(logs);
});


test('upload API responses do not derive public details from exception serialization', () => {
  const uploadSource = fs.readFileSync(path.join(serverRoot, 'src', 'controllers', 'upload.ts'), 'utf8');

  assert.doesNotMatch(uploadSource, /stringifyError/);
  assert.doesNotMatch(uploadSource, /details:\s*message\b/);
});


test('background job state never persists downstream exception messages', () => {
  const fileQueueSource = fs.readFileSync(path.join(serverRoot, 'src', 'services', 'fileQueue.ts'), 'utf8');
  const fileRepositorySource = fs.readFileSync(path.join(serverRoot, 'src', 'repositories', 'files.ts'), 'utf8');
  const evalQueueSource = fs.readFileSync(path.join(serverRoot, 'src', 'services', 'ragEvalQueue.ts'), 'utf8');

  assert.doesNotMatch(fileQueueSource, /err\.message/);
  assert.doesNotMatch(fileQueueSource, /markFileAttemptFailed/);
  assert.match(fileRepositorySource, /RAG service ingestion lease expired/);
  assert.doesNotMatch(evalQueueSource, /error instanceof Error \? error\.message/);
  assert.match(evalQueueSource, /RAG evaluation failed/);
});


const listSourceFiles = (directory, extensions) => fs.readdirSync(directory, { withFileTypes: true })
  .flatMap((entry) => {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) return listSourceFiles(absolutePath, extensions);
    if (!entry.isFile() || entry.name.includes('.test.')) return [];
    return extensions.some((extension) => entry.name.endsWith(extension)) ? [absolutePath] : [];
  });

const isToSafeErrorCall = (node) => ts.isCallExpression(node)
  && ts.isIdentifier(node.expression)
  && node.expression.text === 'toSafeError';

const containsUnsafeErrorValue = (node) => {
  if (isToSafeErrorCall(node)) return false;
  if (ts.isIdentifier(node) && /^(?:e|err)$|error$/i.test(node.text)) return true;
  if (ts.isPropertyAccessExpression(node) && node.name.text === 'reason') return true;
  if (ts.isPropertyAssignment(node)) {
    const name = ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : '';
    if (name === 'error') return !isToSafeErrorCall(node.initializer);
    return containsUnsafeErrorValue(node.initializer);
  }

  let unsafe = false;
  ts.forEachChild(node, (child) => {
    if (!unsafe && containsUnsafeErrorValue(child)) unsafe = true;
  });
  return unsafe;
};


const findUnsafeConsoleCalls = (sourceRoot, extensions) => {
  const violations = [];

  for (const filePath of listSourceFiles(sourceRoot, extensions)) {
    const sourceText = fs.readFileSync(filePath, 'utf8');
    const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true);

    const visit = (node) => {
      if (
        ts.isCallExpression(node)
        && ts.isPropertyAccessExpression(node.expression)
        && ts.isIdentifier(node.expression.expression)
        && node.expression.expression.text === 'console'
        && ['error', 'warn'].includes(node.expression.name.text)
        && node.arguments.some(containsUnsafeErrorValue)
      ) {
        const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        violations.push(`${path.relative(path.resolve(serverRoot, '..'), filePath)}:${position.line + 1}`);
      }
      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
  }

  return violations;
};


test('all server warning and error logs serialize error-like values through toSafeError', () => {
  const srcRoot = path.join(serverRoot, 'src');
  assert.deepEqual(findUnsafeConsoleCalls(srcRoot, ['.ts']), []);
});


test('client warning and error logs serialize error-like values through toSafeError', () => {
  const clientRoot = path.resolve(serverRoot, '..', 'client', 'src');
  assert.deepEqual(findUnsafeConsoleCalls(clientRoot, ['.ts', '.tsx', '.js']), []);
});


test('client error boundary never renders raw exception messages', () => {
  const errorBoundarySource = fs.readFileSync(
    path.resolve(serverRoot, '..', 'client', 'src', 'components', 'ErrorBoundary.tsx'),
    'utf8',
  );
  assert.doesNotMatch(errorBoundarySource, /state\.error\?\.message|error\.message/);
  assert.match(errorBoundarySource, /errorBoundary\.unknown/);
});


test('client workers and progress state never surface caught exception messages', () => {
  const clientLibRoot = path.resolve(serverRoot, '..', 'client', 'src', 'lib');
  const hashWorkerSource = fs.readFileSync(path.join(clientLibRoot, 'hashWorker.ts'), 'utf8');
  const uploadManagerSource = fs.readFileSync(path.join(clientLibRoot, 'uploadManager.ts'), 'utf8');

  assert.doesNotMatch(hashWorkerSource, /error instanceof Error \? error\.message/);
  assert.doesNotMatch(uploadManagerSource, /err instanceof Error \? err\.message/);
});


test('operational scripts serialize caught errors through toSafeError', () => {
  const scriptsRoot = path.resolve(serverRoot, '..', 'scripts');
  assert.deepEqual(findUnsafeConsoleCalls(scriptsRoot, ['.mjs']), []);
});
