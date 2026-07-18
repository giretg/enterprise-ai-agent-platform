import { prisma } from '@/lib/db'
import type { Prisma, WriteGateToken } from '@prisma/client'
import {
  computeDiffHash,
  generateTokenPair,
  signWriteGateToken,
  verifyWriteGateSignature,
} from '@/lib/crypto/hash-chain'

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

export class WriteGateService {
  constructor(private readonly db: WriteGateTokenClient = prisma) {}

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

    return this.db.writeGateToken.create({
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
  }

  async consume(params: {
    tokenId: string
    actualProposedContent: string
  }): Promise<WriteGateToken> {
    const token = await this.db.writeGateToken.findUnique({ where: { id: params.tokenId } })
    if (!token) throw new Error('write_gate: token not found')
    if (token.status !== 'issued') throw new Error(`write_gate: token already ${token.status}`)
    if (new Date() > token.expiresAt) {
      // Compare-and-set: csak akkor jelöljük lejártnak, ha még `issued` —
      // különben egy versenyző `consume` már-consumed sorát írnánk felül.
      await this.db.writeGateToken.updateMany({
        where: { id: token.id, status: 'issued' },
        data: { status: 'expired' },
      })
      throw new Error('write_gate: token expired')
    }

    const actualDiffHash = computeDiffHash(params.actualProposedContent)
    if (actualDiffHash !== token.expectedDiffHash) {
      throw new Error('write_gate: content hash mismatch — approved diff does not match')
    }

    const subjectId = token.trainingTicketId ?? token.memoryCandidateId
    if (!subjectId) throw new Error('write_gate: token has no subject anchor')

    const signatureOk = verifyWriteGateSignature({
      tokenHash: token.tokenHash,
      expectedDiffHash: token.expectedDiffHash,
      subjectId,
      expiresAt: token.expiresAt,
      signature: token.signature,
    })
    if (!signatureOk) throw new Error('write_gate: signature invalid — token tampered')

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
      throw new Error('write_gate: token already consumed — concurrent use rejected')
    }

    // A frissen kiolvasott `token` a saját tranzakciónk győztes írásának állapotát
    // tükrözi (csak ez az út mozdítja `issued`-ról); nincs szükség extra kör-útra.
    return { ...token, status: 'consumed', consumedAt }
  }
}
