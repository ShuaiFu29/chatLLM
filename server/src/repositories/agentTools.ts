import { query, withTransaction } from '../lib/db';

export type AgentToolKind = 'http' | 'mcp';
export type AgentToolRiskLevel = 'read' | 'write' | 'high';
export type AgentToolVersionChangeKind = 'created' | 'edited' | 'secret_rotated';

export interface AgentToolSecretEnvelopeAudit {
  envelopeVersion?: 1 | 2 | null;
  encryptionKeyId?: string | null;
}

/** Tool metadata plus the immutable definition selected by current_version_id. */
export interface AgentToolRow {
  id: string;
  user_id: string;
  project_space_id?: string | null;
  name: string;
  description: string;
  kind: AgentToolKind;
  risk_level: AgentToolRiskLevel;
  /** Per-run ceiling for this tool. Null means only the global ceiling applies. */
  max_invocations_per_run?: number | null;
  configuration: Record<string, unknown>;
  enabled: boolean;
  deleted_at?: string | null;
  has_secrets: boolean;
  current_version_id: string;
  latest_version: number;
  tool_version_id: string;
  tool_version: number;
  secret_version: number;
  configuration_hash: string;
  derived_from_version_id?: string | null;
  change_kind: AgentToolVersionChangeKind;
  created_at: string;
  updated_at: string;
  tool_version_created_at: string;
}

export interface AgentToolWithSecretsRow extends AgentToolRow {
  encrypted_secrets?: string | null;
}

export interface AgentToolVersionRow {
  id: string;
  tool_id: string;
  version: number;
  description: string;
  kind: AgentToolKind;
  risk_level: AgentToolRiskLevel;
  max_invocations_per_run?: number | null;
  configuration: Record<string, unknown>;
  has_secrets: boolean;
  secret_version: number;
  configuration_hash: string;
  derived_from_version_id?: string | null;
  change_kind: AgentToolVersionChangeKind;
  is_current: boolean;
  created_at: string;
}

const publicColumns = (tool = 'tool', version = 'tool_version') => `
  ${tool}.id,
  ${tool}.user_id,
  ${tool}.project_space_id,
  ${tool}.name,
  ${version}.description,
  ${version}.kind,
  ${version}.risk_level,
  ${version}.max_invocations_per_run,
  ${version}.configuration,
  ${tool}.enabled,
  ${tool}.deleted_at,
  (${version}.encrypted_secrets is not null) as has_secrets,
  ${tool}.current_version_id,
  ${tool}.latest_version,
  ${version}.id as tool_version_id,
  ${version}.version as tool_version,
  ${version}.secret_version,
  ${version}.configuration_hash,
  ${version}.derived_from_version_id,
  ${version}.change_kind,
  ${tool}.created_at,
  ${tool}.updated_at,
  ${version}.created_at as tool_version_created_at
`;

const versionColumns = `
  version.id,
  version.tool_id,
  version.version,
  version.description,
  version.kind,
  version.risk_level,
  version.max_invocations_per_run,
  version.configuration,
  (version.encrypted_secrets is not null) as has_secrets,
  version.secret_version,
  version.configuration_hash,
  version.derived_from_version_id,
  version.change_kind,
  (tool.current_version_id = version.id) as is_current,
  version.created_at
`;

const currentVersionJoin = `
  join agent_tool_versions tool_version on tool_version.id = tool.current_version_id
    and tool_version.tool_id = tool.id
`;

export const listAgentToolsForUser = async (input: {
  userId: string;
  projectSpaceId?: string;
  includeDisabled?: boolean;
}) => {
  const values: unknown[] = [input.userId];
  const conditions = ['tool.user_id = $1', 'tool.deleted_at is null'];
  if (input.projectSpaceId) {
    values.push(input.projectSpaceId);
    conditions.push(`(tool.project_space_id is null or tool.project_space_id = $${values.length})`);
  }
  if (!input.includeDisabled) conditions.push('tool.enabled = true');

  const { rows } = await query<AgentToolRow>(
    `select ${publicColumns()}
     from agent_tools tool
     ${currentVersionJoin}
     where ${conditions.join(' and ')}
     order by tool.updated_at desc, tool.id desc`,
    values,
  );
  return rows;
};

export const findAgentToolForUser = async (toolId: string, userId: string) => {
  const { rows } = await query<AgentToolRow>(
    `select ${publicColumns()}
     from agent_tools tool
     ${currentVersionJoin}
     where tool.id = $1 and tool.user_id = $2 and tool.deleted_at is null`,
    [toolId, userId],
  );
  return rows[0] || null;
};

export const findAgentToolWithSecretsForUser = async (
  toolId: string,
  userId: string,
) => {
  const { rows } = await query<AgentToolWithSecretsRow>(
    `select ${publicColumns()}, tool_version.encrypted_secrets
     from agent_tools tool
     ${currentVersionJoin}
     where tool.id = $1 and tool.user_id = $2 and tool.deleted_at is null`,
    [toolId, userId],
  );
  return rows[0] || null;
};

export const findAgentToolsForUserByIds = async (toolIds: string[], userId: string) => {
  if (toolIds.length === 0) return [];
  const { rows } = await query<AgentToolRow>(
    `select ${publicColumns()}
     from agent_tools tool
     ${currentVersionJoin}
     where tool.user_id = $1 and tool.id = any($2::uuid[]) and tool.deleted_at is null`,
    [userId, toolIds],
  );
  return rows;
};

export const findAgentToolsWithSecretsForUserByIds = async (
  toolIds: string[],
  userId: string,
) => {
  if (toolIds.length === 0) return [];
  const { rows } = await query<AgentToolWithSecretsRow>(
    `select ${publicColumns()}, tool_version.encrypted_secrets
     from agent_tools tool
     ${currentVersionJoin}
     where tool.user_id = $1 and tool.id = any($2::uuid[]) and tool.deleted_at is null`,
    [userId, toolIds],
  );
  return rows;
};

/** Load exact immutable versions, regardless of the tool's current pointer. */
export const findAgentToolVersionsForUserByIds = async (
  versionIds: string[],
  userId: string,
) => {
  if (versionIds.length === 0) return [];
  const { rows } = await query<AgentToolRow>(
    `select ${publicColumns('tool', 'tool_version')}
     from agent_tool_versions tool_version
     join agent_tools tool on tool.id = tool_version.tool_id
     where tool.user_id = $1 and tool_version.id = any($2::uuid[])`,
    [userId, versionIds],
  );
  return rows;
};

export const findAgentToolVersionsWithSecretsForUserByIds = async (
  versionIds: string[],
  userId: string,
) => {
  if (versionIds.length === 0) return [];
  const { rows } = await query<AgentToolWithSecretsRow>(
    `select ${publicColumns('tool', 'tool_version')}, tool_version.encrypted_secrets
     from agent_tool_versions tool_version
     join agent_tools tool on tool.id = tool_version.tool_id
     where tool.user_id = $1 and tool_version.id = any($2::uuid[])`,
    [userId, versionIds],
  );
  return rows;
};

export const listAgentToolVersionsForUser = async (toolId: string, userId: string) => {
  const { rows } = await query<AgentToolVersionRow>(
    `select ${versionColumns}
     from agent_tool_versions version
     join agent_tools tool on tool.id = version.tool_id
     where tool.id = $1 and tool.user_id = $2 and tool.deleted_at is null
     order by version.version desc`,
    [toolId, userId],
  );
  return rows;
};

export const findAgentToolVersionForUser = async (
  toolId: string,
  versionId: string,
  userId: string,
) => {
  const { rows } = await query<AgentToolVersionRow>(
    `select ${versionColumns}
     from agent_tool_versions version
     join agent_tools tool on tool.id = version.tool_id
     where tool.id = $1 and version.id = $2 and tool.user_id = $3 and tool.deleted_at is null`,
    [toolId, versionId, userId],
  );
  return rows[0] || null;
};

export const createAgentToolForUser = async (input: {
  toolId?: string;
  userId: string;
  projectSpaceId?: string | null;
  name: string;
  description?: string;
  kind: AgentToolKind;
  riskLevel: AgentToolRiskLevel;
  maxInvocationsPerRun?: number | null;
  configuration: Record<string, unknown>;
  encryptedSecrets?: string | null;
  secretEnvelope?: AgentToolSecretEnvelopeAudit;
  enabled?: boolean;
  maxToolsPerUser?: number;
}) => withTransaction(async (client) => {
  await client.query(
    `select pg_advisory_xact_lock(hashtextextended('agent-tool-quota:' || $1::text, 0))`,
    [input.userId],
  );
  const { rows: countRows } = await client.query<{ count: string }>(
    `select count(*)::text as count
     from agent_tools where user_id = $1 and deleted_at is null`,
    [input.userId],
  );
  if (Number(countRows[0]?.count || 0) >= (input.maxToolsPerUser ?? 100)) {
    throw new Error('AGENT_TOOL_QUOTA_EXCEEDED');
  }

  // The composite FK is deferred, so the metadata row can point at the UUID
  // inserted as version one later in this transaction.
  const toolResult = await client.query<{ id: string; current_version_id: string }>(
    `insert into agent_tools (
       id, user_id, project_space_id, name, description, kind, risk_level,
       max_invocations_per_run, configuration, encrypted_secrets, enabled,
       current_version_id, latest_version
     ) values (coalesce($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, gen_random_uuid(), 1)
     returning id, current_version_id`,
    [
      input.toolId || null,
      input.userId,
      input.projectSpaceId || null,
      input.name,
      input.description || '',
      input.kind,
      input.riskLevel,
      input.maxInvocationsPerRun ?? null,
      JSON.stringify(input.configuration),
      input.encryptedSecrets || null,
      input.enabled ?? true,
    ],
  );
  const tool = toolResult.rows[0];
  await client.query(
    `insert into agent_tool_versions (
       id, tool_id, version, description, kind, risk_level,
       max_invocations_per_run, configuration, encrypted_secrets,
       secret_version, change_kind
     ) values ($1, $2, 1, $3, $4, $5, $6, $7::jsonb, $8, 1, 'created')`,
    [
      tool.current_version_id,
      tool.id,
      input.description || '',
      input.kind,
      input.riskLevel,
      input.maxInvocationsPerRun ?? null,
      JSON.stringify(input.configuration),
      input.encryptedSecrets || null,
    ],
  );
  if (input.encryptedSecrets) {
    await client.query(
      `insert into agent_tool_secret_events (
         user_id, tool_id, tool_version_id, event_type, secret_version,
         envelope_version, encryption_key_id, metadata
       ) values ($1, $2, $3, 'configured', 1, $4, $5, '{}'::jsonb)`,
      [
        input.userId,
        tool.id,
        tool.current_version_id,
        input.secretEnvelope?.envelopeVersion ?? null,
        input.secretEnvelope?.encryptionKeyId || null,
      ],
    );
  }
  const { rows } = await client.query<AgentToolRow>(
    `select ${publicColumns()}
     from agent_tools tool
     ${currentVersionJoin}
     where tool.id = $1`,
    [tool.id],
  );
  return rows[0];
});

export const updateAgentToolForUser = async (
  toolId: string,
  userId: string,
  updates: Partial<{
    project_space_id: string | null;
    name: string;
    description: string;
    risk_level: AgentToolRiskLevel;
    max_invocations_per_run: number | null;
    configuration: Record<string, unknown>;
    encrypted_secrets: string | null;
    enabled: boolean;
  }>,
  options: {
    expectedCurrentVersionId?: string;
    secretEventType?: 'replaced' | 'cleared' | 'rewrapped';
    secretEnvelope?: AgentToolSecretEnvelopeAudit;
  } = {},
) => {
  const entries = Object.entries(updates).filter((entry) => entry[1] !== undefined);
  if (entries.length === 0) return findAgentToolForUser(toolId, userId);
  return withTransaction(async (client) => {
    await client.query(
      `select pg_advisory_xact_lock(hashtextextended('agent-tool-quota:' || $1::text, 0))`,
      [userId],
    );
    await client.query(
      `select pg_advisory_xact_lock(hashtextextended('agent-delegation:' || $1::text, 0))`,
      [userId],
    );
    await client.query(`select id from agents where user_id = $1 for update`, [userId]);
    const existingResult = await client.query<AgentToolWithSecretsRow>(
      `select ${publicColumns()}, tool_version.encrypted_secrets
       from agent_tools tool
       ${currentVersionJoin}
       where tool.id = $1 and tool.user_id = $2 and tool.deleted_at is null
       for update of tool`,
      [toolId, userId],
    );
    const existing = existingResult.rows[0];
    if (!existing) return null;
    if (
      options.expectedCurrentVersionId
      && existing.current_version_id !== options.expectedCurrentVersionId
    ) {
      throw new Error('AGENT_TOOL_VERSION_CHANGED');
    }

    if (updates.project_space_id !== undefined) {
      const boundAgents = await client.query<{ project_space_id: string | null }>(
        `select distinct agent.project_space_id
         from agents agent
         join agent_versions version
           on version.id = agent.current_version_id
           or version.id = agent.published_version_id
         cross join lateral jsonb_array_elements(version.tool_bindings) binding
         where agent.user_id = $2
           and binding ->> 'key' = 'custom:' || $1::uuid::text
           and coalesce((binding ->> 'enabled')::boolean, true)`,
        [toolId, userId],
      );
      if (boundAgents.rows.some((agent) => (
        updates.project_space_id !== null
        && agent.project_space_id !== updates.project_space_id
      ))) throw new Error('AGENT_TOOL_BINDING_SCOPE');
    }
    if (updates.enabled === false) {
      const bindingResult = await client.query<{ count: string }>(
        `select count(*)::text as count
         from agents agent
         join agent_versions version
           on version.id = agent.current_version_id
           or version.id = agent.published_version_id
         cross join lateral jsonb_array_elements(version.tool_bindings) binding
         where agent.user_id = $2
           and binding ->> 'key' = 'custom:' || $1::uuid::text
           and coalesce((binding ->> 'enabled')::boolean, true)`,
        [toolId, userId],
      );
      if (Number(bindingResult.rows[0]?.count || 0) > 0) {
        throw new Error('AGENT_TOOL_STILL_BOUND');
      }
    }

    const owns = (key: string) => Object.prototype.hasOwnProperty.call(updates, key)
      && (updates as Record<string, unknown>)[key] !== undefined;
    const definitionChanged = [
      'description',
      'risk_level',
      'max_invocations_per_run',
      'configuration',
      'encrypted_secrets',
    ].some(owns);
    let nextVersionId = existing.current_version_id;
    let nextVersion = existing.latest_version;

    if (definitionChanged) {
      nextVersion = existing.latest_version + 1;
      const secretChanged = owns('encrypted_secrets');
      const inserted = await client.query<{ id: string }>(
        `insert into agent_tool_versions (
           tool_id, version, description, kind, risk_level,
           max_invocations_per_run, configuration, encrypted_secrets,
           secret_version, derived_from_version_id, change_kind
         ) values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11)
         returning id`,
        [
          toolId,
          nextVersion,
          updates.description ?? existing.description,
          existing.kind,
          updates.risk_level ?? existing.risk_level,
          owns('max_invocations_per_run')
            ? updates.max_invocations_per_run ?? null
            : existing.max_invocations_per_run ?? null,
          JSON.stringify(updates.configuration ?? existing.configuration),
          secretChanged ? updates.encrypted_secrets ?? null : existing.encrypted_secrets ?? null,
          existing.secret_version + (secretChanged ? 1 : 0),
          existing.current_version_id,
          secretChanged ? 'secret_rotated' : 'edited',
        ],
      );
      nextVersionId = inserted.rows[0].id;
      if (secretChanged) {
        const eventType = updates.encrypted_secrets === null
          ? 'cleared'
          : options.secretEventType || 'replaced';
        await client.query(
          `insert into agent_tool_secret_events (
             user_id, tool_id, tool_version_id, event_type, secret_version,
             envelope_version, encryption_key_id, metadata
           ) values ($1, $2, $3, $4, $5, $6, $7, '{}'::jsonb)`,
          [
            userId,
            toolId,
            nextVersionId,
            eventType,
            existing.secret_version + 1,
            options.secretEnvelope?.envelopeVersion ?? null,
            options.secretEnvelope?.encryptionKeyId || null,
          ],
        );
      }
    }

    // Keep the old executable columns as compatibility mirrors. New readers
    // join current_version_id and never use these values as execution truth.
    const metadataProjectChanged = owns('project_space_id');
    await client.query(
      `update agent_tools
       set project_space_id = case when $3 then $4::uuid else project_space_id end,
           name = coalesce($5::text, name),
           enabled = coalesce($6::boolean, enabled),
           current_version_id = $7,
           latest_version = $8,
           description = $9,
           risk_level = $10,
           max_invocations_per_run = $11,
           configuration = $12::jsonb,
           encrypted_secrets = $13,
           updated_at = now()
       where id = $1 and user_id = $2`,
      [
        toolId,
        userId,
        metadataProjectChanged,
        updates.project_space_id ?? null,
        updates.name ?? null,
        updates.enabled ?? null,
        nextVersionId,
        nextVersion,
        updates.description ?? existing.description,
        updates.risk_level ?? existing.risk_level,
        owns('max_invocations_per_run')
          ? updates.max_invocations_per_run ?? null
          : existing.max_invocations_per_run ?? null,
        JSON.stringify(updates.configuration ?? existing.configuration),
        owns('encrypted_secrets')
          ? updates.encrypted_secrets ?? null
          : existing.encrypted_secrets ?? null,
      ],
    );
    const { rows } = await client.query<AgentToolRow>(
      `select ${publicColumns()}
       from agent_tools tool
       ${currentVersionJoin}
       where tool.id = $1 and tool.user_id = $2`,
      [toolId, userId],
    );
    return rows[0] || null;
  });
};

export const deleteAgentToolForUser = async (toolId: string, userId: string) => (
  withTransaction(async (client) => {
    await client.query(
      `select pg_advisory_xact_lock(hashtextextended('agent-tool-quota:' || $1::text, 0))`,
      [userId],
    );
    await client.query(
      `select pg_advisory_xact_lock(hashtextextended('agent-delegation:' || $1::text, 0))`,
      [userId],
    );
    await client.query(`select id from agents where user_id = $1 for update`, [userId]);
    const { rowCount } = await client.query(
      `update agent_tools tool
       set enabled = false, deleted_at = now(), updated_at = now()
       where tool.id = $1 and tool.user_id = $2 and tool.deleted_at is null
         and not exists (
           select 1
           from agents agent
           join agent_versions version
             on version.id = agent.current_version_id
             or version.id = agent.published_version_id
           cross join lateral jsonb_array_elements(version.tool_bindings) binding
           where agent.user_id = $2
             and binding ->> 'key' = 'custom:' || tool.id::text
             and coalesce((binding ->> 'enabled')::boolean, true)
         )`,
      [toolId, userId],
    );
    return (rowCount ?? 0) > 0;
  })
);

export const countEnabledAgentToolBindingsForUser = async (toolId: string, userId: string) => {
  const { rows } = await query<{ count: string }>(
    `select count(*)::text as count
     from agents agent
     join agent_versions version
       on version.id = agent.current_version_id
       or version.id = agent.published_version_id
     cross join lateral jsonb_array_elements(version.tool_bindings) binding
     where agent.user_id = $2
       and binding ->> 'key' = 'custom:' || $1::uuid::text
       and coalesce((binding ->> 'enabled')::boolean, true)`,
    [toolId, userId],
  );
  return Number(rows[0]?.count || 0);
};

export const listAgentToolBindingScopesForUser = async (toolId: string, userId: string) => {
  const { rows } = await query<{ agent_id: string; project_space_id: string | null }>(
    `select distinct agent.id as agent_id, agent.project_space_id
     from agents agent
     join agent_versions version
       on version.id = agent.current_version_id
       or version.id = agent.published_version_id
     cross join lateral jsonb_array_elements(version.tool_bindings) binding
     where agent.user_id = $2
       and binding ->> 'key' = 'custom:' || $1::uuid::text
       and coalesce((binding ->> 'enabled')::boolean, true)`,
    [toolId, userId],
  );
  return rows;
};
