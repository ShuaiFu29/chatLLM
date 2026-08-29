import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');
const {
  decryptAgentToolSecrets,
  encryptAgentToolSecrets,
  inspectAgentToolSecretEnvelope,
} = require(path.join(serverRoot, 'dist', 'lib', 'agentToolSecrets.js'));
const {
  validateAgentToolSecrets,
} = require(path.join(serverRoot, 'dist', 'lib', 'agentToolSecretKeys.js'));
const {
  resolveAgentToolSecretsForUse,
} = require(path.join(
  serverRoot,
  'dist',
  'modules',
  'agents',
  'runtime',
  'agent-tool-secret-runtime.js',
));
const {
  inspectStoredAgentToolSecretEnvelope,
} = require(path.join(
  serverRoot,
  'dist',
  'modules',
  'agents',
  'agent-tools.service.js',
));

const OLD_KEY = '11'.repeat(32);
const NEW_KEY = '22'.repeat(32);
const context = {
  userId: '11111111-1111-4111-8111-111111111111',
  toolId: '22222222-2222-4222-8222-222222222222',
  secretVersion: 7,
};
const keyring = {
  activeKeyId: 'aug_2026',
  keys: { legacy_2025: OLD_KEY, aug_2026: NEW_KEY },
};
const secrets = {
  bearer_token: 'private-token',
  'header:X-Api-Key': 'private-key',
  'query:tenant': 'tenant-a',
};

test('v2 Agent tool Secret envelopes carry a key ID and bind row identity with AAD', () => {
  const payload = encryptAgentToolSecrets(secrets, context, keyring);
  assert.deepEqual(inspectAgentToolSecretEnvelope(payload), {
    envelopeVersion: 2,
    keyId: 'aug_2026',
  });
  assert.doesNotMatch(payload, /private-token|private-key|tenant-a/);
  assert.deepEqual(decryptAgentToolSecrets(payload, context, keyring), secrets);
  assert.throws(() => decryptAgentToolSecrets(payload, {
    ...context,
    userId: '33333333-3333-4333-8333-333333333333',
  }, keyring));
  assert.throws(() => decryptAgentToolSecrets(payload, {
    ...context,
    toolId: '44444444-4444-4444-8444-444444444444',
  }, keyring));
  assert.throws(() => decryptAgentToolSecrets(payload, {
    ...context,
    secretVersion: context.secretVersion + 1,
  }, keyring));
});

test('keyring decrypts old keyed envelopes while new writes select only the active key', () => {
  const oldPayload = encryptAgentToolSecrets(secrets, context, {
    activeKeyId: 'legacy_2025',
    keys: keyring.keys,
  });
  assert.equal(inspectAgentToolSecretEnvelope(oldPayload).keyId, 'legacy_2025');
  assert.deepEqual(decryptAgentToolSecrets(oldPayload, context, keyring), secrets);

  const newPayload = encryptAgentToolSecrets(secrets, context, keyring);
  assert.equal(inspectAgentToolSecretEnvelope(newPayload).keyId, 'aug_2026');
  assert.deepEqual(decryptAgentToolSecrets(newPayload, context, keyring), secrets);
});

test('legacy v1 envelopes remain decryptable by trying decrypt-only keyring entries', () => {
  const legacyPayload = encryptAgentToolSecrets(secrets, OLD_KEY);
  assert.deepEqual(inspectAgentToolSecretEnvelope(legacyPayload), {
    envelopeVersion: 1,
    keyId: null,
  });
  assert.deepEqual(decryptAgentToolSecrets(legacyPayload, context, keyring), secrets);
});

test('Secret rotation maps malformed historical envelopes to a stable conflict', () => {
  assert.throws(
    () => inspectStoredAgentToolSecretEnvelope('v2.invalid-envelope'),
    (error) => (
      error?.getStatus?.() === 409
      && error?.getResponse?.()?.error
        === 'Stored Agent tool credentials use an unsupported encrypted format'
    ),
  );
});

test('HTTP and MCP Secret placements share strict destination validation', () => {
  assert.equal(validateAgentToolSecrets(secrets).size, 3);
  for (const key of [
    'header:Host',
    'header:Content-Length',
    'header:Connection',
    'header:Proxy-Authorization',
    'header:Idempotency-Key',
    'header:MCP-Session-Id',
    'header:Sec-Fetch-Site',
    'query:',
    'unknown_secret',
  ]) {
    assert.throws(
      () => validateAgentToolSecrets({ [key]: 'value' }),
      /cannot be stored|Invalid Agent tool Secret|Unsupported Agent tool Secret/,
      key,
    );
  }
  assert.throws(() => validateAgentToolSecrets({
    bearer_token: 'one',
    'header:authorization': 'two',
  }), /More than one Agent tool Secret targets header:authorization/);
});

const runtimeContext = {
  runId: '55555555-5555-4555-8555-555555555555',
  agentId: '66666666-6666-4666-8666-666666666666',
  attempt: 2,
  toolCallId: 'call-secret-1',
};

const runtimeRow = () => {
  const rowContext = { ...context, secretVersion: 1 };
  return {
    id: rowContext.toolId,
    user_id: rowContext.userId,
    tool_version_id: '77777777-7777-4777-8777-777777777777',
    secret_version: 1,
    encrypted_secrets: encryptAgentToolSecrets(secrets, rowContext),
  };
};

test('runtime audits credential use without copying Secret names or values', async () => {
  const events = [];
  const resolved = await resolveAgentToolSecretsForUse({
    tool: runtimeRow(),
    context: runtimeContext,
    recordEvent: async (event) => events.push(event),
  });
  assert.deepEqual(resolved.secrets, secrets);
  assert.equal(events.length, 1);
  assert.equal(events[0].eventType, 'used');
  assert.equal(events[0].envelopeVersion, 2);
  assert.deepEqual(events[0].metadata, {
    attempt: 2,
    tool_call_id: 'call-secret-1',
    secret_count: 3,
  });
  const serialized = JSON.stringify(events[0]);
  assert.doesNotMatch(serialized, /private-token|private-key|bearer_token|X-Api-Key|tenant-a/);
});

test('runtime fails closed when credential use cannot be audited', async () => {
  await assert.rejects(
    () => resolveAgentToolSecretsForUse({
      tool: runtimeRow(),
      context: runtimeContext,
      recordEvent: async () => { throw new Error('audit unavailable'); },
    }),
    (error) => error?.code === 'tool_secret_audit_failed',
  );
});

test('runtime records a content-free failure when AAD rejects a moved ciphertext', async () => {
  const events = [];
  const row = runtimeRow();
  row.id = '88888888-8888-4888-8888-888888888888';
  await assert.rejects(
    () => resolveAgentToolSecretsForUse({
      tool: row,
      context: runtimeContext,
      recordEvent: async (event) => events.push(event),
    }),
    (error) => error?.code === 'tool_secret_decryption_failed',
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].eventType, 'decrypt_failed');
  assert.doesNotMatch(JSON.stringify(events[0]), /private-token|bearer_token/);
});
