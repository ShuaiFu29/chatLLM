import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');

const requestLimits = require(path.join(serverRoot, 'dist', 'lib', 'requestLimits.js'));
const mainSource = readFileSync(path.join(serverRoot, 'src', 'main.ts'), 'utf8');

test('global JSON requests are capped for non-upload APIs', () => {
  assert.equal(requestLimits.JSON_REQUEST_LIMIT, '1mb');
  assert.equal(requestLimits.JSON_REQUEST_LIMIT_BYTES, 1024 * 1024);
});

test('global urlencoded requests are capped for small form submissions', () => {
  assert.equal(requestLimits.URLENCODED_REQUEST_LIMIT, '100kb');
  assert.equal(requestLimits.URLENCODED_REQUEST_LIMIT_BYTES, 100 * 1024);
});

test('Nest defers body parsing to one Fastify parser per content type', () => {
  assert.match(mainSource, /bodyParser:\s*false/);
  assert.match(mainSource, /bodyLimit:\s*JSON_REQUEST_LIMIT_BYTES/);
  assert.match(
    mainSource,
    /app\.register\(formbody,\s*\{\s*bodyLimit:\s*URLENCODED_REQUEST_LIMIT_BYTES\s*\}\)/,
  );
  assert.equal((mainSource.match(/app\.register\(formbody/g) || []).length, 1);
  assert.doesNotMatch(mainSource, /addContentTypeParser|useBodyParser/);
});

test('Fastify router and request logging use the Fastify 6-compatible options', () => {
  assert.match(mainSource, /logController:\s*new LogController\(\{\s*disableRequestLogging:\s*true\s*\}\)/);
  assert.match(
    mainSource,
    /routerOptions:\s*\{[\s\S]*ignoreTrailingSlash:\s*true,[\s\S]*caseSensitive:\s*false/,
  );
});
