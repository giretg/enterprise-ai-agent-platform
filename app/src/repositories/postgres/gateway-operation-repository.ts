import {
  Prisma,
  type GatewayApproval,
  type GatewayOperation,
} from '@prisma/client'
import { prisma } from '@/lib/db'
import type {
  GatewayOperationCreateInput,
  GatewayOperationPatch,
  GatewayOperationRecord,
  GatewayOperationStore,
} from '@/domain/gateway-operation'

const INCLUDE = {
  approval: true,
  definition: { select: { agentId: true } },
} as const

type LoadedRow = GatewayOperation & {
  approval: GatewayApproval | null
  definition: { agentId: string }
}

function mapRow(row: LoadedRow): GatewayOperationRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    agentDefinitionVersionId: row.agentDefinitionVersionId,
    agentId: row.definition.agentId,
    principalUserId: row.principalUserId,
    toolName: row.toolName,
    argsJson: row.argsJson,
    idempotencyKey: row.idempotencyKey,
    status: row.status,
    connectorId: row.connectorId,
    errorCode: row.errorCode,
    resultJson: row.resultJson,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    approval: row.approval
      ? {
          id: row.approval.id,
          decidedByUserId: row.approval.decidedByUserId,
          decision: row.approval.decision,
          reason: row.approval.reason,
          decidedAt: row.approval.decidedAt,
        }
      : null,
  }
}

function jsonValue(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue
}

export class PostgresGatewayOperationRepository implements GatewayOperationStore {
  async findById(id: string): Promise<GatewayOperationRecord | null> {
    const row = await prisma.gatewayOperation.findUnique({
      where: { id },
      include: INCLUDE,
    })
    return row ? mapRow(row) : null
  }

  async findByTenantAndIdempotencyKey(
    tenantId: string,
    idempotencyKey: string,
  ): Promise<GatewayOperationRecord | null> {
    const row = await prisma.gatewayOperation.findUnique({
      where: { tenantId_idempotencyKey: { tenantId, idempotencyKey } },
      include: INCLUDE,
    })
    return row ? mapRow(row) : null
  }

  async createAwaitingApproval(
    input: GatewayOperationCreateInput,
  ): Promise<{ record: GatewayOperationRecord; created: boolean }> {
    try {
      const row = await prisma.gatewayOperation.create({
        data: {
          tenantId: input.tenantId,
          agentDefinitionVersionId: input.agentDefinitionVersionId,
          principalUserId: input.principalUserId,
          toolName: input.toolName,
          argsJson: jsonValue(input.argsJson),
          idempotencyKey: input.idempotencyKey,
          status: 'awaiting_approval',
          connectorId: input.connectorId,
          approval: { create: { decision: 'pending' } },
        },
        include: INCLUDE,
      })
      return { record: mapRow(row), created: true }
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const existing = await this.findByTenantAndIdempotencyKey(
          input.tenantId,
          input.idempotencyKey,
        )
        if (existing) return { record: existing, created: false }
      }
      throw error
    }
  }

  async listAwaitingApproval(tenantId: string): Promise<GatewayOperationRecord[]> {
    const rows = await prisma.gatewayOperation.findMany({
      where: { tenantId, status: 'awaiting_approval' },
      include: INCLUDE,
      orderBy: { createdAt: 'desc' },
    })
    return rows.map(mapRow)
  }

  async withLockedOperation<T>(
    operationId: string,
    fn: (
      row: GatewayOperationRecord,
      save: (patch: GatewayOperationPatch) => Promise<GatewayOperationRecord>,
    ) => Promise<T>,
  ): Promise<T | null> {
    return prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>(
        Prisma.sql`SELECT id FROM gateway_operations WHERE id = ${operationId}::uuid FOR UPDATE`,
      )
      if (locked.length === 0) return null
      const current = await tx.gatewayOperation.findUnique({
        where: { id: operationId },
        include: INCLUDE,
      })
      if (!current) return null

      const save = async (patch: GatewayOperationPatch): Promise<GatewayOperationRecord> => {
        return applyPatch(tx, operationId, patch)
      }
      return fn(mapRow(current), save)
    })
  }

  async update(id: string, patch: GatewayOperationPatch): Promise<GatewayOperationRecord | null> {
    return prisma.$transaction((tx) => applyPatch(tx, id, patch))
  }
}

async function applyPatch(
  tx: Prisma.TransactionClient,
  id: string,
  patch: GatewayOperationPatch,
): Promise<GatewayOperationRecord> {
  if (patch.approval) {
    await tx.gatewayApproval.update({
      where: { operationId: id },
      data: {
        decision: patch.approval.decision,
        decidedByUserId: patch.approval.decidedByUserId,
        reason: patch.approval.reason ?? null,
        decidedAt: patch.approval.decidedAt,
      },
    })
  }
  const row = await tx.gatewayOperation.update({
    where: { id },
    data: {
      ...(patch.status ? { status: patch.status } : {}),
      ...(patch.errorCode !== undefined ? { errorCode: patch.errorCode } : {}),
      ...(patch.resultJson !== undefined
        ? { resultJson: patch.resultJson === null ? Prisma.JsonNull : jsonValue(patch.resultJson) }
        : {}),
    },
    include: INCLUDE,
  })
  return mapRow(row)
}
