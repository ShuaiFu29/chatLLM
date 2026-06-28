import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');
const envModulePath = path.join(serverRoot, 'dist', 'lib', 'env.js');

const baseEnv = {
  PATH: process.env.PATH,
  SystemRoot: process.env.SystemRoot,
  ComSpec: process.env.ComSpec,
  PATHEXT: process.env.PATHEXT,
  NODE_ENV: 'test',
};

function importServerEnv(overrides, expression = 'serverEnv.DATABASE_URL') {
  return spawnSync(
    process.execPath,
    ['-e', `const { serverEnv } = require(${JSON.stringify(envModulePath)}); console.log(JSON.stringify(${expression}));`],
    {
      cwd: serverRoot,
      env: { ...baseEnv, ...overrides },
      encoding: 'utf8',
    }
  );
}

function parseLastJsonLine(stdout) {
  const lines = stdout.trim().split(/\r?\n/);
  return JSON.parse(lines[lines.length - 1]);
}

test('server env fails fast when required keys are missing', () => {
  const result = importServerEnv({
    DATABASE_URL: '',
    S3_ENDPOINT: '',
    S3_ACCESS_KEY: '',
    S3_SECRET_KEY: '',
    JWT_SECRET: '',
    DEEPSEEK_API_KEY: '',
    MOONSHOT_API_KEY: '',
    OPENAI_API_KEY: '',
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Missing required server environment variables: DATABASE_URL, S3_ENDPOINT, S3_ACCESS_KEY, S3_SECRET_KEY, JWT_SECRET/);
  assert.match(result.stderr, /At least one chat provider key is required: DEEPSEEK_API_KEY, MOONSHOT_API_KEY, OPENAI_API_KEY/);
});

test('server env rejects weak JWT placeholder secrets', () => {
  const result = importServerEnv({
    PORT: '',
    BACKEND_URL: '',
    DATABASE_URL: 'postgres://chatllm:chatllm@localhost:5432/chatllm',
    S3_ENDPOINT: 'http://localhost:9000',
    S3_ACCESS_KEY: 'minioadmin',
    S3_SECRET_KEY: 'minioadmin',
    JWT_SECRET: 'super-secret-jwt-key-change-me',
    DEEPSEEK_API_KEY: 'sk-test',
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /JWT_SECRET must be replaced with a long random secret/);
});

test('server env loads valid required values', () => {
  const result = importServerEnv({
    DATABASE_URL: 'postgres://chatllm:chatllm@localhost:5432/chatllm',
    S3_ENDPOINT: 'http://localhost:9000',
    S3_ACCESS_KEY: 'minioadmin',
    S3_SECRET_KEY: 'minioadmin',
    JWT_SECRET: 'local-random-secret-with-more-than-32-characters',
    DEEPSEEK_API_KEY: 'sk-test',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /postgres:\/\/chatllm:chatllm@localhost:5432\/chatllm/);
});

test('server env defaults to port 3002 and matching backend URL', () => {
  const result = importServerEnv({
    DATABASE_URL: 'postgres://chatllm:chatllm@localhost:5432/chatllm',
    S3_ENDPOINT: 'http://localhost:9000',
    S3_ACCESS_KEY: 'minioadmin',
    S3_SECRET_KEY: 'minioadmin',
    JWT_SECRET: 'local-random-secret-with-more-than-32-characters',
    DEEPSEEK_API_KEY: 'sk-test',
  }, '({ PORT: serverEnv.PORT, BACKEND_URL: serverEnv.BACKEND_URL })');

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(parseLastJsonLine(result.stdout), {
    PORT: 3002,
    BACKEND_URL: 'http://localhost:3002',
  });
});

test('server env derives default backend URL from explicit port', () => {
  const result = importServerEnv({
    PORT: '3015',
    BACKEND_URL: '',
    DATABASE_URL: 'postgres://chatllm:chatllm@localhost:5432/chatllm',
    S3_ENDPOINT: 'http://localhost:9000',
    S3_ACCESS_KEY: 'minioadmin',
    S3_SECRET_KEY: 'minioadmin',
    JWT_SECRET: 'local-random-secret-with-more-than-32-characters',
    DEEPSEEK_API_KEY: 'sk-test',
  }, 'serverEnv.BACKEND_URL');

  assert.equal(result.status, 0, result.stderr);
  assert.equal(parseLastJsonLine(result.stdout), 'http://localhost:3015');
});
