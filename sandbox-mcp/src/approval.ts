// Tools that always require explicit approval before execution.
// read_log is read-only and does not require approval.
const ALWAYS_REQUIRE_APPROVAL: ReadonlySet<string> = new Set(['run_bash', 'git_op']);

/**
 * Returns true if this tool requires approval before it may run.
 * Called by tool handlers to decide whether to check the gate.
 */
export function requiresApproval(toolName: string): boolean {
  return ALWAYS_REQUIRE_APPROVAL.has(toolName);
}

/**
 * Checks whether a tool call is currently permitted.
 *
 * Phase 1: reads AUTO_APPROVE_TOOLS env var. Default is deny.
 *
 * Phase 4 upgrade path: replace this function body with a queue +
 * push notification to the mobile UI, waiting for Approve/Deny.
 * Call sites in the tools do not need to change for that upgrade.
 *
 * @returns 'allow' if the call should proceed, 'deny' with a reason otherwise.
 */
export function checkApprovalGate(
  toolName: string,
  autoApproveTools: string[],
): { decision: 'allow' } | { decision: 'deny'; reason: string } {
  if (!requiresApproval(toolName)) {
    return { decision: 'allow' };
  }

  if (autoApproveTools.includes(toolName)) {
    return { decision: 'allow' };
  }

  return {
    decision: 'deny',
    reason:
      `Tool '${toolName}' requires explicit approval. ` +
      `In Phase 1, add '${toolName}' to AUTO_APPROVE_TOOLS env var for local dev. ` +
      `In production, use the Approval Gate UI (Phase 4).`,
  };
}
