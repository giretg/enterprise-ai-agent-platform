import type { AgentSkill, Prisma, Skill, SkillVersion } from '@prisma/client'
import { prisma } from '@/lib/db'
import {
  dedupeAgentSkillAssignments,
  mergedEnabledForAgent,
  planAgentSkillMigrations,
} from '@/lib/skill/skill-agent-migration'
import type {
  AddSkillVersionInput,
  AgentSkillMigration,
  AgentSkillWithVersion,
  CreateSkillInput,
  SkillRepository,
  SkillVersionActivationResult,
  SkillWithVersions,
} from '../interfaces'

async function migrateAgentAssignmentsToVersion(
  tx: Prisma.TransactionClient,
  skillId: string,
  activeVersionId: string,
  assignedById: string,
): Promise<AgentSkillMigration[]> {
  const stale = await tx.agentSkill.findMany({
    where: {
      skillVersion: { skillId },
      NOT: { skillVersionId: activeVersionId },
    },
    select: { agentId: true, skillVersionId: true, enabled: true, entry: true },
  })
  const plan = planAgentSkillMigrations(stale, activeVersionId)
  if (plan.length === 0) return []

  const byAgent = new Map<string, { enabled: boolean; entry: boolean; fromVersionIds: string[] }>()
  for (const row of stale) {
    const cur = byAgent.get(row.agentId) ?? { enabled: false, entry: false, fromVersionIds: [] }
    cur.enabled = cur.enabled || row.enabled
    cur.entry = cur.entry || row.entry
    cur.fromVersionIds.push(row.skillVersionId)
    byAgent.set(row.agentId, cur)
  }

  const migrations: AgentSkillMigration[] = []
  for (const [agentId, { enabled, entry, fromVersionIds }] of byAgent) {
    const existing = await tx.agentSkill.findUnique({
      where: { agentId_skillVersionId: { agentId, skillVersionId: activeVersionId } },
      select: { enabled: true, entry: true },
    })
    const finalEnabled = mergedEnabledForAgent(existing?.enabled, enabled)
    const finalEntry = Boolean(existing?.entry) || entry

    // Delete before upsert: the one-entry-per-agent index would reject a second entry row.
    await tx.agentSkill.deleteMany({
      where: { agentId, skillVersionId: { in: fromVersionIds } },
    })

    await tx.agentSkill.upsert({
      where: { agentId_skillVersionId: { agentId, skillVersionId: activeVersionId } },
      create: {
        agentId,
        skillVersionId: activeVersionId,
        enabled: finalEnabled,
        entry: finalEntry,
        assignedById,
      },
      update: { enabled: finalEnabled, entry: finalEntry, assignedById },
    })

    for (const fromVersionId of fromVersionIds) {
      migrations.push({
        agentId,
        fromVersionId,
        toVersionId: activeVersionId,
        enabled: finalEnabled,
      })
    }
  }

  return migrations
}

export class PostgresSkillRepository implements SkillRepository {
  async listForTenant(actorTenantId: string | null): Promise<SkillWithVersions[]> {
    // Global (tenantId null) MINDIG, a tenant-lokálisak KIZÁRÓLAG a saját tenanté
    // (fail-closed — idegen tenant skillje sosem kerül a listába).
    return prisma.skill.findMany({
      where: {
        OR: [{ tenantId: null }, ...(actorTenantId ? [{ tenantId: actorTenantId }] : [])],
      },
      orderBy: { createdAt: 'desc' },
      include: { versions: { orderBy: { version: 'desc' } } },
    })
  }

  async findById(id: string): Promise<SkillWithVersions | null> {
    return prisma.skill.findUnique({
      where: { id },
      include: { versions: { orderBy: { version: 'desc' } } },
    })
  }

  async findByNameInScope(name: string, tenantId: string | null): Promise<Skill | null> {
    const normalized = name.trim().toLowerCase()
    if (!normalized) return null
    // DB-oldali case-insensitive egyezés — ne töltsük be a tenant összes skilljét JS-be.
    return prisma.skill.findFirst({
      where: {
        tenantId,
        name: { equals: normalized, mode: 'insensitive' },
      },
    })
  }

  async findVersionById(versionId: string): Promise<(SkillVersion & { skill: Skill }) | null> {
    return prisma.skillVersion.findUnique({
      where: { id: versionId },
      include: { skill: true },
    })
  }

  async findVersionsByIds(versionIds: string[]): Promise<(SkillVersion & { skill: Skill })[]> {
    if (versionIds.length === 0) return []
    const unique = [...new Set(versionIds)]
    return prisma.skillVersion.findMany({
      where: { id: { in: unique } },
      include: { skill: true },
    })
  }

  async createSkill(input: CreateSkillInput): Promise<{ skill: Skill; version: SkillVersion }> {
    return prisma.$transaction(async (tx) => {
      const skill = await tx.skill.create({
        data: {
          name: input.name,
          displayName: input.displayName ?? null,
          description: input.description,
          catalogScope: input.catalogScope,
          tenantId: input.tenantId,
          kind: input.kind,
          sourceType: input.sourceType,
          provenance: input.provenance ?? undefined,
          license: input.license,
          riskTier: input.riskTier,
          producesSkills: input.producesSkills ?? false,
        },
      })
      const version = await tx.skillVersion.create({
        data: {
          skillId: skill.id,
          version: 1,
          content: input.content,
          requires: input.requires,
          ...(input.attachments !== undefined ? { attachments: input.attachments } : {}),
          contentHash: input.contentHash,
          status: 'proposed',
        },
      })
      return { skill, version }
    })
  }

  async updateDisplayName(skillId: string, displayName: string | null): Promise<Skill> {
    return prisma.skill.update({
      where: { id: skillId },
      data: { displayName },
    })
  }

  async updateKind(skillId: string, kind: Skill['kind']): Promise<Skill> {
    return prisma.skill.update({
      where: { id: skillId },
      data: { kind },
    })
  }

  async updateDescription(skillId: string, description: string): Promise<Skill> {
    return prisma.skill.update({
      where: { id: skillId },
      data: { description },
    })
  }

  async addVersion(input: AddSkillVersionInput): Promise<SkillVersion> {
    return prisma.$transaction(async (tx) => {
      const latest = await tx.skillVersion.findFirst({
        where: { skillId: input.skillId },
        orderBy: { version: 'desc' },
        select: { version: true },
      })
      return tx.skillVersion.create({
        data: {
          skillId: input.skillId,
          version: (latest?.version ?? 0) + 1,
          content: input.content,
          requires: input.requires,
          ...(input.attachments !== undefined ? { attachments: input.attachments } : {}),
          contentHash: input.contentHash,
          status: 'proposed',
        },
      })
    })
  }

  async approveVersion(
    versionId: string,
    params: { approverId: string },
  ): Promise<SkillVersionActivationResult> {
    return prisma.$transaction(async (tx) => {
      const target = await tx.skillVersion.findUnique({ where: { id: versionId } })
      if (!target) throw new Error('Skill version not found')

      await tx.skillVersion.updateMany({
        where: { skillId: target.skillId, status: 'active' },
        data: { status: 'retired' },
      })

      const version = await tx.skillVersion.update({
        where: { id: versionId },
        data: { status: 'active', approvedById: params.approverId },
      })

      const agentMigrations = await migrateAgentAssignmentsToVersion(
        tx,
        target.skillId,
        versionId,
        params.approverId,
      )

      return { version, agentMigrations }
    })
  }

  async rollbackToVersion(
    versionId: string,
    params: { approverId: string },
  ): Promise<SkillVersionActivationResult> {
    return prisma.$transaction(async (tx) => {
      const target = await tx.skillVersion.findUnique({ where: { id: versionId } })
      if (!target) throw new Error('Skill version not found')

      // Az aktuálisan aktív verziót rolled_back-re állítjuk (megkülönböztethető a
      // sima retire-tól), a cél-verziót újraaktiváljuk.
      await tx.skillVersion.updateMany({
        where: { skillId: target.skillId, status: 'active' },
        data: { status: 'rolled_back' },
      })

      const version = await tx.skillVersion.update({
        where: { id: versionId },
        data: { status: 'active', approvedById: params.approverId },
      })

      const agentMigrations = await migrateAgentAssignmentsToVersion(
        tx,
        target.skillId,
        versionId,
        params.approverId,
      )

      return { version, agentMigrations }
    })
  }

  async getActiveVersion(skillId: string): Promise<SkillVersion | null> {
    return prisma.skillVersion.findFirst({
      where: { skillId, status: 'active' },
      orderBy: { version: 'desc' },
    })
  }

  async retireActiveVersion(skillId: string): Promise<SkillVersion | null> {
    const active = await this.getActiveVersion(skillId)
    if (!active) return null
    return prisma.skillVersion.update({
      where: { id: active.id },
      data: { status: 'retired' },
    })
  }

  async countAssignmentsForSkill(skillId: string): Promise<number> {
    return prisma.agentSkill.count({
      where: { skillVersion: { skillId } },
    })
  }

  async detachAllAssignmentsForSkill(skillId: string): Promise<number> {
    const result = await prisma.agentSkill.deleteMany({
      where: { skillVersion: { skillId } },
    })
    return result.count
  }

  async deleteSkill(skillId: string): Promise<void> {
    await prisma.skill.delete({ where: { id: skillId } })
  }

  private async listAgentSkillRows(
    agentId: string,
    enabledOnly: boolean,
  ): Promise<AgentSkillWithVersion[]> {
    const rows = await prisma.agentSkill.findMany({
      where: { agentId, ...(enabledOnly ? { enabled: true } : {}) },
      orderBy: { createdAt: enabledOnly ? 'asc' : 'desc' },
      include: { skillVersion: { include: { skill: true } } },
    })
    const deduped = dedupeAgentSkillAssignments(rows)
    if (deduped.length < rows.length) {
      const keptIds = new Set(deduped.map((row) => row.skillVersionId))
      const pruneIds = rows
        .filter((row) => !keptIds.has(row.skillVersionId))
        .map((row) => row.skillVersionId)
      await prisma.agentSkill.deleteMany({
        where: { agentId, skillVersionId: { in: pruneIds } },
      })
    }
    return deduped
  }

  async assign(input: {
    agentId: string
    skillVersionId: string
    assignedById: string | null
  }): Promise<{ assignment: AgentSkill; replacedVersionIds: string[] }> {
    return prisma.$transaction(async (tx) => {
      const target = await tx.skillVersion.findUnique({
        where: { id: input.skillVersionId },
        select: { skillId: true },
      })
      if (!target) throw new Error('Skill version not found')

      const stale = await tx.agentSkill.findMany({
        where: {
          agentId: input.agentId,
          skillVersion: { skillId: target.skillId },
          NOT: { skillVersionId: input.skillVersionId },
        },
        select: { skillVersionId: true, entry: true },
      })
      const replacedVersionIds = stale.map((row) => row.skillVersionId)
      const entry = stale.some((row) => row.entry)

      if (replacedVersionIds.length > 0) {
        await tx.agentSkill.deleteMany({
          where: {
            agentId: input.agentId,
            skillVersionId: { in: replacedVersionIds },
          },
        })
      }

      const assignment = await tx.agentSkill.upsert({
        where: {
          agentId_skillVersionId: {
            agentId: input.agentId,
            skillVersionId: input.skillVersionId,
          },
        },
        create: {
          agentId: input.agentId,
          skillVersionId: input.skillVersionId,
          assignedById: input.assignedById,
          enabled: true,
          entry,
        },
        update: { enabled: true, assignedById: input.assignedById, ...(entry ? { entry } : {}) },
      })

      return { assignment, replacedVersionIds }
    })
  }

  async unassign(agentId: string, skillVersionId: string): Promise<void> {
    await prisma.agentSkill.deleteMany({ where: { agentId, skillVersionId } })
  }

  async setEnabled(agentId: string, skillVersionId: string, enabled: boolean): Promise<AgentSkill> {
    return prisma.agentSkill.update({
      where: { agentId_skillVersionId: { agentId, skillVersionId } },
      data: { enabled },
    })
  }

  async setEntry(agentId: string, skillVersionId: string, entry: boolean): Promise<void> {
    await prisma.$transaction(async (tx) => {
      if (entry) {
        await tx.agentSkill.updateMany({ where: { agentId, entry: true }, data: { entry: false } })
      }
      await tx.agentSkill.update({
        where: { agentId_skillVersionId: { agentId, skillVersionId } },
        data: { entry },
      })
    })
  }

  async listAgentSkills(agentId: string): Promise<AgentSkillWithVersion[]> {
    return this.listAgentSkillRows(agentId, false)
  }

  async listEnabledForAgent(agentId: string): Promise<AgentSkillWithVersion[]> {
    return this.listAgentSkillRows(agentId, true)
  }

  async findAssignment(
    agentId: string,
    skillVersionId: string,
  ): Promise<AgentSkillWithVersion | null> {
    return prisma.agentSkill.findUnique({
      where: { agentId_skillVersionId: { agentId, skillVersionId } },
      include: { skillVersion: { include: { skill: true } } },
    })
  }
}
