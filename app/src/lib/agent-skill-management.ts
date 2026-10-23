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

/** A gyártó skillre az operátori kezelés nem terjed ki: csak tenant admin. */
export function producerSkillAssignmentError(
  role: UserRole | null | undefined,
): string | null {
  if (hasMinimumRole(role, 'admin')) return null
  return 'A gyártó skillt csak tenant admin rendelheti agenthez, és csak ő kapcsolhatja be.'
}

export const PRODUCER_SKILL_TAKEN =
  'Ebben a tenantban már van gyártó skill. Második létrehozását a platform elutasítja.'

/** A jelölőt csak a katalógus admin-művelete teheti rá. Tenantonként egy. */
export function producerSkillMarkerError(input: {
  requested: boolean
  kind: 'tenant' | 'published' | 'system'
  existingProducerSkillId: string | null
  skillId?: string | null
}): string | null {
  if (!input.requested) return null
  if (input.kind !== 'tenant') return 'Gyártó skill csak tenant-skill lehet.'
  if (
    input.existingProducerSkillId &&
    input.existingProducerSkillId !== (input.skillId ?? null)
  ) {
    return PRODUCER_SKILL_TAKEN
  }
  return null
}
