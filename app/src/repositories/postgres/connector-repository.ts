import type { Connector } from '@prisma/client'
import { prisma } from '@/lib/db'

export class PostgresConnectorRepository {
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
}
