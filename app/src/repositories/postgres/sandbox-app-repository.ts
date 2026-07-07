import type { Prisma, SandboxApp, SandboxAppVersion } from '@prisma/client'
import { prisma } from '@/lib/db'
import { artifactObjectPath } from '@/domain/sandbox/artifact-store'
import type {
  AddSandboxAppVersionInput,
  CreateSandboxAppInput,
  SandboxAppListFilter,
  SandboxAppListItem,
  SandboxAppRegistryMetrics,
  SandboxAppRepository,
  SandboxAppWithLatestVersion,
} from '../interfaces'

const DEFAULT_LIST_LIMIT = 50
const MAX_LIST_LIMIT = 200

export class PostgresSandboxAppRepository implements SandboxAppRepository {
  async findByIdWithLatestVersion(appId: string): Promise<SandboxAppWithLatestVersion | null> {
    return prisma.sandboxApp.findUnique({
      where: { id: appId },
      include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
    })
  }

  async findLatestByTicketId(ticketId: string): Promise<SandboxAppWithLatestVersion | null> {
    const version = await prisma.sandboxAppVersion.findFirst({
      where: { sourceTicketId: ticketId },
      orderBy: { createdAt: 'desc' },
      include: {
        app: {
          include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
        },
      },
    })
    return version ? version.app : null
  }

  async findById(appId: string): Promise<SandboxApp | null> {
    return prisma.sandboxApp.findUnique({ where: { id: appId } })
  }

  async create(input: CreateSandboxAppInput): Promise<SandboxApp> {
    return prisma.sandboxApp.create({
      data: {
        tenantId: input.tenantId,
        sandboxId: input.sandboxId ?? null,
        name: input.name,
        description: input.description ?? null,
        level: 'A0',
        type: 'single_html',
        status: 'draft',
        criticality: input.criticality,
        createdByType: input.createdByType,
        createdByUserId: input.createdByUserId ?? null,
        createdByAgentId: input.createdByAgentId ?? null,
        createdFromTicketId: input.createdFromTicketId ?? null,
        createdFromConversationId: input.createdFromConversationId ?? null,
        policy: input.policy,
        tags: (input.tags ?? []) as Prisma.InputJsonValue,
      },
    })
  }

  async addVersion(input: AddSandboxAppVersionInput): Promise<SandboxAppVersion> {
    return prisma.$transaction(async (tx) => {
      const last = await tx.sandboxAppVersion.findFirst({
        where: { appId: input.appId },
        orderBy: { version: 'desc' },
        select: { version: true },
      })
      const version = (last?.version ?? 0) + 1
      const artifactRef = artifactObjectPath({
        tenantId: input.tenantId,
        appId: input.appId,
        version,
      })

      return tx.sandboxAppVersion.create({
        data: {
          tenantId: input.tenantId,
          appId: input.appId,
          version,
          status: 'draft',
          changeSummary: input.changeSummary,
          artifactRef,
          artifactSizeBytes: input.artifactSizeBytes,
          contentHash: input.contentHash,
          mimeType: input.mimeType ?? 'text/html; charset=utf-8',
          createdByType: input.createdByType,
          createdByUserId: input.createdByUserId ?? null,
          createdByAgentId: input.createdByAgentId ?? null,
          createdFromRunId: input.createdFromRunId ?? null,
          sourceTicketId: input.sourceTicketId ?? null,
          validationResult: input.validationResult,
        },
      })
    })
  }

  async setActiveVersion(params: { appId: string; versionId: string }): Promise<void> {
    await prisma.$transaction([
      // A korábbi aktív verziók superseded-re (a most aktiválandó kivételével).
      prisma.sandboxAppVersion.updateMany({
        where: { appId: params.appId, status: 'active', id: { not: params.versionId } },
        data: { status: 'superseded' },
      }),
      prisma.sandboxAppVersion.update({
        where: { id: params.versionId },
        data: { status: 'active' },
      }),
      prisma.sandboxApp.update({
        where: { id: params.appId },
        data: { activeVersionId: params.versionId, status: 'active' },
      }),
    ])
  }

  async archive(appId: string): Promise<SandboxApp> {
    return prisma.sandboxApp.update({
      where: { id: appId },
      data: { status: 'archived', archivedAt: new Date() },
    })
  }

  async getVersion(appId: string, version: number): Promise<SandboxAppVersion | null> {
    return prisma.sandboxAppVersion.findUnique({
      where: { appId_version: { appId, version } },
    })
  }

  async getVersionById(versionId: string): Promise<SandboxAppVersion | null> {
    return prisma.sandboxAppVersion.findUnique({ where: { id: versionId } })
  }

  async listVersions(appId: string): Promise<SandboxAppVersion[]> {
    return prisma.sandboxAppVersion.findMany({
      where: { appId },
      orderBy: { version: 'desc' },
    })
  }

  async list(
    filter: SandboxAppListFilter,
  ): Promise<{ items: SandboxAppListItem[]; nextCursor?: string }> {
    const limit = Math.min(filter.limit ?? DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT)

    const where: Prisma.SandboxAppWhereInput = {
      tenantId: filter.tenantId,
      ...(filter.sandboxId !== undefined ? { sandboxId: filter.sandboxId } : {}),
      ...(filter.createdByAgentId ? { createdByAgentId: filter.createdByAgentId } : {}),
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.search
        ? {
            OR: [
              { name: { contains: filter.search, mode: 'insensitive' } },
              { description: { contains: filter.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    }

    const rows = await prisma.sandboxApp.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      take: limit + 1,
      ...(filter.cursor ? { cursor: { id: filter.cursor }, skip: 1 } : {}),
      include: { versions: true },
    })

    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows
    const items: SandboxAppListItem[] = page.map((app) => {
      const { versions, ...rest } = app
      const activeVersion =
        versions.find((v) => v.id === app.activeVersionId) ?? null
      return { ...rest, activeVersion }
    })

    return { items, nextCursor: hasMore ? page[page.length - 1]?.id : undefined }
  }

  async getRegistryMetrics(tenantId: string | null): Promise<SandboxAppRegistryMetrics> {
    const apps = await prisma.sandboxApp.findMany({
      where: { tenantId },
      select: { id: true, status: true, createdByType: true },
    })

    const appsByStatus: Record<string, number> = {}
    let agent = 0
    let user = 0
    for (const a of apps) {
      appsByStatus[a.status] = (appsByStatus[a.status] ?? 0) + 1
      if (a.createdByType === 'agent') agent += 1
      else user += 1
    }

    const versionAgg = await prisma.sandboxAppVersion.aggregate({
      where: { tenantId },
      _count: { _all: true },
      _avg: { artifactSizeBytes: true },
    })

    const appsTotal = apps.length
    const versionsTotal = versionAgg._count._all

    return {
      appsTotal,
      appsByStatus,
      appsByCreator: { agent, user },
      versionsTotal,
      avgVersionsPerApp: appsTotal > 0 ? versionsTotal / appsTotal : 0,
      avgArtifactSizeBytes: Math.round(versionAgg._avg.artifactSizeBytes ?? 0),
      appIds: apps.map((a) => a.id),
    }
  }
}
