import type { Connector } from '@prisma/client'
import { prisma } from '@/lib/db'
import type { ConnectorRepository } from '@/repositories/interfaces'

export class PostgresConnectorRepository implements ConnectorRepository {
  async findWorkspaceConnector(tenantId: string | null): Promise<Connector | null> {
    const scoped = await prisma.connector.findFirst({
      where: { type: 'workspace', tenantId },
      orderBy: { createdAt: 'asc' },
    })
    if (scoped) return scoped

    return prisma.connector.findFirst({
      where: { type: 'workspace', tenantId: null },
      orderBy: { createdAt: 'asc' },
    })
  }

  async listActiveForPrivacy(
    tenantId: string | null,
  ): Promise<Array<Pick<Connector, 'id' | 'name' | 'config'>>> {
    return prisma.connector.findMany({
      where: {
        lifecycleState: 'active',
        ...(tenantId ? { OR: [{ tenantId: null }, { tenantId }] } : { tenantId: null }),
      },
      select: { id: true, name: true, config: true },
      orderBy: { name: 'asc' },
      take: 200,
    })
  }
}
