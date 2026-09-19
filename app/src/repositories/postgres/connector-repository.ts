import type { Connector } from '@prisma/client'
import { prisma } from '@/lib/db'
import type { ConnectorRepository } from '@/repositories/interfaces'

export class PostgresConnectorRepository implements ConnectorRepository {
  async findById(id: string, tenantId?: string): Promise<Connector | null> {
    return prisma.connector.findFirst({
      where: tenantId ? { id, tenantId } : { id },
    })
  }

  async findByTenantTypeAndName(
    tenantId: string,
    type: Connector['type'],
    name: string,
  ): Promise<Connector | null> {
    return prisma.connector.findUnique({
      where: { tenantId_type_name: { tenantId, type, name } },
    })
  }

  async listActive(tenantId: string): Promise<Connector[]> {
    return prisma.connector.findMany({
      where: { tenantId, lifecycleState: 'active', type: { in: ['google_drive', 'http_api', 'gmail'] } },
      orderBy: { name: 'asc' },
    })
  }

  async create(input: {
    tenantId: string
    type: Connector['type']
    name: string
    authMode: Connector['authMode']
    scope: Connector['scope']
  }): Promise<Connector> {
    return prisma.connector.create({
      data: {
        tenantId: input.tenantId,
        type: input.type,
        name: input.name,
        authMode: input.authMode,
        scope: input.scope,
        lifecycleState: 'active',
      },
    })
  }
}
