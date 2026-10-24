import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import type {
  MiniAppListScope,
  MiniAppRecord,
  MiniAppShareRecord,
  MiniAppStatus,
  MiniAppStore,
  MiniAppVersionMeta,
  MiniAppVersionRecord,
  MiniAppVisibility,
  NewMiniAppVersion,
} from '@/domain/mini-app/types'

const appSelect = {
  id: true,
  tenantId: true,
  ownerAgentId: true,
  projectKey: true,
  name: true,
  description: true,
  status: true,
  visibility: true,
  currentVersion: true,
  copiedFromAppId: true,
  copiedFromVersion: true,
  createdByUserId: true,
  createdAt: true,
  updatedAt: true,
  archivedAt: true,
} satisfies Prisma.MiniAppSelect

/** A lista és a verziótörténet sosem tölti be a HTML-t. */
const versionMetaSelect = {
  id: true,
  appId: true,
  version: true,
  contentHash: true,
  byteSize: true,
  lintWarnings: true,
  changeNote: true,
  createdByUserId: true,
  createdAt: true,
} satisfies Prisma.MiniAppVersionSelect

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
}

function versionData(appId: string, tenantId: string, version: number, input: NewMiniAppVersion) {
  return {
    appId,
    tenantId,
    version,
    html: input.html,
    contentHash: input.contentHash,
    byteSize: input.byteSize,
    lintWarnings: input.lintWarnings,
    changeNote: input.changeNote,
    idempotencyKey: input.idempotencyKey,
    createdByUserId: input.createdByUserId,
  }
}

export class PostgresMiniAppRepository implements MiniAppStore {
  async findById(tenantId: string, appId: string): Promise<MiniAppRecord | null> {
    return prisma.miniApp.findFirst({ where: { id: appId, tenantId }, select: appSelect })
  }

  async findByCreateKey(tenantId: string, ownerAgentId: string, key: string): Promise<MiniAppRecord | null> {
    return prisma.miniApp.findFirst({
      where: { tenantId, ownerAgentId, createIdempotencyKey: key },
      select: appSelect,
    })
  }

  async createWithVersion(input: Parameters<MiniAppStore['createWithVersion']>[0]) {
    const { version, ...app } = input
    try {
      const created = await prisma.$transaction(async (tx) => {
        const row = await tx.miniApp.create({ data: { ...app, currentVersion: 1 }, select: appSelect })
        await tx.miniAppVersion.create({ data: versionData(row.id, row.tenantId, 1, version) })
        return row
      })
      return { app: created, created: true }
    } catch (error) {
      if (!isUniqueViolation(error)) throw error
      const existing = await this.findByCreateKey(input.tenantId, input.ownerAgentId, input.createIdempotencyKey)
      if (!existing) throw error
      return { app: existing, created: false }
    }
  }

  async findVersion(appId: string, version: number): Promise<MiniAppVersionRecord | null> {
    return prisma.miniAppVersion.findUnique({
      where: { appId_version: { appId, version } },
      select: { ...versionMetaSelect, html: true },
    })
  }

  async findVersionByKey(appId: string, key: string): Promise<MiniAppVersionMeta | null> {
    return prisma.miniAppVersion.findUnique({
      where: { appId_idempotencyKey: { appId, idempotencyKey: key } },
      select: versionMetaSelect,
    })
  }

  async listVersions(appId: string): Promise<MiniAppVersionMeta[]> {
    return prisma.miniAppVersion.findMany({
      where: { appId },
      orderBy: { version: 'desc' },
      select: versionMetaSelect,
    })
  }

  async addVersion(input: Parameters<MiniAppStore['addVersion']>[0]): Promise<MiniAppVersionMeta | 'conflict'> {
    const next = input.expectedCurrentVersion + 1
    try {
      return await prisma.$transaction(async (tx) => {
        // Optimista zár: csak akkor lépünk, ha közben senki más nem tett fel verziót.
        const bumped = await tx.miniApp.updateMany({
          where: { id: input.appId, currentVersion: input.expectedCurrentVersion, status: 'active' },
          data: { currentVersion: next },
        })
        if (bumped.count !== 1) throw new MiniAppVersionConflict()
        return tx.miniAppVersion.create({
          data: versionData(input.appId, input.tenantId, next, input.version),
          select: versionMetaSelect,
        })
      })
    } catch (error) {
      if (error instanceof MiniAppVersionConflict || isUniqueViolation(error)) return 'conflict'
      throw error
    }
  }

  async listVisibleToAgent(input: Parameters<MiniAppStore['listVisibleToAgent']>[0]): Promise<MiniAppRecord[]> {
    const mine: Prisma.MiniAppWhereInput = { ownerAgentId: input.agentId }
    const sharedWithMe: Prisma.MiniAppWhereInput[] = [
      { shares: { some: { agentId: input.agentId, revokedAt: null } } },
      { visibility: 'organization' },
    ]
    const relation: Prisma.MiniAppWhereInput = scopeFilter(input.scope, mine, sharedWithMe, input.agentId)
    const statusFilter: Prisma.MiniAppWhereInput = input.includeArchived
      ? // Archivált appot csak a tulajdonos lát.
        { OR: [{ status: 'active' }, { status: 'archived', ownerAgentId: input.agentId }] }
      : { status: 'active' }
    const query = input.query
      ? {
          OR: [
            { name: { contains: input.query, mode: 'insensitive' as const } },
            { description: { contains: input.query, mode: 'insensitive' as const } },
          ],
        }
      : {}
    return prisma.miniApp.findMany({
      where: { AND: [{ tenantId: input.tenantId }, relation, statusFilter, query] },
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
      skip: input.offset,
      take: input.limit,
      select: appSelect,
    })
  }

  async listActiveShares(appId: string): Promise<MiniAppShareRecord[]> {
    return prisma.miniAppShare.findMany({
      where: { appId, revokedAt: null, agent: { retiredAt: null } },
      orderBy: { createdAt: 'asc' },
      select: { appId: true, agentId: true, sharedByUserId: true, createdAt: true },
    })
  }

  async hasActiveShare(appId: string, agentId: string): Promise<boolean> {
    const row = await prisma.miniAppShare.findFirst({ where: { appId, agentId, revokedAt: null }, select: { id: true } })
    return row !== null
  }

  async activateShares(input: { tenantId: string; appId: string; agentIds: string[]; sharedByUserId: string }): Promise<string[]> {
    const before = await prisma.miniAppShare.findMany({
      where: { appId: input.appId, agentId: { in: input.agentIds }, revokedAt: null },
      select: { agentId: true },
    })
    const alreadyActive = new Set(before.map((row) => row.agentId))
    const newly = input.agentIds.filter((id) => !alreadyActive.has(id))
    for (const agentId of newly) {
      await prisma.miniAppShare.upsert({
        where: { appId_agentId: { appId: input.appId, agentId } },
        create: { tenantId: input.tenantId, appId: input.appId, agentId, sharedByUserId: input.sharedByUserId },
        update: { revokedAt: null, sharedByUserId: input.sharedByUserId, createdAt: new Date() },
      })
    }
    return newly
  }

  async revokeShares(appId: string, agentIds: string[]): Promise<string[]> {
    const rows = await prisma.miniAppShare.updateManyAndReturn({
      where: { appId, agentId: { in: agentIds }, revokedAt: null },
      data: { revokedAt: new Date() },
      select: { agentId: true },
    })
    return rows.map((row) => row.agentId)
  }

  async setVisibility(appId: string, visibility: MiniAppVisibility): Promise<void> {
    await prisma.miniApp.update({ where: { id: appId }, data: { visibility } })
  }

  async setStatus(appId: string, status: MiniAppStatus, archivedAt: Date | null): Promise<void> {
    await prisma.miniApp.update({ where: { id: appId }, data: { status, archivedAt } })
  }

  async purgeArchivedBefore(cutoff: Date): Promise<Array<{ id: string; tenantId: string }>> {
    const expired = await prisma.miniApp.findMany({
      where: { status: 'archived', archivedAt: { lt: cutoff } },
      select: { id: true, tenantId: true },
      take: 500,
    })
    if (expired.length === 0) return []
    // A verziók és megosztások ON DELETE CASCADE-del mennek; a feltétel újra véd a közbeni visszaállítás ellen.
    await prisma.miniApp.deleteMany({
      where: { id: { in: expired.map((row) => row.id) }, status: 'archived', archivedAt: { lt: cutoff } },
    })
    return expired
  }
}

class MiniAppVersionConflict extends Error {}

function scopeFilter(
  scope: MiniAppListScope,
  mine: Prisma.MiniAppWhereInput,
  sharedWithMe: Prisma.MiniAppWhereInput[],
  agentId: string,
): Prisma.MiniAppWhereInput {
  if (scope === 'mine') return mine
  if (scope === 'shared_with_me') return { AND: [{ ownerAgentId: { not: agentId } }, { OR: sharedWithMe }] }
  return { OR: [mine, ...sharedWithMe] }
}

/** Control Plane: egy agent saját appjai + a neki megosztottak + a szervezetiek (HTML nélkül). */
export async function listMiniAppsForAgentPage(tenantId: string, agentId: string): Promise<MiniAppRecord[]> {
  return prisma.miniApp.findMany({
    where: {
      tenantId,
      OR: [
        { ownerAgentId: agentId },
        { status: 'active', shares: { some: { agentId, revokedAt: null } } },
        { status: 'active', visibility: 'organization' },
      ],
    },
    orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
    take: 200,
    select: appSelect,
  })
}
