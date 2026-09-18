/**
 * Enterprise tool gateway.
 *
 * TODO(phase-C): registry + authorizeToolCall + execution gateway.
 * Phase 0 only establishes the module boundary.
 */
export type AuthorizeToolCallInput = {
  principalUserId: string
  tenantId: string
  agentId: string
  toolName: string
  args: Record<string, unknown>
}

export type AuthorizeToolCallResult =
  | { allowed: true }
  | { allowed: false; reason: string }

export function authorizeToolCall(
  _input: AuthorizeToolCallInput,
): Promise<AuthorizeToolCallResult> {
  return Promise.reject(new Error('TODO(phase-C): authorizeToolCall is not implemented'))
}
