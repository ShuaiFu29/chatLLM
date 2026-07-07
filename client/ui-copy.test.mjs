import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
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
const retrievalLabPagePath = path.join(clientDir, 'src/pages/RetrievalLab.tsx');
const retrievalLabPageSource = existsSync(retrievalLabPagePath) ? readFileSync(retrievalLabPagePath, 'utf8') : '';
const graphExplorerPagePath = path.join(clientDir, 'src/pages/GraphExplorer.tsx');
const graphExplorerPageSource = existsSync(graphExplorerPagePath) ? readFileSync(graphExplorerPagePath, 'utf8') : '';
const ragTraceLabelsPath = path.join(clientDir, 'src/lib/ragTraceLabels.ts');
const ragTraceLabelsSource = existsSync(ragTraceLabelsPath) ? readFileSync(ragTraceLabelsPath, 'utf8') : '';
const usagePageSource = readFileSync(path.join(clientDir, 'src/pages/Usage.tsx'), 'utf8');
const modalSource = readFileSync(path.join(clientDir, 'src/components/Modal.tsx'), 'utf8');
const avatarUtilsPath = path.join(clientDir, 'src/lib/avatar.ts');
const avatarUtilsSource = existsSync(avatarUtilsPath) ? readFileSync(avatarUtilsPath, 'utf8') : '';
const selectFieldPath = path.join(clientDir, 'src/components/SelectField.tsx');
const selectFieldSource = existsSync(selectFieldPath) ? readFileSync(selectFieldPath, 'utf8') : '';
const chatHeaderSource = readFileSync(path.join(clientDir, 'src/components/ChatHeader.tsx'), 'utf8');
const chatSettingsSource = readFileSync(path.join(clientDir, 'src/components/ChatSettingsDialog.tsx'), 'utf8');
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

test('sidebar dense lists open full management modals instead of rendering every item inline', () => {
  assert.match(mainLayoutSource, /isWorkspaceBrowserOpen/);
  assert.match(mainLayoutSource, /isConversationBrowserOpen/);
  assert.match(mainLayoutSource, /workspace\.viewAllWorkspaces/);
  assert.match(mainLayoutSource, /workspace\.viewAllConversations/);
  assert.match(mainLayoutSource, /workspace\.workspaceBrowserTitle/);
  assert.match(mainLayoutSource, /workspace\.conversationBrowserTitle/);
  assert.match(mainLayoutSource, /workspace\.conversationSummaryTitle/);
  assert.equal(
    mainLayoutSource.includes('visibleSidebarConversations.map'),
    false,
    'sidebar should open the conversation browser instead of rendering recent conversation rows inline',
  );

  for (const localeFile of localeFiles) {
    const locale = readLocale(localeFile);

    assert.ok(locale.workspace?.viewAllWorkspaces, `${localeFile.locale}.json needs workspace.viewAllWorkspaces`);
    assert.ok(locale.workspace?.viewAllConversations, `${localeFile.locale}.json needs workspace.viewAllConversations`);
    assert.ok(locale.workspace?.workspaceBrowserTitle, `${localeFile.locale}.json needs workspace.workspaceBrowserTitle`);
    assert.ok(locale.workspace?.conversationBrowserTitle, `${localeFile.locale}.json needs workspace.conversationBrowserTitle`);
    assert.ok(locale.workspace?.conversationSummaryTitle, `${localeFile.locale}.json needs workspace.conversationSummaryTitle`);
    assert.ok(locale.workspace?.activeConversationSummary, `${localeFile.locale}.json needs workspace.activeConversationSummary`);
    assert.ok(locale.workspace?.archivedConversationSummary, `${localeFile.locale}.json needs workspace.archivedConversationSummary`);
  }
});

test('visible dropdowns use shared SelectField with an app-native chevron', () => {
  assert.ok(existsSync(selectFieldPath), 'SelectField.tsx should exist');
  assert.match(selectFieldSource, /ChevronDown/);
  assert.match(selectFieldSource, /appearance-none/);

  const selectConsumers = [
    ['ChatHeader.tsx', chatHeaderSource],
    ['ChatSettingsDialog.tsx', chatSettingsSource],
    ['SearchDialog.tsx', searchDialogSource],
    ['PromptTemplates.tsx', promptTemplatePageSource],
    ['RagEvaluation.tsx', ragEvaluationPageSource],
    ['RetrievalLab.tsx', retrievalLabPageSource],
    ['GraphExplorer.tsx', graphExplorerPageSource],
  ];

  for (const [filename, source] of selectConsumers) {
    assert.match(source, /SelectField/, `${filename} should import and use SelectField`);
    assert.equal(source.includes('<select'), false, `${filename} should not render raw select controls`);
  }
});

test('user avatar images use a non-empty fallback src', () => {
  assert.ok(existsSync(avatarUtilsPath), 'avatar URL helper should exist');
  assert.match(avatarUtilsSource, /getAvatarUrl/);
  assert.match(avatarUtilsSource, /ui-avatars\.com/);
  assert.match(mainLayoutSource, /getAvatarUrl\(/);
  assert.match(profilePageSource, /getAvatarUrl\(/);
  assert.equal(mainLayoutSource.includes('src={user?.avatar_url}'), false);
  assert.equal(profilePageSource.includes('src={avatarUrl || user?.avatar_url}'), false);
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
  assert.match(usagePageSource, /api\.get(?:<[^>]+>)?\('\/usage\/provider-health'\)/);
  assert.match(usagePageSource, /api\.get(?:<[^>]+>)?\(`\/usage\/conversations\/\$\{conversationId\}`\)/);
  assert.match(usagePageSource, /ragRuns/);
  assert.match(usagePageSource, /usage\.ragRuns/);
  assert.match(usagePageSource, /usage\.ragRunTrace/);
  assert.match(usagePageSource, /usage\.plannedQueries/);
  assert.match(usagePageSource, /usage\.traceSteps/);
  assert.match(usagePageSource, /providerHealth/);
  assert.match(usagePageSource, /usage\.providerHealth/);
  assert.match(usagePageSource, /usage\.quotaStatus/);

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
    assert.ok(locale.usage?.providerHealth, `${localeFile.locale}.json needs usage.providerHealth`);
    assert.ok(locale.usage?.providerHealthHint, `${localeFile.locale}.json needs usage.providerHealthHint`);
    assert.ok(locale.usage?.quotaStatus, `${localeFile.locale}.json needs usage.quotaStatus`);
    assert.ok(locale.usage?.configured, `${localeFile.locale}.json needs usage.configured`);
    assert.ok(locale.usage?.notConfigured, `${localeFile.locale}.json needs usage.notConfigured`);
  }
});

test('RAG evaluation page is routed, reachable from navigation, and localized', () => {
  assert.match(appSource, /const RagEvaluationPage = lazy\(\(\) => import\('\.\/pages\/RagEvaluation'\)\)/);
  assert.match(appSource, /<Route path="\/rag-eval" element=\{<RagEvaluationPage \/>\} \/>/);
  assert.match(mainLayoutSource, /sidebar\.ragEvaluation/);
  assert.match(mainLayoutSource, /navigate\('\/rag-eval'\)/);
  assert.match(ragEvaluationPageSource, /api\.get(?:<[^>]+>)?\('\/rag-eval\/datasets'\)/);
  assert.match(ragEvaluationPageSource, /api\.get(?:<[^>]+>)?\('\/rag-eval\/history'/);
  assert.match(ragEvaluationPageSource, /api\.post(?:<[^>]+>)?\('\/rag-eval\/datasets'/);
  assert.match(ragEvaluationPageSource, /api\.patch(?:<[^>]+>)?\(`\/rag-eval\/datasets\/\$\{selectedDatasetId\}`/);
  assert.match(ragEvaluationPageSource, /api\.delete\(`\/rag-eval\/datasets\/\$\{datasetToDelete\.id\}`/);
  assert.match(ragEvaluationPageSource, /api\.get(?:<[^>]+>)?\(`\/rag-eval\/datasets\/\$\{selectedQualityDatasetId\}\/quality`/);
  assert.match(ragEvaluationPageSource, /api\.post(?:<[^>]+>)?\(`\/rag-eval\/datasets\/\$\{selectedDatasetId\}\/cases`/);
  assert.match(ragEvaluationPageSource, /api\.post(?:<[^>]+>)?\(`\/rag-eval\/datasets\/\$\{datasetId\}\/runs`/);
  assert.match(ragEvaluationPageSource, /api\.get(?:<[^>]+>)?\(`\/rag-eval\/runs\/\$\{runId\}`/);
  assert.match(ragEvaluationPageSource, /api\.post(?:<[^>]+>)?\(`\/rag-eval\/runs\/\$\{runId\}\/cancel`/);
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
  assert.match(ragEvaluationPageSource, /status: 'completed' \| 'failed' \| 'partial' \| 'running'/);
  assert.match(ragEvaluationPageSource, /hasRunningRuns/);
  assert.match(ragEvaluationPageSource, /setInterval\(\(\) => \{/);
  assert.match(ragEvaluationPageSource, /ragEval\.runQueued/);
  assert.match(ragEvaluationPageSource, /ragEval\.runningStatus/);
  assert.match(ragEvaluationPageSource, /ragEval\.cancelRun/);
  assert.match(ragEvaluationPageSource, /ragEval\.cancelledStatus/);
  assert.match(ragEvaluationPageSource, /ragEval\.cancelSuccess/);
  assert.match(ragEvaluationPageSource, /RagEvalQualitySummary/);
  assert.match(ragEvaluationPageSource, /qualitySummary/);
  assert.match(ragEvaluationPageSource, /ragEval\.qualityDashboard/);
  assert.match(ragEvaluationPageSource, /ragEval\.trendDelta/);
  assert.match(ragEvaluationPageSource, /ragEval\.lowScoreCases/);
  assert.match(ragEvaluationPageSource, /qualitySummary\.low_score_cases/);
  assert.match(ragEvaluationPageSource, /historyItems/);
  assert.match(ragEvaluationPageSource, /selectedHistoryItem/);
  assert.match(ragEvaluationPageSource, /isHistoryBrowserOpen/);
  assert.match(ragEvaluationPageSource, /isBenchmarkModalOpen/);
  assert.match(ragEvaluationPageSource, /openCreateCaseFromHistory/);
  assert.match(ragEvaluationPageSource, /ragEval\.historyTitle/);
  assert.match(ragEvaluationPageSource, /ragEval\.historyHint/);
  assert.match(ragEvaluationPageSource, /ragEval\.openHistoryBrowser/);
  assert.match(ragEvaluationPageSource, /ragEval\.openBenchmarkLab/);
  assert.match(ragEvaluationPageSource, /ragEval\.historyDetails/);
  assert.match(ragEvaluationPageSource, /ragEval\.benchmarkTitle/);
  assert.match(ragEvaluationPageSource, /ragEval\.benchmarkHint/);

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
    assert.ok(locale.ragEval?.runQueued, `${localeFile.locale}.json needs ragEval.runQueued`);
    assert.ok(locale.ragEval?.runningStatus, `${localeFile.locale}.json needs ragEval.runningStatus`);
    assert.ok(locale.ragEval?.cancelRun, `${localeFile.locale}.json needs ragEval.cancelRun`);
    assert.ok(locale.ragEval?.cancelledStatus, `${localeFile.locale}.json needs ragEval.cancelledStatus`);
    assert.ok(locale.ragEval?.cancelSuccess, `${localeFile.locale}.json needs ragEval.cancelSuccess`);
    assert.ok(locale.ragEval?.cancelFailed, `${localeFile.locale}.json needs ragEval.cancelFailed`);
    assert.ok(locale.ragEval?.qualityDashboard, `${localeFile.locale}.json needs ragEval.qualityDashboard`);
    assert.ok(locale.ragEval?.qualityDashboardHint, `${localeFile.locale}.json needs ragEval.qualityDashboardHint`);
    assert.ok(locale.ragEval?.trendDelta, `${localeFile.locale}.json needs ragEval.trendDelta`);
    assert.ok(locale.ragEval?.lowScoreCases, `${localeFile.locale}.json needs ragEval.lowScoreCases`);
    assert.ok(locale.ragEval?.noLowScoreCases, `${localeFile.locale}.json needs ragEval.noLowScoreCases`);
    assert.ok(locale.ragEval?.qualityLoadFailed, `${localeFile.locale}.json needs ragEval.qualityLoadFailed`);
    assert.ok(locale.ragEval?.historyTitle, `${localeFile.locale}.json needs ragEval.historyTitle`);
    assert.ok(locale.ragEval?.historyHint, `${localeFile.locale}.json needs ragEval.historyHint`);
    assert.ok(locale.ragEval?.openHistoryBrowser, `${localeFile.locale}.json needs ragEval.openHistoryBrowser`);
    assert.ok(locale.ragEval?.openBenchmarkLab, `${localeFile.locale}.json needs ragEval.openBenchmarkLab`);
    assert.ok(locale.ragEval?.historySummary, `${localeFile.locale}.json needs ragEval.historySummary`);
    assert.ok(locale.ragEval?.benchmarkSummary, `${localeFile.locale}.json needs ragEval.benchmarkSummary`);
    assert.ok(locale.ragEval?.historyEmpty, `${localeFile.locale}.json needs ragEval.historyEmpty`);
    assert.ok(locale.ragEval?.historyLoadFailed, `${localeFile.locale}.json needs ragEval.historyLoadFailed`);
    assert.ok(locale.ragEval?.historyDetails, `${localeFile.locale}.json needs ragEval.historyDetails`);
    assert.ok(locale.ragEval?.historyAnswerPreview, `${localeFile.locale}.json needs ragEval.historyAnswerPreview`);
    assert.ok(locale.ragEval?.historyAddToDataset, `${localeFile.locale}.json needs ragEval.historyAddToDataset`);
    assert.ok(locale.ragEval?.benchmarkTitle, `${localeFile.locale}.json needs ragEval.benchmarkTitle`);
    assert.ok(locale.ragEval?.benchmarkHint, `${localeFile.locale}.json needs ragEval.benchmarkHint`);
  }
});

test('RAG retrieval lab is routed, reachable from navigation, and localized', () => {
  assert.ok(retrievalLabPageSource, 'RetrievalLab.tsx should exist');
  assert.match(appSource, /const RetrievalLabPage = lazy\(\(\) => import\('\.\/pages\/RetrievalLab'\)\)/);
  assert.match(appSource, /<Route path="\/retrieval-lab" element=\{<RetrievalLabPage \/>\} \/>/);
  assert.match(mainLayoutSource, /sidebar\.retrievalLab/);
  assert.match(mainLayoutSource, /navigate\('\/retrieval-lab'\)/);
  assert.match(retrievalLabPageSource, /api\.post(?:<[^>]+>)?\('\/rag-workbench\/inspect'/);
  assert.match(retrievalLabPageSource, /ragWorkbench\.title/);
  assert.match(retrievalLabPageSource, /ragWorkbench\.queryLabel/);
  assert.match(retrievalLabPageSource, /ragWorkbench\.plannedQueries/);
  assert.match(retrievalLabPageSource, /ragWorkbench\.traceSteps/);
  assert.match(retrievalLabPageSource, /ragWorkbench\.retrievalChannels/);
  assert.match(retrievalLabPageSource, /ragWorkbench\.rerankScore/);
  assert.match(retrievalLabPageSource, /retrieval_channels/);
  assert.match(retrievalLabPageSource, /channel_ranks/);
  assert.match(retrievalLabPageSource, /channel_scores/);
  assert.match(retrievalLabPageSource, /project_space_id/);
  assert.match(retrievalLabPageSource, /URLSearchParams\(window\.location\.search\)/);
  assert.match(retrievalLabPageSource, /hasAutoRunFromUrl/);

  for (const localeFile of localeFiles) {
    const locale = readLocale(localeFile);

    assert.ok(locale.sidebar?.retrievalLab, `${localeFile.locale}.json needs sidebar.retrievalLab`);
    assert.ok(locale.ragWorkbench?.title, `${localeFile.locale}.json needs ragWorkbench.title`);
    assert.ok(locale.ragWorkbench?.subtitle, `${localeFile.locale}.json needs ragWorkbench.subtitle`);
    assert.ok(locale.ragWorkbench?.queryLabel, `${localeFile.locale}.json needs ragWorkbench.queryLabel`);
    assert.ok(locale.ragWorkbench?.inspect, `${localeFile.locale}.json needs ragWorkbench.inspect`);
    assert.ok(locale.ragWorkbench?.plannedQueries, `${localeFile.locale}.json needs ragWorkbench.plannedQueries`);
    assert.ok(locale.ragWorkbench?.traceSteps, `${localeFile.locale}.json needs ragWorkbench.traceSteps`);
    assert.ok(locale.ragWorkbench?.retrievalChannels, `${localeFile.locale}.json needs ragWorkbench.retrievalChannels`);
    assert.ok(locale.ragWorkbench?.rerankScore, `${localeFile.locale}.json needs ragWorkbench.rerankScore`);
    assert.ok(locale.ragWorkbench?.loadFailed, `${localeFile.locale}.json needs ragWorkbench.loadFailed`);
  }
});

test('RAG graph explorer is routed, reachable from navigation, and localized', () => {
  assert.ok(graphExplorerPageSource, 'GraphExplorer.tsx should exist');
  assert.match(appSource, /const GraphExplorerPage = lazy\(\(\) => import\('\.\/pages\/GraphExplorer'\)\)/);
  assert.match(appSource, /<Route path="\/rag-graph" element=\{<GraphExplorerPage \/>\} \/>/);
  assert.match(mainLayoutSource, /sidebar\.graphExplorer/);
  assert.match(mainLayoutSource, /navigate\('\/rag-graph'\)/);
  assert.match(graphExplorerPageSource, /api\.post(?:<[^>]+>)?\('\/rag-workbench\/graph\/search'/);
  assert.match(graphExplorerPageSource, /graphExplorer\.title/);
  assert.match(graphExplorerPageSource, /graphExplorer\.queryLabel/);
  assert.match(graphExplorerPageSource, /graphExplorer\.search/);
  assert.match(graphExplorerPageSource, /graphExplorer\.chunkLimit/);
  assert.match(graphExplorerPageSource, /graphExplorer\.visibleGraphStats/);
  assert.match(graphExplorerPageSource, /graph_entities/);
  assert.match(graphExplorerPageSource, /graph_relations/);
  assert.match(graphExplorerPageSource, /relationTypes/);
  assert.match(graphExplorerPageSource, /project_space_id/);
  assert.match(graphExplorerPageSource, /URLSearchParams\(window\.location\.search\)/);
  assert.match(graphExplorerPageSource, /hasAutoRunFromUrl/);

  for (const localeFile of localeFiles) {
    const locale = readLocale(localeFile);

    assert.ok(locale.sidebar?.graphExplorer, `${localeFile.locale}.json needs sidebar.graphExplorer`);
    assert.ok(locale.graphExplorer?.title, `${localeFile.locale}.json needs graphExplorer.title`);
    assert.ok(locale.graphExplorer?.subtitle, `${localeFile.locale}.json needs graphExplorer.subtitle`);
    assert.ok(locale.graphExplorer?.queryLabel, `${localeFile.locale}.json needs graphExplorer.queryLabel`);
    assert.ok(locale.graphExplorer?.search, `${localeFile.locale}.json needs graphExplorer.search`);
    assert.ok(locale.graphExplorer?.chunkLimit, `${localeFile.locale}.json needs graphExplorer.chunkLimit`);
    assert.ok(locale.graphExplorer?.chunkLimitHint, `${localeFile.locale}.json needs graphExplorer.chunkLimitHint`);
    assert.ok(locale.graphExplorer?.visibleGraphStats, `${localeFile.locale}.json needs graphExplorer.visibleGraphStats`);
    assert.ok(locale.graphExplorer?.relationTypes?.dependsOn, `${localeFile.locale}.json needs graphExplorer.relationTypes.dependsOn`);
    assert.ok(locale.graphExplorer?.relationTypes?.conflictsWith, `${localeFile.locale}.json needs graphExplorer.relationTypes.conflictsWith`);
    assert.ok(locale.graphExplorer?.relationTypes?.supports, `${localeFile.locale}.json needs graphExplorer.relationTypes.supports`);
    assert.ok(locale.graphExplorer?.loadFailed, `${localeFile.locale}.json needs graphExplorer.loadFailed`);
    assert.equal(
      /例如|JSBridge|such as/i.test(locale.graphExplorer?.queryPlaceholder || ''),
      false,
      `${localeFile.locale}.json graphExplorer.queryPlaceholder should not include domain-specific examples`,
    );
  }
});

test('RAG evaluation keeps dense history and benchmark content behind modals', () => {
  assert.match(ragEvaluationPageSource, /isHistoryBrowserOpen/);
  assert.match(ragEvaluationPageSource, /setIsHistoryBrowserOpen\(true\)/);
  assert.match(ragEvaluationPageSource, /isBenchmarkModalOpen/);
  assert.match(ragEvaluationPageSource, /setIsBenchmarkModalOpen\(true\)/);
  assert.match(ragEvaluationPageSource, /title=\{t\('ragEval\.historyTitle'\)\}/);
  assert.match(ragEvaluationPageSource, /title=\{t\('ragEval\.benchmarkTitle'\)\}/);
  assert.match(ragEvaluationPageSource, /ragEval\.historySummary/);
  assert.match(ragEvaluationPageSource, /ragEval\.benchmarkSummary/);
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
  assert.match(chatSettingsSource, /api\.get(?:<[^>]+>)?<ProviderHealthResponse>\('\/usage\/provider-health'\)/);
  assert.match(chatSettingsSource, /providerHealth/);
  assert.match(chatSettingsSource, /providerHealth\?\.default_model/);
  assert.match(chatSettingsSource, /moonshot-v1-8k/);
  assert.match(chatSettingsSource, /settings\.providerHealth/);
  assert.match(chatSettingsSource, /settings\.providerUnavailable/);
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
    assert.ok(locale.settings?.providerHealth, `${localeFile.locale}.json needs settings.providerHealth`);
    assert.ok(locale.settings?.providerUnavailable, `${localeFile.locale}.json needs settings.providerUnavailable`);
    assert.ok(locale.settings?.providerHealthLoadFailed, `${localeFile.locale}.json needs settings.providerHealthLoadFailed`);
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
  assert.match(chatMessageSource, /chat\.ragRetrievalFailed/);
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
    assert.ok(locale.chat?.ragRetrievalFailed, `${localeFile.locale}.json needs chat.ragRetrievalFailed`);
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

test('RAG trace steps use readable localized labels instead of internal step ids', () => {
  assert.ok(existsSync(ragTraceLabelsPath), 'ragTraceLabels.ts should define user-facing trace labels');
  assert.match(ragTraceLabelsSource, /getRagTraceStepLabel/);
  assert.match(ragTraceLabelsSource, /getRagTraceStatusLabel/);

  const traceConsumers = [
    ['ChatMessage.tsx', chatMessageSource],
    ['Usage.tsx', usagePageSource],
    ['RetrievalLab.tsx', retrievalLabPageSource],
    ['RagEvaluation.tsx', ragEvaluationPageSource],
  ];

  for (const [filename, source] of traceConsumers) {
    assert.match(source, /getRagTraceStepLabel\(t, step\.step_type\)/, `${filename} should translate trace step ids`);
    assert.match(source, /getRagTraceStatusLabel\(t, step\.status\)/, `${filename} should translate trace statuses`);
    assert.doesNotMatch(source, />\{step\.step_type\}/, `${filename} should not render raw step ids`);
    assert.doesNotMatch(source, /\{step\.step_type \|\| t\('ragEval\.traceStep'\)\}/, `${filename} should not use raw step ids as fallback labels`);
  }

  for (const localeFile of localeFiles) {
    const locale = readLocale(localeFile);

    assert.ok(locale.ragTrace?.steps?.intent_route, `${localeFile.locale}.json needs ragTrace.steps.intent_route`);
    assert.ok(locale.ragTrace?.steps?.metadata_lookup, `${localeFile.locale}.json needs ragTrace.steps.metadata_lookup`);
    assert.ok(locale.ragTrace?.steps?.question_classify, `${localeFile.locale}.json needs ragTrace.steps.question_classify`);
    assert.ok(locale.ragTrace?.steps?.retriever_route, `${localeFile.locale}.json needs ragTrace.steps.retriever_route`);
    assert.ok(locale.ragTrace?.steps?.query_rewrite, `${localeFile.locale}.json needs ragTrace.steps.query_rewrite`);
    assert.ok(locale.ragTrace?.steps?.retrieve, `${localeFile.locale}.json needs ragTrace.steps.retrieve`);
    assert.ok(locale.ragTrace?.steps?.retrieve_retry, `${localeFile.locale}.json needs ragTrace.steps.retrieve_retry`);
    assert.ok(locale.ragTrace?.steps?.rerank, `${localeFile.locale}.json needs ragTrace.steps.rerank`);
    assert.ok(locale.ragTrace?.steps?.evidence_check, `${localeFile.locale}.json needs ragTrace.steps.evidence_check`);
    assert.ok(locale.ragTrace?.steps?.unknown, `${localeFile.locale}.json needs ragTrace.steps.unknown`);
    assert.ok(locale.ragTrace?.statuses?.success, `${localeFile.locale}.json needs ragTrace.statuses.success`);
    assert.ok(locale.ragTrace?.statuses?.partial, `${localeFile.locale}.json needs ragTrace.statuses.partial`);
    assert.ok(locale.ragTrace?.statuses?.failed, `${localeFile.locale}.json needs ragTrace.statuses.failed`);
    assert.ok(locale.ragTrace?.statuses?.unknown, `${localeFile.locale}.json needs ragTrace.statuses.unknown`);
  }
});

test('knowledge graph result limit controls visible node budget with clear copy', () => {
  assert.match(graphExplorerPageSource, /getMaxEntityNodes/);
  assert.match(graphExplorerPageSource, /getMaxEntityNodes\(resultLimit\)/);
  assert.match(graphExplorerPageSource, /buildGraphViewData\(\s*results,\s*\{/);
  assert.match(graphExplorerPageSource, /,\s*limit\s*\)/);
  assert.match(graphExplorerPageSource, /graphExplorer\.chunkLimit/);
  assert.match(graphExplorerPageSource, /graphExplorer\.chunkLimitHint/);
  assert.equal(
    graphExplorerPageSource.includes('const MAX_ENTITY_NODES = 16;'),
    false,
    'graph should not keep a fixed 16-node cap when the user changes the result count',
  );
});

test('RAG evaluation details show readable source names and colored status badges', () => {
  assert.match(ragEvaluationPageSource, /getEvidenceStatusClass/);
  assert.match(ragEvaluationPageSource, /getResultStatusClass/);
  assert.match(ragEvaluationPageSource, /getEvidenceLabel\(result\.evidence_label\)/);
  assert.match(ragEvaluationPageSource, /className=\{`[^`]*getEvidenceStatusClass\(result\.evidence_label\)/);
  assert.match(ragEvaluationPageSource, /className=\{`[^`]*getResultStatusClass\(result\.status\)/);
  assert.match(ragEvaluationPageSource, /source_recall_score/);
  assert.match(ragEvaluationPageSource, /source_precision_score/);
  assert.match(ragEvaluationPageSource, /citation_accuracy_score/);
  assert.match(ragEvaluationPageSource, /grounding_score/);
  assert.match(ragEvaluationPageSource, /break-words text-text-main/);
  assert.equal(
    ragEvaluationPageSource.includes('<div className="truncate text-text-main">'),
    false,
    'RAG evaluation matched source filenames should wrap instead of being truncated',
  );
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
