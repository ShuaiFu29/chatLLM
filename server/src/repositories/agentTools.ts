import { query, withTransaction } from '../lib/db';

export type AgentToolKind = 'http' | 'mcp';
export type AgentToolRiskLevel = 'read' | 'write' | 'high';

export interface AgentToolRow {
  id: string;
  user_id: string;
  project_space_id?: string | null;
  name: string;
  description: string;
  kind: AgentToolKind;
  risk_level: AgentToolRiskLevel;
  configuration: Record<string, unknown>;
  enabled: boolean;
  has_secrets: boolean;
  created_at: string;
  updated_at: string;
}

export interface AgentToolWithSecretsRow extends AgentToolRow {
  encrypted_secrets?: string | null;
}

const publicColumns = `
  id,
  user_id,
  project_space_id,
  name,
  description,
  kind,
  risk_level,
  configuration,
  enabled,
  (encrypted_secrets is not null) as has_secrets,
  created_at,
  updated_at
`;

export const listAgentToolsForUser = async (input: {
  userId: string;
  projectSpaceId?: string;
  includeDisabled?: boolean;
}) => {
  const values: unknown[] = [input.userId];
  const conditions = ['user_id = $1'];
  if (input.projectSpaceId) {
    values.push(input.projectSpaceId);
    conditions.push(`(project_space_id is null or project_space_id = $${values.length})`);
  }
  if (!input.includeDisabled) conditions.push('enabled = true');

  const { rows } = await query<AgentToolRow>(
    `select ${publicColumns}
     from agent_tools
     where ${conditions.join(' and ')}
     order by updated_at desc, id desc`,
    values,
  );
  return rows;
};

export const findAgentToolForUser = async (toolId: string, userId: string) => {
  const { rows } = await query<AgentToolRow>(
    `select ${publicColumns}
     from agent_tools
     where id = $1 and user_id = $2`,
    [toolId, userId],
  );
  return rows[0] || null;
};

export const findAgentToolWithSecretsForUser = async (
  toolId: string,
  userId: string,
) => {
  const { rows } = await query<AgentToolWithSecretsRow>(
    `select ${publicColumns}, encrypted_secrets
     from agent_tools
     where id = $1 and user_id = $2`,
    [toolId, userId],
  );
  return rows[0] || null;
};

export const findAgentToolsForUserByIds = async (
  toolIds: string[],
  userId: string,
) => {
  if (toolIds.length === 0) return [];
  const { rows } = await query<AgentToolRow>(
    `select ${publicColumns}
     from agent_tools
     where user_id = $1 and id = any($2::uuid[])`,
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
    `select ${publicColumns}, encrypted_secrets
     from agent_tools
     where user_id = $1 and id = any($2::uuid[])`,
    [userId, toolIds],
  );
  return rows;
};

export const createAgentToolForUser = async (input: {
  userId: string;
  projectSpaceId?: string | null;
  name: string;
  description?: string;
  kind: AgentToolKind;
  riskLevel: AgentToolRiskLevel;
  configuration: Record<string, unknown>;
  encryptedSecrets?: string | null;
  enabled?: boolean;
  maxToolsPerUser?: number;
}) => {
  return withTransaction(async (client) => {
    await client.query(
      `select pg_advisory_xact_lock(hashtextextended('agent-tool-quota:' || $1::text, 0))`,
      [input.userId],
    );
    const { rows: countRows } = await client.query<{ count: string }>(
      `select count(*)::text as count from agent_tools where user_id = $1`,
      [input.userId],
    );
    if (Number(countRows[0]?.count || 0) >= (input.maxToolsPerUser ?? 100)) {
      throw new Error('AGENT_TOOL_QUOTA_EXCEEDED');
    }
    const { rows } = await client.query<AgentToolRow>(
    `insert into agent_tools (
       user_id, project_space_id, name, description, kind, risk_level,
       configuration, encrypted_secrets, enabled
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     returning ${publicColumns}`,
    [
      input.userId,
      input.projectSpaceId || null,
      input.name,
      input.description || '',
      input.kind,
      input.riskLevel,
      JSON.stringify(input.configuration),
      input.encryptedSecrets || null,
      input.enabled ?? true,
    ],
    );
    return rows[0];
  });
};

export const updateAgentToolForUser = async (
  toolId: string,
  userId: string,
  updates: Partial<{
    project_space_id: string | null;
    name: string;
    description: string;
    risk_level: AgentToolRiskLevel;
    configuration: Record<string, unknown>;
    encrypted_secrets: string | null;
    enabled: boolean;
  }>,
) => {
  const entries = Object.entries(updates).filter((entry) => entry[1] !== undefined);
  if (entries.length === 0) return findAgentToolForUser(toolId, userId);
  return withTransaction(async (client) => {
    await client.query(
      `select pg_advisory_xact_lock(hashtextextended('agent-tool-quota:' || $1::text, 0))`,
      [userId],
    );
    // Match Agent version updates: lock all user Agents before the tool.
    await client.query(`select id from agents where user_id = $1 for update`, [userId]);
    const existing = await client.query<{ id: string }>(
      `select id, project_space_id from agent_tools where id = $1 and user_id = $2 for update`,
      [toolId, userId],
    );
    if (!existing.rows[0]) return null;

    // The service performs an early validation for a fast error response, but
    // the authoritative scope check must run inside this transaction. Agent
    // version updates and tool mutations use the same lock order (all user
    // agents, then the tool), so this prevents a concurrent Agent update from
    // creating an out-of-scope binding between the check and the write.
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
      ))) {
        throw new Error('AGENT_TOOL_BINDING_SCOPE');
      }
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
    const values: unknown[] = [];
    const assignments = entries.map(([key, rawValue]) => {
      const value = key === 'configuration' ? JSON.stringify(rawValue) : rawValue;
      values.push(value);
      return `${key} = $${values.length}`;
    });
    values.push(toolId, userId);
    const { rows } = await client.query<AgentToolRow>(
      `update agent_tools
       set ${assignments.join(', ')}, updated_at = now()
       where id = $${values.length - 1} and user_id = $${values.length}
       returning ${publicColumns}`,
      values,
    );
    return rows[0] || null;
  });
};

export const deleteAgentToolForUser = async (toolId: string, userId: string) => {
  return withTransaction(async (client) => {
    await client.query(
      `select pg_advisory_xact_lock(hashtextextended('agent-tool-quota:' || $1::text, 0))`,
      [userId],
    );
    // Serialize deletion with Agent version updates using the same lock order.
    await client.query(
      `select id from agents where user_id = $1 for update`,
      [userId],
    );
    const toolResult = await client.query<{ id: string }>(
      `select id from agent_tools where id = $1 and user_id = $2 for update`,
      [toolId, userId],
    );
    if (!toolResult.rows[0]) return false;

    const { rowCount } = await client.query(
      `delete from agent_tools tool
       where tool.id = $1 and tool.user_id = $2
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
  });
};

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
