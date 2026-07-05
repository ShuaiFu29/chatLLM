import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');

test('usage tracking exposes authenticated user-scoped routes', () => {
  const indexSource = readFileSync(path.join(serverRoot, 'src/index.ts'), 'utf8');
  const routeSource = readFileSync(path.join(serverRoot, 'src/routes/usage.ts'), 'utf8');

  assert.match(indexSource, /app\.use\('\/api\/usage', usageRoutes\)/);
  assert.match(routeSource, /router\.get\('\/', requireAuth, getUsageOverview\)/);
  assert.match(routeSource, /router\.get\('\/conversations\/:conversationId', requireAuth, getUsageConversation\)/);
});

test('usage repository aggregates conversations, messages, documents, citations, and rag runs by current user only', () => {
  const repositorySource = readFileSync(path.join(serverRoot, 'src/repositories/usage.ts'), 'utf8');

  assert.match(repositorySource, /where c\.user_id = \$1/i);
  assert.match(repositorySource, /from project_spaces\s+where user_id = \$1/i);
  assert.match(repositorySource, /from files\s+where user_id = \$1/i);
  assert.match(repositorySource, /count\(m\.id\) filter \(where m\.role = 'user'\)::int/i);
  assert.match(repositorySource, /count\(m\.id\) filter \(where m\.role = 'assistant'\)::int/i);
  assert.match(repositorySource, /jsonb_array_length\(coalesce\(m\.sources, '\[\]'::jsonb\)\)/i);
  assert.match(repositorySource, /listUsageRagRunsForConversation/);
  assert.match(repositorySource, /from rag_runs rr/i);
  assert.match(repositorySource, /join conversations c on c\.id = rr\.conversation_id/i);
  assert.match(repositorySource, /where rr\.conversation_id = \$1 and c\.user_id = \$2/i);
});

test('usage controller returns overview lists and protects missing conversations', () => {
  const controllerSource = readFileSync(path.join(serverRoot, 'src/controllers/usage.ts'), 'utf8');

  assert.match(controllerSource, /getUsageSummaryForUser\(req\.user\.id\)/);
  assert.match(controllerSource, /listUsageConversationsForUser\(req\.user\.id, conversationLimit\)/);
  assert.match(controllerSource, /findUsageConversationForUser\(conversationId, req\.user\.id\)/);
  assert.match(controllerSource, /listUsageConversationMessagesForUser\(conversationId, req\.user\.id, messageLimit\)/);
  assert.match(controllerSource, /listUsageRagRunsForConversation\(conversationId, req\.user\.id, ragRunLimit\)/);
  assert.match(controllerSource, /res\.json\(\{ conversation, messages, ragRuns \}\)/);
  assert.match(controllerSource, /return res\.status\(404\)\.json\(\{ error: 'Conversation not found' \}\)/);
});

test('usage tracking applies bounded list limits for large histories', () => {
  const controllerSource = readFileSync(path.join(serverRoot, 'src/controllers/usage.ts'), 'utf8');
  const repositorySource = readFileSync(path.join(serverRoot, 'src/repositories/usage.ts'), 'utf8');

  assert.match(controllerSource, /DEFAULT_USAGE_CONVERSATION_LIMIT = 100/);
  assert.match(controllerSource, /MAX_USAGE_CONVERSATION_LIMIT = 500/);
  assert.match(controllerSource, /DEFAULT_USAGE_MESSAGE_LIMIT = 500/);
  assert.match(controllerSource, /MAX_USAGE_MESSAGE_LIMIT = 1000/);
  assert.match(controllerSource, /DEFAULT_USAGE_RAG_RUN_LIMIT = 50/);
  assert.match(controllerSource, /MAX_USAGE_RAG_RUN_LIMIT = 200/);
  assert.match(controllerSource, /parseBoundedLimit/);
  assert.match(controllerSource, /req\.query\.limit/);
  assert.match(controllerSource, /req\.query\.messageLimit/);
  assert.match(controllerSource, /req\.query\.ragRunLimit/);
  assert.match(controllerSource, /listUsageConversationsForUser\(req\.user\.id, conversationLimit\)/);
  assert.match(controllerSource, /listUsageConversationMessagesForUser\(conversationId, req\.user\.id, messageLimit\)/);
  assert.match(controllerSource, /listUsageRagRunsForConversation\(conversationId, req\.user\.id, ragRunLimit\)/);

  assert.match(repositorySource, /listUsageConversationsForUser = async \(userId: string, limit = 100\)/);
  assert.match(repositorySource, /listUsageConversationMessagesForUser = async \(\s*conversationId: string,\s*userId: string,\s*limit = 500\s*\)/);
  assert.match(repositorySource, /listUsageRagRunsForConversation = async \(\s*conversationId: string,\s*userId: string,\s*limit = 50\s*\)/);
  assert.match(repositorySource, /order by c\.updated_at desc\s+limit \$2/i);
  assert.match(repositorySource, /order by m\.created_at asc\s+limit \$3/i);
  assert.match(repositorySource, /order by rr\.created_at desc\s+limit \$3/i);
});
