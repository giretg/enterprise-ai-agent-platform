import { createHash, createHmac, randomBytes } from 'crypto'

export const GENESIS_HASH = '0'.repeat(64)

export function computeAuditHash(params: {
  seq: bigint
  prevHash: string
  actorType: string
  actorId: string | null
  action: string
  targetType: string
  targetId: string | null
  createdAt: Date
}): string {
  const canonical = JSON.stringify({
    seq: params.seq.toString(),
    prevHash: params.prevHash,
    actorType: params.actorType,
    actorId: params.actorId ?? '',
    action: params.action,
    targetType: params.targetType,
    targetId: params.targetId ?? '',
    createdAt: params.createdAt.toISOString(),
  })
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}

// ── Write-gate token crypto ───────────────────────────────────────────────

const WRITE_GATE_SECRET =
  process.env.WRITE_GATE_SECRET ?? 'dev-write-gate-secret-change-in-prod'

export function computeDiffHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

export function generateTokenPair(): { rawToken: string; tokenHash: string } {
  const rawToken = randomBytes(32).toString('hex')
  const tokenHash = createHash('sha256').update(rawToken, 'hex').digest('hex')
  return { rawToken, tokenHash }
}

export function signWriteGateToken(params: {
  tokenHash: string
  expectedDiffHash: string
  ticketId: string
  expiresAt: Date
}): string {
  const msg = [params.tokenHash, params.expectedDiffHash, params.ticketId, params.expiresAt.toISOString()].join(':')
  return createHmac('sha256', WRITE_GATE_SECRET).update(msg).digest('hex')
}

export function verifyWriteGateSignature(params: {
  tokenHash: string
  expectedDiffHash: string
  ticketId: string
  expiresAt: Date
  signature: string
}): boolean {
  const expected = signWriteGateToken(params)
  // constant-time comparison
  try {
    const a = Buffer.from(expected, 'hex')
    const b = Buffer.from(params.signature, 'hex')
    if (a.length !== b.length) return false
    let diff = 0
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
    return diff === 0
  } catch {
    return false
  }
}
