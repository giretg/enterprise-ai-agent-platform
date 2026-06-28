import type { PlaybookV2, PlaybookVersionV2, PlaybookAssignment, Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import type {
  CreatePlaybookAssignmentInput,
  CreatePlaybookV2Input,
  CreatePlaybookVersionV2Input,
  PlaybookV2Repository,
  PlaybookV2WithVersions,
} from '../interfaces'

export class PostgresPlaybookV2Repository implements PlaybookV2Repository {
  async createPlaybook(input: CreatePlaybookV2Input): Promise<PlaybookV2> {
    return prisma.playbookV2.create({
      data: {
        tenantId: input.tenantId,
        key: input.key,
        name: input.name,
        description: input.description ?? null,
        processType: input.processType,
        ownerUserId: input.ownerUserId ?? null,
      },
    })
  }

  async findPlaybook(tenantId: string | null, id: string): Promise<PlaybookV2 | null> {
    return prisma.playbookV2.findFirst({ where: { id, tenantId } })
  }

  async findPlaybookByKey(tenantId: string | null, key: string): Promise<PlaybookV2 | null> {
    return prisma.playbookV2.findFirst({ where: { key, tenantId } })
  }

  async listPlaybooks(tenantId: string | null): Promise<PlaybookV2WithVersions[]> {
    return prisma.playbookV2.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      include: { versions: { orderBy: { version: 'desc' } } },
    })
  }

  async updatePlaybook(
    id: string,
    data: Partial<{
      status: PlaybookV2['status']
      currentPublishedVersionId: string | null
      archivedAt: Date | null
    }>,
  ): Promise<PlaybookV2> {
    return prisma.playbookV2.update({ where: { id }, data })
  }

  async createVersion(input: CreatePlaybookVersionV2Input): Promise<PlaybookVersionV2> {
    return prisma.playbookVersionV2.create({
      data: {
        tenantId: input.tenantId,
        playbookId: input.playbookId,
        version: input.version,
        spec: input.spec,
        changeSummary: input.changeSummary,
        contentHash: input.contentHash,
        validationResult: input.validationResult,
        createdById: input.createdById,
      },
    })
  }

  async findVersion(tenantId: string | null, id: string): Promise<PlaybookVersionV2 | null> {
    return prisma.playbookVersionV2.findFirst({ where: { id, tenantId } })
  }

  async findVersionByContentHash(
    tenantId: string | null,
    playbookId: string,
    contentHash: string,
  ): Promise<PlaybookVersionV2 | null> {
    return prisma.playbookVersionV2.findFirst({ where: { tenantId, playbookId, contentHash } })
  }

  async listVersions(playbookId: string): Promise<PlaybookVersionV2[]> {
    return prisma.playbookVersionV2.findMany({
      where: { playbookId },
      orderBy: { version: 'desc' },
    })
  }

  async nextVersionNumber(playbookId: string): Promise<number> {
    const last = await prisma.playbookVersionV2.findFirst({
      where: { playbookId },
      orderBy: { version: 'desc' },
      select: { version: true },
    })
    return (last?.version ?? 0) + 1
  }

  async updateVersion(
    id: string,
    data: Partial<{
      status: PlaybookVersionV2['status']
      validationResult: Prisma.InputJsonValue
      compiledSpec: Prisma.InputJsonValue
      approvedById: string | null
      approvedAt: Date | null
      publishedAt: Date | null
      retiredAt: Date | null
    }>,
  ): Promise<PlaybookVersionV2> {
    return prisma.playbookVersionV2.update({ where: { id }, data })
  }

  async publishVersion(input: {
    versionId: string
    playbookId: string
    approverId: string
    compiledSpec: Prisma.InputJsonValue
  }): Promise<PlaybookVersionV2> {
    return prisma.$transaction(async (tx) => {
      const now = new Date()
      // §4.3 — a korábbi published verziókat retire-eljük (egy aktív published verzió).
      await tx.playbookVersionV2.updateMany({
        where: { playbookId: input.playbookId, status: 'published' },
        data: { status: 'retired', retiredAt: now },
      })

      const published = await tx.playbookVersionV2.update({
        where: { id: input.versionId },
        data: {
          status: 'published',
          approvedById: input.approverId,
          approvedAt: now,
          publishedAt: now,
          compiledSpec: input.compiledSpec,
        },
      })

      await tx.playbookV2.update({
        where: { id: input.playbookId },
        data: { status: 'published', currentPublishedVersionId: published.id },
      })

      return published
    })
  }

  async createAssignment(input: CreatePlaybookAssignmentInput): Promise<PlaybookAssignment> {
    return prisma.$transaction(async (tx) => {
      if (input.isDefault) {
        // Egy aktív default a (tenant, type, key) párra (§4.4).
        await tx.playbookAssignment.updateMany({
          where: {
            tenantId: input.tenantId,
            assignmentType: input.assignmentType,
            assignmentKey: input.assignmentKey,
            isDefault: true,
            revokedAt: null,
          },
          data: { revokedAt: new Date() },
        })
      }

      return tx.playbookAssignment.create({
        data: {
          tenantId: input.tenantId,
          playbookId: input.playbookId,
          playbookVersionId: input.playbookVersionId,
          assignmentType: input.assignmentType,
          assignmentKey: input.assignmentKey,
          isDefault: input.isDefault,
          createdById: input.createdById,
        },
      })
    })
  }

  async findDefaultAssignment(
    tenantId: string | null,
    assignmentType: string,
    assignmentKey: string,
  ): Promise<PlaybookAssignment | null> {
    return prisma.playbookAssignment.findFirst({
      where: { tenantId, assignmentType, assignmentKey, isDefault: true, revokedAt: null },
      orderBy: { createdAt: 'desc' },
    })
  }
}
