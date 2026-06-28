import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');
const jwtModulePath = path.join(serverRoot, 'dist', 'lib', 'jwt.js');
const jsonwebtokenPath = path.join(serverRoot, 'node_modules', 'jsonwebtoken');

const jwtSecret = 'local-random-secret-with-more-than-32-characters';
const baseEnv = {
  PATH: process.env.PATH,
  SystemRoot: process.env.SystemRoot,
  ComSpec: process.env.ComSpec,
  PATHEXT: process.env.PATHEXT,
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://chatllm:chatllm@localhost:5432/chatllm',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_ACCESS_KEY: 'minioadmin',
  S3_SECRET_KEY: 'minioadmin',
  JWT_SECRET: jwtSecret,
  DEEPSEEK_API_KEY: 'sk-test',
};

function runJwtExpression(expression) {
  return spawnSync(
    process.execPath,
    [
      '-e',
      `
      const jsonwebtoken = require(${JSON.stringify(jsonwebtokenPath)});
      const { generateAccessToken, verifyAccessToken } = require(${JSON.stringify(jwtModulePath)});
      const result = ${expression};
      console.log(JSON.stringify(result));
      `,
    ],
    {
      cwd: serverRoot,
      env: baseEnv,
      encoding: 'utf8',
    }
  );
}

function parseLastJsonLine(stdout) {
  const lines = stdout.trim().split(/\r?\n/);
  return JSON.parse(lines[lines.length - 1]);
}

test('verifyAccessToken accepts tokens generated for a complete user', () => {
  const result = runJwtExpression(`
    (() => {
      const user = {
        id: 'd4bf7f87-0769-486c-bdb8-351df9f6cb38',
        github_id: 12345,
        username: 'octocat',
        avatar_url: 'https://example.com/avatar.png',
        display_name: 'Octo Cat'
      };
      return verifyAccessToken(generateAccessToken(user));
    })()
  `);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(parseLastJsonLine(result.stdout), {
    id: 'd4bf7f87-0769-486c-bdb8-351df9f6cb38',
    github_id: 12345,
    username: 'octocat',
    avatar_url: 'https://example.com/avatar.png',
    display_name: 'Octo Cat',
  });
});

test('verifyAccessToken rejects signed tokens with missing user fields', () => {
  const result = runJwtExpression(`
    (() => {
      const token = jsonwebtoken.sign(
        { id: 'd4bf7f87-0769-486c-bdb8-351df9f6cb38' },
        ${JSON.stringify(jwtSecret)}
      );
      return verifyAccessToken(token);
    })()
  `);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(parseLastJsonLine(result.stdout), null);
});
