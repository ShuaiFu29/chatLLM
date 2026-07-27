import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);
const initMigration = readFileSync(path.join(serverRoot, 'migrations', '0001_init.sql'), 'utf8');
const managementMigration = readFileSync(path.join(serverRoot, 'migrations', '0003_conversation_management.sql'), 'utf8');
const repositorySource = readFileSync(path.join(serverRoot, 'src/repositories/conversations.ts'), 'utf8');
const messageRepositorySource = readFileSync(path.join(serverRoot, 'src/repositories/messages.ts'), 'utf8');
const chatServiceSource = readFileSync(path.join(serverRoot, 'src/modules/chat/chat.service.ts'), 'utf8');
const chatStreamServiceSource = readFileSync(path.join(serverRoot, 'src/modules/chat/chat-stream.service.ts'), 'utf8');
const nestControllerSource = readFileSync(path.join(serverRoot, 'src/modules/chat/chat.controller.ts'), 'utf8');

test('conversation schema supports pinning and archiving for new and existing databases', () => {
  assert.match(initMigration, /is_pinned boolean not null default false/i);
  assert.match(initMigration, /archived_at timestamptz/i);
  assert.match(managementMigration, /alter table conversations\s+add column if not exists is_pinned boolean not null default false/i);
  assert.match(managementMigration, /alter table conversations\s+add column if not exists archived_at timestamptz/i);
  assert.match(managementMigration, /conversations_user_id_project_space_archived_pinned_updated_idx/i);
});

test('conversation listing defaults to active conversations and sorts pinned conversations first', () => {
  assert.match(repositorySource, /includeArchived\?: boolean/);
  assert.match(repositorySource, /archived_at is null/i);
  assert.match(repositorySource, /order by is_pinned desc, updated_at desc/i);
});

test('conversation updates allow pin and archive state changes for the current user only', () => {
  assert.match(repositorySource, /'is_pinned' \| 'archived_at'/);
  assert.match(chatServiceSource, /is_pinned/);
  assert.match(chatServiceSource, /archived/);
  assert.match(chatServiceSource, /updates\.archived_at = archived \? new Date\(\)\.toISOString\(\) : null/);
});

test('regeneration truncates one owned conversation from a selected user message atomically', async () => {
  const messages = require(path.join(serverRoot, 'dist', 'repositories', 'messages.js'));
  assert.equal(typeof messages.truncateConversationFromUserMessage, 'function');

  const calls = [];
  let transactions = 0;
  const runInTransaction = async (callback) => {
    transactions += 1;
    return callback({
      query: async (sql, params) => {
        calls.push({ sql: sql.replace(/\s+/g, ' ').trim().toLowerCase(), params });
        if (calls.length === 1) return { rows: [{ id: 'conversation-id' }] };
        if (calls.length === 2) {
          return { rows: [{ id: 'message-id', created_at: '2026-07-13T00:00:00.000Z' }] };
        }
        if (calls.length === 3) return { rows: [], rowCount: 3 };
        throw new Error(`Unexpected SQL: ${sql}`);
      },
    });
  };

  const result = await messages.truncateConversationFromUserMessage(
    'conversation-id',
    'message-id',
    'user-id',
    runInTransaction,
  );

  assert.deepEqual(result, { deletedCount: 3 });
  assert.equal(transactions, 1);
  assert.match(calls[0].sql, /from conversations .*where id = \$1 and user_id = \$2 .*for update/);
  assert.deepEqual(calls[0].params, ['conversation-id', 'user-id']);
  assert.match(calls[1].sql, /from messages .*conversation_id = \$2 .*role = 'user'.*for update/);
  assert.deepEqual(calls[1].params, ['message-id', 'conversation-id']);
  assert.match(calls[2].sql, /delete from messages .*conversation_id = \$1 .*created_at >= \$2/);
  assert.deepEqual(calls[2].params, ['conversation-id', '2026-07-13T00:00:00.000Z']);
});

test('regeneration truncation stops before reading messages when the conversation is not owned', async () => {
  const messages = require(path.join(serverRoot, 'dist', 'repositories', 'messages.js'));
  let queryCount = 0;
  const result = await messages.truncateConversationFromUserMessage(
    'conversation-id',
    'message-id',
    'other-user-id',
    async (callback) => callback({
      query: async () => {
        queryCount += 1;
        return { rows: [] };
      },
    }),
  );

  assert.equal(result, null);
  assert.equal(queryCount, 1);
});

test('regeneration endpoint is authenticated, validated, and delegates to the atomic repository', () => {
  assert.match(nestControllerSource, /@Controller\('chat'\)/);
  assert.match(nestControllerSource, /@UseGuards\(AuthGuard\)/);
  assert.match(
    nestControllerSource,
    /@Delete\('conversations\/:conversationId\/messages\/:messageId\/truncate'\)[\s\S]*?@ValidateMutation\(mutationSchemas\.chatTruncateConversation\)[\s\S]*?this\.chatService\.truncateConversation\(user, conversationId, messageId\)/,
  );
  assert.match(chatServiceSource, /truncateConversationFromUserMessage\(\s*conversationId,\s*messageId,\s*user\.id/);
  assert.match(chatServiceSource, /if \(!result\) throw publicError\(404/);
  assert.match(messageRepositorySource, /export const truncateConversationFromUserMessage/);
});

test('delayed automatic titles update only the untouched New Chat placeholder', async () => {
  const conversations = require(path.join(serverRoot, 'dist', 'repositories', 'conversations.js'));
  assert.equal(typeof conversations.updateConversationTitleIfPlaceholder, 'function');
  let capturedQuery;
  const updated = await conversations.updateConversationTitleIfPlaceholder(
    'conversation-id',
    'Generated title',
    async (sql, params) => {
      capturedQuery = { sql: sql.replace(/\s+/g, ' ').trim().toLowerCase(), params };
      return { rows: [], rowCount: 0 };
    },
  );

  assert.equal(updated, false);
  assert.match(capturedQuery.sql, /where id = \$2 and title = 'new chat'/);
  assert.deepEqual(capturedQuery.params, ['Generated title', 'conversation-id']);
  assert.match(chatStreamServiceSource, /updateConversationTitleIfPlaceholder\(conversationId, title\)/);
});
