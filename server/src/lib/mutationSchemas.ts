import { z } from 'zod';
import { MAX_CHAT_MESSAGE_CONTENT_LENGTH } from './chatInput';
import { agentMemoryPolicySchema } from './agentMemoryPolicy';
import { agentDelegationBindingsSchema } from './agentDelegation';
import {
  MAX_MULTIPART_PRESIGN_PARTS,
  MAX_MULTIPART_UPLOAD_PARTS,
  MAX_UPLOAD_CHUNKS,
} from './uploadInput';
import { MutationSchema } from './validation';

type AliasPair = readonly [canonical: string, legacy: string];

const strictObject = <Shape extends z.ZodRawShape>(shape: Shape) => z.object(shape).strict();

const strictBody = <Shape extends z.ZodRawShape>(
  shape: Shape,
  options: { aliases?: readonly AliasPair[]; requireAtLeastOne?: boolean } = {}
) => strictObject(shape).superRefine((value, context) => {
  const input = value as Record<string, unknown>;
  for (const [canonical, legacy] of options.aliases || []) {
    if (input[canonical] !== undefined && input[legacy] !== undefined) {
      context.addIssue({
        code: 'custom',
        path: [legacy],
        message: `Use either ${canonical} or ${legacy}, not both`,
      });
    }
  }

  if (options.requireAtLeastOne && !Object.values(input).some((item) => item !== undefined)) {
    context.addIssue({
      code: 'custom',
      message: 'At least one field is required',
    });
  }
});

const emptyBody = strictObject({});
const uuid = z.string().trim().uuid();
const optionalProjectSpaceId = z.union([uuid, z.literal(''), z.null()]).optional();
const sha256 = z.string().trim().regex(/^[a-fA-F0-9]{64}$/);
const optionalText = (maxLength: number) => z.string().trim().max(maxLength).optional();
const requiredText = (maxLength: number) => z.string().trim().min(1).max(maxLength);
const optionalRequiredText = (maxLength: number) => requiredText(maxLength).optional();
const finiteNumber = z.number().finite();
const projectSpaceAliases = [['project_space_id', 'projectSpaceId']] as const;

const authEmail = z.string().trim().toLowerCase().min(3).max(320).email();
const authPassword = z.string().min(8).max(128);
const rememberMe = z.boolean().default(false);

const authRegisterBody = strictBody({
  email: authEmail,
  password: authPassword,
  displayName: requiredText(120),
  rememberMe,
});

const authLoginBody = strictBody({
  email: authEmail,
  password: authPassword,
  rememberMe,
});

const conversationIdParams = strictObject({ conversationId: uuid });
const messageIdParams = strictObject({ messageId: uuid });
const conversationMessageIdParams = strictObject({ conversationId: uuid, messageId: uuid });
const interestIdParams = strictObject({ interestId: uuid });
const observationIdParams = strictObject({ observationId: uuid });
const suggestionIdParams = strictObject({ suggestionId: uuid });
const projectSpaceIdParams = strictObject({ projectSpaceId: uuid });
const templateIdParams = strictObject({ templateId: uuid });
const agentIdParams = strictObject({ agentId: uuid });
const agentVersionIdParams = strictObject({ agentId: uuid, versionId: uuid });
const agentToolIdParams = strictObject({ toolId: uuid });
const agentRunIdParams = strictObject({ runId: uuid });
const agentRunApprovalParams = strictObject({ runId: uuid, approvalId: uuid });
const datasetIdParams = strictObject({ datasetId: uuid });
const runIdParams = strictObject({ runId: uuid });
const caseIdParams = strictObject({ caseId: uuid });
const fileIdParams = strictObject({ id: uuid });

const userSettings = strictObject({
  model: optionalRequiredText(120),
  temperature: finiteNumber.min(0).max(2).optional(),
  system_prompt: optionalText(MAX_CHAT_MESSAGE_CONTENT_LENGTH),
});

const authUpdateProfileBody = strictBody({
  display_name: optionalText(120),
  avatar_url: optionalText(2048),
  settings: userSettings.optional(),
}, { requireAtLeastOne: true });

const chatCreateConversationBody = strictBody({
  title: optionalText(200),
  project_space_id: optionalProjectSpaceId,
  projectSpaceId: optionalProjectSpaceId,
  agent_id: z.union([uuid, z.literal(''), z.null()]).optional(),
}, { aliases: projectSpaceAliases });

const chatBranchConversationBody = strictBody({
  messageId: uuid.optional(),
  title: optionalText(200),
});

const chatUpdateConversationBody = strictBody({
  title: optionalRequiredText(200),
  model: optionalRequiredText(120),
  temperature: finiteNumber.min(0).max(2).optional(),
  system_prompt: optionalText(MAX_CHAT_MESSAGE_CONTENT_LENGTH),
  enable_rag: z.boolean().optional(),
  is_pinned: z.boolean().optional(),
  archived: z.boolean().optional(),
  is_favorite: z.boolean().optional(),
  tags: z.array(requiredText(64)).max(12).optional(),
  note: optionalText(2000),
  project_space_id: optionalProjectSpaceId,
  projectSpaceId: optionalProjectSpaceId,
  agent_id: z.union([uuid, z.literal(''), z.null()]).optional(),
}, { aliases: projectSpaceAliases, requireAtLeastOne: true });

const personaUpdateProfileBody = strictBody({
  summary: optionalText(1200),
  role_label: optionalText(120),
  roleLabel: optionalText(120),
  goals: z.array(requiredText(160)).max(12).optional(),
  preferences: z.array(requiredText(180)).max(12).optional(),
  avoided_topics: z.array(requiredText(180)).max(12).optional(),
  avoidedTopics: z.array(requiredText(180)).max(12).optional(),
  memory_enabled: z.boolean().optional(),
  memoryEnabled: z.boolean().optional(),
}, {
  aliases: [
    ['role_label', 'roleLabel'],
    ['avoided_topics', 'avoidedTopics'],
    ['memory_enabled', 'memoryEnabled'],
  ],
  requireAtLeastOne: true,
});

const personaRecordStatusBody = strictBody({
  status: z.enum(['active', 'accepted', 'hidden', 'rejected']),
});

const personaSuggestionStatusBody = strictBody({
  status: z.enum(['active', 'hidden', 'used', 'rejected']),
});

const projectSpaceCreateBody = strictBody({
  name: requiredText(80),
  description: optionalText(500),
});

const projectSpaceUpdateBody = strictBody({
  name: optionalRequiredText(80),
  description: optionalText(500),
}, { requireAtLeastOne: true });

const promptTemplateCreateBody = strictBody({
  name: requiredText(120),
  content: requiredText(8000),
  description: optionalText(500),
  project_space_id: optionalProjectSpaceId,
  projectSpaceId: optionalProjectSpaceId,
  is_default: z.boolean().optional(),
  isDefault: z.boolean().optional(),
}, {
  aliases: [
    ...projectSpaceAliases,
    ['is_default', 'isDefault'],
  ],
});

const promptTemplateUpdateBody = strictBody({
  name: optionalRequiredText(120),
  content: optionalRequiredText(8000),
  description: optionalText(500),
  project_space_id: optionalProjectSpaceId,
  projectSpaceId: optionalProjectSpaceId,
  is_default: z.boolean().optional(),
  isDefault: z.boolean().optional(),
}, {
  aliases: [
    ...projectSpaceAliases,
    ['is_default', 'isDefault'],
  ],
  requireAtLeastOne: true,
});

const agentToolBinding = strictObject({
  key: requiredText(160),
  enabled: z.boolean().default(true),
  tool_version_id: z.string().uuid().optional(),
  configuration: z.record(z.string(), z.unknown()).optional(),
});

const agentToolBindings = z.array(agentToolBinding).max(24).superRefine((bindings, context) => {
  const seen = new Set<string>();
  bindings.forEach((binding, index) => {
    if (seen.has(binding.key)) {
      context.addIssue({
        code: 'custom',
        path: [index, 'key'],
        message: 'Tool bindings must be unique',
      });
    }
    seen.add(binding.key);
  });
});

const agentConfigurationShape = {
  instructions: requiredText(16000),
  model: optionalRequiredText(120),
  temperature: finiteNumber.min(0).max(2).optional(),
  max_iterations: z.number().int().min(1).max(20).optional(),
  max_duration_ms: z.number().int().min(1000).max(900000).optional(),
  max_output_tokens: z.number().int().min(128).max(100000).optional(),
  memory_mode: z.enum(['none', 'conversation', 'user', 'project', 'custom']).optional(),
  memory_policy: agentMemoryPolicySchema.optional(),
  response_format: z.enum(['markdown', 'json']).optional(),
  output_schema: z.record(z.string(), z.unknown()).optional(),
  approval_policy: z.enum(['never', 'writes', 'always']).optional(),
  tool_bindings: agentToolBindings.optional(),
  delegation_bindings: agentDelegationBindingsSchema.optional(),
  welcome_message: optionalText(2000),
  suggested_prompts: z.array(requiredText(500)).max(12).optional(),
};

const agentCreateBody = strictBody({
  name: requiredText(120),
  description: optionalText(1000),
  avatar: optionalText(2048),
  visibility: z.enum(['private', 'project']).optional(),
  project_space_id: optionalProjectSpaceId,
  projectSpaceId: optionalProjectSpaceId,
  ...agentConfigurationShape,
}, { aliases: projectSpaceAliases });

const agentUpdateBody = strictBody({
  name: optionalRequiredText(120),
  description: optionalText(1000),
  avatar: optionalText(2048),
  visibility: z.enum(['private', 'project']).optional(),
  project_space_id: optionalProjectSpaceId,
  projectSpaceId: optionalProjectSpaceId,
  instructions: optionalRequiredText(16000),
  model: optionalRequiredText(120),
  temperature: finiteNumber.min(0).max(2).optional(),
  max_iterations: z.number().int().min(1).max(20).optional(),
  max_duration_ms: z.number().int().min(1000).max(900000).optional(),
  max_output_tokens: z.number().int().min(128).max(100000).optional(),
  memory_mode: z.enum(['none', 'conversation', 'user', 'project', 'custom']).optional(),
  memory_policy: agentMemoryPolicySchema.optional(),
  response_format: z.enum(['markdown', 'json']).optional(),
  output_schema: z.record(z.string(), z.unknown()).optional(),
  approval_policy: z.enum(['never', 'writes', 'always']).optional(),
  tool_bindings: agentToolBindings.optional(),
  delegation_bindings: agentDelegationBindingsSchema.optional(),
  welcome_message: optionalText(2000),
  suggested_prompts: z.array(requiredText(500)).max(12).optional(),
}, { aliases: projectSpaceAliases, requireAtLeastOne: true });

const agentDuplicateBody = strictBody({
  name: optionalRequiredText(120),
});

const agentPublishBody = strictBody({
  release_notes: optionalText(4000),
  releaseNotes: optionalText(4000),
}, { aliases: [['release_notes', 'releaseNotes']] });

const agentStatusBody = strictBody({
  disabled: z.boolean(),
});

const agentVersionDryRunBody = strictBody({
  input: requiredText(16000),
});

const agentEvalExpectedToolCall = strictObject({
  tool_key: requiredText(160),
  arguments: z.record(z.string(), z.unknown()).optional(),
  fixture: z.unknown().optional(),
});

const agentEvalEvaluationSpec = strictObject({
  expected_output_contains: z.array(requiredText(500)).max(20).optional(),
  forbidden_output_contains: z.array(requiredText(500)).max(20).optional(),
  expected_tool_calls: z.array(agentEvalExpectedToolCall).max(24).optional(),
  forbidden_tool_keys: z.array(requiredText(160)).max(24).optional(),
  grounding_evidence: z.array(requiredText(4000)).max(20).optional(),
  expected_citations: z.array(requiredText(200)).max(20).optional(),
}).superRefine((value, context) => {
  const oracleCount = (value.expected_output_contains?.length || 0)
    + (value.forbidden_output_contains?.length || 0)
    + (value.expected_tool_calls?.length || 0)
    + (value.forbidden_tool_keys?.length || 0)
    + (value.grounding_evidence?.length || 0)
    + (value.expected_citations?.length || 0);
  if (oracleCount === 0) {
    context.addIssue({
      code: 'custom',
      message: 'At least one Agent evaluation oracle is required',
    });
  }
});

const agentEvalDatasetCreateBody = strictBody({
  name: requiredText(120),
  description: optionalText(1000),
});

const agentEvalCaseCreateBody = strictBody({
  name: optionalText(120),
  input: requiredText(16000),
  evaluation_spec: agentEvalEvaluationSpec,
});

const agentEvalRunCreateBody = strictBody({
  agent_id: uuid,
  candidate_version_id: uuid,
  baseline_version_id: uuid.nullable().optional(),
}).superRefine((value, context) => {
  if (value.baseline_version_id && value.baseline_version_id === value.candidate_version_id) {
    context.addIssue({
      code: 'custom',
      path: ['baseline_version_id'],
      message: 'Baseline must be a different Agent version',
    });
  }
});

const agentApprovalDecisionBody = strictBody({
  decision: z.enum(['approved', 'rejected']),
  reason: optionalText(1000),
});

/**
 * Deciding several approvals in one request.
 *
 * Every entry names the approval it decides. There is deliberately no
 * "approve everything pending" form: an approval created between the moment the
 * list was rendered and the moment it was submitted would be decided by a human
 * who never saw it, which is exactly the guarantee the approval exists to provide.
 */
const agentApprovalBatchDecisionBody = strictBody({
  decisions: z.array(strictObject({
    approval_id: uuid,
    decision: z.enum(['approved', 'rejected']),
    reason: optionalText(1000),
  })).min(1).max(20).superRefine((decisions, context) => {
    const ids = decisions.map((entry) => entry.approval_id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: 'custom',
        message: 'Each approval may appear at most once in a batch',
      });
    }
  }),
});

const agentMemoryIdParams = strictObject({ memoryId: uuid });
// Superseding rather than deleting keeps the fact that a statement once applied,
// which is why the replacement has to be named explicitly.
const agentMemorySupersedeBody = strictBody({ superseded_by: uuid });
const agentMemoryDecisionBody = strictBody({
  decision: z.enum(['confirmed', 'rejected']),
});
const agentMemoryScopeSettingBody = strictBody({
  scope: z.enum(['user', 'project', 'agent']),
  enabled: z.boolean(),
});

const agentToolConfiguration = z.record(z.string(), z.unknown());
const agentToolSecrets = z.record(
  z.string().trim().min(1).max(120),
  z.string().max(8192),
).superRefine((secrets, context) => {
  if (Object.keys(secrets).length > 32) {
    context.addIssue({ code: 'custom', message: 'At most 32 tool secrets are allowed' });
  }
});

const agentToolCreateBody = strictBody({
  name: requiredText(120),
  description: optionalText(1000),
  kind: z.enum(['http', 'mcp']),
  risk_level: z.enum(['read', 'write', 'high']).optional(),
  project_space_id: optionalProjectSpaceId,
  projectSpaceId: optionalProjectSpaceId,
  configuration: agentToolConfiguration,
  secrets: agentToolSecrets.optional(),
  enabled: z.boolean().optional(),
}, { aliases: projectSpaceAliases });

const agentToolUpdateBody = strictBody({
  name: optionalRequiredText(120),
  description: optionalText(1000),
  risk_level: z.enum(['read', 'write', 'high']).optional(),
  project_space_id: optionalProjectSpaceId,
  projectSpaceId: optionalProjectSpaceId,
  configuration: agentToolConfiguration.optional(),
  secrets: agentToolSecrets.optional(),
  clear_secrets: z.boolean().optional(),
  enabled: z.boolean().optional(),
}, { aliases: projectSpaceAliases, requireAtLeastOne: true }).superRefine((body, context) => {
  if (body.secrets !== undefined && body.clear_secrets === true) {
    context.addIssue({
      code: 'custom',
      path: ['clear_secrets'],
      message: 'Secrets cannot be supplied and cleared in the same request',
    });
  }
});

const agentToolDiagnosticBody = strictBody({
  operation: z.enum(['preflight', 'safe_test', 'discover']),
  input: z.record(z.string(), z.unknown()).optional(),
}).superRefine((body, context) => {
  if (body.operation !== 'safe_test' && body.input !== undefined) {
    context.addIssue({
      code: 'custom',
      path: ['input'],
      message: 'Diagnostic input is accepted only for a safe HTTP test',
    });
  }
});

const agentToolOpenApiImportBody = strictBody({
  document: z.record(z.string(), z.unknown()),
  base_url: z.string().trim().url().max(2048).optional(),
}).superRefine((body, context) => {
  const bytes = Buffer.byteLength(JSON.stringify(body.document), 'utf8');
  if (bytes > 512 * 1024) {
    context.addIssue({
      code: 'custom',
      path: ['document'],
      message: 'OpenAPI document exceeds 512 KiB',
    });
  }
});

const ragEvalDatasetCreateBody = strictBody({
  name: requiredText(120),
  description: optionalText(500),
  project_space_id: optionalProjectSpaceId,
  projectSpaceId: optionalProjectSpaceId,
}, { aliases: projectSpaceAliases });

const ragEvalDatasetUpdateBody = strictBody({
  name: requiredText(120),
  description: optionalText(500),
  project_space_id: optionalProjectSpaceId,
  projectSpaceId: optionalProjectSpaceId,
}, { aliases: projectSpaceAliases });

const ragEvalGraphRelationExpectation = z.object({
  source: requiredText(200),
  relation: requiredText(120),
  target: requiredText(200),
  polarity: z.enum(['affirmative', 'negative']).default('affirmative'),
  modality: z.enum(['asserted', 'conditional', 'planned_or_obligatory', 'historical']).default('asserted'),
}).strict();

const ragEvalHumanScores = z.object({
  correctness: finiteNumber.min(0).max(1).optional(),
  completeness: finiteNumber.min(0).max(1).optional(),
  faithfulness: finiteNumber.min(0).max(1).optional(),
}).strict();

const ragEvalEvaluationSpec = z.object({
  tags: z.array(requiredText(80)).max(20).optional(),
  category: optionalText(80),
  difficulty: z.enum(['easy', 'medium', 'hard']).optional(),
  expected_chunk_ids: z.array(requiredText(128)).max(50).optional(),
  expected_evidence: z.array(requiredText(1000)).max(20).optional(),
  expected_answerable: z.boolean().nullable().optional(),
  expected_graph_relations: z.array(ragEvalGraphRelationExpectation).max(20).optional(),
  human_scores: ragEvalHumanScores.optional(),
}).strict();

const ragEvalCaseCreateBody = strictBody({
  question: requiredText(4096),
  expected_answer: optionalText(4000),
  expectedAnswer: optionalText(4000),
  expected_keywords: z.array(requiredText(120)).max(20).optional(),
  expectedKeywords: z.array(requiredText(120)).max(20).optional(),
  expected_source_files: z.array(requiredText(120)).max(20).optional(),
  expectedSourceFiles: z.array(requiredText(120)).max(20).optional(),
  evaluation_spec: ragEvalEvaluationSpec.optional(),
  evaluationSpec: ragEvalEvaluationSpec.optional(),
}, {
  aliases: [
    ['expected_answer', 'expectedAnswer'],
    ['expected_keywords', 'expectedKeywords'],
    ['expected_source_files', 'expectedSourceFiles'],
    ['evaluation_spec', 'evaluationSpec'],
  ],
});

const ragWorkbenchInspectBody = strictBody({
  query: requiredText(MAX_CHAT_MESSAGE_CONTENT_LENGTH),
  project_space_id: optionalProjectSpaceId,
  projectSpaceId: optionalProjectSpaceId,
  limit: z.number().int().min(1).max(30).optional(),
  threshold: finiteNumber.min(0).max(1).optional(),
}, { aliases: projectSpaceAliases });

const ragWorkbenchGraphListBody = strictBody({
  project_space_id: optionalProjectSpaceId,
  projectSpaceId: optionalProjectSpaceId,
  limit: z.number().int().min(1).max(30).optional(),
}, { aliases: projectSpaceAliases });

const ragWorkbenchGraphSearchBody = strictBody({
  query: requiredText(MAX_CHAT_MESSAGE_CONTENT_LENGTH),
  project_space_id: optionalProjectSpaceId,
  projectSpaceId: optionalProjectSpaceId,
  limit: z.number().int().min(1).max(30).optional(),
}, { aliases: projectSpaceAliases });

const documentFilename = requiredText(255);
const documentIdentityFields = {
  filename: documentFilename,
  hash: sha256,
  project_space_id: optionalProjectSpaceId,
  projectSpaceId: optionalProjectSpaceId,
};

const uploadCheckBody = strictBody(documentIdentityFields, { aliases: projectSpaceAliases });

const uploadInitBody = strictBody({
  ...documentIdentityFields,
  size: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  type: optionalText(255),
}, { aliases: projectSpaceAliases });

const uploadMultipartPartsBody = strictBody({
  uploadId: uuid,
  partNumbers: z.array(z.number().int().min(1).max(MAX_MULTIPART_UPLOAD_PARTS))
    .min(1)
    .max(MAX_MULTIPART_PRESIGN_PARTS)
    .optional(),
  part_numbers: z.array(z.number().int().min(1).max(MAX_MULTIPART_UPLOAD_PARTS))
    .min(1)
    .max(MAX_MULTIPART_PRESIGN_PARTS)
    .optional(),
}, {
  aliases: [['partNumbers', 'part_numbers']],
}).superRefine((value, context) => {
  if (value.partNumbers === undefined && value.part_numbers === undefined) {
    context.addIssue({ code: 'custom', message: 'Part numbers are required' });
  }
});

const uploadIdBody = strictBody({ uploadId: uuid });

const uploadChunkIndex = z.string().trim().regex(/^\d+$/).refine(
  (value) => Number(value) < MAX_UPLOAD_CHUNKS,
  { message: 'Chunk index is out of range' }
);

const uploadChunkBody = strictBody({
  uploadId: uuid,
  chunkIndex: uploadChunkIndex,
  hash: sha256.optional(),
});

const uploadMergeBody = strictBody({
  uploadId: uuid,
  filename: documentFilename,
  totalChunks: z.number().int().min(1).max(MAX_UPLOAD_CHUNKS),
  hash: sha256.optional(),
});

export const mutationSchemas = {
  authRegister: { body: authRegisterBody },
  authLogin: { body: authLoginBody },
  authRefresh: { body: emptyBody },
  authUpdateProfile: { body: authUpdateProfileBody },
  authDeleteAccount: { body: emptyBody },
  authLogout: { body: emptyBody },

  chatCreateConversation: { body: chatCreateConversationBody },
  chatBranchConversation: { body: chatBranchConversationBody, params: conversationIdParams },
  chatUpdateConversation: { body: chatUpdateConversationBody, params: conversationIdParams },
  chatDeleteConversation: { body: emptyBody, params: conversationIdParams },
  chatDeleteMessage: { body: emptyBody, params: messageIdParams },
  chatTruncateConversation: { body: emptyBody, params: conversationMessageIdParams },
  chatSendMessage: {
    body: strictBody({
      content: requiredText(MAX_CHAT_MESSAGE_CONTENT_LENGTH),
      continue: z.boolean().optional(),
    }),
    params: conversationIdParams,
  },

  personaAnalyze: { body: emptyBody },
  personaUpdateProfile: { body: personaUpdateProfileBody },
  personaDeleteProfile: { body: emptyBody },
  personaUpdateInterest: { body: personaRecordStatusBody, params: interestIdParams },
  personaDeleteInterest: { body: emptyBody, params: interestIdParams },
  personaUpdateObservation: { body: personaRecordStatusBody, params: observationIdParams },
  personaDeleteObservation: { body: emptyBody, params: observationIdParams },
  personaUpdateSuggestion: { body: personaSuggestionStatusBody, params: suggestionIdParams },
  personaDeleteSuggestion: { body: emptyBody, params: suggestionIdParams },
  personaReset: { body: emptyBody },

  projectSpaceCreate: { body: projectSpaceCreateBody },
  projectSpaceUpdate: { body: projectSpaceUpdateBody, params: projectSpaceIdParams },
  projectSpaceDelete: { body: emptyBody, params: projectSpaceIdParams },

  promptTemplateCreate: { body: promptTemplateCreateBody },
  promptTemplateUpdate: { body: promptTemplateUpdateBody, params: templateIdParams },
  promptTemplateDelete: { body: emptyBody, params: templateIdParams },

  agentCreate: { body: agentCreateBody },
  agentUpdate: { body: agentUpdateBody, params: agentIdParams },
  agentPublish: { body: agentPublishBody, params: agentIdParams },
  agentVersionDryRun: { body: agentVersionDryRunBody, params: agentVersionIdParams },
  agentVersionRollback: { body: emptyBody, params: agentVersionIdParams },
  agentDuplicate: { body: agentDuplicateBody, params: agentIdParams },
  agentStatus: { body: agentStatusBody, params: agentIdParams },
  agentDelete: { body: emptyBody, params: agentIdParams },

  agentToolCreate: { body: agentToolCreateBody },
  agentToolUpdate: { body: agentToolUpdateBody, params: agentToolIdParams },
  agentToolRotateSecrets: { body: emptyBody, params: agentToolIdParams },
  agentToolDiagnostic: { body: agentToolDiagnosticBody, params: agentToolIdParams },
  agentToolOpenApiImport: { body: agentToolOpenApiImportBody },
  agentToolDelete: { body: emptyBody, params: agentToolIdParams },
  agentRunCancel: { body: emptyBody, params: agentRunIdParams },
  agentRunConversationCancel: { body: emptyBody, params: conversationIdParams },
  agentRunApprovalDecision: { body: agentApprovalDecisionBody, params: agentRunApprovalParams },
  agentMemorySupersede: { body: agentMemorySupersedeBody, params: agentMemoryIdParams },
  agentMemoryDecision: { body: agentMemoryDecisionBody, params: agentMemoryIdParams },
  agentMemoryScopeSetting: { body: agentMemoryScopeSettingBody },
  agentMemoryDelete: { body: emptyBody, params: agentMemoryIdParams },
  agentRunApprovalBatchDecision: {
    body: agentApprovalBatchDecisionBody,
    params: agentRunIdParams,
  },

  agentEvalDatasetCreate: { body: agentEvalDatasetCreateBody },
  agentEvalDatasetDelete: { body: emptyBody, params: datasetIdParams },
  agentEvalCaseCreate: { body: agentEvalCaseCreateBody, params: datasetIdParams },
  agentEvalCaseDelete: { body: emptyBody, params: caseIdParams },
  agentEvalRunCreate: { body: agentEvalRunCreateBody, params: datasetIdParams },
  agentEvalRunCancel: { body: emptyBody, params: runIdParams },

  ragEvalDatasetCreate: { body: ragEvalDatasetCreateBody },
  ragEvalDatasetUpdate: { body: ragEvalDatasetUpdateBody, params: datasetIdParams },
  ragEvalDatasetDelete: { body: emptyBody, params: datasetIdParams },
  ragEvalCaseCreate: { body: ragEvalCaseCreateBody, params: datasetIdParams },
  ragEvalDatasetRun: { body: emptyBody, params: datasetIdParams },
  ragEvalRunCancel: { body: emptyBody, params: runIdParams },
  ragEvalCaseDelete: { body: emptyBody, params: caseIdParams },

  ragWorkbenchInspect: { body: ragWorkbenchInspectBody },
  ragWorkbenchGraphList: { body: ragWorkbenchGraphListBody },
  ragWorkbenchGraphSearch: { body: ragWorkbenchGraphSearchBody },

  uploadCheck: { body: uploadCheckBody },
  uploadInit: { body: uploadInitBody },
  uploadMultipartInit: { body: uploadInitBody },
  uploadMultipartParts: { body: uploadMultipartPartsBody },
  uploadMultipartComplete: { body: uploadIdBody },
  uploadMultipartAbort: { body: uploadIdBody },
  uploadChunk: { body: uploadChunkBody },
  uploadMerge: { body: uploadMergeBody },
  uploadAvatar: { body: emptyBody },
  uploadRetryFile: { body: emptyBody, params: fileIdParams },
  uploadDeleteFile: { body: emptyBody, params: fileIdParams },
} satisfies Record<string, MutationSchema>;
