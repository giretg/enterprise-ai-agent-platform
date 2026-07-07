import type { AuditLog, Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import { computeAuditHashV2, GENESIS_HASH } from '@/lib/crypto/hash-chain'

type AuditDb = Prisma.TransactionClient | typeof prisma

/**
 * Az egyszeri (admin) reconcile a teljes láncot a v2 (teljes soronkénti fedésű) formulára
 * hozza. Ez a `backfill-audit-hashes` migrációs eszköz útja, ahol az append-only trigger
 * kézzel, egyszeri jelleggel le van tiltva; runtime úton NEM fut.
 */
function hashFields(row: AuditLog, prevHash: string) {
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
