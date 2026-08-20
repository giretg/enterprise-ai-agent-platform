/**
 * Teljes értékű in-memory surrogate vault a privacy tesztekhez: ref + val sorok
 * ÉS a perzisztált megjelenítési értékek (spec §5 R19). A korábbi teszt-duplikátumok
 * csak ref sorokat ismertek, ezért a szerver-újraindítás eseteket nem lehetett
 * velük megfogni — pont azt, ami éles használatban elromlott.
 */
import { randomUUID } from 'node:crypto'
import { parseSurrogate, type SurrogateEntityType } from '../src/domain/privacy/surrogate-format'
import {
  authenticateRefVaultRecord,
  authenticateValVaultRecord,
  computeSurrogateHmac,
  hmacFieldsFromInsert,
  hmacFieldsFromValInsert,
  insertRefsSequentially,
  SurrogateTakenError,
  type InsertRefInput,
  type InsertValInput,
  type PrivacyScope,
  type RefEntityRef,
  type RefVaultRecord,
  type SurrogateDisplayValueRow,
  type SurrogateVault,
  type TenantHmacKeyResolver,
  type ValVaultLookup,
  type ValVaultRecord,
  type VaultLookup,
} from '../src/domain/privacy/surrogate-vault'

function scopeKey(tenantId: string, scope: PrivacyScope): string {
  return `${tenantId} ${scope.type} ${scope.id}`
}

export class InMemorySurrogateVault implements SurrogateVault {
  readonly refs: RefVaultRecord[] = []
  readonly vals: ValVaultRecord[] = []
  private readonly displayValues = new Map<string, Map<string, string>>()

  constructor(private readonly resolveTenantKey: TenantHmacKeyResolver = () => 'test-tenant-key') {}

  private inScope(
    row: { tenantId: string; scopeType: string; scopeId: string },
    tenantId: string,
    scope: PrivacyScope,
  ): boolean {
    return row.tenantId === tenantId && row.scopeType === scope.type && row.scopeId === scope.id
  }

  private authRef(row: RefVaultRecord | undefined): VaultLookup {
    if (!row) return { status: 'miss' }
    return authenticateRefVaultRecord(row, this.resolveTenantKey(row.tenantId))
  }

  private authVal(row: ValVaultRecord | undefined): ValVaultLookup {
    if (!row) return { status: 'miss' }
    return authenticateValVaultRecord(row, this.resolveTenantKey(row.tenantId))
  }

  async findByEntity(
    tenantId: string,
    scope: PrivacyScope,
    entity: RefEntityRef,
  ): Promise<VaultLookup> {
    return this.authRef(
      this.refs.find(
        (row) =>
          this.inScope(row, tenantId, scope) &&
          row.entityType === entity.entityType &&
          row.connectorId === entity.connectorId &&
          row.sourceId === entity.sourceId,
      ),
    )
  }

  async findBySurrogate(
    tenantId: string,
    scope: PrivacyScope,
    surrogate: string,
  ): Promise<VaultLookup> {
    return this.authRef(
      this.refs.find((row) => this.inScope(row, tenantId, scope) && row.surrogate === surrogate),
    )
  }

  async findHitsBySurrogateInTenant(tenantId: string, surrogate: string): Promise<RefVaultRecord[]> {
    const hits: RefVaultRecord[] = []
    for (const row of this.refs) {
      if (row.tenantId !== tenantId || row.surrogate !== surrogate) continue
      const lookup = this.authRef(row)
      if (lookup.status === 'hit') hits.push(lookup.record)
    }
    return hits
  }

  async listByScope(tenantId: string, scope: PrivacyScope): Promise<RefVaultRecord[]> {
    return this.refs.filter((row) => this.inScope(row, tenantId, scope))
  }

  async maxOrdinal(
    tenantId: string,
    scope: PrivacyScope,
    entityType: SurrogateEntityType,
  ): Promise<number> {
    let max = 0
    for (const row of [...this.refs, ...this.vals]) {
      if (!this.inScope(row, tenantId, scope)) continue
      const parsed = parseSurrogate(row.surrogate)
      if (parsed?.entityType === entityType && parsed.ordinal > max) max = parsed.ordinal
    }
    return max
  }

  async insertRef(input: InsertRefInput): Promise<RefVaultRecord> {
    const existing = this.refs.find(
      (row) =>
        this.inScope(row, input.tenantId, input.scope) &&
        row.entityType === input.entityType &&
        row.connectorId === input.connectorId &&
        row.sourceId === input.sourceId,
    )
    if (existing) return existing
    if (this.taken(input.tenantId, input.scope, input.surrogate)) {
      throw new SurrogateTakenError(input.surrogate)
    }
    const fields = hmacFieldsFromInsert(input)
    const record: RefVaultRecord = {
      ...fields,
      id: randomUUID(),
      hmac: computeSurrogateHmac(this.resolveTenantKey(input.tenantId), fields),
    }
    this.refs.push(record)
    return record
  }

  async insertRefs(inputs: InsertRefInput[]): Promise<RefVaultRecord[]> {
    return insertRefsSequentially((input) => this.insertRef(input), inputs)
  }

  async findValByFingerprint(
    tenantId: string,
    scope: PrivacyScope,
    entityType: SurrogateEntityType,
    fingerprint: string,
  ): Promise<ValVaultLookup> {
    return this.authVal(
      this.vals.find(
        (row) =>
          this.inScope(row, tenantId, scope) &&
          row.entityType === entityType &&
          row.sourceId === fingerprint,
      ),
    )
  }

  async findValBySurrogate(
    tenantId: string,
    scope: PrivacyScope,
    surrogate: string,
  ): Promise<ValVaultLookup> {
    return this.authVal(
      this.vals.find((row) => this.inScope(row, tenantId, scope) && row.surrogate === surrogate),
    )
  }

  async insertVal(input: InsertValInput): Promise<ValVaultRecord> {
    if (this.taken(input.tenantId, input.scope, input.surrogate)) {
      throw new SurrogateTakenError(input.surrogate)
    }
    const fields = hmacFieldsFromValInsert(input)
    const record: ValVaultRecord = {
      ...fields,
      id: randomUUID(),
      encryptedValue: input.encryptedValue,
      hmac: computeSurrogateHmac(this.resolveTenantKey(input.tenantId), fields),
    }
    this.vals.push(record)
    return record
  }

  async saveDisplayValues(
    tenantId: string,
    scope: PrivacyScope,
    rows: readonly SurrogateDisplayValueRow[],
  ): Promise<void> {
    const key = scopeKey(tenantId, scope)
    let bucket = this.displayValues.get(key)
    if (!bucket) {
      bucket = new Map()
      this.displayValues.set(key, bucket)
    }
    for (const row of rows) {
      // A Postgres adapter `updateMany`-vel ír: csak meglévő sorra.
      const known = [...this.refs, ...this.vals].some(
        (stored) => this.inScope(stored, tenantId, scope) && stored.surrogate === row.surrogate,
      )
      if (known) bucket.set(row.surrogate, row.displayValueEnc)
    }
  }

  async listDisplayValues(
    tenantId: string,
    scope: PrivacyScope,
  ): Promise<SurrogateDisplayValueRow[]> {
    const bucket = this.displayValues.get(scopeKey(tenantId, scope))
    if (!bucket) return []
    return [...bucket].map(([surrogate, displayValueEnc]) => ({ surrogate, displayValueEnc }))
  }

  private taken(tenantId: string, scope: PrivacyScope, surrogate: string): boolean {
    return [...this.refs, ...this.vals].some(
      (row) => this.inScope(row, tenantId, scope) && row.surrogate === surrogate,
    )
  }
}

/** Beszélgetés-adatkulcs teszt-implementáció (feladat-ticket scope is kap kulcsot). */
export class InMemoryPrivacyKeyRepository {
  private readonly keys = new Map<string, Buffer>()
  private readonly shredded = new Set<string>()

  async ensureDataKey(tenantId: string, conversationId: string): Promise<Buffer> {
    return this.ensureScopeDataKey(tenantId, 'conversation', conversationId)
  }

  async getDataKey(tenantId: string, conversationId: string): Promise<Buffer | null> {
    return this.getScopeDataKey(tenantId, 'conversation', conversationId)
  }

  async ensureScopeDataKey(tenantId: string, scopeType: string, scopeId: string): Promise<Buffer> {
    const key = `${tenantId} ${scopeType} ${scopeId}`
    const existing = this.keys.get(key)
    if (existing) return existing
    const created = Buffer.alloc(32, key.length % 251)
    this.keys.set(key, created)
    return created
  }

  async getScopeDataKey(
    tenantId: string,
    scopeType: string,
    scopeId: string,
  ): Promise<Buffer | null> {
    const key = `${tenantId} ${scopeType} ${scopeId}`
    if (this.shredded.has(key)) return null
    return this.keys.get(key) ?? null
  }

  async shredKeysForConversations(conversationIds: string[]): Promise<number> {
    let count = 0
    for (const key of [...this.keys.keys()]) {
      const [, scopeType, scopeId] = key.split(' ')
      if (scopeType === 'conversation' && scopeId && conversationIds.includes(scopeId)) {
        this.keys.delete(key)
        this.shredded.add(key)
        count += 1
      }
    }
    return count
  }
}
