import type { ConnectorTemplate } from '@prisma/client'
import { prisma } from '@/lib/db'
import type { ConnectorTemplateRepository, NewTemplateVersion } from '../interfaces'

export class PostgresConnectorTemplateRepository implements ConnectorTemplateRepository {
  async listVisible(scope: { tenantId: string | null }): Promise<ConnectorTemplate[]> {
    return prisma.connectorTemplate.findMany({
      where: {
        status: { in: ['active', 'deprecated'] },
        OR: [{ tenantId: null }, ...(scope.tenantId ? [{ tenantId: scope.tenantId }] : [])],
      },
      orderBy: [{ displayName: 'asc' }, { version: 'desc' }],
    })
  }

  async findLatestByKey(key: string, tenantId: string | null): Promise<ConnectorTemplate | null> {
    return prisma.connectorTemplate.findFirst({
      where: {
        key,
        status: { in: ['active', 'deprecated'] },
        OR: [{ tenantId: null }, ...(tenantId ? [{ tenantId }] : [])],
      },
      orderBy: [{ version: 'desc' }],
    })
  }

  async findByIdVersion(id: string): Promise<ConnectorTemplate | null> {
    return prisma.connectorTemplate.findUnique({ where: { id } })
  }

  async createVersion(input: NewTemplateVersion): Promise<ConnectorTemplate> {
    return prisma.connectorTemplate.create({
      data: {
        key: input.key,
        version: input.version,
        origin: input.origin,
        displayName: input.displayName,
        description: input.description ?? null,
        tenantId: input.tenantId,
        descriptor: input.descriptor,
        status: input.status ?? 'active',
        createdById: input.createdById ?? null,
      },
    })
  }

  async deprecate(id: string): Promise<void> {
    await prisma.connectorTemplate.update({
      where: { id },
      data: { status: 'deprecated' },
    })
  }

  async upsertBuiltin(input: NewTemplateVersion): Promise<ConnectorTemplate> {
    const existing = await prisma.connectorTemplate.findFirst({
      where: { key: input.key, version: input.version, tenantId: null, origin: 'builtin' },
    })
    if (!existing) return this.createVersion({ ...input, origin: 'builtin', tenantId: null })
    return prisma.connectorTemplate.update({
      where: { id: existing.id },
      data: {
        displayName: input.displayName,
        description: input.description ?? null,
        descriptor: input.descriptor,
        status: input.status ?? 'active',
      },
    })
  }
}
