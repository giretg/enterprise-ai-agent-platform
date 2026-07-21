import type { UserRole } from '@prisma/client'
import { meetsMinRole } from '@/lib/iam-policy'

/**
 * Operator-láthatóság: tenant admin elrejtheti az agentet az operátorok
 * (és a többi nem-admin szerep) elől anélkül, hogy a futást megállítaná.
 * A dispatchelhetőség továbbra is csak az `AgentStatus`-tól függ.
 */
export function canViewAgent(
  role: UserRole,
  agent: { hiddenFromOperators: boolean },
): boolean {
  if (!agent.hiddenFromOperators) return true
  return meetsMinRole(role, 'admin')
}

/** Listázáskor: non-admin szerepeknek ki kell szűrni a rejtett agenteket. */
export function shouldExcludeHiddenAgents(role: UserRole): boolean {
  return !meetsMinRole(role, 'admin')
}
