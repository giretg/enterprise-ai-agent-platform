import { Prisma, type MemoryWriteMode, type ProjectMemoryKind, type ProjectMemoryStatus } from '@prisma/client'
import { prisma } from '@/lib/db'
import type {
  ProjectMemoryRecord,
  ProjectMemoryStore,
  WorkFileRecord,
  WorkFileSave,
  WorkFileStore,
  WorkProjectRecord,
  WorkProjectStore,
} from '@/domain/project-work/types'

function mapProject(row: {
  id: string
  tenantId: string
  key: string
  name: string
  description: string | null
  createdById: string
  createdAt: Date
  updatedAt: Date
  archivedAt: Date | null
}): WorkProjectRecord {
  return row
}

function mapFile(row: {
  id: string
  tenantId: string
  projectKey: string
  path: string
  content: string
  byteSize: number
  lastWriterUserId: string
  createdAt: Date
  updatedAt: Date
}): WorkFileRecord {
  return row
}

function mapMemory(row: {
  id: string
  tenantId: string
  agentId: string
  projectKey: string
  kind: ProjectMemoryKind
  title: string
  body: string
  artifactPath: string | null
  withUserId: string
  status: ProjectMemoryStatus
  supersedesId: string | null
  createdAt: Date
}): ProjectMemoryRecord {
  return row
}

export class PostgresWorkProjectRepository implements WorkProjectStore {
  async listByTenant(tenantId: string): Promise<WorkProjectRecord[]> {
    const rows = await prisma.workProject.findMany({
      where: { tenantId },
      orderBy: { name: 'asc' },
    })
    return rows.map(mapProject)
  }

  async findByKey(tenantId: string, key: string): Promise<WorkProjectRecord | null> {
    const row = await prisma.workProject.findUnique({
      where: { tenantId_key: { tenantId, key } },
    })
    return row ? mapProject(row) : null
  }

  async create(input: {
    tenantId: string
    key: string
    name: string
    description: string | null
    createdById: string
  }): Promise<WorkProjectRecord> {
    const row = await prisma.workProject.create({ data: input })
    return mapProject(row)
  }
}

export class PostgresWorkFileRepository implements WorkFileStore {
  async list(
    tenantId: string,
    projectKey: string,
    prefix?: string,
  ): Promise<Omit<WorkFileRecord, 'content'>[]> {
    const rows = await prisma.workFile.findMany({
      where: {
        tenantId,
        projectKey,
        ...(prefix ? { path: { startsWith: prefix } } : {}),
      },
      orderBy: { path: 'asc' },
      select: {
        id: true,
        tenantId: true,
        projectKey: true,
        path: true,
        byteSize: true,
        lastWriterUserId: true,
        createdAt: true,
        updatedAt: true,
      },
    })
    return rows
  }

  async find(tenantId: string, projectKey: string, path: string): Promise<WorkFileRecord | null> {
    const row = await prisma.workFile.findUnique({
      where: { tenantId_projectKey_path: { tenantId, projectKey, path } },
    })
    return row ? mapFile(row) : null
  }

  async saveWithinQuota(input: WorkFileSave): Promise<WorkFileRecord | 'file_too_large' | 'quota_exceeded'> {
    return prisma.$transaction(async (tx) => {
      // ponytail: project-level advisory lock; hash collisions only serialize unrelated projects.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.tenantId}), hashtext(${input.projectKey}))`
      const where = {
        tenantId_projectKey_path: { tenantId: input.tenantId, projectKey: input.projectKey, path: input.path },
      }
      const existing = await tx.workFile.findUnique({ where })
      const content = input.append ? `${existing?.content ?? ''}${input.content}` : input.content
      const byteSize = Buffer.byteLength(content, 'utf8')
      if (byteSize > input.maxFileBytes) return 'file_too_large'
      const scope = { tenantId: input.tenantId, projectKey: input.projectKey }
      const [count, agg] = await Promise.all([
        tx.workFile.count({ where: scope }),
        tx.workFile.aggregate({ where: scope, _sum: { byteSize: true } }),
      ])
      if (count + (existing ? 0 : 1) > input.maxCount ||
          (agg._sum.byteSize ?? 0) - (existing?.byteSize ?? 0) + byteSize > input.maxProjectBytes) {
        return 'quota_exceeded'
      }
      return mapFile(await tx.workFile.upsert({
        where,
        create: { ...scope, path: input.path, content, byteSize, lastWriterUserId: input.lastWriterUserId },
        update: { content, byteSize, lastWriterUserId: input.lastWriterUserId },
      }))
    })
  }

  async delete(tenantId: string, projectKey: string, path: string): Promise<boolean> {
    try {
      await prisma.workFile.delete({
        where: { tenantId_projectKey_path: { tenantId, projectKey, path } },
      })
      return true
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') return false
      throw error
    }
  }
}

export class PostgresProjectMemoryRepository implements ProjectMemoryStore {
  async listActive(input: {
    tenantId: string
    agentId: string
    projectKey: string
    withUserId?: string
  }): Promise<ProjectMemoryRecord[]> {
    const rows = await prisma.projectMemoryItem.findMany({
      where: {
        tenantId: input.tenantId,
        agentId: input.agentId,
        projectKey: input.projectKey,
        status: 'active',
        ...(input.withUserId ? { withUserId: input.withUserId } : {}),
      },
      orderBy: { createdAt: 'asc' },
    })
    return rows.map(mapMemory)
  }

  async findById(id: string): Promise<ProjectMemoryRecord | null> {
    const row = await prisma.projectMemoryItem.findUnique({ where: { id } })
    return row ? mapMemory(row) : null
  }

  async insertActive(input: {
    tenantId: string
    agentId: string
    projectKey: string
    kind: ProjectMemoryKind
    title: string
    body: string
    artifactPath: string | null
    withUserId: string
    supersedesId: string | null
    alsoSupersedeIds: string[]
  }): Promise<ProjectMemoryRecord> {
    const { alsoSupersedeIds, ...data } = input
    const retire = [...new Set([data.supersedesId, ...alsoSupersedeIds].filter((id): id is string => !!id))]
    const row = await prisma.$transaction(async (tx) => {
      if (retire.length > 0) {
        // CAS: két párhuzamos csere közül csak az egyik nyerhet.
        const { count } = await tx.projectMemoryItem.updateMany({
          where: { id: { in: retire }, status: 'active' },
          data: { status: 'superseded' },
        })
        if (count !== retire.length) throw new Error('memory_not_found')
      }
      return tx.projectMemoryItem.create({ data: { ...data, status: 'active' } })
    })
    return mapMemory(row)
  }

  async retireActive(input: { tenantId: string; agentId: string; id: string }): Promise<boolean> {
    const { count } = await prisma.projectMemoryItem.updateMany({
      where: {
        id: input.id,
        tenantId: input.tenantId,
        agentId: input.agentId,
        status: 'active',
      },
      data: { status: 'superseded' },
    })
    return count === 1
  }
}

export async function findAgentMemoryWriteMode(
  agentId: string,
  tenantId: string,
): Promise<MemoryWriteMode | null> {
  const row = await prisma.agent.findFirst({
    where: { id: agentId, tenantId },
    select: { memoryWriteMode: true },
  })
  return row?.memoryWriteMode ?? null
}

export async function updateAgentMemoryWriteMode(
  agentId: string,
  memoryWriteMode: MemoryWriteMode,
): Promise<void> {
  await prisma.agent.update({
    where: { id: agentId },
    data: { memoryWriteMode },
  })
}
