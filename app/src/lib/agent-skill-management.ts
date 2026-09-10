import type { UserRole } from '@prisma/client'
import { hasMinimumRole } from '@/lib/iam-policy'

/**
 * Ki kezelheti egy agent skill-hozzárendeléseit (hozzárendel / levesz / ki-bekapcsol)?
 *
 * Alap: tenant admin. Az admin agentenként DELEGÁLHATJA ezt az operátornak
 * (`Agent.operatorCanManageSkills`) — ilyenkor az operátor is választhat a már
 * jóváhagyott, aktív skillek közül EZEN az agenten. Amit a delegálás NEM ad:
 * skill-tartalom szerkesztést, új verzió jóváhagyását, sem capability-grantot —
 * a skill „ereje" továbbra is az agentnek adott eszközjogokból jön.
 *
 * Egy forrás, egy igazság: a server action kapuja és a UI `canEdit` ugyanezt hívja,
 * így nem tudnak szétcsúszni. Fail-closed: hiányzó szerep → nem kezelheti.
 */
export function canManageAgentSkills(
  role: UserRole | null | undefined,
  operatorCanManageSkills: boolean,
): boolean {
  if (hasMinimumRole(role, 'admin')) return true
  return operatorCanManageSkills && hasMinimumRole(role, 'operator')
}
