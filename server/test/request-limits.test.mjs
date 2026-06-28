import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');

const requestLimits = require(path.join(serverRoot, 'dist', 'lib', 'requestLimits.js'));

test('global JSON requests are capped for non-upload APIs', () => {
  assert.equal(requestLimits.JSON_REQUEST_LIMIT, '1mb');
});

test('global urlencoded requests are capped for small form submissions', () => {
  assert.equal(requestLimits.URLENCODED_REQUEST_LIMIT, '100kb');
});
