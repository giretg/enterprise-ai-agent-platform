import type { PlaybookV2, PlaybookVersionV2, PlaybookAssignment, Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import { prismaPageArgs, toListPage } from '@/lib/list-pagination'
import type {
  CreatePlaybookAssignmentInput,
  CreatePlaybookV2Input,
  CreatePlaybookVersionV2Input,
  PlaybookListOpts,
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

  async listPlaybooks(tenantId: string | null, opts?: PlaybookListOpts): Promise<PlaybookV2WithVersions[]> {
    const includeVersions = opts?.includeVersions ?? 'none'
    const { take, skip, pageLimit } = prismaPageArgs(
      opts?.unbounded
        ? { unbounded: true }
        : opts?.limit !== undefined || opts?.offset !== undefined || opts?.includeVersions === 'all'
          ? { limit: opts?.limit, offset: opts?.offset, unbounded: opts?.unbounded }
          : { limit: opts?.limit, offset: opts?.offset },
    )
    const offset = skip ?? 0

    if (includeVersions === 'all') {
      const rows = await prisma.playbookV2.findMany({
        where: { tenantId },
        orderBy: { createdAt: 'desc' },
        ...(take !== undefined ? { take, skip: offset } : {}),
        include: { versions: { orderBy: { version: 'desc' } } },
      })
      return toListPage(
        rows.map((row) => ({ ...row, versionCount: row.versions.length })),
        pageLimit,
        offset,
      ).items
    }

    const rows = await prisma.playbookV2.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      ...(take !== undefined ? { take, skip: offset } : {}),
      include: { _count: { select: { versions: true } } },
    })
    return toListPage(
      rows.map(({ _count, ...row }) => ({
        ...row,
        versions: [] as PlaybookVersionV2[],
        versionCount: _count.versions,
      })),
      pageLimit,
      offset,
    ).items
  }

  async listDefaultAssignments(
    tenantId: string | null,
    assignmentType: string,
  ): Promise<PlaybookAssignment[]> {
    return prisma.playbookAssignment.findMany({
      where: { tenantId, assignmentType, isDefault: true, revokedAt: null },
      orderBy: { createdAt: 'desc' },
    })
  }

  async findVersionsByIds(tenantId: string | null, ids: string[]): Promise<PlaybookVersionV2[]> {
    if (ids.length === 0) return []
    return prisma.playbookVersionV2.findMany({
      where: { tenantId, id: { in: ids } },
    })
  }

  async findPlaybooksByIds(tenantId: string | null, ids: string[]): Promise<PlaybookV2[]> {
    if (ids.length === 0) return []
    return prisma.playbookV2.findMany({
      where: { tenantId, id: { in: ids } },
    })
  }

  async updatePlaybook(
    id: string,
    data: Partial<{
      name: string
      description: string | null
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
        layout: input.layout ?? {},
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
      spec: Prisma.InputJsonValue
      changeSummary: string
      contentHash: string
      validationResult: Prisma.InputJsonValue
      compiledSpec: Prisma.InputJsonValue
      layout: Prisma.InputJsonValue
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

  async findDefaultAssignments(
    tenantId: string | null,
    assignmentType: string,
    assignmentKeys: string[],
  ): Promise<Map<string, PlaybookAssignment>> {
    const result = new Map<string, PlaybookAssignment>()
    if (assignmentKeys.length === 0) return result
    const uniqueKeys = [...new Set(assignmentKeys)]
    const rows = await prisma.playbookAssignment.findMany({
      where: {
        tenantId,
        assignmentType,
        assignmentKey: { in: uniqueKeys },
        isDefault: true,
        revokedAt: null,
      },
      orderBy: { createdAt: 'desc' },
    })
    for (const row of rows) {
      if (!result.has(row.assignmentKey)) result.set(row.assignmentKey, row)
    }
    return result
  }
}
