import type { AuditLog, Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import {
  computeAuditHash,
  computeAuditHashV2,
  parseAuditHashVersion,
  GENESIS_HASH,
} from '@/lib/crypto/hash-chain'

type AuditDb = Prisma.TransactionClient | typeof prisma

/**
 * A reconcile a MEGLÉVŐ sor tárolt hash-verziója szerint számol újra: egy v2 sort v2
 * formulával (teljes mezőfedés), egy v1 (legacy) sort v1-gyel. Hash nélküli (gap) sort
 * a jelenlegi verzióval (v2) horgonyoz — az új írások eleve v2-esek. Így a repair nem
 * minősíti vissza a v2 sorok governance/metadata-fedését.
 */
function hashFields(row: AuditLog, prevHash: string) {
  if (!row.hash || parseAuditHashVersion(row.hash) === 2) {
    return computeAuditHashV2({
      seq: row.seq,
      prevHash,
      actorType: row.actorType,
      actorId: row.actorId,
      agentVersion: row.agentVersion,
      action: row.action,
      targetType: row.targetType,
      targetId: row.targetId,
      modelUsed: row.modelUsed,
      inputRef: row.inputRef,
      outputRef: row.outputRef,
      policyDecision: row.policyDecision,
      metadata: row.metadata,
      tenantId: row.tenantId,
      ticketId: row.ticketId,
      conversationId: row.conversationId,
      createdAt: row.createdAt,
    })
  }
  return computeAuditHash({
    seq: row.seq,
    prevHash,
    actorType: row.actorType,
    actorId: row.actorId,
    action: row.action,
    targetType: row.targetType,
    targetId: row.targetId,
    createdAt: row.createdAt,
  })
}

/** Recompute prevHash/hash for every row in seq order. Returns the chain head. */
export async function reconcileAuditChain(db: AuditDb = prisma): Promise<string> {
  const rows = await db.auditLog.findMany({ orderBy: { seq: 'asc' } })
  let prevHash = GENESIS_HASH

  for (const row of rows) {
    const hash = hashFields(row, prevHash)
    if (row.prevHash !== prevHash || row.hash !== hash) {
      await db.auditLog.update({
        where: { id: row.id },
        data: { prevHash, hash },
      })
    }
    prevHash = hash
  }

  return prevHash
}

export async function chainHasGaps(db: AuditDb = prisma): Promise<boolean> {
  const gap = await db.auditLog.findFirst({
    where: { OR: [{ hash: null }, { prevHash: null }] },
    orderBy: { seq: 'asc' },
  })
  return gap !== null
}

export async function chainNeedsReconcile(db: AuditDb = prisma): Promise<boolean> {
  if (await chainHasGaps(db)) return true

  const rows = await db.auditLog.findMany({ orderBy: { seq: 'asc' } })
  let prevHash = GENESIS_HASH

  for (const row of rows) {
    if (row.prevHash !== prevHash) return true
    const expected = hashFields(row, prevHash)
    if (row.hash !== expected) return true
    prevHash = row.hash!
  }

  return false
}
