import type { AuditLog } from '@prisma/client'
import type { AuditRepository } from '@/repositories/interfaces'
import {
  computeAuditHash,
  computeAuditHashV2,
  parseAuditHashVersion,
  GENESIS_HASH,
} from '@/lib/crypto/hash-chain'

/**
 * A tárolt hash verziója dönti el, melyik formulával kell újraszámolni az elvárt értéket.
 * A v2 a sor minden érdemi mezőjét fedi; a v1 (legacy) csak a vázat. A verzió magában a
 * hash-stringben utazik (`"2:"` előfej), így egy v2 sort nem lehet a v1 formulával
 * (ami a policyDecision/metadata mezőket figyelmen kívül hagyja) átverni a verifikáción.
 * A v2 az attribúciós oszlopokat (tenant/ticket/conversation) közvetlenül a tárolt
 * értékből ellenőrzi — pontosan azt, amit írás-időben a hash fedett.
 */
function expectedHashForRow(row: AuditLog, prevHash: string): string {
  if (row.hash && parseAuditHashVersion(row.hash) === 2) {
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

export type VerifyResult =
  | { ok: true; checked: number }
  | { ok: false; checked: number; firstBreakSeq: string }

export class AuditChainService {
  constructor(private audit: AuditRepository) {}

  /**
   * Teljes lánc (paraméter nélkül) vagy egy [fromSeq..toSeq] szegmens verifikációja
   * (spec §6.2/§6.3 — checkpoint-alapú részleges ellenőrzés). Szegmens esetén a lánc
   * belső konzisztenciáját nézzük: a szegmens első sorának SAJÁT tárolt `prevHash`-ét
   * anchor-nak fogadjuk el (azt egy korábbi teljes/anchor-ellenőrzés már igazolta).
   */
  async verifyChain(fromSeq?: bigint, toSeq?: bigint): Promise<VerifyResult> {
    const rows = await this.audit.findAll(
      fromSeq !== undefined || toSeq !== undefined ? { fromSeq, toSeq } : undefined,
    )
    if (rows.length === 0) return { ok: true, checked: 0 }

    let prevHash = fromSeq !== undefined ? (rows[0].prevHash ?? GENESIS_HASH) : GENESIS_HASH

    for (const row of rows) {
      if (!row.hash) {
        return { ok: false, checked: rows.indexOf(row), firstBreakSeq: row.seq.toString() }
      }

      const expected = expectedHashForRow(row, prevHash)

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
