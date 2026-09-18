/**
 * Agent-turn API hozzáférés (spec §6.2–6.4 / E9): tenant + létrehozó egyezés.
 */
export type AgentTurnAccessSubject = {
  tenantId: string | null
  createdById: string
}

export type AgentTurnAccessActor = {
  activeTenantId: string | null
  user: { id: string }
}

export function isAgentTurnAccessible(
  turn: AgentTurnAccessSubject,
  actor: AgentTurnAccessActor,
): boolean {
  if (turn.tenantId !== actor.activeTenantId) return false
  if (turn.createdById !== actor.user.id) return false
  return true
}
