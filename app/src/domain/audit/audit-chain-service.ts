import type { AuditLog } from '@prisma/client'
import type { AuditRepository, AuditWalkFilter } from '@/repositories/interfaces'
import {
  computeAuditHash,
  computeAuditHashV2,
  parseAuditHashVersion,
  GENESIS_HASH,
} from '@/lib/crypto/hash-chain'

/**
 * A tárolt hash verziója dönti el, melyik formulával kell újraszámolni.
 * A v2 hash ticketId/conversationId mezőit üres stringként fedi (nincs oszlop).
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
      ticketId: null,
      conversationId: null,
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
   * Teljes lánc (paraméter nélkül) vagy egy [fromSeq..toSeq] szegmens.
   * Tenant-szűrés a tenant sorok mezőit ellenőrzi, a prevHash-t a globális
   * előző seq hash-éből (csak seq+hash, idegen metadata nélkül).
   */
  async verifyChain(
    fromSeq?: bigint,
    toSeq?: bigint,
    tenantId?: string,
  ): Promise<VerifyResult> {
    const filter: AuditWalkFilter | undefined =
      fromSeq !== undefined || toSeq !== undefined || tenantId
        ? { fromSeq, toSeq, tenantId }
        : undefined
    const rows = await this.audit.findAll(filter)
    if (rows.length === 0) return { ok: true, checked: 0 }

    const tenantScoped = Boolean(tenantId)
    const links = tenantScoped ? await this.audit.listHashChain({ toSeq }) : undefined

    let prevHash =
      tenantScoped || fromSeq !== undefined ? (rows[0].prevHash ?? GENESIS_HASH) : GENESIS_HASH
    let linkIdx = 0
    let globalPrev = GENESIS_HASH

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]
      if (!row.hash) {
        return { ok: false, checked: i, firstBreakSeq: row.seq.toString() }
      }

      if (tenantScoped && links) {
        while (linkIdx < links.length && links[linkIdx].seq < row.seq) {
          const linkHash = links[linkIdx].hash
          if (linkHash) globalPrev = linkHash
          linkIdx += 1
        }
      }

      const expectedPrev = tenantScoped ? globalPrev : prevHash
      if (tenantScoped && (row.prevHash ?? GENESIS_HASH) !== expectedPrev) {
        return { ok: false, checked: i, firstBreakSeq: row.seq.toString() }
      }

      const expected = expectedHashForRow(row, expectedPrev)
      if (row.hash !== expected) {
        return { ok: false, checked: i, firstBreakSeq: row.seq.toString() }
      }

      prevHash = row.hash
    }

    return { ok: true, checked: rows.length }
  }

  async exportJsonLines(params: { tenantId: string; since?: Date }): Promise<string> {
    const rows = await this.audit.findAll(params)
    return rows.map((r) => JSON.stringify(serializeRow(r))).join('\n')
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
    tenant_id: row.tenantId,
    created_at: row.createdAt.toISOString(),
  }
}
