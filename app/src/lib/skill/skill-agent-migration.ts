export interface AgentSkillAssignmentRow {
  agentId: string
  skillVersionId: string
  enabled: boolean
}

export interface AgentSkillMigration {
  agentId: string
  fromVersionId: string
  toVersionId: string
  enabled: boolean
}

/** Egy agentnél több régi verzió is lehet — enabled OR, minden forrás külön migrációs sor. */
export function planAgentSkillMigrations(
  assignments: AgentSkillAssignmentRow[],
  activeVersionId: string,
): AgentSkillMigration[] {
  const stale = assignments.filter((a) => a.skillVersionId !== activeVersionId)
  if (stale.length === 0) return []

  const byAgent = new Map<string, { enabled: boolean; fromVersionIds: string[] }>()
  for (const row of stale) {
    const cur = byAgent.get(row.agentId) ?? { enabled: false, fromVersionIds: [] }
    cur.enabled = cur.enabled || row.enabled
    cur.fromVersionIds.push(row.skillVersionId)
    byAgent.set(row.agentId, cur)
  }

  const migrations: AgentSkillMigration[] = []
  for (const [agentId, { enabled, fromVersionIds }] of byAgent) {
    for (const fromVersionId of fromVersionIds) {
      migrations.push({ agentId, fromVersionId, toVersionId: activeVersionId, enabled })
    }
  }
  return migrations
}

export function mergedEnabledForAgent(
  existingEnabled: boolean | undefined,
  migratedEnabled: boolean,
): boolean {
  return (existingEnabled ?? false) || migratedEnabled
}

/** Egy skillből csak a legmagasabb verziószámú hozzárendelés marad (legacy duplikátumok ellen). */
export function dedupeAgentSkillAssignments<
  T extends { skillVersion: { skill: { id: string }; version: number } },
>(assignments: T[]): T[] {
  const bySkillId = new Map<string, T>()
  for (const row of assignments) {
    const skillId = row.skillVersion.skill.id
    const existing = bySkillId.get(skillId)
    if (!existing || row.skillVersion.version > existing.skillVersion.version) {
      bySkillId.set(skillId, row)
    }
  }
  return [...bySkillId.values()]
}
