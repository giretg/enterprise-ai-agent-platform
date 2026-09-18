import { randomUUID } from 'node:crypto'
import { prisma } from '@/lib/db'
import type { WorkProjectRecord, WorkProjectRepository } from '../interfaces'

type SqlRow = {
  id: string
  tenant_id: string
  key: string
  name: string
  description: string | null
  created_by: string
  created_at: Date
  updated_at: Date
  archived_at: Date | null
}

function toRecord(row: {
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
  return {
    id: row.id,
    tenantId: row.tenantId,
    key: row.key,
    name: row.name,
    description: row.description,
    createdById: row.createdById,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    archivedAt: row.archivedAt,
  }
}

function fromSql(row: SqlRow): WorkProjectRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    key: row.key,
    name: row.name,
    description: row.description,
    createdById: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  }
}

/** A hosszú életű `next dev` Prisma-példánya a generate előtt cache-elődhet. */
function workProjectDelegate() {
  return (prisma as { workProject?: typeof prisma.workProject }).workProject ?? null
}

export class PostgresWorkProjectRepository implements WorkProjectRepository {
  async listByTenant(
    tenantId: string,
    opts?: { includeArchived?: boolean },
  ): Promise<WorkProjectRecord[]> {
    const includeArchived = opts?.includeArchived === true
    const delegate = workProjectDelegate()
    if (delegate) {
      const rows = await delegate.findMany({
        where: includeArchived ? { tenantId } : { tenantId, archivedAt: null },
        orderBy: { name: 'asc' },
      })
      return rows.map(toRecord)
    }
    const rows = includeArchived
      ? await prisma.$queryRaw<SqlRow[]>`
          SELECT id, tenant_id, key, name, description, created_by, created_at, updated_at, archived_at
          FROM work_projects
          WHERE tenant_id = ${tenantId}::uuid
          ORDER BY name ASC
        `
      : await prisma.$queryRaw<SqlRow[]>`
          SELECT id, tenant_id, key, name, description, created_by, created_at, updated_at, archived_at
          FROM work_projects
          WHERE tenant_id = ${tenantId}::uuid AND archived_at IS NULL
          ORDER BY name ASC
        `
    return rows.map(fromSql)
  }

  async findById(id: string): Promise<WorkProjectRecord | null> {
    const delegate = workProjectDelegate()
    if (delegate) {
      const row = await delegate.findUnique({ where: { id } })
      return row ? toRecord(row) : null
    }
    const rows = await prisma.$queryRaw<SqlRow[]>`
      SELECT id, tenant_id, key, name, description, created_by, created_at, updated_at, archived_at
      FROM work_projects
      WHERE id = ${id}::uuid
      LIMIT 1
    `
    return rows[0] ? fromSql(rows[0]) : null
  }

  async findByKey(tenantId: string, key: string): Promise<WorkProjectRecord | null> {
    const delegate = workProjectDelegate()
    if (delegate) {
      const row = await delegate.findUnique({
        where: { tenantId_key: { tenantId, key } },
      })
      return row ? toRecord(row) : null
    }
    const rows = await prisma.$queryRaw<SqlRow[]>`
      SELECT id, tenant_id, key, name, description, created_by, created_at, updated_at, archived_at
      FROM work_projects
      WHERE tenant_id = ${tenantId}::uuid AND key = ${key}
      LIMIT 1
    `
    return rows[0] ? fromSql(rows[0]) : null
  }

  async create(data: {
    tenantId: string
    key: string
    name: string
    description: string | null
    createdById: string
  }): Promise<WorkProjectRecord> {
    const delegate = workProjectDelegate()
    if (delegate) {
      const row = await delegate.create({ data })
      return toRecord(row)
    }
    const id = randomUUID()
    const rows = await prisma.$queryRaw<SqlRow[]>`
      INSERT INTO work_projects (id, tenant_id, key, name, description, created_by, created_at, updated_at, archived_at)
      VALUES (
        ${id}::uuid,
        ${data.tenantId}::uuid,
        ${data.key},
        ${data.name},
        ${data.description},
        ${data.createdById}::uuid,
        NOW(),
        NOW(),
        NULL
      )
      RETURNING id, tenant_id, key, name, description, created_by, created_at, updated_at, archived_at
    `
    if (!rows[0]) throw new Error('A projekt mentése nem adott vissza sort')
    return fromSql(rows[0])
  }

  async update(
    id: string,
    patch: { name?: string; description?: string | null; archivedAt?: Date | null },
  ): Promise<WorkProjectRecord> {
    const delegate = workProjectDelegate()
    if (delegate) {
      const row = await delegate.update({ where: { id }, data: patch })
      return toRecord(row)
    }
    const nextName = patch.name ?? null
    const nextDescription = patch.description === undefined ? null : patch.description
    const keepDescription = patch.description === undefined
    const nextArchived = patch.archivedAt === undefined ? null : patch.archivedAt
    const keepArchived = patch.archivedAt === undefined
    const rows = await prisma.$queryRaw<SqlRow[]>`
      UPDATE work_projects
      SET
        name = COALESCE(${nextName}, name),
        description = CASE WHEN ${keepDescription} THEN description ELSE ${nextDescription} END,
        archived_at = CASE WHEN ${keepArchived} THEN archived_at ELSE ${nextArchived} END,
        updated_at = NOW()
      WHERE id = ${id}::uuid
      RETURNING id, tenant_id, key, name, description, created_by, created_at, updated_at, archived_at
    `
    if (!rows[0]) throw new Error('A projekt nem található')
    return fromSql(rows[0])
  }
}
