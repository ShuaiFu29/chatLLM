import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');
const distPath = (...segments) => path.join(serverRoot, 'dist', ...segments);

const { ChatStreamService } = require(distPath('modules', 'chat', 'chat-stream.service.js'));
const conversations = require(distPath('repositories', 'conversations.js'));
const messages = require(distPath('repositories', 'messages.js'));
const persona = require(distPath('repositories', 'persona.js'));
const ragRuns = require(distPath('repositories', 'ragRuns.js'));
const answerGeneration = require(distPath('services', 'answerGeneration.js'));
const llmProviders = require(distPath('lib', 'llmProviders.js'));

const CONTINUE_PROMPT = 'Please continue your response. You stopped at: "...rotation issues a new refresh token". Continue exactly from there, do not repeat the context.';

const createConnection = () => {
  const connection = new EventEmitter();
  connection.aborted = false;
  connection.destroyed = false;
  return connection;
};

const readSseFrames = (stream) => new Promise((resolve, reject) => {
  const chunks = [];
  stream.on('data', (chunk) => chunks.push(chunk));
  stream.once('error', reject);
  stream.once('end', () => {
    const payload = Buffer.concat(chunks).toString('utf8');
    resolve(payload
      .split('\n\n')
      .map((frame) => frame.replace(/^data: /, '').trim())
      .filter(Boolean));
  });
});

/**
 * Replace the module exports the chat stream reaches out to, run `body`, and
 * always restore them. TypeScript emits `module_1.fn(...)` call sites, so the
 * exports object is the seam.
 */
const withPatchedModules = async (patches, body) => {
  const originals = patches.map(([module, key]) => [module, key, module[key]]);
  for (const [module, key, value] of patches) module[key] = value;
  try {
    return await body();
  } finally {
    for (const [module, key, value] of originals) module[key] = value;
  }
};

const baseConversation = {
  id: 'conversation-1',
  user_id: 'user-1',
  project_space_id: 'space-1',
  title: 'Existing chat',
  model: 'deepseek-chat',
  temperature: 0.5,
  system_prompt: null,
  enable_rag: true,
  agent_id: null,
};

const answerStreamPatches = (deltas) => [
  [llmProviders, 'createChatClientForModel', () => ({
    client: { chat: { completions: { create: async () => [] } } },
    provider: 'deepseek',
    resolvedModel: 'deepseek-chat',
  })],
  [answerGeneration, 'streamGroundedAnswer', async () => (async function* stream() {
    for (const delta of deltas) {
      yield { choices: [{ delta: { content: delta } }] };
    }
  })()],
];

const runChatStream = async (patches, request) => {
  const service = new ChatStreamService({});
  // The generation body runs detached from `sendMessage`, so the patches must
  // stay installed until the SSE stream has finished.
  return withPatchedModules(patches, async () => {
    const result = await service.sendMessage(request);
    return readSseFrames(result.body.getStream());
  });
};

test('continue in a plain chat never triggers retrieval (P1-CONTINUE-RAG)', async () => {
  let prepareCalls = 0;
  const insertedMessages = [];

  const frames = await runChatStream([
    [conversations, 'findConversationForUser', async () => ({ ...baseConversation })],
    [conversations, 'touchConversation', async () => undefined],
    [messages, 'findLatestUserMessageForConversation', async () => ({
      id: 'user-message-1',
      content: 'How does refresh token rotation work?',
    })],
    [messages, 'listRecentMessages', async () => ([
      { role: 'assistant', content: 'Rotation issues a new refresh token' },
      { role: 'user', content: 'How does refresh token rotation work?' },
    ])],
    [messages, 'insertMessage', async (conversationId, role, content) => {
      insertedMessages.push({ conversationId, role, content });
      return { id: 'assistant-2', conversation_id: conversationId, role, content };
    }],
    [persona, 'getPersonaPromptContextForUser', async () => null],
    [persona, 'refreshPersonaInsightsForUser', async () => undefined],
    [ragRuns, 'insertRagRunForMessage', async () => undefined],
    [answerGeneration, 'prepareGroundedAnswer', async () => {
      prepareCalls += 1;
      throw new Error('retrieval must not run for a continuation');
    }],
    ...answerStreamPatches([' and revokes the previous one.']),
  ], {
    user: { id: 'user-1' },
    conversationId: 'conversation-1',
    content: CONTINUE_PROMPT,
    continueGeneration: true,
    connection: createConnection(),
  });

  assert.equal(prepareCalls, 0, 'the continue prompt must not be retrieved on');

  const payloads = frames.filter((frame) => frame !== '[DONE]').map((frame) => JSON.parse(frame));
  assert.equal(payloads.some((payload) => 'ragRunId' in payload), false);
  assert.equal(payloads.some((payload) => payload.ragSkipped), false, 'a continuation is not a skipped question');
  assert.equal(payloads.some((payload) => payload.ragError), false);
  assert.deepEqual(
    payloads.find((payload) => 'userMessageId' in payload),
    { userMessageId: 'user-message-1' },
    'continue reuses the previous user message instead of creating one',
  );
  assert.ok(payloads.some((payload) => payload.content === ' and revokes the previous one.'));
  assert.ok(payloads.some((payload) => payload.assistantMessageId === 'assistant-2'));
  assert.equal(frames.at(-1), '[DONE]');

  // Only the continuation answer is persisted; the synthetic prompt is not.
  assert.deepEqual(insertedMessages.map((message) => message.role), ['assistant']);
  assert.equal(
    insertedMessages.some((message) => message.content.includes('Please continue your response')),
    false,
    'the synthetic continue prompt must never be persisted (P2-CONTINUE-PERSIST)',
  );
});

test('a real question in the same conversation still runs retrieval (P1-CONTINUE-RAG control)', async () => {
  let prepareCalls = 0;

  const frames = await runChatStream([
    [conversations, 'findConversationForUser', async () => ({ ...baseConversation })],
    [conversations, 'touchConversation', async () => undefined],
    [messages, 'listRecentMessages', async () => []],
    [messages, 'insertMessage', async (conversationId, role, content) => ({
      id: role === 'user' ? 'user-message-9' : 'assistant-9',
      conversation_id: conversationId,
      role,
      content,
    })],
    [persona, 'getPersonaPromptContextForUser', async () => null],
    [persona, 'refreshPersonaInsightsForUser', async () => undefined],
    [ragRuns, 'insertRagRunForMessage', async () => undefined],
    [answerGeneration, 'prepareGroundedAnswer', async () => {
      prepareCalls += 1;
      return {
        ragRun: {
          run_id: 'rag-run-1',
          mode: 'agentic',
          quality: { overall_score: 0.8, evidence_label: 'strong' },
          planned_queries: ['refresh token rotation'],
          trace_steps: [],
        },
        traceSummary: { mode: 'agentic', planned_queries: [], trace_steps: [], quality: {} },
        insufficientEvidence: false,
        answerGuidance: '',
        contextText: 'Rotation revokes the previous refresh token.',
        assistantSources: [],
        verificationSources: [],
      };
    }],
    ...answerStreamPatches(['Rotation revokes the previous refresh token.']),
  ], {
    user: { id: 'user-1' },
    conversationId: 'conversation-1',
    content: 'How does refresh token rotation work in the handbook?',
    connection: createConnection(),
  });

  assert.equal(prepareCalls, 1);
  const payloads = frames.filter((frame) => frame !== '[DONE]').map((frame) => JSON.parse(frame));
  assert.ok(payloads.some((payload) => payload.ragRunId === 'rag-run-1'));
});

test('continue is rejected in an Agent conversation (P2-AGENT-CONTINUE)', async () => {
  const service = new ChatStreamService({});
  let insertCalls = 0;

  await withPatchedModules([
    [conversations, 'findConversationForUser', async () => ({ ...baseConversation, agent_id: 'agent-1' })],
    [messages, 'insertMessage', async () => {
      insertCalls += 1;
      return { id: 'never' };
    }],
  ], async () => {
    await assert.rejects(() => service.sendMessage({
      user: { id: 'user-1' },
      conversationId: 'conversation-1',
      content: CONTINUE_PROMPT,
      continueGeneration: true,
      connection: createConnection(),
    }), (error) => {
      assert.equal(error.getStatus(), 400);
      assert.match(JSON.stringify(error.getResponse()), /Agent conversation/);
      return true;
    });
  });

  assert.equal(insertCalls, 0);
});

test('continue without a previous user message is rejected, not persisted (P2-CONTINUE-PERSIST)', async () => {
  const service = new ChatStreamService({});
  let insertCalls = 0;

  await withPatchedModules([
    [conversations, 'findConversationForUser', async () => ({ ...baseConversation })],
    [messages, 'findLatestUserMessageForConversation', async () => null],
    [messages, 'insertMessage', async () => {
      insertCalls += 1;
      return { id: 'never' };
    }],
    [persona, 'refreshPersonaInsightsForUser', async () => undefined],
  ], async () => {
    await assert.rejects(() => service.sendMessage({
      user: { id: 'user-1' },
      conversationId: 'conversation-1',
      content: CONTINUE_PROMPT,
      continueGeneration: true,
      connection: createConnection(),
    }), (error) => {
      assert.equal(error.getStatus(), 400);
      assert.match(JSON.stringify(error.getResponse()), /no previous answer/i);
      return true;
    });
  });

  assert.equal(insertCalls, 0, 'the synthetic prompt must never reach the messages table');
});

test('the chat stream slot is not leaked by a rejected continue request', () => {
  const chatStreamSource = readFileSync(
    path.join(serverRoot, 'src/modules/chat/chat-stream.service.ts'),
    'utf8',
  );

  // The Agent guard runs before the slot is acquired, and the missing-history
  // guard releases the slot it already holds.
  assert.match(
    chatStreamSource,
    /Continue is not supported in an Agent conversation[\s\S]*?tryAcquireChatStreamSlot/,
  );
  assert.match(
    chatStreamSource,
    /chatSlot\.release\(false\);\s*throw publicError\(400, 'There is no previous answer to continue'\)/,
  );
});
