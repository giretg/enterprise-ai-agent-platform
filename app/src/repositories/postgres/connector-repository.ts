import type { Connector, Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import type { ConnectorRepository } from '@/repositories/interfaces'
import { pinnedRuntimeConfig } from '@/domain/connector/runtime-config'

/**
 * Self-updating connectorok `config` oszlopa üres ({}) — a valódi baseUrl/auth/
 * endpoint-lista a jóváhagyott spec-verzió capability_set-jéből pinnelődik.
 * Enélkül minden futásidejű hívás (pl. http_api_get) üres baseUrl-lel bukik el,
 * miközben az admin UI és a listázás helyesen látja a kapcsolatot aktívnak.
 */
export function resolveRuntimeConnector(
  row: Connector & { activeSpecVersion: { capabilitySet: Prisma.JsonValue } | null },
): Connector | null {
  const { activeSpecVersion, ...connector } = row
  if (connector.connectorMode !== 'self_updating') return connector
  const pinned = pinnedRuntimeConfig('self_updating', connector.config, activeSpecVersion?.capabilitySet ?? null)
  if (pinned === null) return null
  return { ...connector, config: pinned }
}

export class PostgresConnectorRepository implements ConnectorRepository {
  async findById(id: string, tenantId?: string): Promise<Connector | null> {
    const row = await prisma.connector.findFirst({
      where: tenantId ? { id, tenantId } : { id },
      include: { activeSpecVersion: { select: { capabilitySet: true } } },
    })
    return row ? resolveRuntimeConnector(row) : null
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

  async findByNameInTenant(tenantId: string, name: string): Promise<Connector[]> {
    const trimmed = name.trim()
    if (!trimmed) return this.listForTenant(tenantId)
    return prisma.connector.findMany({
      where: { tenantId, name: { equals: trimmed, mode: 'insensitive' } },
      orderBy: { name: 'asc' },
    })
  }

  async listForTenant(tenantId: string): Promise<Connector[]> {
    return prisma.connector.findMany({
      where: { tenantId },
      orderBy: { name: 'asc' },
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
