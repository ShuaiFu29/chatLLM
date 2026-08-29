import type { PoolClient } from 'pg';
import { query, withTransaction } from '../lib/db';
import { serverEnv } from '../lib/env';
import {
  memoryModeFromPolicy,
  memoryPolicyFromLegacyMode,
  type AgentMemoryMode,
  type AgentMemoryPolicy,
} from '../lib/agentMemoryPolicy';
import type {
  AgentDelegationBinding,
  AgentDelegationMode,
} from '../lib/agentDelegation';
import { cancelActiveAgentRunsForAgentForUserWithClient } from './agentRuns';
import { cancelActiveAgentEvalRunsForAgentWithClient } from './agentEval';

export type { AgentMemoryMode, AgentMemoryPolicy } from '../lib/agentMemoryPolicy';

export type AgentVisibility = 'private' | 'project';
export type AgentStatus = 'draft' | 'published' | 'disabled';
export type AgentResponseFormat = 'markdown' | 'json';
export type AgentApprovalPolicy = 'never' | 'writes' | 'always';
export type AgentVersionChangeKind = 'created' | 'edited' | 'rollback';
export type AgentPublicationValidationStatus = 'passed' | 'failed' | 'not_applicable';

export interface AgentToolBinding {
  key: string;
  enabled: boolean;
  /** Required for custom tools; built-ins are versioned with the application. */
  tool_version_id?: string;
  configuration?: Record<string, unknown>;
  /** Migration-only tombstone for a custom tool deleted before versioning existed. */
  legacy_unavailable?: boolean;
}

export interface AgentVersionConfiguration {
  instructions: string;
  model: string;
  temperature: number;
  max_iterations: number;
  max_duration_ms: number;
  max_output_tokens: number;
  memory_mode: AgentMemoryMode;
  memory_policy: AgentMemoryPolicy;
  response_format: AgentResponseFormat;
  output_schema: Record<string, unknown>;
  approval_policy: AgentApprovalPolicy;
  tool_bindings: AgentToolBinding[];
  delegation_mode: AgentDelegationMode;
  delegation_bindings: AgentDelegationBinding[];
  welcome_message: string;
  suggested_prompts: string[];
}

export const agentVersionConfigurationKeys = [
  'instructions',
  'model',
  'temperature',
  'max_iterations',
  'max_duration_ms',
  'max_output_tokens',
  'memory_mode',
  'memory_policy',
  'response_format',
  'output_schema',
  'approval_policy',
  'tool_bindings',
  'delegation_mode',
  'delegation_bindings',
  'welcome_message',
  'suggested_prompts',
] as const satisfies readonly (keyof AgentVersionConfiguration)[];

export interface AgentPublicationValidationCheck {
  key: string;
  status: AgentPublicationValidationStatus;
  message: string;
}

export interface AgentPublicationValidationReport {
  format_version: 1;
  valid: boolean;
  checks: AgentPublicationValidationCheck[];
}

export interface AgentVersionPublicationRow {
  id: string;
  agent_id: string;
  agent_version_id: string;
  published_by?: string | null;
  release_notes: string;
  validation_report: AgentPublicationValidationReport;
  published_at: string;
}

export interface AgentDetailRow extends AgentVersionConfiguration {
  id: string;
  user_id: string;
  project_space_id?: string | null;
  name: string;
  description: string;
  avatar: string;
  visibility: AgentVisibility;
  status: AgentStatus;
  current_version_id: string;
  published_version_id?: string | null;
  latest_version: number;
  version: number;
  configuration_hash: string;
  derived_from_version_id?: string | null;
  change_kind: AgentVersionChangeKind;
  published_version?: number | null;
  has_unpublished_changes: boolean;
  created_at: string;
  updated_at: string;
  version_created_at: string;
}

export interface AgentVersionRow extends AgentVersionConfiguration {
  id: string;
  agent_id: string;
  version: number;
  configuration_hash: string;
  derived_from_version_id?: string | null;
  change_kind: AgentVersionChangeKind;
  is_current: boolean;
  is_published: boolean;
  publication_id?: string | null;
  published_at?: string | null;
  published_by?: string | null;
  release_notes?: string | null;
  validation_report?: AgentPublicationValidationReport | null;
  created_at: string;
}

export interface AgentListOptions {
  projectSpaceId?: string;
  includeDisabled?: boolean;
}

export interface CreateAgentInput extends AgentVersionConfiguration {
  userId: string;
  projectSpaceId?: string | null;
  name: string;
  description?: string;
  avatar?: string;
  visibility?: AgentVisibility;
  maxAgentsPerUser?: number;
}

export type AgentMetadataUpdates = Partial<{
  project_space_id: string | null;
  name: string;
  description: string;
  avatar: string;
  visibility: AgentVisibility;
  status: AgentStatus;
}>;

export type AgentVersionUpdates = Partial<AgentVersionConfiguration>;

const agentDetailColumns = `
  a.id,
  a.user_id,
  a.project_space_id,
  a.name,
  a.description,
  a.avatar,
  a.visibility,
  a.status,
  a.current_version_id,
  a.published_version_id,
  a.latest_version,
  a.created_at,
  a.updated_at,
  current_version.version,
  current_version.instructions,
  current_version.model,
  current_version.temperature,
  current_version.max_iterations,
  current_version.max_duration_ms,
  current_version.max_output_tokens,
  current_version.memory_mode,
  current_version.memory_policy,
  current_version.response_format,
  current_version.output_schema,
  current_version.approval_policy,
  current_version.tool_bindings,
  current_version.delegation_mode,
  current_version.delegation_bindings,
  current_version.welcome_message,
  current_version.suggested_prompts,
  current_version.configuration_hash,
  current_version.derived_from_version_id,
  current_version.change_kind,
  current_version.created_at as version_created_at,
  published_version.version as published_version,
  (a.current_version_id is distinct from a.published_version_id) as has_unpublished_changes
`;

const agentDetailJoins = `
  join agent_versions current_version on current_version.id = a.current_version_id
  left join agent_versions published_version on published_version.id = a.published_version_id
`;

const versionColumns = `
  version_row.id,
  version_row.agent_id,
  version_row.version,
  version_row.instructions,
  version_row.model,
  version_row.temperature,
  version_row.max_iterations,
  version_row.max_duration_ms,
  version_row.max_output_tokens,
  version_row.memory_mode,
  version_row.memory_policy,
  version_row.response_format,
  version_row.output_schema,
  version_row.approval_policy,
  version_row.tool_bindings,
  version_row.delegation_mode,
  version_row.delegation_bindings,
  version_row.welcome_message,
  version_row.suggested_prompts,
  version_row.configuration_hash,
  version_row.derived_from_version_id,
  version_row.change_kind,
  (agent.current_version_id = version_row.id) as is_current,
  (agent.published_version_id = version_row.id) as is_published,
  publication.id as publication_id,
  publication.published_at,
  publication.published_by,
  publication.release_notes,
  publication.validation_report,
  version_row.created_at
`;

const versionPublicationJoin = `
  left join lateral (
    select publication.*
    from agent_version_publications publication
    where publication.agent_version_id = version_row.id
    order by publication.published_at desc, publication.id desc
    limit 1
  ) publication on true
`;

const CUSTOM_TOOL_KEY = /^custom:([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

const customToolReferencesFromBindings = (bindings: AgentToolBinding[]) => bindings
  .filter((binding) => binding.enabled !== false)
  .flatMap((binding) => {
    const match = CUSTOM_TOOL_KEY.exec(binding.key);
    return match ? [{ toolId: match[1], toolVersionId: binding.tool_version_id }] : [];
  });

const lockAgentDelegationGraphForUser = async (client: PoolClient, userId: string) => {
  await client.query(
    `select pg_advisory_xact_lock(hashtextextended('agent-delegation:' || $1::text, 0))`,
    [userId],
  );
};

const assertAgentHasNoInboundDelegationBindingsWithClient = async (
  client: PoolClient,
  agentId: string,
  userId: string,
) => {
  const { rows } = await client.query<{ count: string }>(
    `select count(*)::text as count
     from agents parent
     join agent_versions version
       on version.id in (parent.current_version_id, parent.published_version_id)
     cross join lateral jsonb_array_elements(version.delegation_bindings) binding
     where parent.user_id = $2
       and version.delegation_mode = 'explicit'
       and binding ->> 'agent_id' = $1::uuid::text`,
    [agentId, userId],
  );
  if (Number(rows[0]?.count || 0) > 0) {
    throw new Error('AGENT_DELEGATION_STILL_BOUND');
  }
};

const assertAgentInboundDelegationScopeWithClient = async (
  client: PoolClient,
  input: {
    agentId: string;
    userId: string;
    projectSpaceId: string | null;
  },
) => {
  if (input.projectSpaceId === null) return;
  const { rows } = await client.query<{ project_space_id: string | null }>(
    `select distinct parent.project_space_id
     from agents parent
     join agent_versions version
       on version.id in (parent.current_version_id, parent.published_version_id)
     cross join lateral jsonb_array_elements(version.delegation_bindings) binding
     where parent.user_id = $2
       and version.delegation_mode = 'explicit'
       and binding ->> 'agent_id' = $1::uuid::text`,
    [input.agentId, input.userId],
  );
  if (rows.some((parent) => parent.project_space_id !== input.projectSpaceId)) {
    throw new Error('AGENT_DELEGATION_BINDING_SCOPE');
  }
};

const assertDelegationBindingsWithClient = async (
  client: PoolClient,
  input: {
    userId: string;
    agentId: string;
    delegationMode: AgentDelegationMode;
    delegationBindings: AgentDelegationBinding[];
    projectSpaceId: string | null;
    includePublishedVersion?: boolean;
  },
) => {
  const configurations: Array<{
    delegationMode: AgentDelegationMode;
    delegationBindings: AgentDelegationBinding[];
  }> = [{
    delegationMode: input.delegationMode,
    delegationBindings: input.delegationBindings,
  }];
  if (input.includePublishedVersion) {
    const { rows } = await client.query<{
      delegation_mode: AgentDelegationMode;
      delegation_bindings: AgentDelegationBinding[];
    }>(
      `select published_version.delegation_mode, published_version.delegation_bindings
       from agents source
       join agent_versions published_version on published_version.id = source.published_version_id
       where source.id = $1 and source.user_id = $2`,
      [input.agentId, input.userId],
    );
    if (rows[0]) configurations.push({
      delegationMode: rows[0].delegation_mode,
      delegationBindings: rows[0].delegation_bindings,
    });
  }

  type PendingBinding = {
    binding: AgentDelegationBinding;
    ancestorAgentIds: string[];
    depth: number;
  };
  type LoadedTarget = {
    agent_id: string;
    agent_version_id: string;
    project_space_id: string | null;
    status: AgentStatus;
    delegation_mode: AgentDelegationMode;
    delegation_bindings: AgentDelegationBinding[];
  };
  const loadedTargets = new Map<string, LoadedTarget>();
  let inspectedBindingCount = 0;

  for (const configuration of configurations) {
    if (configuration.delegationMode === 'legacy_dynamic') {
      if (configuration.delegationBindings.length > 0) {
        throw new Error('AGENT_DELEGATION_BINDING_INVALID');
      }
      continue;
    }
    const pending: PendingBinding[] = configuration.delegationBindings.map((binding) => ({
      binding,
      ancestorAgentIds: [input.agentId],
      depth: 1,
    }));
    while (pending.length > 0) {
      const item = pending.shift()!;
      if (item.depth > serverEnv.AGENT_MAX_SUBAGENT_DEPTH) {
        throw new Error('AGENT_DELEGATION_DEPTH_EXCEEDED');
      }
      if (item.ancestorAgentIds.includes(item.binding.agent_id)) {
        throw new Error('AGENT_DELEGATION_CYCLE');
      }
      inspectedBindingCount += 1;
      if (inspectedBindingCount > 5000) {
        throw new Error('AGENT_DELEGATION_GRAPH_TOO_LARGE');
      }
      const cacheKey = `${item.binding.agent_id}:${item.binding.agent_version_id}`;
      let target = loadedTargets.get(cacheKey);
      if (!target) {
        const { rows } = await client.query<LoadedTarget>(
          `select target.id as agent_id, version.id as agent_version_id,
                  target.project_space_id, target.status,
                  version.delegation_mode, version.delegation_bindings
           from agents target
           join agent_versions version
             on version.id = $2 and version.agent_id = target.id
           where target.id = $1 and target.user_id = $3
             and target.status = 'published'
             and exists (
               select 1
               from agent_version_publications publication
               where publication.agent_id = target.id
                 and publication.agent_version_id = version.id
                 and coalesce((publication.validation_report ->> 'valid')::boolean, false)
             )
           for update of target`,
          [item.binding.agent_id, item.binding.agent_version_id, input.userId],
        );
        target = rows[0];
        if (!target) throw new Error('AGENT_DELEGATION_BINDING_UNAVAILABLE');
        loadedTargets.set(cacheKey, target);
      }
      if (target.project_space_id && target.project_space_id !== input.projectSpaceId) {
        throw new Error('AGENT_DELEGATION_BINDING_SCOPE');
      }
      if (target.delegation_mode !== 'explicit') {
        throw new Error('AGENT_DELEGATION_LEGACY_DEPENDENCY');
      }
      const nextAncestors = [...item.ancestorAgentIds, target.agent_id];
      pending.push(...target.delegation_bindings.map((binding) => ({
        binding,
        ancestorAgentIds: nextAncestors,
        depth: item.depth + 1,
      })));
    }
  }
};

/**
 * Fail the transaction unless every bound custom tool is usable by an Agent in
 * `projectSpaceId`.
 *
 * The tool rows are locked so a concurrent `updateAgentToolForUser` cannot move a
 * tool between the check and the commit. Both paths take locks in the same order
 * (user agents, then tools), so this cannot deadlock with a tool mutation.
 */
const assertToolBindingsInAgentScopeWithClient = async (
  client: PoolClient,
  input: {
    userId: string;
    agentId: string;
    toolBindings: AgentToolBinding[];
    projectSpaceId: string | null;
    includePublishedVersion?: boolean;
  },
) => {
  const references = customToolReferencesFromBindings(input.toolBindings);
  if (input.includePublishedVersion) {
    const { rows } = await client.query<{ tool_bindings: AgentToolBinding[] }>(
      `select published_version.tool_bindings
       from agents a
       join agent_versions published_version on published_version.id = a.published_version_id
       where a.id = $1 and a.user_id = $2`,
      [input.agentId, input.userId],
    );
    references.push(...customToolReferencesFromBindings(rows[0]?.tool_bindings || []));
  }
  if (references.length === 0) return;
  if (references.some((reference) => !reference.toolVersionId)) {
    throw new Error('AGENT_TOOL_BINDING_VERSION_REQUIRED');
  }

  const uniqueReferences = new Map(references.map((reference) => [
    `${reference.toolId}:${reference.toolVersionId}`,
    reference as { toolId: string; toolVersionId: string },
  ]));
  const requested = [...uniqueReferences.values()];
  const { rows: toolRows } = await client.query<{
    id: string;
    tool_version_id: string;
    project_space_id: string | null;
  }>(
    `select tool.id, version.id as tool_version_id, tool.project_space_id
     from agent_tools tool
     join agent_tool_versions version on version.tool_id = tool.id
     where tool.user_id = $1
       and tool.id = any($2::uuid[])
       and version.id = any($3::uuid[])
       and tool.enabled = true
       and tool.deleted_at is null
     for update of tool`,
    [
      input.userId,
      requested.map((reference) => reference.toolId),
      requested.map((reference) => reference.toolVersionId),
    ],
  );
  const loaded = new Set(toolRows.map((tool) => `${tool.id}:${tool.tool_version_id}`));
  if (requested.some((reference) => !loaded.has(
    `${reference.toolId}:${reference.toolVersionId}`,
  ))) {
    throw new Error('AGENT_TOOL_BINDING_UNAVAILABLE');
  }
  if (toolRows.some((tool) => tool.project_space_id && tool.project_space_id !== input.projectSpaceId)) {
    throw new Error('AGENT_TOOL_BINDING_SCOPE');
  }
};

const selectAgentForUserWithClient = async (
  client: PoolClient,
  agentId: string,
  userId: string,
) => {
  const { rows } = await client.query<AgentDetailRow>(
    `select ${agentDetailColumns}
     from agents a
     ${agentDetailJoins}
     where a.id = $1 and a.user_id = $2`,
    [agentId, userId],
  );
  return rows[0] || null;
};

export const listAgentsForUser = async (
  userId: string,
  options: AgentListOptions = {},
) => {
  const values: unknown[] = [userId];
  const conditions = ['a.user_id = $1'];

  if (options.projectSpaceId) {
    values.push(options.projectSpaceId);
    conditions.push(`(a.project_space_id is null or a.project_space_id = $${values.length})`);
  }
  if (!options.includeDisabled) conditions.push("a.status <> 'disabled'");

  const { rows } = await query<AgentDetailRow>(
    `select ${agentDetailColumns}
     from agents a
     ${agentDetailJoins}
     where ${conditions.join(' and ')}
     order by a.updated_at desc, a.id desc`,
    values,
  );
  return rows;
};

export const findAgentForUser = async (agentId: string, userId: string) => {
  const { rows } = await query<AgentDetailRow>(
    `select ${agentDetailColumns}
     from agents a
     ${agentDetailJoins}
     where a.id = $1 and a.user_id = $2`,
    [agentId, userId],
  );
  return rows[0] || null;
};

export const findPublishedAgentForUser = async (agentId: string, userId: string) => {
  const { rows } = await query<AgentDetailRow>(
    `select ${agentDetailColumns}
     from agents a
     join agent_versions current_version on current_version.id = a.published_version_id
     left join agent_versions published_version on published_version.id = a.published_version_id
     where a.id = $1 and a.user_id = $2 and a.status = 'published'`,
    [agentId, userId],
  );
  return rows[0] || null;
};

export interface ExecutableAgentVersionRow extends AgentDetailRow {
  selected_version_id: string;
}

/** Load one exact Agent version that has passed publication at least once. */
export const findExecutableAgentVersionForUser = async (
  agentId: string,
  versionId: string,
  userId: string,
) => {
  const { rows } = await query<ExecutableAgentVersionRow>(
    `select ${agentDetailColumns}, current_version.id as selected_version_id
     from agents a
     join agent_versions current_version
       on current_version.id = $2 and current_version.agent_id = a.id
     left join agent_versions published_version on published_version.id = a.published_version_id
     where a.id = $1 and a.user_id = $3 and a.status = 'published'
       and exists (
         select 1
         from agent_version_publications publication
         where publication.agent_id = a.id
           and publication.agent_version_id = current_version.id
           and coalesce((publication.validation_report ->> 'valid')::boolean, false)
       )`,
    [agentId, versionId, userId],
  );
  return rows[0] || null;
};

export const createAgentForUser = async (input: CreateAgentInput) => withTransaction(
  async (client) => {
    if (memoryModeFromPolicy(input.memory_policy) !== input.memory_mode) {
      throw new Error('AGENT_MEMORY_POLICY_MISMATCH');
    }
    await client.query(
      `select pg_advisory_xact_lock(hashtextextended('agent-quota:' || $1::text, 0))`,
      [input.userId],
    );
    await lockAgentDelegationGraphForUser(client, input.userId);
    const { rows: countRows } = await client.query<{ count: string }>(
      `select count(*)::text as count from agents where user_id = $1`,
      [input.userId],
    );
    if (Number(countRows[0]?.count || 0) >= (input.maxAgentsPerUser ?? 100)) {
      throw new Error('AGENT_QUOTA_EXCEEDED');
    }
    const agentResult = await client.query<{ id: string }>(
      `insert into agents (
         user_id, project_space_id, name, description, avatar, visibility
       ) values ($1, $2, $3, $4, $5, $6)
       returning id`,
      [
        input.userId,
        input.projectSpaceId || null,
        input.name,
        input.description || '',
        input.avatar || '',
        input.visibility || 'private',
      ],
    );
    const agentId = agentResult.rows[0].id;

    await assertToolBindingsInAgentScopeWithClient(client, {
      userId: input.userId,
      agentId,
      toolBindings: input.tool_bindings,
      projectSpaceId: input.projectSpaceId ?? null,
    });
    await assertDelegationBindingsWithClient(client, {
      userId: input.userId,
      agentId,
      delegationMode: input.delegation_mode,
      delegationBindings: input.delegation_bindings,
      projectSpaceId: input.projectSpaceId ?? null,
    });

    const versionResult = await client.query<{ id: string }>(
       `insert into agent_versions (
         agent_id, version, instructions, model, temperature, max_iterations,
         max_duration_ms, max_output_tokens, memory_mode, memory_policy, response_format,
         output_schema, approval_policy, tool_bindings, delegation_mode,
         delegation_bindings, welcome_message, suggested_prompts, change_kind
       ) values (
         $1, 1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13,
         $14, $15::jsonb, $16, $17, 'created'
       ) returning id`,
      [
        agentId,
        input.instructions,
        input.model,
        input.temperature,
        input.max_iterations,
        input.max_duration_ms,
        input.max_output_tokens,
        input.memory_mode,
        JSON.stringify(input.memory_policy),
        input.response_format,
        JSON.stringify(input.output_schema),
        input.approval_policy,
        JSON.stringify(input.tool_bindings),
        input.delegation_mode,
        JSON.stringify(input.delegation_bindings),
        input.welcome_message,
        JSON.stringify(input.suggested_prompts),
      ],
    );

    await client.query(
      `update agents
       set current_version_id = $1
       where id = $2`,
      [versionResult.rows[0].id, agentId],
    );

    return (await selectAgentForUserWithClient(client, agentId, input.userId))!;
  },
);

export const updateAgentForUser = async (input: {
  agentId: string;
  userId: string;
  metadata: AgentMetadataUpdates;
  version: AgentVersionUpdates;
  maxVersionsPerAgent?: number;
}) => withTransaction(async (client) => {
  await lockAgentDelegationGraphForUser(client, input.userId);
  const lockedAgentResult = await client.query<AgentDetailRow>(
    `select ${agentDetailColumns}
     from agents a
     ${agentDetailJoins}
     where a.id = $1 and a.user_id = $2
     for update of a`,
    [input.agentId, input.userId],
  );
  const current = lockedAgentResult.rows[0];
  if (!current) return null;

  const metadataEntries = Object.entries(input.metadata)
    .filter((entry) => entry[1] !== undefined);

  // Moving an Agent between project spaces can invalidate tool bindings that
  // were legal a moment ago. When no new version is created the version block
  // below never runs, so a "change the workspace only" edit used to skip the
  // scope check entirely: interleaved with a concurrent tool move it could leave
  // a published Agent in space B bound to a tool scoped to space A, which then
  // fails fail-closed on every single chat.
  const movesProjectSpace = input.metadata.project_space_id !== undefined
    && input.metadata.project_space_id !== current.project_space_id;
  if (movesProjectSpace) {
    await assertToolBindingsInAgentScopeWithClient(client, {
      userId: input.userId,
      agentId: input.agentId,
      // The draft version's bindings are what a later publish would ship, and
      // the published bindings are what running chats use. Both must stay legal.
      toolBindings: input.version.tool_bindings ?? current.tool_bindings,
      projectSpaceId: input.metadata.project_space_id ?? null,
      includePublishedVersion: true,
    });
    await assertDelegationBindingsWithClient(client, {
      userId: input.userId,
      agentId: input.agentId,
      delegationMode: input.version.delegation_mode ?? current.delegation_mode,
      delegationBindings: input.version.delegation_bindings ?? current.delegation_bindings,
      projectSpaceId: input.metadata.project_space_id ?? null,
      includePublishedVersion: true,
    });
    await assertAgentInboundDelegationScopeWithClient(client, {
      agentId: input.agentId,
      userId: input.userId,
      projectSpaceId: input.metadata.project_space_id ?? null,
    });
  }

  if (metadataEntries.length > 0) {
    const values: unknown[] = [];
    const assignments = metadataEntries.map(([key, value]) => {
      values.push(value);
      return `${key} = $${values.length}`;
    });
    values.push(input.agentId, input.userId);
    await client.query(
      `update agents
       set ${assignments.join(', ')}, updated_at = now()
       where id = $${values.length - 1} and user_id = $${values.length}`,
      values,
    );
  }

  const versionEntries = Object.entries(input.version)
    .filter((entry) => entry[1] !== undefined);
  if (versionEntries.length > 0) {
    const nextVersion = current.latest_version + 1;
    // The quota bounds how many version rows we keep, so it has to count rows.
    // Comparing it against the monotonic version number instead meant an Agent
    // edited 100 times was bricked for good: version numbers never go back down,
    // so every later edit failed even though pruning old versions should have
    // freed room. Version numbers stay monotonic for identity/audit purposes.
    const versionCountResult = await client.query<{ count: string }>(
      'select count(*)::text as count from agent_versions where agent_id = $1',
      [input.agentId],
    );
    const storedVersions = Number(versionCountResult.rows[0]?.count ?? '0');
    if (storedVersions >= (input.maxVersionsPerAgent ?? 100)) {
      throw new Error('AGENT_VERSION_QUOTA_EXCEEDED');
    }
    const memoryPolicy = input.version.memory_policy
      ?? (input.version.memory_mode && input.version.memory_mode !== 'custom'
        ? memoryPolicyFromLegacyMode(input.version.memory_mode)
        : current.memory_policy);
    const memoryMode = memoryModeFromPolicy(memoryPolicy);
    if (input.version.memory_mode !== undefined && input.version.memory_mode !== memoryMode) {
      throw new Error('AGENT_MEMORY_POLICY_MISMATCH');
    }
    const configuration: AgentVersionConfiguration = {
      instructions: input.version.instructions ?? current.instructions,
      model: input.version.model ?? current.model,
      temperature: input.version.temperature ?? current.temperature,
      max_iterations: input.version.max_iterations ?? current.max_iterations,
      max_duration_ms: input.version.max_duration_ms ?? current.max_duration_ms,
      max_output_tokens: input.version.max_output_tokens ?? current.max_output_tokens,
      memory_mode: memoryMode,
      memory_policy: memoryPolicy,
      response_format: input.version.response_format ?? current.response_format,
      output_schema: input.version.output_schema ?? current.output_schema,
      approval_policy: input.version.approval_policy ?? current.approval_policy,
      tool_bindings: input.version.tool_bindings ?? current.tool_bindings,
      delegation_mode: input.version.delegation_mode ?? current.delegation_mode,
      delegation_bindings: input.version.delegation_bindings ?? current.delegation_bindings,
      welcome_message: input.version.welcome_message ?? current.welcome_message,
      suggested_prompts: input.version.suggested_prompts ?? current.suggested_prompts,
    };

    const effectiveProjectSpaceId = input.metadata.project_space_id !== undefined
      ? input.metadata.project_space_id
      : current.project_space_id;
    await assertToolBindingsInAgentScopeWithClient(client, {
      userId: input.userId,
      agentId: input.agentId,
      toolBindings: configuration.tool_bindings,
      projectSpaceId: effectiveProjectSpaceId ?? null,
    });
    await assertDelegationBindingsWithClient(client, {
      userId: input.userId,
      agentId: input.agentId,
      delegationMode: configuration.delegation_mode,
      delegationBindings: configuration.delegation_bindings,
      projectSpaceId: effectiveProjectSpaceId ?? null,
    });

    const versionResult = await client.query<{ id: string }>(
       `insert into agent_versions (
         agent_id, version, instructions, model, temperature, max_iterations,
         max_duration_ms, max_output_tokens, memory_mode, memory_policy, response_format,
         output_schema, approval_policy, tool_bindings, delegation_mode,
         delegation_bindings, welcome_message, suggested_prompts,
         derived_from_version_id, change_kind
       ) values (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, $14,
         $15, $16::jsonb, $17, $18, $19, 'edited'
       ) returning id`,
      [
        input.agentId,
        nextVersion,
        configuration.instructions,
        configuration.model,
        configuration.temperature,
        configuration.max_iterations,
        configuration.max_duration_ms,
        configuration.max_output_tokens,
        configuration.memory_mode,
        JSON.stringify(configuration.memory_policy),
        configuration.response_format,
        JSON.stringify(configuration.output_schema),
        configuration.approval_policy,
        JSON.stringify(configuration.tool_bindings),
        configuration.delegation_mode,
        JSON.stringify(configuration.delegation_bindings),
        configuration.welcome_message,
        JSON.stringify(configuration.suggested_prompts),
        current.current_version_id,
      ],
    );
    await client.query(
      `update agents
       set current_version_id = $1, latest_version = $2, updated_at = now()
       where id = $3 and user_id = $4`,
      [versionResult.rows[0].id, nextVersion, input.agentId, input.userId],
    );
  }

  return selectAgentForUserWithClient(client, input.agentId, input.userId);
});

export const publishAgentForUser = async (input: {
  agentId: string;
  userId: string;
  expectedVersionId: string;
  releaseNotes: string;
  validationReport: AgentPublicationValidationReport;
}) => withTransaction(async (client) => {
  await lockAgentDelegationGraphForUser(client, input.userId);
  const lockedAgentResult = await client.query<AgentDetailRow>(
    `select ${agentDetailColumns}
     from agents a
     ${agentDetailJoins}
     where a.id = $1 and a.user_id = $2
     for update of a`,
    [input.agentId, input.userId],
  );
  const current = lockedAgentResult.rows[0];
  if (!current) return null;
  if (current.status === 'disabled') throw new Error('AGENT_DISABLED');
  if (current.current_version_id !== input.expectedVersionId) {
    throw new Error('AGENT_VERSION_CHANGED');
  }
  if (!input.validationReport.valid) throw new Error('AGENT_VALIDATION_FAILED');

  // Re-lock the custom tools inside the publication transaction. Static
  // validation happens before this transaction, but a tool can be disabled or
  // moved while a provider check is running.
  await assertToolBindingsInAgentScopeWithClient(client, {
    userId: input.userId,
    agentId: input.agentId,
    toolBindings: current.tool_bindings,
    projectSpaceId: current.project_space_id ?? null,
  });
  await assertDelegationBindingsWithClient(client, {
    userId: input.userId,
    agentId: input.agentId,
    delegationMode: current.delegation_mode,
    delegationBindings: current.delegation_bindings,
    projectSpaceId: current.project_space_id ?? null,
  });

  const publicationResult = await client.query<AgentVersionPublicationRow>(
    `insert into agent_version_publications (
       agent_id, agent_version_id, published_by, release_notes, validation_report
     ) values ($1, $2, $3, $4, $5::jsonb)
     returning id, agent_id, agent_version_id, published_by, release_notes,
               validation_report, published_at`,
    [
      input.agentId,
      input.expectedVersionId,
      input.userId,
      input.releaseNotes,
      JSON.stringify(input.validationReport),
    ],
  );

  await client.query(
    `update agents
     set published_version_id = current_version_id,
         status = 'published',
         updated_at = now()
     where id = $1 and user_id = $2`,
    [input.agentId, input.userId],
  );
  const agent = await selectAgentForUserWithClient(client, input.agentId, input.userId);
  return agent ? { ...agent, publication: publicationResult.rows[0] } : null;
});

export const setAgentDisabledForUser = async (
  agentId: string,
  userId: string,
  disabled: boolean,
) => withTransaction(async (client) => {
  await lockAgentDelegationGraphForUser(client, userId);
  const locked = await client.query<{ id: string }>(
    `select id from agents where id = $1 and user_id = $2 for update`,
    [agentId, userId],
  );
  if (!locked.rows[0]) return null;
  if (disabled) {
    await assertAgentHasNoInboundDelegationBindingsWithClient(client, agentId, userId);
    await cancelActiveAgentRunsForAgentForUserWithClient(
      client,
      agentId,
      userId,
      'Agent was disabled while a run was active',
    );
    await cancelActiveAgentEvalRunsForAgentWithClient(client, agentId, userId);
  }
  const { rows } = await client.query<{ id: string }>(
    `update agents
     set status = case
       when $3 then 'disabled'
       when published_version_id is not null then 'published'
       else 'draft'
     end,
     updated_at = now()
     where id = $1 and user_id = $2
     returning id`,
    [agentId, userId, disabled],
  );
  if (rows.length === 0) return null;
  return selectAgentForUserWithClient(client, agentId, userId);
});

export const listAgentVersionsForUser = async (agentId: string, userId: string) => {
  const { rows } = await query<AgentVersionRow>(
    `select ${versionColumns}
     from agents agent
     join agent_versions version_row on version_row.agent_id = agent.id
     ${versionPublicationJoin}
     where agent.id = $1 and agent.user_id = $2
     order by version_row.version desc`,
    [agentId, userId],
  );
  return rows;
};

export const findAgentVersionForUser = async (
  agentId: string,
  versionId: string,
  userId: string,
) => {
  const { rows } = await query<AgentVersionRow>(
    `select ${versionColumns}
     from agents agent
     join agent_versions version_row on version_row.agent_id = agent.id
     ${versionPublicationJoin}
     where agent.id = $1 and agent.user_id = $2 and version_row.id = $3`,
    [agentId, userId, versionId],
  );
  return rows[0] || null;
};

export const rollbackAgentVersionForUser = async (input: {
  agentId: string;
  versionId: string;
  userId: string;
  maxVersionsPerAgent?: number;
}) => withTransaction(async (client) => {
  await lockAgentDelegationGraphForUser(client, input.userId);
  const lockedAgentResult = await client.query<AgentDetailRow>(
    `select ${agentDetailColumns}
     from agents a
     ${agentDetailJoins}
     where a.id = $1 and a.user_id = $2
     for update of a`,
    [input.agentId, input.userId],
  );
  const current = lockedAgentResult.rows[0];
  if (!current) return null;

  const targetResult = await client.query<AgentVersionRow>(
    `select version_row.*,
            false as is_current,
            false as is_published,
            null::uuid as publication_id,
            null::timestamptz as published_at,
            null::uuid as published_by,
            null::text as release_notes,
            null::jsonb as validation_report
     from agent_versions version_row
     where version_row.id = $1 and version_row.agent_id = $2`,
    [input.versionId, input.agentId],
  );
  const target = targetResult.rows[0];
  if (!target) throw new Error('AGENT_VERSION_NOT_FOUND');

  const versionCountResult = await client.query<{ count: string }>(
    'select count(*)::text as count from agent_versions where agent_id = $1',
    [input.agentId],
  );
  if (Number(versionCountResult.rows[0]?.count ?? '0') >= (input.maxVersionsPerAgent ?? 100)) {
    throw new Error('AGENT_VERSION_QUOTA_EXCEEDED');
  }

  await assertToolBindingsInAgentScopeWithClient(client, {
    userId: input.userId,
    agentId: input.agentId,
    toolBindings: target.tool_bindings,
    projectSpaceId: current.project_space_id ?? null,
  });
  await assertDelegationBindingsWithClient(client, {
    userId: input.userId,
    agentId: input.agentId,
    delegationMode: target.delegation_mode,
    delegationBindings: target.delegation_bindings,
    projectSpaceId: current.project_space_id ?? null,
  });

  const nextVersion = current.latest_version + 1;
  const versionResult = await client.query<{ id: string }>(
    `insert into agent_versions (
       agent_id, version, instructions, model, temperature, max_iterations,
       max_duration_ms, max_output_tokens, memory_mode, memory_policy, response_format,
       output_schema, approval_policy, tool_bindings, delegation_mode,
       delegation_bindings, welcome_message, suggested_prompts,
       derived_from_version_id, change_kind
     ) values (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, $14,
       $15, $16::jsonb, $17, $18, $19, 'rollback'
     ) returning id`,
    [
      input.agentId,
      nextVersion,
      target.instructions,
      target.model,
      target.temperature,
      target.max_iterations,
      target.max_duration_ms,
      target.max_output_tokens,
      target.memory_mode,
      JSON.stringify(target.memory_policy),
      target.response_format,
      JSON.stringify(target.output_schema),
      target.approval_policy,
      JSON.stringify(target.tool_bindings),
      target.delegation_mode,
      JSON.stringify(target.delegation_bindings),
      target.welcome_message,
      JSON.stringify(target.suggested_prompts),
      target.id,
    ],
  );
  await client.query(
    `update agents
     set current_version_id = $1, latest_version = $2, updated_at = now()
     where id = $3 and user_id = $4`,
    [versionResult.rows[0].id, nextVersion, input.agentId, input.userId],
  );
  return selectAgentForUserWithClient(client, input.agentId, input.userId);
});

export const deleteAgentForUser = async (agentId: string, userId: string) => {
  return withTransaction(async (client) => {
    await client.query(
      `select pg_advisory_xact_lock(hashtextextended('agent-quota:' || $1::text, 0))`,
      [userId],
    );
    await lockAgentDelegationGraphForUser(client, userId);
    const locked = await client.query<{ id: string }>(
      `select id from agents where id = $1 and user_id = $2 for update`,
      [agentId, userId],
    );
    if (!locked.rows[0]) return false;
    await assertAgentHasNoInboundDelegationBindingsWithClient(client, agentId, userId);
    await cancelActiveAgentRunsForAgentForUserWithClient(
      client,
      agentId,
      userId,
      'Agent was deleted while a run was active',
    );
    await cancelActiveAgentEvalRunsForAgentWithClient(client, agentId, userId);
    const { rowCount } = await client.query(
      `delete from agents where id = $1 and user_id = $2`,
      [agentId, userId],
    );
    return (rowCount ?? 0) > 0;
  });
};
