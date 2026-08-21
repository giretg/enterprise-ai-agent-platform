/**
 * Surrogate vault domain contract (APG-02, spec §5–§6).
 * A konkrét perzisztencia-adapter a repositories rétegben él.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { SurrogateEntityType } from '@/domain/privacy/surrogate-format'

export type PrivacyScope = { type: 'conversation' | 'trace'; id: string }

export type RefEntityRef = {
  entityType: SurrogateEntityType
  connectorId: string
  sourceId: string
}

export type TenantHmacKeyResolver = (tenantId: string) => string

export type SurrogateHmacFields = {
  tenantId: string
  scopeType: PrivacyScope['type']
  scopeId: string
  entityType: SurrogateEntityType
  surrogate: string
  class: 'ref'
  connectorId: string
  sourceId: string
}

export type AnySurrogateHmacFields = SurrogateHmacFields | ValSurrogateHmacFields

export type RefVaultRecord = SurrogateHmacFields & { id: string; hmac: string }

export type ValSurrogateHmacFields = {
  tenantId: string
  scopeType: PrivacyScope['type']
  scopeId: string
  entityType: SurrogateEntityType
  surrogate: string
  class: 'val'
  connectorId: ''
  sourceId: string
}

export type ValVaultRecord = ValSurrogateHmacFields & {
  id: string
  hmac: string
  encryptedValue: string
}

export type VaultLookup =
  | { status: 'hit'; record: RefVaultRecord }
  | { status: 'miss' }
  | { status: 'tampered' }

export type ValVaultLookup =
  | { status: 'hit'; record: ValVaultRecord }
  | { status: 'miss' }
  | { status: 'tampered' }

export type InsertRefInput = {
  tenantId: string
  scope: PrivacyScope
  entityType: SurrogateEntityType
  connectorId: string
  sourceId: string
  surrogate: string
}

export type InsertValInput = {
  tenantId: string
  scope: PrivacyScope
  entityType: SurrogateEntityType
  fingerprint: string
  surrogate: string
  encryptedValue: string
}

export class SurrogateTakenError extends Error {
  constructor(surrogate: string) {
    super(`az álnév foglalt a scope-on belül: ${surrogate}`)
    this.name = 'SurrogateTakenError'
  }
}

/** Álnév → titkosított megjelenítési érték (spec §5 R19). */
export type SurrogateDisplayValueRow = {
  surrogate: string
  displayValueEnc: string
}

export interface SurrogateVault {
  findByEntity(tenantId: string, scope: PrivacyScope, entity: RefEntityRef): Promise<VaultLookup>
  findBySurrogate(tenantId: string, scope: PrivacyScope, surrogate: string): Promise<VaultLookup>
  findHitsBySurrogateInTenant(tenantId: string, surrogate: string): Promise<RefVaultRecord[]>
  listByScope(tenantId: string, scope: PrivacyScope): Promise<RefVaultRecord[]>
  maxOrdinal(
    tenantId: string,
    scope: PrivacyScope,
    entityType: SurrogateEntityType,
  ): Promise<number>
  insertRef(input: InsertRefInput): Promise<RefVaultRecord>
  insertRefs(inputs: InsertRefInput[]): Promise<RefVaultRecord[]>
  findValByFingerprint(
    tenantId: string,
    scope: PrivacyScope,
    entityType: SurrogateEntityType,
    fingerprint: string,
  ): Promise<ValVaultLookup>
  findValBySurrogate(
    tenantId: string,
    scope: PrivacyScope,
    surrogate: string,
  ): Promise<ValVaultLookup>
  insertVal(input: InsertValInput): Promise<ValVaultRecord>
  /**
   * Megjelenítési értékek perzisztálása (spec §5 R19). Opcionális: a régebbi
   * adapterek és a tesztduplikátumok memóriában maradnak, a hívó ezt tolerálja.
   */
  saveDisplayValues?(
    tenantId: string,
    scope: PrivacyScope,
    rows: readonly SurrogateDisplayValueRow[],
  ): Promise<void>
  /** Egy scope összes eltárolt megjelenítési értéke — a beszélgetés újranyitásához. */
  listDisplayValues?(
    tenantId: string,
    scope: PrivacyScope,
  ): Promise<SurrogateDisplayValueRow[]>
}

export async function insertRefsSequentially(
  insertRef: (input: InsertRefInput) => Promise<RefVaultRecord>,
  inputs: InsertRefInput[],
): Promise<RefVaultRecord[]> {
  const records: RefVaultRecord[] = []
  for (const input of inputs) records.push(await insertRef(input))
  return records
}

const HMAC_VERSION = 'surrogate-hmac-v1'

export function canonicalSurrogateHmacPayload(fields: AnySurrogateHmacFields): string {
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

export function computeSurrogateHmac(tenantKey: string, fields: AnySurrogateHmacFields): string {
  return createHmac('sha256', tenantKey).update(canonicalSurrogateHmacPayload(fields)).digest('hex')
}

export function verifySurrogateHmac(
  tenantKey: string,
  fields: AnySurrogateHmacFields,
  hmac: string,
): boolean {
  const expected = Buffer.from(computeSurrogateHmac(tenantKey, fields), 'utf8')
  const actual = Buffer.from(hmac, 'utf8')
  if (expected.length !== actual.length) return false
  return timingSafeEqual(expected, actual)
}

export function hmacFieldsFromInsert(input: InsertRefInput): SurrogateHmacFields {
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

export function hmacFieldsFromRecord(record: RefVaultRecord): SurrogateHmacFields {
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

export function hmacFieldsFromValInsert(input: InsertValInput): ValSurrogateHmacFields {
  return {
    tenantId: input.tenantId,
    scopeType: input.scope.type,
    scopeId: input.scope.id,
    entityType: input.entityType,
    surrogate: input.surrogate,
    class: 'val',
    connectorId: '',
    sourceId: input.fingerprint,
  }
}

export function hmacFieldsFromValRecord(record: ValVaultRecord): ValSurrogateHmacFields {
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

export function authenticateRefVaultRecord(
  record: RefVaultRecord,
  tenantKey: string,
): VaultLookup {
  if (!verifySurrogateHmac(tenantKey, hmacFieldsFromRecord(record), record.hmac)) {
    return { status: 'tampered' }
  }
  return { status: 'hit', record }
}

export function authenticateValVaultRecord(
  record: ValVaultRecord,
  tenantKey: string,
): ValVaultLookup {
  if (!verifySurrogateHmac(tenantKey, hmacFieldsFromValRecord(record), record.hmac)) {
    return { status: 'tampered' }
  }
  return { status: 'hit', record }
}
