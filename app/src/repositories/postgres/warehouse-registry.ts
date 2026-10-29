import type { PrismaClient, TenantWarehouse } from '@prisma/client'
import { prisma as defaultClient } from '@/lib/db'
import type { WarehouseRegistry, WarehouseRegistryRecord, WarehouseStatus } from '@/domain/warehouse/warehouse-service'

function toRecord(row: TenantWarehouse): WarehouseRegistryRecord {
  return {
    tenantId: row.tenantId,
    status: row.status as WarehouseStatus,
    provisioner: row.provisioner,
    schemaName: row.schemaName,
    internalVersion: row.internalVersion,
    lastError: row.lastError,
    attempts: row.attempts,
    readyAt: row.readyAt?.toISOString() ?? null,
  }
}

/** #984: cég ↔ adattárház nyilvántartás a platform-DB-ben (tenantId egyedi → idempotens aktiválás). */
export class PostgresWarehouseRegistry implements WarehouseRegistry {
  constructor(private readonly client: PrismaClient = defaultClient) {}

  async find(tenantId: string) {
    const row = await this.client.tenantWarehouse.findUnique({ where: { tenantId } })
    return row ? toRecord(row) : null
  }

  async ensure(input: { tenantId: string; schemaName: string; provisioner: string; requestedById: string }) {
    const row = await this.client.tenantWarehouse.upsert({
      where: { tenantId: input.tenantId },
      create: {
        tenantId: input.tenantId,
        status: 'requested',
        provisioner: input.provisioner,
        schemaName: input.schemaName,
        requestedById: input.requestedById,
      },
      update: {},
    })
    return toRecord(row)
  }

  async update(
    tenantId: string,
    patch: Partial<Pick<WarehouseRegistryRecord, 'status' | 'internalVersion' | 'lastError'>> & { attempt?: boolean; ready?: boolean },
  ) {
    const row = await this.client.tenantWarehouse.update({
      where: { tenantId },
      data: {
        ...(patch.status ? { status: patch.status } : {}),
        ...(patch.internalVersion !== undefined ? { internalVersion: patch.internalVersion } : {}),
        ...(patch.lastError !== undefined ? { lastError: patch.lastError } : {}),
        ...(patch.attempt ? { attempts: { increment: 1 } } : {}),
        ...(patch.ready ? { readyAt: new Date() } : {}),
      },
    })
    return toRecord(row)
  }
}
