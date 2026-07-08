import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');

const readSource = (relativePath) => readFileSync(path.join(serverRoot, relativePath), 'utf8');
const readOptionalSource = (relativePath) => {
  const fullPath = path.join(serverRoot, relativePath);
  return existsSync(fullPath) ? readFileSync(fullPath, 'utf8') : '';
};

test('persona center migration stores editable profiles, evidence, interests, and suggestions', () => {
  const migrationSource = readOptionalSource('migrations/0022_user_persona_center.sql');

  assert.match(migrationSource, /create table if not exists user_personas/i);
  assert.match(migrationSource, /user_id uuid not null references users\(id\) on delete cascade/i);
  assert.match(migrationSource, /memory_enabled boolean not null default true/i);
  assert.match(migrationSource, /updated_by_user_at timestamptz/i);
  assert.match(migrationSource, /create table if not exists user_persona_observations/i);
  assert.match(migrationSource, /evidence_message_ids uuid\[\] not null default '\{\}'::uuid\[\]/i);
  assert.match(migrationSource, /constraint user_persona_observations_status_check/i);
  assert.match(migrationSource, /create table if not exists user_interest_topics/i);
  assert.match(migrationSource, /create table if not exists user_question_suggestions/i);
  assert.match(migrationSource, /create table if not exists user_persona_audit_events/i);
  assert.match(migrationSource, /user_interest_topics_user_score_idx/i);
  assert.match(migrationSource, /user_question_suggestions_user_status_idx/i);
});

test('persona center exposes authenticated profile, analysis, edit, hide, and reset routes', () => {
  const indexSource = readSource('src/index.ts');
  const routesSource = readOptionalSource('src/routes/persona.ts');
  const controllerSource = readOptionalSource('src/controllers/persona.ts');
  const repositorySource = readOptionalSource('src/repositories/persona.ts');

  assert.match(indexSource, /personaRoutes/);
  assert.match(indexSource, /app\.use\('\/api\/persona', createRateLimit\(/);
  assert.match(indexSource, /keyPrefix:\s*'persona'/);
  assert.match(routesSource, /router\.get\('\/', requireAuth, getPersonaCenter\)/);
  assert.match(routesSource, /router\.post\('\/analyze', requireAuth, analyzePersonaCenter\)/);
  assert.match(routesSource, /router\.patch\('\/profile', requireAuth, updatePersonaProfile\)/);
  assert.match(routesSource, /router\.patch\('\/interests\/:interestId', requireAuth, updatePersonaInterest\)/);
  assert.match(routesSource, /router\.patch\('\/suggestions\/:suggestionId', requireAuth, updatePersonaSuggestion\)/);
  assert.match(routesSource, /router\.post\('\/reset', requireAuth, resetPersonaCenter\)/);

  assert.match(controllerSource, /getPersonaCenterForUser\(req\.user\.id\)/);
  assert.match(controllerSource, /refreshPersonaInsightsForUser\(req\.user\.id\)/);
  assert.match(controllerSource, /updatePersonaProfileForUser\(req\.user\.id/);
  assert.match(controllerSource, /updatePersonaInterestStatusForUser\(req\.user\.id/);
  assert.match(controllerSource, /updatePersonaSuggestionStatusForUser\(req\.user\.id/);
  assert.match(controllerSource, /resetPersonaCenterForUser\(req\.user\.id\)/);

  assert.match(repositorySource, /listRecentUserMessagesForPersona/);
  assert.match(repositorySource, /where c\.user_id = \$1/i);
  assert.match(repositorySource, /m\.role = 'user'/i);
  assert.match(repositorySource, /upsertPersonaProfileForUser/);
  assert.match(repositorySource, /updated_by_user_at is null/i);
});

test('persona analyzer extracts non-sensitive interests and next-question suggestions from chat history', () => {
  const {
    analyzePersonaSignals,
    mergePersonaProfile,
    buildPersonalizedSystemPrompt,
  } = require(path.join(serverRoot, 'dist', 'lib', 'personaInsights.js'));

  const result = analyzePersonaSignals([
    {
      id: '11111111-1111-1111-1111-111111111111',
      content: '我想把 ChatLLM 的 Agentic RAG、Milvus、ES BM25、RAG 测评和 trace 机制做成项目亮点。',
      created_at: '2026-07-08T10:00:00.000Z',
    },
    {
      id: '22222222-2222-2222-2222-222222222222',
      content: '这个项目要能抗住企业级高并发和超大文件上传，分片上传、MinIO、队列和兜底策略都要专业。',
      created_at: '2026-07-08T11:00:00.000Z',
    },
    {
      id: '33333333-3333-3333-3333-333333333333',
      content: '界面布局太难看了，i18n、弹窗、Playwright 测试都要补齐。',
      created_at: '2026-07-08T12:00:00.000Z',
    },
    {
      id: '44444444-4444-4444-4444-444444444444',
      content: '我不希望系统推断我的健康、宗教、政治这些敏感信息。',
      created_at: '2026-07-08T13:00:00.000Z',
    },
  ]);

  assert.equal(result.profile.role_label, 'AI 应用项目开发者');
  assert.match(result.profile.summary, /Agentic RAG/);
  assert.ok(result.profile.goals.some((goal) => goal.includes('企业级')));
  assert.ok(result.profile.preferences.some((preference) => preference.includes('可验证')));
  assert.ok(result.interests.some((interest) => interest.topic === 'Agentic RAG 与知识检索'));
  assert.ok(result.interests.some((interest) => interest.topic === '企业级稳定性与大文件上传'));
  assert.ok(result.suggestions.some((suggestion) => suggestion.question.includes('Agentic RAG')));
  assert.ok(result.observations.every((observation) => !/健康|宗教|政治/.test(observation.detail)));

  const preserved = mergePersonaProfile(
    {
      summary: '用户手动写下的个人定位',
      role_label: '后端工程师',
      goals: ['保留我自己的目标'],
      preferences: ['保留我自己的偏好'],
      avoided_topics: ['不要推荐音频功能'],
      memory_enabled: true,
      updated_by_user_at: '2026-07-08T14:00:00.000Z',
    },
    result.profile
  );
  assert.equal(preserved.summary, '用户手动写下的个人定位');
  assert.deepEqual(preserved.goals, ['保留我自己的目标']);

  const systemPrompt = buildPersonalizedSystemPrompt('You are helpful.', preserved);
  assert.match(systemPrompt, /User profile/);
  assert.match(systemPrompt, /用户手动写下的个人定位/);
  assert.doesNotMatch(buildPersonalizedSystemPrompt('You are helpful.', { ...preserved, memory_enabled: false }), /User profile/);
});
