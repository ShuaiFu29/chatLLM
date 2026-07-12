import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');
const migration = readFileSync(path.join(serverRoot, 'migrations', '0004_chat_workbench_upgrades.sql'), 'utf8');
const indexSource = readFileSync(path.join(serverRoot, 'src/index.ts'), 'utf8');
const chatRoutesSource = readFileSync(path.join(serverRoot, 'src/routes/chat.ts'), 'utf8');
const chatControllerSource = readFileSync(path.join(serverRoot, 'src/controllers/chat.ts'), 'utf8');
const conversationRepositorySource = readFileSync(path.join(serverRoot, 'src/repositories/conversations.ts'), 'utf8');
const promptRoutesSource = readFileSync(path.join(serverRoot, 'src/routes/promptTemplates.ts'), 'utf8');
const promptRepositorySource = readFileSync(path.join(serverRoot, 'src/repositories/promptTemplates.ts'), 'utf8');
const messageRepositorySource = readFileSync(path.join(serverRoot, 'src/repositories/messages.ts'), 'utf8');
const usageRepositorySource = readFileSync(path.join(serverRoot, 'src/repositories/usage.ts'), 'utf8');

test('workbench migration adds branch metadata, conversation metadata, and prompt templates', () => {
  assert.match(migration, /parent_conversation_id uuid references conversations\(id\) on delete set null/i);
  assert.match(migration, /branched_from_message_id uuid references messages\(id\) on delete set null/i);
  assert.match(migration, /is_favorite boolean not null default false/i);
  assert.match(migration, /tags text\[\] not null default '\{\}'::text\[\]/i);
  assert.match(migration, /note text not null default ''/i);
  assert.match(migration, /create table if not exists prompt_templates/i);
  assert.match(migration, /prompt_templates_user_id_updated_at_idx/i);
});

test('chat routes expose branching and comparison endpoints scoped by authentication', () => {
  assert.match(chatRoutesSource, /router\.post\('\/conversations\/:conversationId\/branches', requireAuth, validateMutation\(mutationSchemas\.chatBranchConversation\), branchConversation\)/);
  assert.match(chatRoutesSource, /router\.get\('\/conversations\/:conversationId\/compare\/:otherConversationId', requireAuth, compareConversations\)/);
  assert.match(chatControllerSource, /createConversationBranchForUser\(\{\s*userId: req\.user\.id/s);
  assert.match(chatControllerSource, /compareConversationsForUser\(req\.user\.id/);
});

test('conversation repository stores tags, favorites, notes, and branch lineage', () => {
  assert.match(conversationRepositorySource, /parent_conversation_id/);
  assert.match(conversationRepositorySource, /branched_from_message_id/);
  assert.match(conversationRepositorySource, /branch_name/);
  assert.match(conversationRepositorySource, /is_favorite/);
  assert.match(conversationRepositorySource, /tags/);
  assert.match(conversationRepositorySource, /note/);
  assert.match(conversationRepositorySource, /createConversationBranchForUser/);
  assert.match(conversationRepositorySource, /compareConversationsForUser/);
});

test('prompt templates have authenticated routes and a user-scoped repository', () => {
  assert.match(indexSource, /app\.use\('\/api\/prompt-templates', promptTemplateRoutes\)/);
  assert.match(promptRoutesSource, /router\.get\('\/', requireAuth, listPromptTemplates\)/);
  assert.match(promptRoutesSource, /router\.post\('\/', requireAuth, validateMutation\(mutationSchemas\.promptTemplateCreate\), createPromptTemplate\)/);
  assert.match(promptRoutesSource, /router\.patch\('\/:templateId', requireAuth, validateMutation\(mutationSchemas\.promptTemplateUpdate\), updatePromptTemplate\)/);
  assert.match(promptRoutesSource, /router\.delete\('\/:templateId', requireAuth, validateMutation\(mutationSchemas\.promptTemplateDelete\), deletePromptTemplate\)/);
  assert.match(promptRepositorySource, /where user_id = \$1/i);
});

test('message search supports workspace, source, model, favorite, tag, and archive filters', () => {
  assert.match(messageRepositorySource, /projectSpaceId\?: string/);
  assert.match(messageRepositorySource, /hasSources\?: boolean/);
  assert.match(messageRepositorySource, /model\?: string/);
  assert.match(messageRepositorySource, /favoriteOnly\?: boolean/);
  assert.match(messageRepositorySource, /tag\?: string/);
  assert.match(messageRepositorySource, /includeArchived\?: boolean/);
});

test('usage repository exposes estimated token and model usage statistics', () => {
  assert.match(usageRepositorySource, /estimatedTokens/);
  assert.match(usageRepositorySource, /modelUsage/);
  assert.match(usageRepositorySource, /ceil\(char_length\(m\.content\) \/ 4\.0\)/i);
});
