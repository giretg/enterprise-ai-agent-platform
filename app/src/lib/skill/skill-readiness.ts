import type { SkillRequirement } from './skill-content'

/**
 * Readiness-check (spec §D10, WP-4). Hozzárendeléskor jelzi, hogy egy skill
 * `requires` capability-igényei mennyire teljesülnek az agenten — de JOGOT NEM
 * ad: a capability-grant külön, magasabb jogú admin-aktus (kemény padló). A skill
 * sosem bővítheti a saját hatáskörét.
 *
 * Színek:
 *   - green:  minden igényelt tool engedélyezett capability az agenten.
 *   - yellow: van hiányzó tool, DE a tool ismert (van connector) → grant-elhető.
 *   - red:    van olyan igényelt tool, amihez EGYÁLTALÁN nincs connector →
 *             a skill nem működőképes, amíg nincs orvosolva.
 */
export type SkillReadinessColor = 'green' | 'yellow' | 'red'

export type SkillRequirementStatus =
  | 'satisfied' // engedélyezett capability
  | 'grantable' // nincs engedélyezve, de van hozzá connector
  | 'unavailable' // nincs connector — nem grant-elhető, amíg nincs kiépítve

export interface SkillReadinessItem {
  toolName: string
  reason: string
  status: SkillRequirementStatus
}

export interface SkillReadiness {
  color: SkillReadinessColor
  items: SkillReadinessItem[]
  missingCount: number
  unavailableCount: number
}

export function computeSkillReadiness(
  requires: SkillRequirement[],
  input: {
    /** Az agenten `allowed=true` capability tool-nevek. */
    allowedTools: ReadonlySet<string>
    /** A tenantban ismert (connectorral kiépíthető) tool-nevek. */
    knownTools: ReadonlySet<string>
  },
): SkillReadiness {
  const items: SkillReadinessItem[] = requires.map((req) => {
    let status: SkillRequirementStatus
    if (input.allowedTools.has(req.toolName)) {
      status = 'satisfied'
    } else if (input.knownTools.has(req.toolName)) {
      status = 'grantable'
    } else {
      status = 'unavailable'
    }
    return { toolName: req.toolName, reason: req.reason, status }
  })

  const unavailableCount = items.filter((i) => i.status === 'unavailable').length
  const missingCount = items.filter((i) => i.status !== 'satisfied').length

  let color: SkillReadinessColor
  if (unavailableCount > 0) color = 'red'
  else if (missingCount > 0) color = 'yellow'
  else color = 'green'

  return { color, items, missingCount, unavailableCount }
}
