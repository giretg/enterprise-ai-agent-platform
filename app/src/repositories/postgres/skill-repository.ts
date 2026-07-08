import type { AgentSkill, Skill, SkillVersion } from '@prisma/client'
import { prisma } from '@/lib/db'
import type {
  AddSkillVersionInput,
  AgentSkillWithVersion,
  CreateSkillInput,
  SkillRepository,
  SkillWithVersions,
} from '../interfaces'

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

  async findVersionById(versionId: string): Promise<(SkillVersion & { skill: Skill }) | null> {
    return prisma.skillVersion.findUnique({
      where: { id: versionId },
      include: { skill: true },
    })
  }

  async createSkill(input: CreateSkillInput): Promise<{ skill: Skill; version: SkillVersion }> {
    return prisma.$transaction(async (tx) => {
      const skill = await tx.skill.create({
        data: {
          name: input.name,
          description: input.description,
          catalogScope: input.catalogScope,
          tenantId: input.tenantId,
          sourceType: input.sourceType,
          provenance: input.provenance ?? undefined,
          license: input.license,
          riskTier: input.riskTier,
        },
      })
      const version = await tx.skillVersion.create({
        data: {
          skillId: skill.id,
          version: 1,
          content: input.content,
          requires: input.requires,
          contentHash: input.contentHash,
          status: 'proposed',
        },
      })
      return { skill, version }
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
          contentHash: input.contentHash,
          status: 'proposed',
        },
      })
    })
  }

  async approveVersion(
    versionId: string,
    params: { approverId: string; signature: string },
  ): Promise<SkillVersion> {
    return prisma.$transaction(async (tx) => {
      const target = await tx.skillVersion.findUnique({ where: { id: versionId } })
      if (!target) throw new Error('Skill version not found')

      await tx.skillVersion.updateMany({
        where: { skillId: target.skillId, status: 'active' },
        data: { status: 'retired' },
      })

      return tx.skillVersion.update({
        where: { id: versionId },
        data: { status: 'active', approvedById: params.approverId, signature: params.signature },
      })
    })
  }

  async rollbackToVersion(
    versionId: string,
    params: { approverId: string; signature: string },
  ): Promise<SkillVersion> {
    return prisma.$transaction(async (tx) => {
      const target = await tx.skillVersion.findUnique({ where: { id: versionId } })
      if (!target) throw new Error('Skill version not found')

      // Az aktuálisan aktív verziót rolled_back-re állítjuk (megkülönböztethető a
      // sima retire-tól), a cél-verziót újraaktiváljuk.
      await tx.skillVersion.updateMany({
        where: { skillId: target.skillId, status: 'active' },
        data: { status: 'rolled_back' },
      })

      return tx.skillVersion.update({
        where: { id: versionId },
        data: { status: 'active', approvedById: params.approverId, signature: params.signature },
      })
    })
  }

  async getActiveVersion(skillId: string): Promise<SkillVersion | null> {
    return prisma.skillVersion.findFirst({
      where: { skillId, status: 'active' },
      orderBy: { version: 'desc' },
    })
  }

  async assign(input: {
    agentId: string
    skillVersionId: string
    assignedById: string | null
  }): Promise<AgentSkill> {
    return prisma.agentSkill.upsert({
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
      },
      update: { enabled: true, assignedById: input.assignedById },
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

  async listAgentSkills(agentId: string): Promise<AgentSkillWithVersion[]> {
    return prisma.agentSkill.findMany({
      where: { agentId },
      orderBy: { createdAt: 'desc' },
      include: { skillVersion: { include: { skill: true } } },
    })
  }

  async listEnabledForAgent(agentId: string): Promise<AgentSkillWithVersion[]> {
    return prisma.agentSkill.findMany({
      where: { agentId, enabled: true },
      orderBy: { createdAt: 'asc' },
      include: { skillVersion: { include: { skill: true } } },
    })
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
