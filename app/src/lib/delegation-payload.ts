export type DelegationPayload = {
  requesterAgentId: string
  parentTicketId: string | null
  question: string
}

export function readDelegationPayload(
  payload: Record<string, unknown> | null,
): DelegationPayload | null {
  if (!payload?.delegation) return null
  const requesterAgentId =
    typeof payload.requesterAgentId === 'string' ? payload.requesterAgentId.trim() : ''
  if (!requesterAgentId) return null
  return {
    requesterAgentId,
    parentTicketId:
      typeof payload.parentTicketId === 'string' ? payload.parentTicketId : null,
    question: typeof payload.question === 'string' ? payload.question : '',
  }
}

export function shouldCompleteDelegation(
  payload: Record<string, unknown>,
  actingAgentId: string,
  assigneeId: string | null,
  patch: {
    state?: string
    payload?: Record<string, unknown>
  },
): boolean {
  const delegation = readDelegationPayload(payload)
  if (!delegation) return false
  if (payload.delegationReturned === true) return false
  if (actingAgentId === delegation.requesterAgentId) return false
  if (assigneeId !== actingAgentId) return false

  const patchPayload = patch.payload
  const hasAnswer =
    patchPayload &&
    typeof patchPayload.answer === 'string' &&
    patchPayload.answer.trim().length > 0
  const terminalState = patch.state === 'done' || patch.state === 'awaiting_human'
  return hasAnswer || terminalState
}
