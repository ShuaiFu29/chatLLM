import { isDeepStrictEqual } from 'node:util';
import {
  AgentVersionRow,
  agentVersionConfigurationKeys,
} from '../../repositories/agents';

export interface AgentVersionFieldChange {
  field: (typeof agentVersionConfigurationKeys)[number];
  before: AgentVersionRow[(typeof agentVersionConfigurationKeys)[number]];
  after: AgentVersionRow[(typeof agentVersionConfigurationKeys)[number]];
}

/**
 * Produce a semantic field-level diff. JSON object key insertion order is not
 * configuration meaning, so deep comparison is used instead of stringifying
 * the values returned by PostgreSQL jsonb.
 */
export const buildAgentVersionDiff = (base: AgentVersionRow, target: AgentVersionRow) => {
  const changes = agentVersionConfigurationKeys.flatMap<AgentVersionFieldChange>((field) => {
    if (isDeepStrictEqual(base[field], target[field])) return [];
    return [{ field, before: base[field], after: target[field] }];
  });
  return {
    from: {
      id: base.id,
      version: base.version,
      configuration_hash: base.configuration_hash,
    },
    to: {
      id: target.id,
      version: target.version,
      configuration_hash: target.configuration_hash,
    },
    changed_fields: changes.map((change) => change.field),
    changes,
  };
};
