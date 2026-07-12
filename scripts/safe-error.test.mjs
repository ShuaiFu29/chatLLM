import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';


const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.join(__dirname, 'safe-error.mjs');


test('script error serialization excludes messages, URLs, payloads, and secret headers', async () => {
  assert.equal(fs.existsSync(modulePath), true, 'safe-error.mjs must centralize script error redaction');
  const { toSafeError } = await import(pathToFileURL(modulePath));
  const error = Object.assign(new Error('exception-secret-value'), {
    name: 'Error',
    code: 'ERR_BAD_RESPONSE',
    status: 503,
    config: {
      url: 'https://example.test/path?token=query-secret-value',
      headers: { Authorization: 'Bearer token-secret-value' },
      data: { prompt: 'body-secret-value' },
    },
  });

  const safe = toSafeError(error);
  assert.deepEqual(safe, {
    name: 'Error',
    code: 'ERR_BAD_RESPONSE',
    status: 503,
  });
  assert.doesNotMatch(JSON.stringify(safe), /secret-value|Authorization|prompt|token/);
});


test('script URL serialization removes credentials, query strings, and fragments', async () => {
  assert.equal(fs.existsSync(modulePath), true, 'safe-error.mjs must centralize script URL redaction');
  const { toSafeUrl } = await import(pathToFileURL(modulePath));

  assert.equal(
    toSafeUrl('https://user:password@example.test:8443/health/ready?token=query-secret#fragment-secret'),
    'https://example.test:8443/health/ready',
  );
  assert.equal(toSafeUrl('not a URL'), 'invalid-url');
});
