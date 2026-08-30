import type { ConnectorGrant, ConnectorGrantStatus, Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'

export interface ConnectorGrantRepository {
  findActiveGrant(params: {
    tenantId: string | null
    connectorId: string
    userId: string
  }): Promise<ConnectorGrant | null>
  findActiveByConnector(connectorId: string): Promise<ConnectorGrant[]>
  findActiveForInactiveConnectors(userId: string, tenantId?: string | null): Promise<ConnectorGrant[]>
  findByUser(
    userId: string,
    tenantId?: string | null,
  ): Promise<
    Array<
      ConnectorGrant & {
        connector: { id: string; name: string; type: string; lifecycleState: string }
      }
    >
  >
  create(data: {
    tenantId: string | null
    connectorId: string
    userId: string
    scopes: Prisma.JsonValue
    tokenRef: string
    accountLabel?: string | null
    expiresAt?: Date | null
  }): Promise<ConnectorGrant>
  updateStatus(
    id: string,
    status: ConnectorGrantStatus,
    extra?: { revokedAt?: Date; lastRefreshedAt?: Date; expiresAt?: Date | null },
  ): Promise<ConnectorGrant>
  revokeAllForUser(userId: string): Promise<number>
  findById(id: string): Promise<ConnectorGrant | null>
  updateMetadata(id: string, metadata: Prisma.InputJsonValue): Promise<ConnectorGrant>
}

export class PostgresConnectorGrantRepository implements ConnectorGrantRepository {
  async findActiveGrant(params: {
    tenantId: string | null
    connectorId: string
    userId: string
  }): Promise<ConnectorGrant | null> {
    return prisma.connectorGrant.findFirst({
      where: {
        tenantId: params.tenantId,
        connectorId: params.connectorId,
        userId: params.userId,
        status: 'active',
        connector: { lifecycleState: 'active' },
      },
    })
  }

  async findActiveByConnector(connectorId: string) {
    return prisma.connectorGrant.findMany({
      where: { connectorId, status: 'active' },
    })
  }

  async findActiveForInactiveConnectors(userId: string, tenantId?: string | null) {
    return prisma.connectorGrant.findMany({
      where: {
        userId,
        status: 'active',
        ...(tenantId !== undefined ? { tenantId } : {}),
        connector: { lifecycleState: { not: 'active' } },
      },
    })
  }

  async findByUser(userId: string, tenantId?: string | null) {
    return prisma.connectorGrant.findMany({
      where: {
        userId,
        ...(tenantId !== undefined ? { tenantId } : {}),
      },
      include: {
        connector: { select: { id: true, name: true, type: true, lifecycleState: true } },
      },
      orderBy: { grantedAt: 'desc' },
    })
  }

  async create(data: {
    tenantId: string | null
    connectorId: string
    userId: string
    scopes: Prisma.JsonValue
    tokenRef: string
    accountLabel?: string | null
    expiresAt?: Date | null
  }) {
    const existing = await prisma.connectorGrant.findFirst({
      where: {
        tenantId: data.tenantId,
        connectorId: data.connectorId,
        userId: data.userId,
      },
    })

    const payload = {
      scopes: data.scopes as Prisma.InputJsonValue,
      tokenRef: data.tokenRef,
      accountLabel: data.accountLabel ?? null,
      expiresAt: data.expiresAt ?? null,
      status: 'active' as const,
      revokedAt: null,
    }

    if (existing) {
      return prisma.connectorGrant.update({
        where: { id: existing.id },
        data: { ...payload, grantedAt: new Date() },
      })
    }

    return prisma.connectorGrant.create({
      data: {
        tenantId: data.tenantId,
        connectorId: data.connectorId,
        userId: data.userId,
        ...payload,
      },
    })
  }

  async updateStatus(
    id: string,
    status: ConnectorGrantStatus,
    extra?: { revokedAt?: Date; lastRefreshedAt?: Date; expiresAt?: Date | null },
  ) {
    return prisma.connectorGrant.update({
      where: { id },
      data: { status, ...extra },
    })
  }

  async revokeAllForUser(userId: string) {
    const result = await prisma.connectorGrant.updateMany({
      where: { userId, status: 'active' },
      data: { status: 'revoked', revokedAt: new Date() },
    })
    return result.count
  }

  async findById(id: string) {
    return prisma.connectorGrant.findUnique({ where: { id } })
  }

  async updateMetadata(id: string, metadata: Prisma.InputJsonValue) {
    return prisma.connectorGrant.update({
      where: { id },
      data: { metadata },
    })
  }
}
