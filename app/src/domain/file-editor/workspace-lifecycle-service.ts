import type { TicketState } from '@prisma/client'
import { prisma } from '@/lib/db'
import type { PostgresConnectorRepository } from '@/repositories/postgres/connector-repository'
import { WorkspaceStorage } from './workspace-storage'

const TERMINAL_TICKET_STATES: TicketState[] = ['done', 'rejected', 'approved']

type WorkspaceConnectorConfig = {
  bucket?: string
  retentionDays?: number
}

function resolveBucket(config: WorkspaceConnectorConfig): string {
  return config.bucket ?? process.env.WORKSPACE_BUCKET ?? 'platform-workspace-prod'
}

function resolveRetentionDays(config: WorkspaceConnectorConfig): number {
  return typeof config.retentionDays === 'number' && config.retentionDays > 0 ? config.retentionDays : 30
}

export class WorkspaceLifecycleService {
  constructor(
    private connectors: PostgresConnectorRepository,
    private storageFactory: (bucket: string) => WorkspaceStorage,
  ) {}

  async purgeExpiredWorkspaces(limit = 50): Promise<{ purgedTickets: number; deletedObjects: number }> {
    const connector = await this.connectors.findWorkspaceConnector(null)
    if (!connector) return { purgedTickets: 0, deletedObjects: 0 }

    const config = connector.config as WorkspaceConnectorConfig
    const retentionDays = resolveRetentionDays(config)
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000)
    const storage = this.storageFactory(resolveBucket(config))
    const tenantId = connector.tenantId ?? 'global'

    const tickets = await prisma.ticket.findMany({
      where: {
        state: { in: TERMINAL_TICKET_STATES },
        updatedAt: { lt: cutoff },
      },
      select: { id: true },
      orderBy: { updatedAt: 'asc' },
      take: limit,
    })

    let deletedObjects = 0
    for (const ticket of tickets) {
      deletedObjects += await storage.deleteTicketWorkspace(tenantId, ticket.id)
    }

    return { purgedTickets: tickets.length, deletedObjects }
  }

  async purgeTenantWorkspaces(tenantId: string): Promise<number> {
    const connector = await this.connectors.findWorkspaceConnector(tenantId)
    if (!connector) return 0

    const config = connector.config as WorkspaceConnectorConfig
    const storage = this.storageFactory(resolveBucket(config))
    return storage.deleteTenantWorkspaces(tenantId)
  }

  async purgeTicketWorkspace(tenantId: string | null, ticketId: string): Promise<number> {
    const connector = await this.connectors.findWorkspaceConnector(tenantId)
    if (!connector) return 0

    const config = connector.config as WorkspaceConnectorConfig
    const storage = this.storageFactory(resolveBucket(config))
    const workspaceTenantKey = tenantId ?? connector.tenantId ?? 'global'
    return storage.deleteTicketWorkspace(workspaceTenantKey, ticketId)
  }
}
