import type { AgentToolRiskLevel } from '../../../repositories/agentTools';

export type AgentApprovalPolicy = 'never' | 'writes' | 'always';
export type AgentToolPolicyDecision = 'execute' | 'approve' | 'reject';

/**
 * Resolving an approval policy across a Run tree.
 *
 * The three policies are not a single strength ladder, and treating them as one
 * is how a subagent becomes a privilege-escalation path. They vary along two
 * independent axes:
 *
 *   - how much risk may be executed at all: `never` forbids anything beyond a
 *     read, the other two permit writes once approved;
 *   - how much requires a human decision: `always` covers every call, `writes`
 *     covers non-read calls, `never` asks for nothing because it already refused
 *     the risky calls.
 *
 * Combining ancestors therefore takes the minimum permitted risk and the maximum
 * approval scope. Anything less careful lets a parent configured `never` dispatch
 * to a child configured `writes` and have the child perform a write the parent's
 * own policy forbids -- with no human ever asked.
 */

const RISK_ORDER: Record<AgentToolRiskLevel, number> = {
  read: 0,
  write: 1,
  high: 2,
};

/** Which calls a human must decide. */
export type ApprovalScope = 'none' | 'non_read' | 'all';

const SCOPE_ORDER: Record<ApprovalScope, number> = {
  none: 0,
  non_read: 1,
  all: 2,
};

export interface ResolvedToolPolicy {
  /** The highest risk level any tool in this tree may reach. */
  maxRiskLevel: AgentToolRiskLevel;
  approvalScope: ApprovalScope;
}

const policyToResolved = (policy: AgentApprovalPolicy): ResolvedToolPolicy => {
  if (policy === 'never') return { maxRiskLevel: 'read', approvalScope: 'none' };
  if (policy === 'always') return { maxRiskLevel: 'high', approvalScope: 'all' };
  return { maxRiskLevel: 'high', approvalScope: 'non_read' };
};

/**
 * Fold every policy on the path from the root down to the Run that is about to
 * call a tool. Order does not matter, so a caller may pass the chain in either
 * direction.
 */
export const resolveAgentToolPolicyChain = (
  policies: AgentApprovalPolicy[],
): ResolvedToolPolicy => {
  if (policies.length === 0) {
    // No policy at all is treated as the most restrictive option rather than the
    // most permissive: an empty chain means the caller failed to supply lineage,
    // and that must not silently widen what a tool may do.
    return { maxRiskLevel: 'read', approvalScope: 'all' };
  }
  return policies.reduce<ResolvedToolPolicy>((accumulated, policy) => {
    const current = policyToResolved(policy);
    return {
      maxRiskLevel: RISK_ORDER[current.maxRiskLevel] < RISK_ORDER[accumulated.maxRiskLevel]
        ? current.maxRiskLevel
        : accumulated.maxRiskLevel,
      approvalScope: SCOPE_ORDER[current.approvalScope] > SCOPE_ORDER[accumulated.approvalScope]
        ? current.approvalScope
        : accumulated.approvalScope,
    };
  }, policyToResolved(policies[0]));
};

export const decideAgentToolPolicyFromResolved = (
  resolved: ResolvedToolPolicy,
  riskLevel: AgentToolRiskLevel,
): AgentToolPolicyDecision => {
  if (RISK_ORDER[riskLevel] > RISK_ORDER[resolved.maxRiskLevel]) return 'reject';
  if (resolved.approvalScope === 'all') return 'approve';
  if (resolved.approvalScope === 'non_read' && riskLevel !== 'read') return 'approve';
  return 'execute';
};

/**
 * Single-policy decision, preserved so a root Run behaves exactly as before.
 */
export const decideAgentToolPolicy = (
  policy: AgentApprovalPolicy,
  riskLevel: AgentToolRiskLevel,
): AgentToolPolicyDecision => decideAgentToolPolicyFromResolved(
  policyToResolved(policy),
  riskLevel,
);

/**
 * Split resolved tools into the ones the model may see and the ones the policy
 * refuses outright.
 *
 * A refused tool used to stay in the advertised list and be rejected only after
 * the model chose it, which cost a full iteration and a round of tokens to learn
 * something the runtime already knew. Withholding it is both cheaper and clearer:
 * the model cannot plan around a capability it does not have.
 */
export const partitionToolsByPolicy = <T extends { key: string; riskLevel: AgentToolRiskLevel }>(
  tools: T[],
  resolved: ResolvedToolPolicy,
) => {
  const available: T[] = [];
  const withheld: { key: string; riskLevel: AgentToolRiskLevel }[] = [];
  for (const tool of tools) {
    if (decideAgentToolPolicyFromResolved(resolved, tool.riskLevel) === 'reject') {
      withheld.push({ key: tool.key, riskLevel: tool.riskLevel });
      continue;
    }
    available.push(tool);
  }
  return { available, withheld };
};
