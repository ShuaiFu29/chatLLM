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

test('persona evidence migration clears legacy active generated rows without deleting user-confirmed choices', () => {
  const migrationSource = readOptionalSource('migrations/0023_persona_evidence_refresh.sql');

  assert.match(migrationSource, /delete from user_question_suggestions\s+where status = 'active'/i);
  assert.match(migrationSource, /delete from user_interest_topics\s+where status = 'active'/i);
  assert.match(migrationSource, /delete from user_persona_observations\s+where status = 'active'/i);
  assert.match(migrationSource, /where updated_by_user_at is null/i);
  assert.match(migrationSource, /summary = ''/i);
  assert.match(migrationSource, /goals = '\{\}'::text\[\]/i);
  assert.match(migrationSource, /avoided_topics = '\{\}'::text\[\]/i);
});

test('persona center exposes authenticated profile, analysis, edit, hide, and reset routes', () => {
  const nestControllerSource = readSource('src/modules/persona/persona.controller.ts');
  const moduleSource = readSource('src/modules/persona/persona.module.ts');
  const serviceSource = readSource('src/modules/persona/persona.service.ts');
  const repositorySource = readOptionalSource('src/repositories/persona.ts');

  assert.match(nestControllerSource, /@Controller\('persona'\)/);
  assert.match(nestControllerSource, /@UseGuards\(AuthGuard\)/);
  assert.match(nestControllerSource, /@RateLimitScope\(\{[\s\S]*?keyPrefix:\s*'persona',[\s\S]*?max:\s*serverEnv\.RATE_LIMIT_MAX/);
  assert.match(nestControllerSource, /constructor\(private readonly personaService: PersonaService\)/);
  assert.match(nestControllerSource, /@Get\(\)[\s\S]*?@CurrentUser\(\)[\s\S]*?this\.personaService\.get\(user\.id, requestId\)/);
  assert.match(nestControllerSource, /@Post\('analyze'\)[\s\S]*?@ValidateMutation\(mutationSchemas\.personaAnalyze\)[\s\S]*?this\.personaService\.analyze\(user\.id, requestId\)/);
  assert.match(nestControllerSource, /@Patch\('profile'\)[\s\S]*?@ValidateMutation\(mutationSchemas\.personaUpdateProfile\)[\s\S]*?@Body\(\)[\s\S]*?this\.personaService\.updateProfile\(user\.id, body, requestId\)/);
  assert.match(nestControllerSource, /@Delete\('profile'\)[\s\S]*?@ValidateMutation\(mutationSchemas\.personaDeleteProfile\)[\s\S]*?this\.personaService\.deleteProfile\(user\.id, requestId\)/);
  assert.match(nestControllerSource, /@Patch\('interests\/:interestId'\)[\s\S]*?@Param\('interestId'\)[\s\S]*?this\.personaService\.updateInterest\(user\.id, interestId, status, requestId\)/);
  assert.match(nestControllerSource, /@Delete\('interests\/:interestId'\)[\s\S]*?this\.personaService\.deleteInterest\(user\.id, interestId, requestId\)/);
  assert.match(nestControllerSource, /@Patch\('observations\/:observationId'\)[\s\S]*?this\.personaService\.updateObservation\(user\.id, observationId, status, requestId\)/);
  assert.match(nestControllerSource, /@Delete\('observations\/:observationId'\)[\s\S]*?this\.personaService\.deleteObservation\(user\.id, observationId, requestId\)/);
  assert.match(nestControllerSource, /@Patch\('suggestions\/:suggestionId'\)[\s\S]*?this\.personaService\.updateSuggestion\(user\.id, suggestionId, status, requestId\)/);
  assert.match(nestControllerSource, /@Delete\('suggestions\/:suggestionId'\)[\s\S]*?this\.personaService\.deleteSuggestion\(user\.id, suggestionId, requestId\)/);
  assert.match(nestControllerSource, /@Post\('reset'\)[\s\S]*?this\.personaService\.reset\(user\.id, requestId\)/);
  assert.doesNotMatch(nestControllerSource, /@Res\(|@Req\(|AppReply|AppRequest/);
  assert.match(moduleSource, /providers:\s*\[AuthGuard, PersonaService\]/);
  assert.equal(existsSync(path.join(serverRoot, 'src/controllers/persona.ts')), false);

  assert.match(serviceSource, /@Injectable\(\)/);
  assert.match(serviceSource, /getPersonaCenterForUser\(userId\)/);
  assert.match(serviceSource, /refreshPersonaInsightsForUser\(userId\)/);
  assert.match(serviceSource, /updatePersonaProfileForUser\(userId/);
  assert.match(serviceSource, /updatePersonaInterestStatusForUser\([\s\S]*?userId/);
  assert.match(serviceSource, /updatePersonaObservationStatusForUser\([\s\S]*?userId/);
  assert.match(serviceSource, /updatePersonaSuggestionStatusForUser\([\s\S]*?userId/);
  assert.match(serviceSource, /deletePersonaProfileForUser\(userId\)/);
  assert.match(serviceSource, /deletePersonaInterestForUser\(userId, interestId\)/);
  assert.match(serviceSource, /deletePersonaObservationForUser\(userId, observationId\)/);
  assert.match(serviceSource, /deletePersonaSuggestionForUser\(userId, suggestionId\)/);
  assert.match(serviceSource, /resetPersonaCenterForUser\(userId\)/);
  assert.doesNotMatch(serviceSource, /AppReply|AppRequest|res\.code|res\.send/);

  assert.match(repositorySource, /listRecentUserMessagesForPersona/);
  assert.match(repositorySource, /where c\.user_id = \$1/i);
  assert.match(repositorySource, /m\.role = 'user'/i);
  assert.match(repositorySource, /upsertPersonaProfileForUser/);
  assert.match(repositorySource, /updated_by_user_at is null/i);
});

test('persona native Nest controller forwards validated values and preserves public 400 errors', async () => {
  const { PersonaController } = require(path.join(
    serverRoot,
    'dist',
    'modules',
    'persona',
    'persona.controller.js',
  ));
  const { PersonaService } = require(path.join(
    serverRoot,
    'dist',
    'modules',
    'persona',
    'persona.service.js',
  ));
  const expected = { id: 'interest-one', status: 'hidden' };
  const calls = [];
  const controller = new PersonaController({
    updateInterest: async (...args) => {
      calls.push(args);
      return expected;
    },
  });

  const result = await controller.updateInterest(
    { id: 'user-one' },
    'interest-one',
    'hidden',
    'request-one',
  );
  assert.equal(result, expected);
  assert.deepEqual(calls, [[
    'user-one',
    'interest-one',
    'hidden',
    'request-one',
  ]]);

  const service = new PersonaService();
  await assert.rejects(
    service.updateProfile('user-one', {}, 'request-one'),
    (error) => {
      assert.equal(error.getStatus(), 400);
      assert.deepEqual(error.getResponse(), { error: 'No fields to update' });
      return true;
    },
  );
  await assert.rejects(
    service.updateInterest('user-one', 'interest-one', 'unsupported', 'request-one'),
    (error) => {
      assert.equal(error.getStatus(), 400);
      assert.deepEqual(error.getResponse(), { error: 'Invalid interest status' });
      return true;
    },
  );
});

test('persona center exposes hidden records for review restore and deletion', () => {
  const repositorySource = readOptionalSource('src/repositories/persona.ts');
  const migrationSource = readOptionalSource('migrations/0024_persona_hidden_records.sql');

  assert.match(repositorySource, /hidden:\s*\{/);
  assert.match(repositorySource, /status = 'hidden'/);
  assert.match(repositorySource, /updatePersonaObservationStatusForUser/);
  assert.match(repositorySource, /deletePersonaObservationForUser/);
  assert.match(repositorySource, /deletePersonaInterestForUser/);
  assert.match(repositorySource, /deletePersonaSuggestionForUser/);
  assert.match(repositorySource, /set status = 'rejected'/);
  assert.match(repositorySource, /deletePersonaProfileForUser/);
  assert.match(repositorySource, /delete from user_question_suggestions where user_id = \$1/);
  assert.match(repositorySource, /delete from user_interest_topics where user_id = \$1/);
  assert.match(repositorySource, /delete from user_persona_observations where user_id = \$1/);

  assert.match(migrationSource, /drop constraint if exists user_question_suggestions_status_check/i);
  assert.match(migrationSource, /'rejected'/i);
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
      id: '11111111-1111-1111-1111-111111111112',
      content: 'RAG 检索、引用、召回和知识图谱这些链路需要继续形成稳定的项目能力。',
      created_at: '2026-07-08T10:30:00.000Z',
    },
    {
      id: '22222222-2222-2222-2222-222222222222',
      content: '这个项目要能抗住企业级高并发和超大文件上传，分片上传、MinIO、队列和兜底策略都要专业。',
      created_at: '2026-07-08T11:00:00.000Z',
    },
    {
      id: '22222222-2222-2222-2222-222222222223',
      content: '后端限流、worker、Redis、Postgres 和异步队列都要考虑稳定性。',
      created_at: '2026-07-08T11:30:00.000Z',
    },
    {
      id: '33333333-3333-3333-3333-333333333333',
      content: '界面布局太难看了，i18n、弹窗、Playwright 测试都要补齐。',
      created_at: '2026-07-08T12:00:00.000Z',
    },
    {
      id: '33333333-3333-3333-3333-333333333334',
      content: 'UI 交互、按钮和页面渲染也要继续打磨。',
      created_at: '2026-07-08T12:30:00.000Z',
    },
    {
      id: '44444444-4444-4444-4444-444444444444',
      content: '我不希望系统推断我的健康、宗教、政治这些敏感信息。',
      created_at: '2026-07-08T13:00:00.000Z',
    },
  ]);

  assert.match(result.profile.role_label, /AI 应用/);
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

test('manual persona edits can intentionally clear generated fields without being refilled', () => {
  const { mergePersonaProfile } = require(path.join(serverRoot, 'dist', 'lib', 'personaInsights.js'));

  const generated = {
    summary: '系统生成的一句话定位',
    role_label: 'AI 应用项目开发者',
    goals: ['系统生成目标'],
    preferences: ['系统生成偏好'],
    avoided_topics: ['系统生成规避项'],
    memory_enabled: true,
  };

  const merged = mergePersonaProfile(
    {
      summary: '',
      role_label: '',
      goals: [],
      preferences: [],
      avoided_topics: [],
      memory_enabled: true,
      updated_by_user_at: '2026-07-08T19:00:00.000Z',
    },
    generated
  );

  assert.equal(merged.summary, '');
  assert.equal(merged.role_label, '');
  assert.deepEqual(merged.goals, []);
  assert.deepEqual(merged.preferences, []);
  assert.deepEqual(merged.avoided_topics, []);
});

test('manual persona prompt still uses edited fields when summary is intentionally empty', () => {
  const { buildPersonalizedSystemPrompt } = require(path.join(serverRoot, 'dist', 'lib', 'personaInsights.js'));

  const manualProfile = {
    summary: '',
    role_label: '后端工程师',
    goals: ['排查项目稳定性问题'],
    preferences: ['回答更直接，先说结论'],
    avoided_topics: [],
    memory_enabled: true,
    updated_by_user_at: '2026-07-08T20:00:00.000Z',
  };

  const systemPrompt = buildPersonalizedSystemPrompt('You are helpful.', manualProfile);
  assert.match(systemPrompt, /User profile/);
  assert.match(systemPrompt, /后端工程师/);
  assert.match(systemPrompt, /回答更直接/);

  const generatedEmptyProfile = {
    summary: '',
    role_label: '',
    goals: [],
    preferences: [],
    avoided_topics: ['不要自动推断敏感身份信息'],
    memory_enabled: true,
  };
  assert.doesNotMatch(buildPersonalizedSystemPrompt('You are helpful.', generatedEmptyProfile), /User profile/);
});

test('persona analyzer does not infer a persona from weak or isolated keywords', () => {
  const { analyzePersonaSignals, buildPersonalizedSystemPrompt } = require(path.join(serverRoot, 'dist', 'lib', 'personaInsights.js'));

  const result = analyzePersonaSignals([
    {
      id: '55555555-5555-5555-5555-555555555555',
      content: '知识库按钮这里有点大，页面布局再收一下。',
      created_at: '2026-07-08T15:00:00.000Z',
    },
  ]);

  assert.equal(result.profile.summary, '');
  assert.equal(result.profile.role_label, '');
  assert.deepEqual(result.profile.goals, []);
  assert.deepEqual(result.profile.preferences, []);
  assert.deepEqual(result.interests, []);
  assert.deepEqual(result.observations, []);
  assert.deepEqual(result.suggestions, []);
  assert.doesNotMatch(buildPersonalizedSystemPrompt('You are helpful.', result.profile), /User profile/);
});

test('persona analyzer requires repeated explicit evidence before generating RAG interests', () => {
  const { analyzePersonaSignals } = require(path.join(serverRoot, 'dist', 'lib', 'personaInsights.js'));

  const weak = analyzePersonaSignals([
    {
      id: '66666666-6666-6666-6666-666666666666',
      content: 'RAG 这个词在页面上是不是太显眼了？',
      created_at: '2026-07-08T16:00:00.000Z',
    },
  ]);

  assert.equal(
    weak.interests.some((interest) => interest.topic === 'Agentic RAG 与知识检索'),
    false,
    'single weak RAG mention should not become a stable inferred interest',
  );

  const strong = analyzePersonaSignals([
    {
      id: '77777777-7777-7777-7777-777777777777',
      content: '我想升级 Agentic RAG，重点看 RAG 检索、引用、trace 和测评。',
      created_at: '2026-07-08T17:00:00.000Z',
    },
    {
      id: '88888888-8888-8888-8888-888888888888',
      content: '知识图谱、Milvus、embedding、rerank、召回这些 RAG 链路也要继续优化。',
      created_at: '2026-07-08T18:00:00.000Z',
    },
  ]);

  assert.ok(strong.interests.some((interest) => interest.topic === 'Agentic RAG 与知识检索'));
  assert.ok(strong.suggestions.some((suggestion) => suggestion.question.includes('Agentic RAG')));
});

test('persona refresh clears stale generated insights before inserting new evidence-backed rows', () => {
  const repositorySource = readOptionalSource('src/repositories/persona.ts');

  assert.match(repositorySource, /delete from user_persona_observations\s+where user_id = \$1\s+and status = 'active'/i);
  assert.match(repositorySource, /delete from user_interest_topics\s+where user_id = \$1\s+and status = 'active'/i);
  assert.match(repositorySource, /delete from user_question_suggestions\s+where user_id = \$1\s+and status = 'active'/i);
});

test('persona refresh serializes per-user analysis to avoid concurrent active-row replacement races', () => {
  const repositorySource = readOptionalSource('src/repositories/persona.ts');

  assert.match(repositorySource, /pg_advisory_xact_lock\(hashtext\(\$1\)\)/);
  assert.match(repositorySource, /persona-refresh:\$\{userId\}/);
  assert.match(repositorySource, /listRecentUserMessagesForPersonaInTransaction\(client, userId, 100\)/);
});

test('persona center returns scoped evidence snippets so users can verify inferred content', () => {
  const repositorySource = readOptionalSource('src/repositories/persona.ts');

  assert.match(repositorySource, /interface PersonaEvidenceMessage/);
  assert.match(repositorySource, /evidence_messages\?: PersonaEvidenceMessage\[\]/);
  assert.match(repositorySource, /loadEvidenceMessagesForUser/);
  assert.match(repositorySource, /m\.id = any\(\$2::uuid\[\]\)/i);
  assert.match(repositorySource, /c\.user_id = \$1/i);
  assert.match(repositorySource, /attachEvidenceMessages/);
});

test('persona center does not serve generated insights when personalized memory is disabled', () => {
  const repositorySource = readOptionalSource('src/repositories/persona.ts');

  assert.match(repositorySource, /if \(!profile\.memory_enabled\)/);
  assert.match(repositorySource, /observations:\s*\[\]/);
  assert.match(repositorySource, /interests:\s*\[\]/);
  assert.match(repositorySource, /suggestions:\s*\[\]/);
});
