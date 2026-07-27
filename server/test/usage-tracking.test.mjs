import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');

test('usage tracking exposes authenticated user-scoped routes', () => {
  const nestControllerSource = readFileSync(path.join(serverRoot, 'src/modules/usage/usage.controller.ts'), 'utf8');

  assert.match(nestControllerSource, /@Controller\('usage'\)/);
  assert.match(nestControllerSource, /@UseGuards\(AuthGuard\)/);
  assert.match(nestControllerSource, /@Get\(\)[\s\S]*?this\.usageService\.getOverview\(user\.id/);
  assert.match(
    nestControllerSource,
    /@Get\('conversations\/:conversationId'\)[\s\S]*?this\.usageService\.getConversation\(/,
  );
  assert.match(nestControllerSource, /@CurrentUser\(\) user: User/);
  assert.match(nestControllerSource, /@RequestId\(\) requestId\?: string/);
  assert.doesNotMatch(nestControllerSource, /@(?:Req|Res)\(|App(?:Request|Reply)|controllers\/usage/);
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
  const serviceSource = readFileSync(path.join(serverRoot, 'src/modules/usage/usage.service.ts'), 'utf8');

  assert.match(serviceSource, /getUsageSummaryForUser\(userId\)/);
  assert.match(serviceSource, /listUsageConversationsForUser\(userId, conversationLimit\)/);
  assert.match(serviceSource, /findUsageConversationForUser\([\s\S]*?conversationId,[\s\S]*?userId/);
  assert.match(serviceSource, /listUsageConversationMessagesForUser\([\s\S]*?conversationId,[\s\S]*?userId,[\s\S]*?messageLimit/);
  assert.match(serviceSource, /listUsageRagRunsForConversation\(conversationId, userId, ragRunLimit\)/);
  assert.match(serviceSource, /return \{ conversation, messages, ragRuns \}/);
  assert.match(serviceSource, /\{ error: 'Conversation not found' \}[\s\S]*?HttpStatus\.NOT_FOUND/);
});

test('usage tracking applies bounded list limits for large histories', () => {
  const serviceSource = readFileSync(path.join(serverRoot, 'src/modules/usage/usage.service.ts'), 'utf8');
  const repositorySource = readFileSync(path.join(serverRoot, 'src/repositories/usage.ts'), 'utf8');

  assert.match(serviceSource, /DEFAULT_USAGE_CONVERSATION_LIMIT = 100/);
  assert.match(serviceSource, /MAX_USAGE_CONVERSATION_LIMIT = 500/);
  assert.match(serviceSource, /DEFAULT_USAGE_MESSAGE_LIMIT = 500/);
  assert.match(serviceSource, /MAX_USAGE_MESSAGE_LIMIT = 1000/);
  assert.match(serviceSource, /DEFAULT_USAGE_RAG_RUN_LIMIT = 50/);
  assert.match(serviceSource, /MAX_USAGE_RAG_RUN_LIMIT = 200/);
  assert.match(serviceSource, /parseBoundedLimit/);
  assert.match(serviceSource, /listUsageConversationsForUser\(userId, conversationLimit\)/);
  assert.match(serviceSource, /listUsageConversationMessagesForUser\([\s\S]*?conversationId,[\s\S]*?userId,[\s\S]*?messageLimit/);
  assert.match(serviceSource, /listUsageRagRunsForConversation\(conversationId, userId, ragRunLimit\)/);

  assert.match(repositorySource, /listUsageConversationsForUser = async \(userId: string, limit = 100\)/);
  assert.match(repositorySource, /listUsageConversationMessagesForUser = async \(\s*conversationId: string,\s*userId: string,\s*limit = 500\s*\)/);
  assert.match(repositorySource, /listUsageRagRunsForConversation = async \(\s*conversationId: string,\s*userId: string,\s*limit = 50\s*\)/);
  assert.match(repositorySource, /order by c\.updated_at desc\s+limit \$2/i);
  assert.match(repositorySource, /order by m\.created_at asc\s+limit \$3/i);
  assert.match(repositorySource, /order by rr\.created_at desc\s+limit \$3/i);
});
