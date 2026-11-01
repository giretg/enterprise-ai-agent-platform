import { PrismaClient } from '@prisma/client'
import { prisma } from '@/lib/db'
import { resolvePublicAppOrigin } from '@/lib/public-app-url'
import { PgSchemaProvisioner } from '@/domain/warehouse/provisioner'
import { prismaWarehouseDatabase } from '@/domain/warehouse/sql'
import { WarehouseService } from '@/domain/warehouse/warehouse-service'
import { PostgresWarehouseRegistry } from '@/repositories/postgres/warehouse-registry'
import { repositories } from '@/repositories/postgres'

const globalForWarehouse = globalThis as unknown as { warehousePrisma?: PrismaClient }

/**
 * #984 R2/Q2: az adattárház-adatbázis külön is beállítható (`WAREHOUSE_DATABASE_URL`);
 * hiányában a platform-DB-ben, cégenként külön sémában él.
 */
function warehouseClient(): PrismaClient {
  const url = process.env.WAREHOUSE_DATABASE_URL?.trim()
  if (!url) return prisma
  globalForWarehouse.warehousePrisma ??= new PrismaClient({ datasourceUrl: url, log: ['error'] })
  return globalForWarehouse.warehousePrisma
}

let service: WarehouseService | null = null

export function warehouseService(): WarehouseService {
  if (service) return service
  const db = prismaWarehouseDatabase(warehouseClient())
  service = new WarehouseService({
    db,
    registry: new PostgresWarehouseRegistry(prisma),
    provisioner: new PgSchemaProvisioner(db),
    audit: repositories.audit,
    reviewUrl: (importId) => `/control-plane/warehouse${importId ? `?import=${importId}` : ''}`,
  })
  return service
}

export function warehousePageUrl(path: string): string {
  return `${resolvePublicAppOrigin()}${path}`
}
