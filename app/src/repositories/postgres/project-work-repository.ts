import { Prisma, type MemoryWriteMode, type ProjectMemoryKind, type ProjectMemoryStatus } from '@prisma/client'
import { prisma } from '@/lib/db'
import type {
  ProjectMemoryRecord,
  ProjectMemoryStore,
  WorkFileAppendResult,
  WorkFileQuota,
  WorkFileRecord,
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

  async upsert(input: {
    tenantId: string
    projectKey: string
    path: string
    content: string
    byteSize: number
    lastWriterUserId: string
  }): Promise<WorkFileRecord> {
    const row = await prisma.workFile.upsert({
      where: {
        tenantId_projectKey_path: {
          tenantId: input.tenantId,
          projectKey: input.projectKey,
          path: input.path,
        },
      },
      create: input,
      update: {
        content: input.content,
        byteSize: input.byteSize,
        lastWriterUserId: input.lastWriterUserId,
      },
    })
    return mapFile(row)
  }

  /**
   * Párhuzamos MCP append-ek ne veszítsenek chunkot: advisory lock a fájlkulcson,
   * majd read→concat→quota→upsert egy tranzakcióban (akár létrehozás is).
   */
  async appendAtomic(input: {
    tenantId: string
    projectKey: string
    path: string
    chunk: string
    lastWriterUserId: string
    maxFileBytes: number
    maxProjectBytes: number
    maxCount: number
  }): Promise<WorkFileAppendResult> {
    return prisma.$transaction(async (tx) => {
      const lockKey = `${input.tenantId}:${input.projectKey}:${input.path}`
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`

      const existing = await tx.workFile.findUnique({
        where: {
          tenantId_projectKey_path: {
            tenantId: input.tenantId,
            projectKey: input.projectKey,
            path: input.path,
          },
        },
      })
      const content = `${existing?.content ?? ''}${input.chunk}`
      const byteSize = Buffer.byteLength(content, 'utf8')
      if (byteSize > input.maxFileBytes) return { ok: false as const, code: 'file_too_large' as const }

      const [count, agg] = await Promise.all([
        tx.workFile.count({
          where: { tenantId: input.tenantId, projectKey: input.projectKey },
        }),
        tx.workFile.aggregate({
          where: { tenantId: input.tenantId, projectKey: input.projectKey },
          _sum: { byteSize: true },
        }),
      ])
      const nextCount = existing ? count : count + 1
      const nextBytes = (agg._sum.byteSize ?? 0) - (existing?.byteSize ?? 0) + byteSize
      if (nextCount > input.maxCount || nextBytes > input.maxProjectBytes) {
        return { ok: false as const, code: 'quota_exceeded' as const }
      }

      const row = await tx.workFile.upsert({
        where: {
          tenantId_projectKey_path: {
            tenantId: input.tenantId,
            projectKey: input.projectKey,
            path: input.path,
          },
        },
        create: {
          tenantId: input.tenantId,
          projectKey: input.projectKey,
          path: input.path,
          content,
          byteSize,
          lastWriterUserId: input.lastWriterUserId,
        },
        update: {
          content,
          byteSize,
          lastWriterUserId: input.lastWriterUserId,
        },
      })
      return { ok: true as const, record: mapFile(row) }
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

  async quota(tenantId: string, projectKey: string): Promise<WorkFileQuota> {
    const [count, agg] = await Promise.all([
      prisma.workFile.count({ where: { tenantId, projectKey } }),
      prisma.workFile.aggregate({
        where: { tenantId, projectKey },
        _sum: { byteSize: true },
      }),
    ])
    return { count, bytes: agg._sum.byteSize ?? 0 }
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
