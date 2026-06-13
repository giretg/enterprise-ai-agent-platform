import type { AuditLog } from '@prisma/client'
import type { AuditRepository } from '@/repositories/interfaces'
import { computeAuditHash, GENESIS_HASH } from '@/lib/crypto/hash-chain'

export type VerifyResult =
  | { ok: true; checked: number }
  | { ok: false; checked: number; firstBreakSeq: string }

export class AuditChainService {
  constructor(private audit: AuditRepository) {}

  async verifyChain(): Promise<VerifyResult> {
    const rows = await this.audit.findAll()
    if (rows.length === 0) return { ok: true, checked: 0 }

    let prevHash = GENESIS_HASH

    for (const row of rows) {
      if (!row.hash) {
        return { ok: false, checked: rows.indexOf(row), firstBreakSeq: row.seq.toString() }
      }

      const expected = computeAuditHash({
        seq: row.seq,
        prevHash,
        actorType: row.actorType,
        actorId: row.actorId,
        action: row.action,
        targetType: row.targetType,
        targetId: row.targetId,
        createdAt: row.createdAt,
      })

      if (row.hash !== expected) {
        return { ok: false, checked: rows.indexOf(row), firstBreakSeq: row.seq.toString() }
      }

      prevHash = row.hash
    }

    return { ok: true, checked: rows.length }
  }

  async exportJsonLines(since?: Date): Promise<string> {
    const rows = await this.audit.findAll()
    const filtered = since ? rows.filter((r) => r.createdAt >= since) : rows
    return filtered.map((r) => JSON.stringify(serializeRow(r))).join('\n')
  }
}

function serializeRow(row: AuditLog) {
  return {
    id: row.id,
    seq: row.seq.toString(),
    actor_type: row.actorType,
    actor_id: row.actorId,
    agent_version: row.agentVersion,
    action: row.action,
    target_type: row.targetType,
    target_id: row.targetId,
    model_used: row.modelUsed,
    input_ref: row.inputRef,
    output_ref: row.outputRef,
    policy_decision: row.policyDecision,
    prev_hash: row.prevHash,
    hash: row.hash,
    metadata: row.metadata,
    created_at: row.createdAt.toISOString(),
  }
}
