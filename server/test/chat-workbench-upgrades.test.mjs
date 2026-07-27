import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');
const migration = readFileSync(path.join(serverRoot, 'migrations', '0004_chat_workbench_upgrades.sql'), 'utf8');
const chatNestControllerSource = readFileSync(path.join(serverRoot, 'src/modules/chat/chat.controller.ts'), 'utf8');
const chatServiceSource = readFileSync(path.join(serverRoot, 'src/modules/chat/chat.service.ts'), 'utf8');
const conversationRepositorySource = readFileSync(path.join(serverRoot, 'src/repositories/conversations.ts'), 'utf8');
const promptNestControllerSource = readFileSync(path.join(serverRoot, 'src/modules/prompt-templates/prompt-templates.controller.ts'), 'utf8');
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

test('chat controller exposes branching and comparison endpoints scoped by authentication', () => {
  assert.match(chatNestControllerSource, /@Controller\('chat'\)/);
  assert.match(chatNestControllerSource, /@UseGuards\(AuthGuard\)/);
  assert.match(
    chatNestControllerSource,
    /@Post\('conversations\/:conversationId\/branches'\)[\s\S]*?@ValidateMutation\(mutationSchemas\.chatBranchConversation\)[\s\S]*?this\.chatService\.branchConversation\(user, conversationId, body\)/,
  );
  assert.match(
    chatNestControllerSource,
    /@Get\('conversations\/:conversationId\/compare\/:otherConversationId'\)[\s\S]*?this\.chatService\.compareConversations\(/,
  );
  assert.match(chatServiceSource, /createConversationBranchForUser\(\{\s*userId: user\.id/s);
  assert.match(chatServiceSource, /compareConversationsForUser\(\s*user\.id/);
  assert.doesNotMatch(chatNestControllerSource, /@Res\(|AppReply/);
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

test('prompt templates have an authenticated Nest controller and a user-scoped repository', () => {
  assert.match(promptNestControllerSource, /@Controller\('prompt-templates'\)/);
  assert.match(promptNestControllerSource, /@UseGuards\(AuthGuard\)/);
  assert.match(promptNestControllerSource, /@Get\(\)[\s\S]*?this\.promptTemplatesService\.list\(user\.id/);
  assert.match(
    promptNestControllerSource,
    /@Post\(\)[\s\S]*?@ValidateMutation\(mutationSchemas\.promptTemplateCreate\)[\s\S]*?this\.promptTemplatesService\.create\(user\.id, body, requestId\)/,
  );
  assert.match(
    promptNestControllerSource,
    /@Patch\(':templateId'\)[\s\S]*?@ValidateMutation\(mutationSchemas\.promptTemplateUpdate\)[\s\S]*?this\.promptTemplatesService\.update\(/,
  );
  assert.match(
    promptNestControllerSource,
    /@Delete\(':templateId'\)[\s\S]*?@ValidateMutation\(mutationSchemas\.promptTemplateDelete\)[\s\S]*?this\.promptTemplatesService\.delete\(user\.id, templateId, requestId\)/,
  );
  assert.doesNotMatch(promptNestControllerSource, /@(?:Req|Res)\(|App(?:Request|Reply)|controllers\/promptTemplates/);
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
