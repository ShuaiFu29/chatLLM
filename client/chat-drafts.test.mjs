import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import ts from './node_modules/typescript/lib/typescript.js';

async function importTypeScriptModule(relativePath) {
  const filePath = path.resolve(import.meta.dirname, relativePath);
  const source = readFileSync(filePath, 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      verbatimModuleSyntax: false,
    },
    fileName: filePath,
  });
  const encoded = Buffer.from(compiled.outputText, 'utf8').toString('base64');
  return import(`data:text/javascript;base64,${encoded}`);
}

const {
  clearChatDraft,
  createChatDraftKey,
  readChatDraft,
  writeChatDraft,
} = await importTypeScriptModule('src/lib/chatDrafts.ts');

function createMemoryStorage() {
  const data = new Map();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
    removeItem: (key) => data.delete(key),
  };
}

test('chat draft keys are scoped by user and conversation', () => {
  assert.equal(createChatDraftKey('user-1', 'conv-1'), 'chatllm:draft:user-1:conv-1');
  assert.equal(createChatDraftKey(undefined, null), 'chatllm:draft:anonymous:new');
});

test('chat drafts can be written, read, and cleared from storage', () => {
  const storage = createMemoryStorage();
  writeChatDraft(storage, 'user-1', 'conv-1', '  unfinished prompt  ');

  assert.equal(readChatDraft(storage, 'user-1', 'conv-1'), '  unfinished prompt  ');

  writeChatDraft(storage, 'user-1', 'conv-1', '');
  assert.equal(readChatDraft(storage, 'user-1', 'conv-1'), '');

  writeChatDraft(storage, 'user-1', 'conv-1', 'new draft');
  clearChatDraft(storage, 'user-1', 'conv-1');
  assert.equal(readChatDraft(storage, 'user-1', 'conv-1'), '');
});

test('chat draft helpers tolerate unavailable storage', () => {
  const brokenStorage = {
    getItem: () => { throw new Error('blocked'); },
    setItem: () => { throw new Error('blocked'); },
    removeItem: () => { throw new Error('blocked'); },
  };

  assert.equal(readChatDraft(brokenStorage, 'user-1', 'conv-1'), '');
  assert.doesNotThrow(() => writeChatDraft(brokenStorage, 'user-1', 'conv-1', 'draft'));
  assert.doesNotThrow(() => clearChatDraft(brokenStorage, 'user-1', 'conv-1'));
});
