import type { AuditLog, Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import type { AuditAppendInput, AuditListFilter, AuditRepository, AuditWalkFilter } from '../interfaces'
import { computeAuditHashV2, GENESIS_HASH } from '@/lib/crypto/hash-chain'
import { assertAuditMetadataSafe } from '@/lib/audit/payload-guard'
import { assertAuditActionRegistered } from '@/lib/audit/event-catalog'
import { deriveAuditAttribution } from '@/lib/audit/attribution'

const AUDIT_CHAIN_LOCK_KEY = 424242

/** Ugyanaz az audit-hash-lánc írás, egy hívó által már megnyitott tranzakcióban. */
export async function appendAuditInTransaction(
  tx: Prisma.TransactionClient,
  data: AuditAppendInput,
): Promise<AuditLog> {
  assertAuditActionRegistered(data.action)
  assertAuditMetadataSafe(data.metadata)
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${AUDIT_CHAIN_LOCK_KEY})`
  const [{ nextval: seq }] = await tx.$queryRaw<{ nextval: bigint }[]>`
    SELECT nextval('audit_log_seq_seq') AS nextval
  `
  const last = await tx.auditLog.findFirst({ orderBy: { seq: 'desc' } })
  const prevHash = last?.hash ?? GENESIS_HASH
  const createdAt = new Date()
  const attribution = deriveAuditAttribution(data)
  const hash = computeAuditHashV2({
    seq,
    prevHash,
    actorType: data.actorType,
    actorId: data.actorId ?? null,
    agentVersion: data.agentVersion ?? null,
    action: data.action,
    targetType: data.targetType,
    targetId: data.targetId ?? null,
    modelUsed: data.modelUsed ?? null,
    inputRef: data.inputRef ?? null,
    outputRef: data.outputRef ?? null,
    policyDecision: data.policyDecision ?? null,
    metadata: data.metadata,
    tenantId: attribution.tenantId,
    ticketId: null,
    conversationId: null,
    createdAt,
  })
  return tx.auditLog.create({
    data: {
      actorType: data.actorType,
      actorId: data.actorId ?? null,
      agentVersion: data.agentVersion ?? null,
      action: data.action,
      targetType: data.targetType,
      targetId: data.targetId ?? null,
      modelUsed: data.modelUsed ?? null,
      inputRef: data.inputRef ?? null,
      outputRef: data.outputRef ?? null,
      policyDecision: data.policyDecision ?? null,
      metadata: data.metadata === undefined ? undefined : (data.metadata as Prisma.InputJsonValue),
      tenantId: attribution.tenantId,
      seq,
      prevHash,
      hash,
      createdAt,
    },
  })
}

export class PostgresAuditRepository implements AuditRepository {
  /**
   * Egyetlen belépési pont az audit_log-ba. A hash-t INSERT ELŐTT számítjuk
   * (nextval a seq-sequence-ről az advisory lock alatt), így a sor egy atomi
   * INSERT-tel jön létre — nincs utólagos UPDATE.
   */
  async append(data: AuditAppendInput): Promise<AuditLog> {
    return prisma.$transaction((tx) => appendAuditInTransaction(tx, data), { timeout: 60_000 })
  }

  async findMany(filter?: AuditListFilter): Promise<AuditLog[]> {
    return prisma.auditLog.findMany({
      where: {
        ...(filter?.action
          ? { action: Array.isArray(filter.action) ? { in: filter.action } : filter.action }
          : {}),
        ...(filter?.actorType ? { actorType: filter.actorType } : {}),
        ...(filter?.actorId ? { actorId: filter.actorId } : {}),
        ...(filter?.targetType ? { targetType: filter.targetType } : {}),
        ...(filter?.targetId ? { targetId: filter.targetId } : {}),
        ...(filter?.tenantId ? { tenantId: filter.tenantId } : {}),
        ...(filter?.since || filter?.until
          ? {
              createdAt: {
                ...(filter?.since ? { gte: filter.since } : {}),
                ...(filter?.until ? { lte: filter.until } : {}),
              },
            }
          : {}),
      },
      orderBy: { seq: filter?.order ?? 'desc' },
      take: filter?.limit ?? 100,
    })
  }

  async findAll(filter?: AuditWalkFilter): Promise<AuditLog[]> {
    const seqFilter: Prisma.BigIntFilter = {}
    if (filter?.fromSeq !== undefined) seqFilter.gte = filter.fromSeq
    if (filter?.toSeq !== undefined) seqFilter.lte = filter.toSeq

    return prisma.auditLog.findMany({
      where: {
        ...(Object.keys(seqFilter).length > 0 ? { seq: seqFilter } : {}),
        ...(filter?.tenantId ? { tenantId: filter.tenantId } : {}),
        ...(filter?.since ? { createdAt: { gte: filter.since } } : {}),
      },
      orderBy: { seq: 'asc' },
    })
  }

  async getActionCounts(filter?: {
    actions?: string[]
    since?: Date
  }): Promise<Record<string, number>> {
    const grouped = await prisma.auditLog.groupBy({
      by: ['action'],
      where: {
        ...(filter?.actions ? { action: { in: filter.actions } } : {}),
        ...(filter?.since ? { createdAt: { gte: filter.since } } : {}),
      },
      _count: { _all: true },
    })

    const counts: Record<string, number> = {}
    if (filter?.actions) {
      for (const action of filter.actions) counts[action] = 0
    }
    for (const row of grouped) counts[row.action] = row._count._all
    return counts
  }
}
