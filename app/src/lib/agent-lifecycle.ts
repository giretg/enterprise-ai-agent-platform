import type { AgentStatus } from '@prisma/client'

/**
 * Agent életciklus-állapotgép (Agent Registry feature-spec §4).
 *
 *   ●→ draft ──activate──▶ active ◀──resume── suspended
 *                            │ │ │
 *              suspend ──────┘ │ └────── retire ──▶ retired (terminális)
 *                              └── retire ─────────▶ retired
 *
 * Minden átmenet RBAC-kapuzott és auditált a szolgáltatás-rétegben; itt csak a
 * megengedett átmenetek halmazát és a dispatchelhetőséget definiáljuk, hogy a
 * szabály egy helyen, tesztelhetően éljen.
 */
export const AGENT_STATUS_TRANSITIONS: Record<AgentStatus, AgentStatus[]> = {
  draft: ['active'],
  active: ['suspended', 'retired'],
  suspended: ['active', 'retired'],
  retired: [],
}

export function canTransition(from: AgentStatus, to: AgentStatus): boolean {
  return AGENT_STATUS_TRANSITIONS[from]?.includes(to) ?? false
}

export function assertTransition(from: AgentStatus, to: AgentStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid agent lifecycle transition: ${from} → ${to}`)
  }
}

/** I1 (§8): kizárólag `active` agent dispatchelhető. */
export function isDispatchable(status: AgentStatus): boolean {
  return status === 'active'
}

/** MCP-n csak közzétett ÉS aktív munkatárs látszik — ez a „Használható” kapcsoló. */
export function isAvailableOnMcp(agent: {
  status: AgentStatus
  currentDefinitionVersionId: string | null
}): boolean {
  return Boolean(agent.currentDefinitionVersionId) && isDispatchable(agent.status)
}

/**
 * I3 (§8): aktivált/nyugdíjazott agent fizikailag nem törölhető (audit-megőrzés) —
 * csak snapshot nélküli `draft` törölhető, minden más csak `retire`-elhető.
 */
export function isPhysicallyDeletable(status: AgentStatus): boolean {
  return status === 'draft'
}
