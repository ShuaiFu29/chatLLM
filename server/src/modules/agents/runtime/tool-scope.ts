/**
 * A custom tool is either global (usable by any Agent owned by the user) or
 * pinned to exactly one project. Project-scoped tools must never be reachable
 * from a global Agent or from an Agent in a different project.
 */
export const isAgentToolInProjectScope = (
  toolProjectSpaceId: string | null | undefined,
  agentProjectSpaceId: string | null | undefined,
) => (
  !toolProjectSpaceId || toolProjectSpaceId === agentProjectSpaceId
);
