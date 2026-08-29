export interface AgentToolSecretDraft {
  id: string;
  key: string;
  value: string;
}

export const buildAgentToolSecrets = (
  rows: ReadonlyArray<AgentToolSecretDraft>,
): Record<string, string> | undefined => {
  const active = rows.filter((row) => row.key.trim() || row.value);
  if (active.length === 0) return undefined;
  if (active.length > 32) throw new Error('too_many_secrets');
  const result: Record<string, string> = {};
  for (const row of active) {
    const key = row.key.trim();
    if (!key || !row.value) throw new Error('incomplete_secret');
    if (Object.prototype.hasOwnProperty.call(result, key)) throw new Error('duplicate_secret');
    result[key] = row.value;
  }
  return result;
};

