import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const clientDir = path.resolve(import.meta.dirname);
const read = (relativePath) => readFileSync(path.join(clientDir, relativePath), 'utf8');

const messageListSource = read('src/components/MessageList.tsx');
const chatMessageSource = read('src/components/ChatMessage.tsx');
const chatPageSource = read('src/pages/Chat.tsx');

test('adjacent assistant messages are rendered separately (P1-CONTINUE-MERGE)', () => {
  // "Continue" persists a second assistant row for the same user turn. Merging
  // adjacent assistant messages reused the first message's id for the React key
  // and for delete/branch/copy, so deleting the continuation removed the
  // original answer instead.
  assert.doesNotMatch(
    messageListSource,
    /role === 'assistant'\s*&&\s*\w+\.role === 'assistant'/,
    'MessageList must not merge adjacent assistant messages',
  );
  assert.doesNotMatch(
    messageListSource,
    /content:\s*\w+\.content\s*\+\s*\w+\.content/,
    'MessageList must not concatenate two persisted answers',
  );
  assert.match(messageListSource, /key=\{msg\.id\}/);
  assert.match(messageListSource, /message=\{msg\}/);
});

test('per-message actions always address the clicked message id (P1-CONTINUE-MERGE)', () => {
  assert.match(chatMessageSource, /onDelete\(msg\.id\)/);
  assert.match(chatMessageSource, /onBranch\(msg\.id\)/);
});

test('a non-empty conversation never renders as a blank frame', () => {
  // useDeferredValue can lag one commit behind; the empty-state check and the
  // render fallback both have to look at the live list.
  assert.match(
    messageListSource,
    /deferredMessages\.length === 0 && messages\.length > 0 \? messages : deferredMessages/,
  );
  assert.match(messageListSource, /messages\.length === 0 \?/);
});

test('Continue is hidden in an Agent conversation (P2-AGENT-CONTINUE)', () => {
  assert.match(
    chatPageSource,
    /const canContinue = !currentConversation\?\.agent_id/,
  );
});

test('the first send is guarded and targets an explicit conversation id (P1-FIRST-SEND)', () => {
  // Creation happens inside the same try/lock as the send, so a double submit
  // cannot create two conversations and a creation failure restores the draft.
  assert.match(chatPageSource, /if \(!input\.trim\(\) \|\| sendingMessage \|\| isStartingConversation\) return;/);
  assert.match(chatPageSource, /setIsStartingConversation\(true\);/);
  assert.match(chatPageSource, /const conversationId = currentConversationId[\s\S]*?await createConversation\(/);
  assert.match(chatPageSource, /await sendMessage\(content, false, conversationId\)/);
  assert.match(chatPageSource, /setInput\(content\);[\s\S]*?writeChatDraft\([\s\S]*?showGenerationError\(error\)/);
  assert.match(chatPageSource, /setIsStartingConversation\(false\)/);
  assert.match(chatPageSource, /isSending=\{sendingMessage \|\| isStartingConversation\}/);
});

test('a dropped Agent stream is recovered, not retried by the user (P1-SSE-RECOVER)', () => {
  assert.match(chatPageSource, /import \{ hasRecoverableAgentRun \} from '\.\.\/lib\/agentRunRecovery'/);
  assert.match(chatPageSource, /const recoverableAgentRun = hasRecoverableAgentRun\(messages\)/);
  assert.match(chatPageSource, /if \(hasRecoverableAgentRun\(useChatStore\.getState\(\)\.messages\)\)/);
  assert.match(chatPageSource, /toast\.info\(t\('chat\.agentRunRecovering'\)\)/);
  // The poll depends on the combined signal, not on the server status alone.
  assert.match(chatPageSource, /\[currentConversationId, recoverableAgentRun, refreshMessages, sendingMessage\]/);
});

test('a failed history load renders an error state with a retry (P2-FETCH-SILENT)', () => {
  const messageListSourceLocal = read('src/components/MessageList.tsx');
  assert.match(messageListSourceLocal, /messages\.length === 0 && messagesError \?/);
  assert.match(messageListSourceLocal, /t\('chat\.messagesLoadFailed'\)/);
  assert.match(messageListSourceLocal, /onClick=\{onRetryMessages\}/);
  assert.match(chatPageSource, /messagesError=\{messagesError\}/);
  assert.match(chatPageSource, /onRetryMessages=\{handleRetryMessages\}/);
});

test('the run history polls while a run is still active (P2-RUN-HISTORY-POLL)', () => {
  const runHistorySource = read('src/features/agents/AgentRunHistory.tsx');
  assert.match(runHistorySource, /const hasActiveRun = runs\.some\(\(run\) => activeStatuses\.includes\(run\.status\)\)/);
  assert.match(runHistorySource, /if \(!hasActiveRun\) return;/);
  assert.match(runHistorySource, /loadRuns\(controller\.signal, \{ silent: true \}\)/);
  assert.match(runHistorySource, /loadDetail\(selectedRunId, controller\.signal, \{ silent: true \}\)/);
  // A background tick must not spam toasts or flash the spinner.
  assert.match(runHistorySource, /if \(!options\.silent\) toast\.error\(t\('agents\.runsLoadFailed'\)\)/);
});

test('optimistic messages cannot be branched or deleted (P2-NUMERIC-ID)', () => {
  const chatStoreSource = read('src/stores/useChatStore.ts');
  assert.match(chatStoreSource, /export const isOptimisticMessageId/);
  assert.match(chatStoreSource, /return `temp-\$\{role\}-\$\{Date\.now\(\)\}-\$\{optimisticMessageSequence\}`/);
  assert.doesNotMatch(chatStoreSource, /tempUserId = Date\.now\(\)\.toString\(\)/);
  assert.doesNotMatch(chatStoreSource, /tempAiId = \(Date\.now\(\) \+ 1\)\.toString\(\)/);
  assert.match(chatMessageSource, /const isOptimistic = isOptimisticMessageId\(msg\.id\)/);
  assert.match(chatMessageSource, /\{onBranch && !isOptimistic &&/);
  assert.match(chatMessageSource, /disabled=\{isOptimistic\}/);
});
