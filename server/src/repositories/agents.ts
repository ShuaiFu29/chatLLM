import type { PoolClient } from 'pg';
import { query, withTransaction } from '../lib/db';

export type AgentVisibility = 'private' | 'project';
export type AgentStatus = 'draft' | 'published' | 'disabled';
export type AgentMemoryMode = 'none' | 'conversation' | 'user' | 'project';
export type AgentResponseFormat = 'markdown' | 'json';
export type AgentApprovalPolicy = 'never' | 'writes' | 'always';

export interface AgentToolBinding {
  key: string;
  enabled: boolean;
  configuration?: Record<string, unknown>;
}

export interface AgentVersionConfiguration {
  instructions: string;
  model: string;
  temperature: number;
  max_iterations: number;
  max_duration_ms: number;
  max_output_tokens: number;
  memory_mode: AgentMemoryMode;
  response_format: AgentResponseFormat;
  output_schema: Record<string, unknown>;
  approval_policy: AgentApprovalPolicy;
  tool_bindings: AgentToolBinding[];
  welcome_message: string;
  suggested_prompts: string[];
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
  current_version.response_format,
  current_version.output_schema,
  current_version.approval_policy,
  current_version.tool_bindings,
  current_version.welcome_message,
  current_version.suggested_prompts,
  current_version.created_at as version_created_at,
  published_version.version as published_version,
  (a.current_version_id is distinct from a.published_version_id) as has_unpublished_changes
`;

const agentDetailJoins = `
  join agent_versions current_version on current_version.id = a.current_version_id
  left join agent_versions published_version on published_version.id = a.published_version_id
`;

const versionColumns = `
  id,
  agent_id,
  version,
  instructions,
  model,
  temperature,
  max_iterations,
  max_duration_ms,
  max_output_tokens,
  memory_mode,
  response_format,
  output_schema,
  approval_policy,
  tool_bindings,
  welcome_message,
  suggested_prompts,
  created_at
`;

const CUSTOM_TOOL_KEY = /^custom:([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

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

export const createAgentForUser = async (input: CreateAgentInput) => withTransaction(
  async (client) => {
    await client.query(
      `select pg_advisory_xact_lock(hashtextextended('agent-quota:' || $1::text, 0))`,
      [input.userId],
    );
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

    const versionResult = await client.query<{ id: string }>(
      `insert into agent_versions (
         agent_id, version, instructions, model, temperature, max_iterations,
         max_duration_ms, max_output_tokens, memory_mode, response_format,
         output_schema, approval_policy, tool_bindings, welcome_message,
         suggested_prompts
       ) values (
         $1, 1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14
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
        input.response_format,
        JSON.stringify(input.output_schema),
        input.approval_policy,
        JSON.stringify(input.tool_bindings),
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
    if (nextVersion > (input.maxVersionsPerAgent ?? 100)) {
      throw new Error('AGENT_VERSION_QUOTA_EXCEEDED');
    }
    const configuration: AgentVersionConfiguration = {
      instructions: input.version.instructions ?? current.instructions,
      model: input.version.model ?? current.model,
      temperature: input.version.temperature ?? current.temperature,
      max_iterations: input.version.max_iterations ?? current.max_iterations,
      max_duration_ms: input.version.max_duration_ms ?? current.max_duration_ms,
      max_output_tokens: input.version.max_output_tokens ?? current.max_output_tokens,
      memory_mode: input.version.memory_mode ?? current.memory_mode,
      response_format: input.version.response_format ?? current.response_format,
      output_schema: input.version.output_schema ?? current.output_schema,
      approval_policy: input.version.approval_policy ?? current.approval_policy,
      tool_bindings: input.version.tool_bindings ?? current.tool_bindings,
      welcome_message: input.version.welcome_message ?? current.welcome_message,
      suggested_prompts: input.version.suggested_prompts ?? current.suggested_prompts,
    };

    const customToolIds = configuration.tool_bindings
      .filter((binding) => binding.enabled !== false)
      .flatMap((binding) => {
        const match = CUSTOM_TOOL_KEY.exec(binding.key);
        return match ? [match[1]] : [];
      });
    if (customToolIds.length > 0) {
      const toolResult = await client.query<{ id: string; project_space_id: string | null }>(
        `select id, project_space_id, enabled from agent_tools
         where user_id = $1 and id = any($2::uuid[])
           and enabled = true
         for update`,
        [input.userId, customToolIds],
      );
      if (toolResult.rows.length !== new Set(customToolIds).size) {
        throw new Error('AGENT_TOOL_BINDING_UNAVAILABLE');
      }
      const effectiveProjectSpaceId = input.metadata.project_space_id !== undefined
        ? input.metadata.project_space_id
        : current.project_space_id;
      if (toolResult.rows.some((tool) => (
        tool.project_space_id && tool.project_space_id !== effectiveProjectSpaceId
      ))) {
        throw new Error('AGENT_TOOL_BINDING_SCOPE');
      }
    }

    const versionResult = await client.query<{ id: string }>(
      `insert into agent_versions (
         agent_id, version, instructions, model, temperature, max_iterations,
         max_duration_ms, max_output_tokens, memory_mode, response_format,
         output_schema, approval_policy, tool_bindings, welcome_message,
         suggested_prompts
       ) values (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15
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
        configuration.response_format,
        JSON.stringify(configuration.output_schema),
        configuration.approval_policy,
        JSON.stringify(configuration.tool_bindings),
        configuration.welcome_message,
        JSON.stringify(configuration.suggested_prompts),
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

export const publishAgentForUser = async (agentId: string, userId: string) => {
  const { rows } = await query<{ id: string }>(
    `update agents
     set published_version_id = current_version_id,
         status = 'published',
         updated_at = now()
     where id = $1 and user_id = $2 and current_version_id is not null
     returning id`,
    [agentId, userId],
  );
  if (rows.length === 0) return null;
  return findAgentForUser(agentId, userId);
};

export const setAgentDisabledForUser = async (
  agentId: string,
  userId: string,
  disabled: boolean,
) => {
  const { rows } = await query<{ id: string }>(
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
  return findAgentForUser(agentId, userId);
};

export const listAgentVersionsForUser = async (agentId: string, userId: string) => {
  const { rows } = await query<AgentVersionRow>(
    `select ${versionColumns}
     from agent_versions
     where agent_id = $1
       and exists (
         select 1 from agents where id = $1 and user_id = $2
       )
     order by version desc`,
    [agentId, userId],
  );
  return rows;
};

export const deleteAgentForUser = async (agentId: string, userId: string) => {
  return withTransaction(async (client) => {
    await client.query(
      `select pg_advisory_xact_lock(hashtextextended('agent-quota:' || $1::text, 0))`,
      [userId],
    );
    const { rowCount } = await client.query(
      `delete from agents where id = $1 and user_id = $2`,
      [agentId, userId],
    );
    return (rowCount ?? 0) > 0;
  });
};
