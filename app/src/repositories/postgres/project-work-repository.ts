import { Prisma, type MemoryWriteMode, type ProjectMemoryKind, type ProjectMemoryStatus } from '@prisma/client'
import { prisma } from '@/lib/db'
import type {
  ProjectMemoryRecord,
  ProjectMemoryStore,
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
  }): Promise<ProjectMemoryRecord> {
    const row = await prisma.projectMemoryItem.create({
      data: { ...input, status: 'active' },
    })
    return mapMemory(row)
  }

  async replaceActive(input: {
    tenantId: string
    agentId: string
    projectKey: string
    kind: ProjectMemoryKind
    title: string
    body: string
    artifactPath: string | null
    withUserId: string
    supersedesId: string
  }): Promise<ProjectMemoryRecord | null> {
    return prisma.$transaction(async (tx) => {
      const claimed = await tx.projectMemoryItem.updateMany({
        where: {
          id: input.supersedesId,
          tenantId: input.tenantId,
          agentId: input.agentId,
          projectKey: input.projectKey,
          status: 'active',
        },
        data: { status: 'superseded' },
      })
      if (claimed.count !== 1) return null
      const row = await tx.projectMemoryItem.create({
        data: { ...input, status: 'active' },
      })
      return mapMemory(row)
    })
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
