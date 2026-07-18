import { prisma } from '@/lib/db'
import type { Prisma, WriteGateToken } from '@prisma/client'
import {
  computeDiffHash,
  generateTokenPair,
  signWriteGateToken,
  verifyWriteGateSignature,
} from '@/lib/crypto/hash-chain'
import type { AuditRepository } from '@/repositories/interfaces'

const TOKEN_TTL_MS = 15 * 60 * 1000 // 15 perc

/**
 * A service kizárólag a `writeGateToken` delegátumot használja a Prisma kliensből.
 * Szűk interfészre szűkítjük, hogy az atomikus (compare-and-set) fogyasztási
 * viselkedés injektált, in-memory klienssel is determinisztikusan tesztelhető
 * legyen — a codebase konstruktor-injekciós mintája szerint.
 */
export type WriteGateTokenClient = {
  writeGateToken: {
    create: (args: Prisma.WriteGateTokenCreateArgs) => Promise<WriteGateToken>
    findUnique: (args: Prisma.WriteGateTokenFindUniqueArgs) => Promise<WriteGateToken | null>
    updateMany: (args: Prisma.WriteGateTokenUpdateManyArgs) => Promise<Prisma.BatchPayload>
  }
}

/**
 * A write-gate audit-sorok hívói kontextusa. A token-sor maga nem hordoz tenantot
 * és aktort (csak agentId-t), ezért a governance-lánchoz a hívónak kell megadnia:
 * ki kérte az írás-engedélyt és melyik tenant nevében.
 */
export type WriteGateAuditContext = {
  tenantId: string | null
  actorType: 'human' | 'agent' | 'system'
  /** Human/agent aktor UUID-je; `system` úton null. */
  actorId: string | null
  agentVersion?: number | null
}

/** A `write_gate.*` audit-akciók; mindegyik regisztrált az event-catalog-ban. */
type WriteGateAuditAction =
  | 'write_gate.issued'
  | 'write_gate.consumed'
  | 'write_gate.replay_denied'
  | 'write_gate.expired'
  | 'write_gate.rejected'

export class WriteGateService {
  /**
   * Az audit-repository KÖTELEZŐ függőség: a write-gate a governance-lánc egyik
   * kapuja, így nem példányosítható auditálás nélkül. A DB-kliens marad injektálható
   * (alapból a valódi prisma), hogy a CAS-viselkedés DB nélkül is tesztelhető legyen.
   */
  constructor(
    private readonly audit: AuditRepository,
    private readonly db: WriteGateTokenClient = prisma,
  ) {}

  /**
   * A write-gate események a következményes írás engedélyét dokumentálják, ezért a
   * hash-láncba kerülnek. A metaadat SOHA nem tartalmazza a nyers token-értéket
   * (az egyébként sem perzisztált) és a tokenHash/aláírás sem kerül bele — csak a
   * token azonosítója, az érintett agent, a cél-memória és a horgony.
   */
  private async auditToken(params: {
    action: WriteGateAuditAction
    token: Pick<
      WriteGateToken,
      'id' | 'agentId' | 'targetMemoryId' | 'trainingTicketId' | 'memoryCandidateId' | 'expectedDiffHash'
    >
    context: WriteGateAuditContext
    policyDecision: string
  }): Promise<void> {
    const { token, context } = params
    await this.audit.append({
      actorType: context.actorType,
      actorId: context.actorId,
      agentVersion: context.agentVersion ?? null,
      action: params.action,
      targetType: 'write_gate_token',
      targetId: token.id,
      modelUsed: null,
      inputRef: token.trainingTicketId ?? token.memoryCandidateId,
      outputRef: token.targetMemoryId,
      policyDecision: params.policyDecision,
      tenantId: context.tenantId,
      // `ticketId` az audit-láncban a `Ticket` modellre mutat (lásd
      // `deriveAuditAttribution`: targetType === 'ticket'). A `TrainingTicket` MÁS
      // entitás, ide betéve elszennyezné a ticket-szűrt audit-lekérdezéseket —
      // a training-ticket horgony az `inputRef`-en és a metaadatban van.
      metadata: {
        writeGateTokenId: token.id,
        agentId: token.agentId,
        targetMemoryId: token.targetMemoryId,
        trainingTicketId: token.trainingTicketId,
        memoryCandidateId: token.memoryCandidateId,
        expectedDiffHash: token.expectedDiffHash,
      },
    })
  }

  /**
   * §9.4 — a token horgonya training-útnál `trainingTicketId`, memória-útnál
   * (inline candidate-jóváhagyás) `memoryCandidateId`. Pontosan az egyiknek
   * kell kitöltöttnek lennie; ez az invariáns itt, alkalmazás-szinten dől el
   * (a séma mindkettőt nullable-nek engedi).
   */
  async issue(params: {
    trainingTicketId?: string
    memoryCandidateId?: string
    agentId: string
    targetMemoryId: string
    proposedContent: string
    context: WriteGateAuditContext
  }): Promise<WriteGateToken> {
    const subjectId = params.trainingTicketId ?? params.memoryCandidateId
    if (!subjectId || (params.trainingTicketId && params.memoryCandidateId)) {
      throw new Error('write_gate: exactly one of trainingTicketId/memoryCandidateId is required')
    }

    const expectedDiffHash = computeDiffHash(params.proposedContent)
    const { tokenHash } = generateTokenPair()
    const expiresAt = new Date(Date.now() + TOKEN_TTL_MS)

    const signature = signWriteGateToken({
      tokenHash,
      expectedDiffHash,
      subjectId,
      expiresAt,
    })

    const token = await this.db.writeGateToken.create({
      data: {
        trainingTicketId: params.trainingTicketId ?? null,
        memoryCandidateId: params.memoryCandidateId ?? null,
        agentId: params.agentId,
        targetMemoryId: params.targetMemoryId,
        expectedDiffHash,
        tokenHash,
        signature,
        status: 'issued',
        expiresAt,
      },
    })

    await this.auditToken({
      action: 'write_gate.issued',
      token,
      context: params.context,
      policyDecision: 'write_gate_issued',
    })

    return token
  }

  async consume(params: {
    tokenId: string
    actualProposedContent: string
    context: WriteGateAuditContext
  }): Promise<WriteGateToken> {
    const token = await this.db.writeGateToken.findUnique({ where: { id: params.tokenId } })
    if (!token) throw new Error('write_gate: token not found')

    /**
     * Elutasítási ág: auditálunk, majd dobunk. Az audit-írás best-effort, mert egy
     * audit-hiba NEM nyomhatja el a biztonsági hibaokot — a hívó (és a fail-closed
     * viselkedés) számára az elutasítás oka a fontos, azt kell látnia a stack-en.
     */
    const deny = async (
      action: WriteGateAuditAction,
      policyDecision: string,
      message: string,
    ): Promise<never> => {
      try {
        await this.auditToken({ action, token, context: params.context, policyDecision })
      } catch (auditError) {
        console.error('[write-gate] audit append failed on deny path', {
          tokenId: token.id,
          action,
          error: auditError instanceof Error ? auditError.message : String(auditError),
        })
      }
      throw new Error(message)
    }

    if (token.status !== 'issued') {
      // Már lezárt tokenre érkező fogyasztás — visszajátszási kísérlet, auditáljuk.
      return deny(
        'write_gate.replay_denied',
        `write_gate_replay_denied:${token.status}`,
        `write_gate: token already ${token.status}`,
      )
    }
    if (new Date() > token.expiresAt) {
      // Compare-and-set: csak akkor jelöljük lejártnak, ha még `issued` —
      // különben egy versenyző `consume` már-consumed sorát írnánk felül.
      const expiry = await this.db.writeGateToken.updateMany({
        where: { id: token.id, status: 'issued' },
        data: { status: 'expired' },
      })
      // Ha a CAS 0 sort érintett, egy párhuzamos fogyasztó már elvitte a tokent:
      // a valós terminál-státusz `consumed`, ezért NEM írhatunk `expired` láncsort —
      // az hamis tényt rögzítene. Ilyenkor ez is visszajátszásnak minősül.
      if (expiry.count === 0) {
        return deny(
          'write_gate.replay_denied',
          'write_gate_replay_denied:concurrent',
          'write_gate: token already consumed — concurrent use rejected',
        )
      }
      return deny('write_gate.expired', 'write_gate_expired', 'write_gate: token expired')
    }

    const actualDiffHash = computeDiffHash(params.actualProposedContent)
    if (actualDiffHash !== token.expectedDiffHash) {
      // Hamisítás-jelzés: a jóváhagyott diff nem az, amit írni akarnak. A §9.4
      // "nem hamisítható" invariáns sérülése épp úgy láncba tartozik, mint a replay.
      return deny(
        'write_gate.rejected',
        'write_gate_rejected:content_hash_mismatch',
        'write_gate: content hash mismatch — approved diff does not match',
      )
    }

    const subjectId = token.trainingTicketId ?? token.memoryCandidateId
    if (!subjectId) {
      return deny(
        'write_gate.rejected',
        'write_gate_rejected:missing_subject_anchor',
        'write_gate: token has no subject anchor',
      )
    }

    const signatureOk = verifyWriteGateSignature({
      tokenHash: token.tokenHash,
      expectedDiffHash: token.expectedDiffHash,
      subjectId,
      expiresAt: token.expiresAt,
      signature: token.signature,
    })
    if (!signatureOk) {
      return deny(
        'write_gate.rejected',
        'write_gate_rejected:signature_invalid',
        'write_gate: signature invalid — token tampered',
      )
    }

    // §9.4 — a write-gate token EGYSZER használatos: egy jóváhagyás pontosan egy
    // írást hitelesít. A státusz-átmenetet atomikus compare-and-set-tel zárjuk, így
    // két párhuzamos `consume` közül csak az egyik nyerhet; a fenti státusz-olvasás
    // csak gyors, best-effort hibaüzenet. A `count === 0` a versenyben vesztett
    // (időközben már nem `issued`) tokent fail-closed elutasítja.
    const consumedAt = new Date()
    const claim = await this.db.writeGateToken.updateMany({
      where: { id: token.id, status: 'issued' },
      data: { status: 'consumed', consumedAt },
    })
    if (claim.count === 0) {
      // A versenyben vesztes fogyasztó: átjutott a korai státusz-olvasáson, de a CAS
      // már nem találta `issued`-nak. Ez is visszajátszás — auditálandó.
      return deny(
        'write_gate.replay_denied',
        'write_gate_replay_denied:concurrent',
        'write_gate: token already consumed — concurrent use rejected',
      )
    }

    await this.auditToken({
      action: 'write_gate.consumed',
      token,
      context: params.context,
      policyDecision: 'write_gate_consumed',
    })

    // A frissen kiolvasott `token` a saját tranzakciónk győztes írásának állapotát
    // tükrözi (csak ez az út mozdítja `issued`-ról); nincs szükség extra kör-útra.
    return { ...token, status: 'consumed', consumedAt }
  }
}
