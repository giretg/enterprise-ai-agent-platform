import type { Connector } from '@prisma/client'
import { prisma } from '@/lib/db'
import type { ConnectorRepository } from '@/repositories/interfaces'

export class PostgresConnectorRepository implements ConnectorRepository {
  async findById(id: string, tenantId?: string): Promise<Connector | null> {
    return prisma.connector.findFirst({
      where: tenantId ? { id, tenantId } : { id },
    })
  }

  async listActive(tenantId: string): Promise<Connector[]> {
    return prisma.connector.findMany({
      where: { tenantId, lifecycleState: 'active' },
      orderBy: { name: 'asc' },
    })
  }
}
