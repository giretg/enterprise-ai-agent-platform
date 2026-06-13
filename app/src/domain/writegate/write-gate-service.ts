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
  async issue(params: {
    trainingTicketId: string
    agentId: string
    targetMemoryId: string
    proposedContent: string
  }): Promise<WriteGateToken> {
    const expectedDiffHash = computeDiffHash(params.proposedContent)
    const { tokenHash } = generateTokenPair()
    const expiresAt = new Date(Date.now() + TOKEN_TTL_MS)

    const signature = signWriteGateToken({
      tokenHash,
      expectedDiffHash,
      ticketId: params.trainingTicketId,
      expiresAt,
    })

    return prisma.writeGateToken.create({
      data: {
        trainingTicketId: params.trainingTicketId,
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

    const signatureOk = verifyWriteGateSignature({
      tokenHash: token.tokenHash,
      expectedDiffHash: token.expectedDiffHash,
      ticketId: token.trainingTicketId,
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
