import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const clientDir = path.resolve(import.meta.dirname);
const appSource = readFileSync(path.join(clientDir, 'src/App.tsx'), 'utf8');
const mainLayoutSource = readFileSync(path.join(clientDir, 'src/layouts/MainLayout.tsx'), 'utf8');
const projectSpaceStoreSource = readFileSync(path.join(clientDir, 'src/stores/useProjectSpaceStore.ts'), 'utf8');
const chatStoreSource = readFileSync(path.join(clientDir, 'src/stores/useChatStore.ts'), 'utf8');
const errorBoundarySource = readFileSync(path.join(clientDir, 'src/components/ErrorBoundary.tsx'), 'utf8');
const protectedRouteSource = readFileSync(path.join(clientDir, 'src/components/ProtectedRoute.tsx'), 'utf8');
const loginSource = readFileSync(path.join(clientDir, 'src/pages/Login.tsx'), 'utf8');
const knowledgePageSource = readFileSync(path.join(clientDir, 'src/pages/KnowledgeBase.tsx'), 'utf8');
const profilePageSource = readFileSync(path.join(clientDir, 'src/pages/Profile.tsx'), 'utf8');
const searchDialogSource = readFileSync(path.join(clientDir, 'src/components/SearchDialog.tsx'), 'utf8');
const promptTemplatePageSource = readFileSync(path.join(clientDir, 'src/pages/PromptTemplates.tsx'), 'utf8');
const ragEvaluationPagePath = path.join(clientDir, 'src/pages/RagEvaluation.tsx');
const ragEvaluationPageSource = readFileSync(ragEvaluationPagePath, 'utf8');
const usagePageSource = readFileSync(path.join(clientDir, 'src/pages/Usage.tsx'), 'utf8');
const modalSource = readFileSync(path.join(clientDir, 'src/components/Modal.tsx'), 'utf8');
const chatMessageSource = readFileSync(path.join(clientDir, 'src/components/ChatMessage.tsx'), 'utf8');
const markdownRendererSource = readFileSync(path.join(clientDir, 'src/components/MarkdownRenderer.tsx'), 'utf8');
const localeFiles = ['en', 'zh'].map((locale) => ({
  locale,
  filePath: path.join(clientDir, `src/locales/${locale}.json`),
}));

function readLocale({ filePath }) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function findDuplicateTopLevelKeys(source) {
  const keyPattern = /^\s{2}"([^"]+)":\s*\{/gm;
  const seen = new Set();
  const duplicates = new Set();
  let match;

  while ((match = keyPattern.exec(source)) !== null) {
    const key = match[1];
    if (seen.has(key)) {
      duplicates.add(key);
    }
    seen.add(key);
  }

  return [...duplicates];
}

function listSourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return listSourceFiles(fullPath);
    return /\.(?:ts|tsx|js|jsx)$/.test(entry.name) ? [fullPath] : [];
  });
}

function getLocaleValue(locale, dottedKey) {
  return dottedKey.split('.').reduce((value, segment) => {
    if (value && typeof value === 'object' && segment in value) {
      return value[segment];
    }
    return undefined;
  }, locale);
}

function collectStaticTranslationKeys(source) {
  const keys = new Set();
  const keyPattern = /(?:\bt|i18n\.t)\(\s*(['"])([A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z0-9_-]+)+)\1/g;
  let match;

  while ((match = keyPattern.exec(source)) !== null) {
    keys.add(match[2]);
  }

  return keys;
}

function findHardcodedTranslationFallbacks(source, sourcePath) {
  return source
    .split(/\r?\n/)
    .flatMap((line, index) => (
      /(?:\bt|i18n\.t)\(\s*['"][A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z0-9_-]+)+['"][^)]*\)\s*\|\|\s*['"]/.test(line)
        ? [`${path.relative(clientDir, sourcePath)}:${index + 1}`]
        : []
    ));
}

test('locale files do not contain duplicate top-level namespaces', () => {
  for (const localeFile of localeFiles) {
    const source = readFileSync(localeFile.filePath, 'utf8');
    assert.deepEqual(
      findDuplicateTopLevelKeys(source),
      [],
      `${localeFile.locale}.json should not define the same namespace twice`,
    );
  }
});

test('every static translation key used by the client exists in every locale', () => {
  const sourceFiles = listSourceFiles(path.join(clientDir, 'src'));
  const keyReferences = new Map();

  for (const sourceFile of sourceFiles) {
    const source = readFileSync(sourceFile, 'utf8');
    for (const key of collectStaticTranslationKeys(source)) {
      if (!keyReferences.has(key)) keyReferences.set(key, []);
      keyReferences.get(key).push(path.relative(clientDir, sourceFile));
    }
  }

  assert.notEqual(keyReferences.size, 0, 'the client should use static translation keys');

  for (const localeFile of localeFiles) {
    const locale = readLocale(localeFile);
    const missingKeys = [...keyReferences.keys()]
      .filter((key) => getLocaleValue(locale, key) === undefined)
      .map((key) => `${key} (${keyReferences.get(key).join(', ')})`);

    assert.deepEqual(
      missingKeys,
      [],
      `${localeFile.locale}.json is missing static translation keys`,
    );
  }
});

test('localized UI does not hide missing keys behind hardcoded fallback text', () => {
  const fallbackLocations = listSourceFiles(path.join(clientDir, 'src')).flatMap((sourceFile) => (
    findHardcodedTranslationFallbacks(readFileSync(sourceFile, 'utf8'), sourceFile)
  ));

  assert.deepEqual(
    fallbackLocations,
    [],
    'static t()/i18n.t() calls should rely on locale coverage instead of English fallback strings',
  );
});

test('workspace and knowledge base copy are separate in every locale', () => {
  const genericKnowledgeLabels = {
    en: 'Knowledge Base',
    zh: '知识库',
  };

  for (const localeFile of localeFiles) {
    const locale = readLocale(localeFile);

    assert.ok(locale.workspace?.sectionTitle, `${localeFile.locale}.json needs workspace.sectionTitle`);
    assert.ok(locale.workspace?.createTitle, `${localeFile.locale}.json needs workspace.createTitle`);
    assert.ok(locale.workspace?.renameTitle, `${localeFile.locale}.json needs workspace.renameTitle`);
    assert.ok(locale.workspace?.deleteTitle, `${localeFile.locale}.json needs workspace.deleteTitle`);
    assert.ok(locale.workspace?.knowledgeScopeHint, `${localeFile.locale}.json needs workspace.knowledgeScopeHint`);
    assert.ok(locale.workspace?.documentsScopeLabel, `${localeFile.locale}.json needs workspace.documentsScopeLabel`);
    assert.ok(locale.sidebar?.knowledgeBase, `${localeFile.locale}.json needs sidebar.knowledgeBase`);
    assert.ok(locale.chat?.exportMarkdown, `${localeFile.locale}.json needs chat.exportMarkdown`);
    assert.ok(locale.chat?.exportSuccess, `${localeFile.locale}.json needs chat.exportSuccess`);
    assert.notEqual(
      locale.workspace.sectionTitle,
      locale.sidebar.knowledgeBase,
      `${localeFile.locale}.json should not label workspaces and the knowledge base identically`,
    );
    assert.notEqual(
      locale.sidebar.knowledgeBase,
      genericKnowledgeLabels[localeFile.locale],
      `${localeFile.locale}.json should label the sidebar entry as workspace-scoped documents`,
    );
  }
});

test('workspace creation uses the app modal instead of the browser prompt', () => {
  assert.equal(mainLayoutSource.includes('window.prompt'), false);
  assert.match(mainLayoutSource, /workspace\.createTitle/);
  assert.match(mainLayoutSource, /isCreateProjectSpaceOpen/);
});

test('workspace list exposes rename and delete actions for non-default workspaces', () => {
  assert.match(projectSpaceStoreSource, /renameProjectSpace/);
  assert.match(projectSpaceStoreSource, /deleteProjectSpace/);
  assert.match(mainLayoutSource, /workspace\.renameTitle/);
  assert.match(mainLayoutSource, /workspace\.deleteTitle/);
  assert.match(mainLayoutSource, /!space\.is_default/);
});

test('usage tracking page is routed, reachable from navigation, and localized', () => {
  assert.match(appSource, /const UsagePage = lazy\(\(\) => import\('\.\/pages\/Usage'\)\)/);
  assert.match(appSource, /<Route path="\/usage" element=\{<UsagePage \/>\} \/>/);
  assert.match(mainLayoutSource, /sidebar\.usage/);
  assert.match(usagePageSource, /api\.get(?:<[^>]+>)?\('\/usage'\)/);
  assert.match(usagePageSource, /api\.get(?:<[^>]+>)?\(`\/usage\/conversations\/\$\{conversationId\}`\)/);
  assert.match(usagePageSource, /ragRuns/);
  assert.match(usagePageSource, /usage\.ragRuns/);
  assert.match(usagePageSource, /usage\.ragRunTrace/);
  assert.match(usagePageSource, /usage\.plannedQueries/);
  assert.match(usagePageSource, /usage\.traceSteps/);

  for (const localeFile of localeFiles) {
    const locale = readLocale(localeFile);

    assert.ok(locale.sidebar?.usage, `${localeFile.locale}.json needs sidebar.usage`);
    assert.ok(locale.usage?.title, `${localeFile.locale}.json needs usage.title`);
    assert.ok(locale.usage?.overview, `${localeFile.locale}.json needs usage.overview`);
    assert.ok(locale.usage?.conversations, `${localeFile.locale}.json needs usage.conversations`);
    assert.ok(locale.usage?.traceConversation, `${localeFile.locale}.json needs usage.traceConversation`);
    assert.ok(locale.usage?.noConversationSelected, `${localeFile.locale}.json needs usage.noConversationSelected`);
    assert.ok(locale.usage?.ragRuns, `${localeFile.locale}.json needs usage.ragRuns`);
    assert.ok(locale.usage?.ragRunTrace, `${localeFile.locale}.json needs usage.ragRunTrace`);
    assert.ok(locale.usage?.plannedQueries, `${localeFile.locale}.json needs usage.plannedQueries`);
    assert.ok(locale.usage?.traceSteps, `${localeFile.locale}.json needs usage.traceSteps`);
  }
});

test('RAG evaluation page is routed, reachable from navigation, and localized', () => {
  assert.match(appSource, /const RagEvaluationPage = lazy\(\(\) => import\('\.\/pages\/RagEvaluation'\)\)/);
  assert.match(appSource, /<Route path="\/rag-eval" element=\{<RagEvaluationPage \/>\} \/>/);
  assert.match(mainLayoutSource, /sidebar\.ragEvaluation/);
  assert.match(mainLayoutSource, /navigate\('\/rag-eval'\)/);
  assert.match(ragEvaluationPageSource, /api\.get(?:<[^>]+>)?\('\/rag-eval\/datasets'\)/);
  assert.match(ragEvaluationPageSource, /api\.post(?:<[^>]+>)?\('\/rag-eval\/datasets'/);
  assert.match(ragEvaluationPageSource, /api\.patch(?:<[^>]+>)?\(`\/rag-eval\/datasets\/\$\{selectedDatasetId\}`/);
  assert.match(ragEvaluationPageSource, /api\.delete\(`\/rag-eval\/datasets\/\$\{datasetToDelete\.id\}`/);
  assert.match(ragEvaluationPageSource, /api\.post(?:<[^>]+>)?\(`\/rag-eval\/datasets\/\$\{selectedDatasetId\}\/cases`/);
  assert.match(ragEvaluationPageSource, /api\.post(?:<[^>]+>)?\(`\/rag-eval\/datasets\/\$\{datasetId\}\/runs`/);
  assert.match(ragEvaluationPageSource, /api\.get(?:<[^>]+>)?\(`\/rag-eval\/runs\/\$\{runId\}`/);
  assert.match(ragEvaluationPageSource, /datasetModalMode/);
  assert.match(ragEvaluationPageSource, /openEditDataset/);
  assert.match(ragEvaluationPageSource, /datasetToDelete/);
  assert.match(ragEvaluationPageSource, /buildRagEvalRunMarkdown/);
  assert.match(ragEvaluationPageSource, /createRagEvalRunExportFilename/);
  assert.match(ragEvaluationPageSource, /downloadTextFile/);
  assert.match(ragEvaluationPageSource, /selectedRun/);
  assert.match(ragEvaluationPageSource, /ragEval\.viewRunDetails/);
  assert.match(ragEvaluationPageSource, /ragEval\.editDataset/);
  assert.match(ragEvaluationPageSource, /ragEval\.deleteDataset/);
  assert.match(ragEvaluationPageSource, /ragEval\.exportRunReport/);
  assert.match(ragEvaluationPageSource, /ragEval\.runHistory/);
  assert.match(ragEvaluationPageSource, /ragEval\.createdAt/);
  assert.match(ragEvaluationPageSource, /selectedDataset\.runs\.map/);
  assert.match(ragEvaluationPageSource, /handleViewRunDetails\(run\.id\)/);
  assert.match(ragEvaluationPageSource, /ragEval\.traceSteps/);
  assert.match(ragEvaluationPageSource, /ragEval\.matchedSources/);
  assert.match(ragEvaluationPageSource, /MAX_RAG_EVAL_CASES_PER_DATASET = 50/);
  assert.match(ragEvaluationPageSource, /isSelectedDatasetAtCaseLimit/);
  assert.match(ragEvaluationPageSource, /ragEval\.maxCasesHint/);
  assert.match(ragEvaluationPageSource, /disabled=\{isSaving \|\| isSelectedDatasetAtCaseLimit\}/);

  for (const localeFile of localeFiles) {
    const locale = readLocale(localeFile);

    assert.ok(locale.sidebar?.ragEvaluation, `${localeFile.locale}.json needs sidebar.ragEvaluation`);
    assert.ok(locale.ragEval?.title, `${localeFile.locale}.json needs ragEval.title`);
    assert.ok(locale.ragEval?.newDataset, `${localeFile.locale}.json needs ragEval.newDataset`);
    assert.ok(locale.ragEval?.editDataset, `${localeFile.locale}.json needs ragEval.editDataset`);
    assert.ok(locale.ragEval?.deleteDataset, `${localeFile.locale}.json needs ragEval.deleteDataset`);
    assert.ok(locale.ragEval?.deleteDatasetTitle, `${localeFile.locale}.json needs ragEval.deleteDatasetTitle`);
    assert.ok(locale.ragEval?.addCase, `${localeFile.locale}.json needs ragEval.addCase`);
    assert.ok(locale.ragEval?.runEval, `${localeFile.locale}.json needs ragEval.runEval`);
    assert.ok(locale.ragEval?.latestRuns, `${localeFile.locale}.json needs ragEval.latestRuns`);
    assert.ok(locale.ragEval?.viewRunDetails, `${localeFile.locale}.json needs ragEval.viewRunDetails`);
    assert.ok(locale.ragEval?.exportRunReport, `${localeFile.locale}.json needs ragEval.exportRunReport`);
    assert.ok(locale.ragEval?.exportSuccess, `${localeFile.locale}.json needs ragEval.exportSuccess`);
    assert.ok(locale.ragEval?.runHistory, `${localeFile.locale}.json needs ragEval.runHistory`);
    assert.ok(locale.ragEval?.createdAt, `${localeFile.locale}.json needs ragEval.createdAt`);
    assert.ok(locale.ragEval?.runDetails, `${localeFile.locale}.json needs ragEval.runDetails`);
    assert.ok(locale.ragEval?.traceSteps, `${localeFile.locale}.json needs ragEval.traceSteps`);
    assert.ok(locale.ragEval?.matchedSources, `${localeFile.locale}.json needs ragEval.matchedSources`);
    assert.ok(locale.ragEval?.maxCasesHint, `${localeFile.locale}.json needs ragEval.maxCasesHint`);
  }
});

test('conversation list supports pinning, archiving, and archived filtering in localized UI', () => {
  const chatStoreSource = readFileSync(path.join(clientDir, 'src/stores/useChatStore.ts'), 'utf8');

  assert.match(chatStoreSource, /is_pinned\?: boolean/);
  assert.match(chatStoreSource, /archived_at\?: string \| null/);
  assert.match(mainLayoutSource, /conversationFilter/);
  assert.match(mainLayoutSource, /chat\.showActive/);
  assert.match(mainLayoutSource, /chat\.showArchived/);
  assert.match(mainLayoutSource, /toggleConversationPinned/);
  assert.match(mainLayoutSource, /archiveConversation/);
  assert.match(mainLayoutSource, /unarchiveConversation/);

  for (const localeFile of localeFiles) {
    const locale = readLocale(localeFile);

    assert.ok(locale.chat?.pinConversation, `${localeFile.locale}.json needs chat.pinConversation`);
    assert.ok(locale.chat?.unpinConversation, `${localeFile.locale}.json needs chat.unpinConversation`);
    assert.ok(locale.chat?.archiveConversation, `${localeFile.locale}.json needs chat.archiveConversation`);
    assert.ok(locale.chat?.unarchiveConversation, `${localeFile.locale}.json needs chat.unarchiveConversation`);
    assert.ok(locale.chat?.showActive, `${localeFile.locale}.json needs chat.showActive`);
    assert.ok(locale.chat?.showArchived, `${localeFile.locale}.json needs chat.showArchived`);
    assert.ok(locale.sidebar?.noArchivedConversations, `${localeFile.locale}.json needs sidebar.noArchivedConversations`);
  }
});

test('chat workbench upgrades expose prompt templates, branches, metadata, and search filters', () => {
  const appSource = readFileSync(path.join(clientDir, 'src/App.tsx'), 'utf8');
  const chatPageSource = readFileSync(path.join(clientDir, 'src/pages/Chat.tsx'), 'utf8');
  const chatMessageSource = readFileSync(path.join(clientDir, 'src/components/ChatMessage.tsx'), 'utf8');
  const chatSettingsSource = readFileSync(path.join(clientDir, 'src/components/ChatSettingsDialog.tsx'), 'utf8');
  const searchDialogSource = readFileSync(path.join(clientDir, 'src/components/SearchDialog.tsx'), 'utf8');

  assert.match(appSource, /const PromptTemplatesPage = lazy\(\(\) => import\('\.\/pages\/PromptTemplates'\)\)/);
  assert.match(appSource, /<Route path="\/prompts" element=\{<PromptTemplatesPage \/>\} \/>/);
  assert.match(mainLayoutSource, /sidebar\.promptTemplates/);
  assert.match(promptTemplatePageSource, /api\.get(?:<[^>]+>)?\('\/prompt-templates'\)/);
  assert.match(chatMessageSource, /onBranch/);
  assert.match(chatPageSource, /branchConversation/);
  assert.match(chatPageSource, /compareConversations/);
  assert.match(chatSettingsSource, /settings\.tags/);
  assert.match(chatSettingsSource, /settings\.note/);
  assert.match(chatSettingsSource, /settings\.promptTemplate/);
  assert.match(searchDialogSource, /search\.filters/);
  assert.match(searchDialogSource, /favoriteOnly/);
  assert.match(searchDialogSource, /hasSources/);

  for (const localeFile of localeFiles) {
    const locale = readLocale(localeFile);

    assert.ok(locale.sidebar?.promptTemplates, `${localeFile.locale}.json needs sidebar.promptTemplates`);
    assert.ok(locale.prompts?.title, `${localeFile.locale}.json needs prompts.title`);
    assert.ok(locale.chat?.branchFromMessage, `${localeFile.locale}.json needs chat.branchFromMessage`);
    assert.ok(locale.chat?.compareVersions, `${localeFile.locale}.json needs chat.compareVersions`);
    assert.ok(locale.settings?.tags, `${localeFile.locale}.json needs settings.tags`);
    assert.ok(locale.settings?.note, `${localeFile.locale}.json needs settings.note`);
    assert.ok(locale.settings?.promptTemplate, `${localeFile.locale}.json needs settings.promptTemplate`);
    assert.ok(locale.search?.filters, `${localeFile.locale}.json needs search.filters`);
    assert.ok(locale.usage?.estimatedTokens, `${localeFile.locale}.json needs usage.estimatedTokens`);
    assert.ok(locale.usage?.modelUsage, `${localeFile.locale}.json needs usage.modelUsage`);
  }
});

test('conversation sidebar shows metadata badges without redundant favorite or tag filters', () => {
  assert.equal(mainLayoutSource.includes('conversationFavoriteFilter'), false);
  assert.equal(mainLayoutSource.includes('conversationTagFilter'), false);
  assert.equal(mainLayoutSource.includes('availableConversationTags'), false);
  assert.equal(mainLayoutSource.includes("chat.favoritesOnly"), false);
  assert.equal(mainLayoutSource.includes("chat.allTags"), false);
  assert.equal(mainLayoutSource.includes("chat.filterByTag"), false);
  assert.match(mainLayoutSource, /conv\.tags/);
  assert.match(mainLayoutSource, /conv\.note/);

  for (const localeFile of localeFiles) {
    const locale = readLocale(localeFile);

    assert.equal(locale.chat?.favoritesOnly, undefined, `${localeFile.locale}.json should not keep chat.favoritesOnly`);
    assert.equal(locale.chat?.allTags, undefined, `${localeFile.locale}.json should not keep chat.allTags`);
    assert.equal(locale.chat?.filterByTag, undefined, `${localeFile.locale}.json should not keep chat.filterByTag`);
    assert.ok(locale.chat?.conversationNote, `${localeFile.locale}.json needs chat.conversationNote`);
  }
});

test('chat page persists unsent drafts per user and conversation', () => {
  const chatPageSource = readFileSync(path.join(clientDir, 'src/pages/Chat.tsx'), 'utf8');
  const chatInputSource = readFileSync(path.join(clientDir, 'src/components/ChatInput.tsx'), 'utf8');
  const chatMessageSource = readFileSync(path.join(clientDir, 'src/components/ChatMessage.tsx'), 'utf8');
  const messageListSource = readFileSync(path.join(clientDir, 'src/components/MessageList.tsx'), 'utf8');

  assert.match(chatPageSource, /readChatDraft/);
  assert.match(chatPageSource, /writeChatDraft/);
  assert.match(chatPageSource, /clearChatDraft/);
  assert.match(chatPageSource, /currentDraftKey/);
  assert.match(chatPageSource, /chat\.draftSaved/);
  assert.match(chatPageSource, /handleEditMessageAsDraft/);
  assert.match(chatPageSource, /chat\.messageLoadedToDraft/);
  assert.match(chatInputSource, /onClearDraft/);
  assert.match(chatInputSource, /chat\.clearDraft/);
  assert.match(chatInputSource, /accept="\.md,\.markdown"/);
  assert.match(chatMessageSource, /onEditAsDraft/);
  assert.match(messageListSource, /onEditAsDraft/);

  for (const localeFile of localeFiles) {
    const locale = readLocale(localeFile);

    assert.ok(locale.chat?.draftSaved, `${localeFile.locale}.json needs chat.draftSaved`);
    assert.ok(locale.chat?.clearDraft, `${localeFile.locale}.json needs chat.clearDraft`);
    assert.ok(locale.chat?.editAsDraft, `${localeFile.locale}.json needs chat.editAsDraft`);
    assert.ok(locale.chat?.messageLoadedToDraft, `${localeFile.locale}.json needs chat.messageLoadedToDraft`);
  }
});

test('chat runtime status copy is localized instead of hardcoded', () => {
  const chatPageSource = readFileSync(path.join(clientDir, 'src/pages/Chat.tsx'), 'utf8');
  const chatInputSource = readFileSync(path.join(clientDir, 'src/components/ChatInput.tsx'), 'utf8');
  const chatMessageSource = readFileSync(path.join(clientDir, 'src/components/ChatMessage.tsx'), 'utf8');

  assert.match(chatMessageSource, /chat\.searchingWorkspaceDocuments/);
  assert.match(chatMessageSource, /chat\.loadingContent/);
  assert.match(chatInputSource, /chat\.sendMessage/);
  assert.match(chatPageSource, /chat\.uploadHashing/);
  assert.match(chatPageSource, /chat\.uploadUploading/);
  assert.match(chatPageSource, /chat\.uploadMerging/);
  assert.match(chatPageSource, /chat\.uploadProcessing/);

  assert.equal(chatMessageSource.includes('Searching knowledge base...'), false);
  assert.equal(chatMessageSource.includes('Loading content...'), false);
  assert.equal(chatPageSource.includes('Merging file...'), false);
  assert.equal(chatPageSource.includes('Processing file content...'), false);

  for (const localeFile of localeFiles) {
    const locale = readLocale(localeFile);

    assert.ok(locale.chat?.searchingWorkspaceDocuments, `${localeFile.locale}.json needs chat.searchingWorkspaceDocuments`);
    assert.ok(locale.chat?.loadingContent, `${localeFile.locale}.json needs chat.loadingContent`);
    assert.ok(locale.chat?.sendMessage, `${localeFile.locale}.json needs chat.sendMessage`);
    assert.ok(locale.chat?.uploadHashing, `${localeFile.locale}.json needs chat.uploadHashing`);
    assert.ok(locale.chat?.uploadUploading, `${localeFile.locale}.json needs chat.uploadUploading`);
    assert.ok(locale.chat?.uploadMerging, `${localeFile.locale}.json needs chat.uploadMerging`);
    assert.ok(locale.chat?.uploadProcessing, `${localeFile.locale}.json needs chat.uploadProcessing`);
  }
});

test('chat store optimistic placeholders are localized', () => {
  assert.match(chatStoreSource, /i18n\.t\('sidebar\.newChat'\)/);
  assert.match(chatStoreSource, /i18n\.t\('common\.loading'\)/);
  assert.equal(chatStoreSource.includes("title: title || 'New Chat'"), false);
  assert.equal(chatStoreSource.includes("content: 'Thinking...'"), false);
});

test('shared error, loading, knowledge, search, and profile copy is localized', () => {
  assert.match(errorBoundarySource, /i18n\.t\('errorBoundary\.title'\)/);
  assert.match(errorBoundarySource, /i18n\.t\('errorBoundary\.reload'\)/);
  assert.equal(errorBoundarySource.includes('Something went wrong'), false);
  assert.equal(errorBoundarySource.includes('Reload Application'), false);

  assert.match(loginSource, /t\('common\.loading'\)/);
  assert.match(protectedRouteSource, /t\('common\.loading'\)/);
  assert.equal(loginSource.includes('Loading...'), false);
  assert.equal(protectedRouteSource.includes('Loading...'), false);

  assert.match(mainLayoutSource, /title=\{t\('profile\.title'\)\}/);
  assert.equal(mainLayoutSource.includes('View Profile & Settings'), false);

  assert.match(knowledgePageSource, /knowledge\.dropToUpload/);
  assert.match(knowledgePageSource, /knowledge\.unsupportedFileType/);
  assert.match(knowledgePageSource, /accept="\.md,\.markdown"/);
  assert.match(knowledgePageSource, /knowledge\.retryQueued/);
  assert.match(knowledgePageSource, /knowledge\.retryFailed/);
  assert.equal(knowledgePageSource.includes('Drop files to upload'), false);
  assert.equal(knowledgePageSource.includes('Only .md and .pdf files are supported'), false);
  assert.equal(knowledgePageSource.includes('File queued for retry'), false);
  assert.equal(knowledgePageSource.includes('Failed to retry file'), false);

  assert.match(searchDialogSource, /search\.shortcutOpen/);
  assert.match(searchDialogSource, /search\.shortcutClose/);
  assert.match(searchDialogSource, /search\.unknownChat/);
  assert.equal(searchDialogSource.includes('to open'), false);
  assert.equal(searchDialogSource.includes('to close'), false);
  assert.equal(searchDialogSource.includes('Unknown Chat'), false);

  assert.match(profilePageSource, /profile\.displayNamePlaceholder/);
  assert.match(profilePageSource, /profile\.customColor/);
  assert.match(profilePageSource, /profile\.avatarUploadSuccess/);
  assert.match(profilePageSource, /profile\.deleteSuccess/);
  assert.equal(profilePageSource.includes('Your Name'), false);
  assert.equal(profilePageSource.includes('Custom Color'), false);
  assert.equal(profilePageSource.includes('Avatar updated successfully!'), false);
  assert.equal(profilePageSource.includes('Account deleted.'), false);

  for (const localeFile of localeFiles) {
    const locale = readLocale(localeFile);

    assert.ok(locale.errorBoundary?.title, `${localeFile.locale}.json needs errorBoundary.title`);
    assert.ok(locale.errorBoundary?.reload, `${localeFile.locale}.json needs errorBoundary.reload`);
    assert.ok(locale.knowledge?.dropToUpload, `${localeFile.locale}.json needs knowledge.dropToUpload`);
    assert.ok(locale.knowledge?.unsupportedFileType, `${localeFile.locale}.json needs knowledge.unsupportedFileType`);
    assert.ok(locale.knowledge?.retryQueued, `${localeFile.locale}.json needs knowledge.retryQueued`);
    assert.ok(locale.knowledge?.retryFailed, `${localeFile.locale}.json needs knowledge.retryFailed`);
    assert.ok(locale.search?.shortcutOpen, `${localeFile.locale}.json needs search.shortcutOpen`);
    assert.ok(locale.search?.shortcutClose, `${localeFile.locale}.json needs search.shortcutClose`);
    assert.ok(locale.search?.unknownChat, `${localeFile.locale}.json needs search.unknownChat`);
    assert.ok(locale.profile?.displayNamePlaceholder, `${localeFile.locale}.json needs profile.displayNamePlaceholder`);
    assert.ok(locale.profile?.customColor, `${localeFile.locale}.json needs profile.customColor`);
    assert.ok(locale.profile?.avatarUploadSuccess, `${localeFile.locale}.json needs profile.avatarUploadSuccess`);
    assert.ok(locale.profile?.deleteSuccess, `${localeFile.locale}.json needs profile.deleteSuccess`);
  }
});

test('knowledge document table keeps action controls visible for long filenames', () => {
  assert.match(knowledgePageSource, /<table className="[^"]*table-fixed/);
  assert.match(knowledgePageSource, /<col className="w-\[(?:96|128)px\]"/);
  assert.match(knowledgePageSource, /<td className="px-6 py-4 text-right align-middle"/);
  assert.match(knowledgePageSource, /aria-label=\{t\('knowledge\.deleteFileAction'\)\}/);
  assert.match(knowledgePageSource, /aria-label=\{t\('knowledge\.retryProcessingAction'\)\}/);
  assert.equal(knowledgePageSource.includes('whitespace-nowrap block">{file.filename}</span>'), false);
});

test('knowledge document names omit markdown extensions in visible lists', () => {
  assert.match(knowledgePageSource, /formatFilename\(file\.filename\)/);
  assert.match(knowledgePageSource, /replace\(\/\\\.\(\?:md\|markdown\)\$\/i/);
  assert.equal(knowledgePageSource.includes('>{file.filename}</span>'), false);
});

test('prompt templates use compact modal editing instead of a permanent oversized editor panel', () => {
  assert.match(modalSource, /maxWidth\?:/);
  assert.match(promptTemplatePageSource, /import Modal from '\.\.\/components\/Modal'/);
  assert.match(promptTemplatePageSource, /templateModalMode/);
  assert.match(promptTemplatePageSource, /openTemplateView/);
  assert.match(promptTemplatePageSource, /prompts\.viewTemplate/);
  assert.match(promptTemplatePageSource, /maxWidth="2xl"/);
  assert.equal(promptTemplatePageSource.includes('lg:grid-cols-[320px_minmax(0,1fr)]'), false);
  assert.equal(promptTemplatePageSource.includes('min-h-72 w-full resize-y'), false);
});

test('usage tracking details open in localized modals from document and conversation cards', () => {
  assert.match(usagePageSource, /import Modal from '\.\.\/components\/Modal'/);
  assert.match(usagePageSource, /selectedFileJob/);
  assert.match(usagePageSource, /isTraceModalOpen/);
  assert.match(usagePageSource, /usage\.documentJobDetails/);
  assert.match(usagePageSource, /usage\.conversationDetails/);
  assert.match(usagePageSource, /aria-label=\{t\('usage\.viewDocumentJob'/);
  assert.match(usagePageSource, /aria-label=\{t\('usage\.viewConversationTrace'/);

  for (const localeFile of localeFiles) {
    const locale = readLocale(localeFile);

    assert.ok(locale.usage?.documentJobDetails, `${localeFile.locale}.json needs usage.documentJobDetails`);
    assert.ok(locale.usage?.conversationDetails, `${localeFile.locale}.json needs usage.conversationDetails`);
    assert.ok(locale.usage?.viewDocumentJob, `${localeFile.locale}.json needs usage.viewDocumentJob`);
    assert.ok(locale.usage?.viewConversationTrace, `${localeFile.locale}.json needs usage.viewConversationTrace`);
    assert.ok(locale.prompts?.viewTemplate, `${localeFile.locale}.json needs prompts.viewTemplate`);
    assert.ok(locale.prompts?.detailsHint, `${localeFile.locale}.json needs prompts.detailsHint`);
  }
});

test('uploaded markdown documents can be opened as original documents from knowledge and chat sources', () => {
  const documentViewerSource = readFileSync(path.join(clientDir, 'src/components/DocumentViewerModal.tsx'), 'utf8');

  assert.match(knowledgePageSource, /DocumentViewerModal/);
  assert.match(knowledgePageSource, /selectedDocument/);
  assert.match(knowledgePageSource, /knowledge\.viewFileAction/);

  assert.match(chatMessageSource, /DocumentViewerModal/);
  assert.match(chatMessageSource, /selectedSourceDocument/);
  assert.match(chatMessageSource, /chat\.viewOriginalDocument/);
  assert.match(chatMessageSource, /source\.file_id/);

  assert.match(documentViewerSource, /api\.get<string>\(`\/upload\/files\/\$\{document\.id\}\/content`/);
  assert.match(documentViewerSource, /MarkdownRenderer/);
  assert.match(documentViewerSource, /knowledge\.rawMarkdown/);
  assert.match(documentViewerSource, /knowledge\.renderedMarkdown/);

  for (const localeFile of localeFiles) {
    const locale = readLocale(localeFile);

    assert.ok(locale.knowledge?.documentPreview, `${localeFile.locale}.json needs knowledge.documentPreview`);
    assert.ok(locale.knowledge?.viewFileAction, `${localeFile.locale}.json needs knowledge.viewFileAction`);
    assert.ok(locale.knowledge?.rawMarkdown, `${localeFile.locale}.json needs knowledge.rawMarkdown`);
    assert.ok(locale.knowledge?.renderedMarkdown, `${localeFile.locale}.json needs knowledge.renderedMarkdown`);
    assert.ok(locale.knowledge?.loadDocumentFailed, `${localeFile.locale}.json needs knowledge.loadDocumentFailed`);
    assert.ok(locale.chat?.viewOriginalDocument, `${localeFile.locale}.json needs chat.viewOriginalDocument`);
  }
});

test('chat source document previews carry citation snippets and scroll to the matching original section', () => {
  const documentViewerSource = readFileSync(path.join(clientDir, 'src/components/DocumentViewerModal.tsx'), 'utf8');

  assert.match(chatMessageSource, /citationContent:\s*source\.content/);
  assert.match(chatMessageSource, /chunkIndex:\s*source\.chunk_index/);
  assert.match(documentViewerSource, /citationContent\?: string/);
  assert.match(documentViewerSource, /findCitationLocation/);
  assert.match(documentViewerSource, /data-citation-target="true"/);
  assert.match(documentViewerSource, /scrollIntoView/);
  assert.match(documentViewerSource, /knowledge\.citationMatched/);
  assert.match(documentViewerSource, /knowledge\.citationNotFound/);

  for (const localeFile of localeFiles) {
    const locale = readLocale(localeFile);

    assert.ok(locale.knowledge?.citationMatched, `${localeFile.locale}.json needs knowledge.citationMatched`);
    assert.ok(locale.knowledge?.citationNotFound, `${localeFile.locale}.json needs knowledge.citationNotFound`);
    assert.ok(locale.knowledge?.citationTarget, `${localeFile.locale}.json needs knowledge.citationTarget`);
  }
});

test('assistant messages expose Agentic RAG trace and quality summaries in localized UI', () => {
  assert.match(chatStoreSource, /ragRunId/);
  assert.match(chatStoreSource, /traceSummary/);
  assert.match(chatStoreSource, /qualitySummary/);
  assert.match(chatMessageSource, /chat\.ragQuality/);
  assert.match(chatMessageSource, /chat\.ragTrace/);
  assert.match(chatMessageSource, /chat\.ragPlannedQueries/);
  assert.match(chatMessageSource, /chat\.ragEvidence/);

  for (const localeFile of localeFiles) {
    const locale = readLocale(localeFile);

    assert.ok(locale.chat?.ragQuality, `${localeFile.locale}.json needs chat.ragQuality`);
    assert.ok(locale.chat?.ragTrace, `${localeFile.locale}.json needs chat.ragTrace`);
    assert.ok(locale.chat?.ragPlannedQueries, `${localeFile.locale}.json needs chat.ragPlannedQueries`);
    assert.ok(locale.chat?.ragEvidence, `${localeFile.locale}.json needs chat.ragEvidence`);
    assert.ok(locale.chat?.ragEvidenceStrong, `${localeFile.locale}.json needs chat.ragEvidenceStrong`);
    assert.ok(locale.chat?.ragEvidencePartial, `${localeFile.locale}.json needs chat.ragEvidencePartial`);
    assert.ok(locale.chat?.ragEvidenceWeak, `${localeFile.locale}.json needs chat.ragEvidenceWeak`);
  }
});

test('markdown image references show a localized fallback when the uploaded markdown did not include image assets', () => {
  assert.match(markdownRendererSource, /MarkdownImage/);
  assert.match(markdownRendererSource, /isRemoteImageSource/);
  assert.match(markdownRendererSource, /onError=\{\(\) => setFailedSource\(src \|\| ''\)\}/);
  assert.match(markdownRendererSource, /knowledge\.imageUnavailable/);
  assert.match(markdownRendererSource, /knowledge\.imageLocalUnavailableHint/);
  assert.match(markdownRendererSource, /knowledge\.imageRemoteUnavailableHint/);
  assert.match(markdownRendererSource, /img\(\{ src, alt/);
  assert.match(markdownRendererSource, /text-text-main/);
  assert.match(markdownRendererSource, /text-text-muted/);
  assert.equal(markdownRendererSource.includes('text-amber-100'), false);

  for (const localeFile of localeFiles) {
    const locale = readLocale(localeFile);

    assert.ok(locale.knowledge?.imageUnavailable, `${localeFile.locale}.json needs knowledge.imageUnavailable`);
    assert.ok(locale.knowledge?.imageLocalUnavailableHint, `${localeFile.locale}.json needs knowledge.imageLocalUnavailableHint`);
    assert.ok(locale.knowledge?.imageRemoteUnavailableHint, `${localeFile.locale}.json needs knowledge.imageRemoteUnavailableHint`);
  }
});
