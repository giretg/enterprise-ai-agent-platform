import { prisma } from '@/lib/db'
import type { WriteGateToken } from '@prisma/client'
import {
  computeDiffHash,
  generateTokenPair,
  signWriteGateToken,
  verifyWriteGateSignature,
} from '@/lib/crypto/hash-chain'

const TOKEN_TTL_MS = 15 * 60 * 1000 // 15 perc

export class WriteGateService {
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

    return prisma.writeGateToken.create({
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
    const token = await prisma.writeGateToken.findUnique({ where: { id: params.tokenId } })
    if (!token) throw new Error('write_gate: token not found')
    if (token.status !== 'issued') throw new Error(`write_gate: token already ${token.status}`)
    if (new Date() > token.expiresAt) {
      await prisma.writeGateToken.update({ where: { id: token.id }, data: { status: 'expired' } })
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

    return prisma.writeGateToken.update({
      where: { id: token.id },
      data: { status: 'consumed', consumedAt: new Date() },
    })
  }
}
