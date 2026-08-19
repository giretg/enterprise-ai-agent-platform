/**
 * Surrogate vault: repository-interface + Postgres adapter (APG-02, spec §5–§6).
 *
 * A HMAC tenant-kulccsal hitelesíti a vault-rekordot, és **nem** kerül az álnév
 * szövegébe. Feloldás csak vault-találaton + érvényes HMAC-en: a modell által
 * kitalált `[[COMPANY_99]]` definíció szerint feloldhatatlan.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import { allocateRefSurrogate } from '@/domain/privacy/allocate-ref-surrogate'
import { parseSurrogate } from '@/domain/privacy/surrogate-format'

export type PrivacyScope = {
  type: 'conversation' | 'trace'
  id: string
}

export type RefEntityRef = {
  entityType: string
  connectorId: string
  sourceId: string
}

export type TenantHmacKeyResolver = (tenantId: string) => string

export type SurrogateHmacFields = {
  tenantId: string
  scopeType: PrivacyScope['type']
  scopeId: string
  entityType: string
  surrogate: string
  class: 'ref'
  connectorId: string
  sourceId: string
}

export type RefVaultRecord = SurrogateHmacFields & {
  id: string
  hmac: string
}

export type VaultLookup =
  | { status: 'hit'; record: RefVaultRecord }
  | { status: 'miss' }
  | { status: 'tampered' }

export type InsertRefInput = {
  tenantId: string
  scope: PrivacyScope
  entityType: string
  connectorId: string
  sourceId: string
  surrogate: string
}

/** Az álnév stringet a scope-on belül már más entitás viseli — az engine új sorszámmal próbál. */
export class SurrogateTakenError extends Error {
  constructor(surrogate: string) {
    super(`az álnév foglalt a scope-on belül: ${surrogate}`)
    this.name = 'SurrogateTakenError'
  }
}

export interface SurrogateVault {
  findByEntity(tenantId: string, scope: PrivacyScope, entity: RefEntityRef): Promise<VaultLookup>
  findBySurrogate(tenantId: string, scope: PrivacyScope, surrogate: string): Promise<VaultLookup>
  /** A típus eddig kiosztott legnagyobb sorszáma; üres scope-on 0. */
  maxOrdinal(tenantId: string, scope: PrivacyScope, entityType: string): Promise<number>
  /** HMAC-et a vault képzi. Entitás-ütközésnél a meglévő sort adja vissza. */
  insertRef(input: InsertRefInput): Promise<RefVaultRecord>
}

const HMAC_VERSION = 'surrogate-hmac-v1'

export function canonicalSurrogateHmacPayload(fields: SurrogateHmacFields): string {
  return [
    HMAC_VERSION,
    fields.tenantId,
    fields.scopeType,
    fields.scopeId,
    fields.entityType,
    fields.surrogate,
    fields.class,
    fields.connectorId,
    fields.sourceId,
  ].join('\n')
}

export function computeSurrogateHmac(tenantKey: string, fields: SurrogateHmacFields): string {
  return createHmac('sha256', tenantKey).update(canonicalSurrogateHmacPayload(fields)).digest('hex')
}

export function verifySurrogateHmac(
  tenantKey: string,
  fields: SurrogateHmacFields,
  hmac: string,
): boolean {
  const expected = Buffer.from(computeSurrogateHmac(tenantKey, fields), 'utf8')
  const actual = Buffer.from(hmac, 'utf8')
  if (expected.length !== actual.length) return false
  return timingSafeEqual(expected, actual)
}

function hmacFieldsFrom(input: InsertRefInput): SurrogateHmacFields {
  return {
    tenantId: input.tenantId,
    scopeType: input.scope.type,
    scopeId: input.scope.id,
    entityType: input.entityType,
    surrogate: input.surrogate,
    class: 'ref',
    connectorId: input.connectorId,
    sourceId: input.sourceId,
  }
}

function hmacFieldsOf(record: RefVaultRecord): SurrogateHmacFields {
  return {
    tenantId: record.tenantId,
    scopeType: record.scopeType,
    scopeId: record.scopeId,
    entityType: record.entityType,
    surrogate: record.surrogate,
    class: record.class,
    connectorId: record.connectorId,
    sourceId: record.sourceId,
  }
}

function authenticate(record: RefVaultRecord, tenantKey: string): VaultLookup {
  if (!verifySurrogateHmac(tenantKey, hmacFieldsOf(record), record.hmac)) {
    return { status: 'tampered' }
  }
  return { status: 'hit', record }
}

function isUniqueCollision(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
}

function toRecord(row: {
  id: string
  tenantId: string
  scopeType: 'conversation' | 'trace'
  scopeId: string
  entityType: string
  surrogate: string
  class: 'ref' | 'val'
  connectorId: string | null
  sourceId: string | null
  hmac: string
}): RefVaultRecord | null {
  if (row.class !== 'ref' || !row.connectorId || !row.sourceId) return null
  return {
    id: row.id,
    tenantId: row.tenantId,
    scopeType: row.scopeType,
    scopeId: row.scopeId,
    entityType: row.entityType,
    surrogate: row.surrogate,
    class: 'ref',
    connectorId: row.connectorId,
    sourceId: row.sourceId,
    hmac: row.hmac,
  }
}

const REF_SELECT = {
  id: true,
  tenantId: true,
  scopeType: true,
  scopeId: true,
  entityType: true,
  surrogate: true,
  class: true,
  connectorId: true,
  sourceId: true,
  hmac: true,
} as const

export class PostgresSurrogateVault implements SurrogateVault {
  constructor(private readonly resolveTenantKey: TenantHmacKeyResolver) {}

  async findByEntity(
    tenantId: string,
    scope: PrivacyScope,
    entity: RefEntityRef,
  ): Promise<VaultLookup> {
    const row = await prisma.surrogateMap.findFirst({
      where: {
        tenantId,
        scopeType: scope.type,
        scopeId: scope.id,
        entityType: entity.entityType,
        connectorId: entity.connectorId,
        sourceId: entity.sourceId,
      },
      select: REF_SELECT,
    })
    const record = row ? toRecord(row) : null
    if (!record) return { status: 'miss' }
    return authenticate(record, this.resolveTenantKey(tenantId))
  }

  async findBySurrogate(
    tenantId: string,
    scope: PrivacyScope,
    surrogate: string,
  ): Promise<VaultLookup> {
    const row = await prisma.surrogateMap.findFirst({
      where: {
        tenantId,
        scopeType: scope.type,
        scopeId: scope.id,
        surrogate,
      },
      select: REF_SELECT,
    })
    const record = row ? toRecord(row) : null
    if (!record) return { status: 'miss' }
    return authenticate(record, this.resolveTenantKey(tenantId))
  }

  async maxOrdinal(tenantId: string, scope: PrivacyScope, entityType: string): Promise<number> {
    const rows = await prisma.surrogateMap.findMany({
      where: { tenantId, scopeType: scope.type, scopeId: scope.id, entityType },
      select: { surrogate: true },
    })
    let max = 0
    for (const row of rows) {
      const parsed = parseSurrogate(row.surrogate)
      if (parsed && parsed.entityType === entityType && parsed.ordinal > max) {
        max = parsed.ordinal
      }
    }
    return max
  }

  async insertRef(input: InsertRefInput): Promise<RefVaultRecord> {
    const fields = hmacFieldsFrom(input)
    const hmac = computeSurrogateHmac(this.resolveTenantKey(input.tenantId), fields)
    let allocated
    try {
      allocated = await allocateRefSurrogate({
        tenantId: input.tenantId,
        scopeType: input.scope.type,
        scopeId: input.scope.id,
        entityType: input.entityType,
        surrogate: input.surrogate,
        connectorId: input.connectorId,
        sourceId: input.sourceId,
        hmac,
      })
    } catch (error) {
      if (isUniqueCollision(error)) throw new SurrogateTakenError(input.surrogate)
      throw error
    }

    const row = await prisma.surrogateMap.findUnique({
      where: { id: allocated.id },
      select: REF_SELECT,
    })
    const record = row ? toRecord(row) : null
    if (!record) throw new Error('vault-sor allokáció után nem olvasható')
    const verified = authenticate(record, this.resolveTenantKey(input.tenantId))
    if (verified.status !== 'hit') throw new Error('vault-sor HMAC-je érvénytelen')
    return verified.record
  }
}
