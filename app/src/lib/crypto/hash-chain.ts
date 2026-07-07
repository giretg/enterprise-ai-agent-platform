import { createHash, createHmac, randomBytes } from 'crypto'

export const GENESIS_HASH = '0'.repeat(64)

/**
 * Audit hash-lánc verziók.
 *  - v1 (legacy): a `computeAuditHash` által számolt, ELŐFEJ NÉLKÜLI 64-hex digest, ami
 *    csak a sor "vázát" (seq/prevHash/actor/action/target/createdAt) fedi. A v1-gyel írt
 *    sorok visszamenőleg ellenőrizhetők maradnak (nincs rehash-kényszer).
 *  - v2: a `computeAuditHashV2` által számolt, `"2:"` előfejjel jelölt digest, ami a
 *    sor MINDEN érdemi mezőjét fedi (policyDecision / input_ref / output_ref / model_used /
 *    agent_version / metadata / tenant/ticket/conversation attribúció). A verzió magában a
 *    tárolt hash-stringben utazik, ezért nem kell külön oszlop, és egy v2 sort nem lehet
 *    "v1-ként" újraértelmezve átverni a verifikáción (a láncba kötött prevHash a teljes,
 *    előfejes stringet hordozza).
 */
export const AUDIT_HASH_VERSION = 2
const AUDIT_HASH_V2_PREFIX = `${AUDIT_HASH_VERSION}:`

export type AuditHashVersion = 1 | 2

/** A tárolt hash-stringből kiolvassa, melyik formula szerint kell ellenőrizni. */
export function parseAuditHashVersion(storedHash: string): AuditHashVersion {
  return storedHash.startsWith(AUDIT_HASH_V2_PREFIX) ? 2 : 1
}

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

export interface AuditHashV2Params {
  seq: bigint
  prevHash: string
  actorType: string
  actorId: string | null
  agentVersion: number | null
  action: string
  targetType: string
  targetId: string | null
  modelUsed: string | null
  inputRef: string | null
  outputRef: string | null
  policyDecision: string | null
  metadata: unknown
  tenantId: string | null
  ticketId: string | null
  conversationId: string | null
  createdAt: Date
}

/**
 * Determinisztikus, kulcs-sorrendtől független kanonikalizálás. A `metadata` a DB-ben
 * `jsonb`, ami NEM őrzi meg a kulcs-sorrendet; a rekurzív kulcsrendezés biztosítja, hogy
 * az írás-idejű (JS objektum) és az ellenőrzés-idejű (jsonb-ból visszaolvasott) forma
 * ugyanazt a kanonikus stringet adja. A payload-guard (assertAuditMetadataSafe) eleve
 * skalár/korlátozott alakra szűkíti a metaadatot, így a jsonb érték-normalizálása
 * (szám/whitespace) nem okoz eltérést.
 */
function canonicalizeJson(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(canonicalizeJson)
  const obj = value as Record<string, unknown>
  return Object.keys(obj)
    .sort()
    .reduce<Record<string, unknown>>((acc, key) => {
      acc[key] = canonicalizeJson(obj[key])
      return acc
    }, {})
}

/**
 * v2 audit hash — a sor MINDEN érdemi mezőjére kiterjed, így a governance-döntés
 * (policyDecision), a payload-bizonyíték mutatók (input_ref/output_ref), a metaadat és a
 * tenant-attribúció sem módosítható a lánc megtörése nélkül. Az eredmény `"2:"` előfejjel
 * tér vissza (lásd AUDIT_HASH_VERSION).
 */
export function computeAuditHashV2(params: AuditHashV2Params): string {
  const canonical = JSON.stringify({
    v: AUDIT_HASH_VERSION,
    seq: params.seq.toString(),
    prevHash: params.prevHash,
    actorType: params.actorType,
    actorId: params.actorId ?? '',
    agentVersion: params.agentVersion ?? null,
    action: params.action,
    targetType: params.targetType,
    targetId: params.targetId ?? '',
    modelUsed: params.modelUsed ?? '',
    inputRef: params.inputRef ?? '',
    outputRef: params.outputRef ?? '',
    policyDecision: params.policyDecision ?? '',
    metadata: params.metadata == null ? null : canonicalizeJson(params.metadata),
    tenantId: params.tenantId ?? '',
    ticketId: params.ticketId ?? '',
    conversationId: params.conversationId ?? '',
    createdAt: params.createdAt.toISOString(),
  })
  return AUDIT_HASH_V2_PREFIX + createHash('sha256').update(canonical, 'utf8').digest('hex')
}

// ── Write-gate token crypto ───────────────────────────────────────────────

const WRITE_GATE_SECRET =
  process.env.WRITE_GATE_SECRET ?? 'dev-write-gate-secret-change-in-prod'

export function computeDiffHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

export function hashOpaqueToken(rawToken: string): string {
  return createHash('sha256').update(rawToken, 'hex').digest('hex')
}

export function generateTokenPair(): { rawToken: string; tokenHash: string } {
  const rawToken = randomBytes(32).toString('hex')
  const tokenHash = hashOpaqueToken(rawToken)
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
