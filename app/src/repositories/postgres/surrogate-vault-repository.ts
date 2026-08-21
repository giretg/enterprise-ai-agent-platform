import { Prisma } from '@prisma/client'
import { isEntityTypeSlug, parseSurrogate, surrogateOrdinalKey, type SurrogateEntityType } from '@/domain/privacy/surrogate-format'
import {
  authenticateRefVaultRecord,
  authenticateValVaultRecord,
  computeSurrogateHmac,
  hmacFieldsFromInsert,
  hmacFieldsFromValInsert,
  SurrogateTakenError,
  type InsertRefInput,
  type InsertValInput,
  type ObservePreviewRow,
  type PrivacyScope,
  type RefEntityRef,
  type RefVaultRecord,
  type SurrogateDisplayValueRow,
  type SurrogateVault,
  type TenantHmacKeyResolver,
  type ValVaultLookup,
  type ValVaultRecord,
  type VaultLookup,
} from '@/domain/privacy/surrogate-vault'
import { VaultUnavailableError } from '@/domain/privacy/privacy-transform-failure'
import { prisma } from '@/lib/db'

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

const VAL_SELECT = {
  ...REF_SELECT,
  encryptedValue: true,
} as const

const VAULT_UNAVAILABLE_CODES = new Set(['P1001', 'P1002', 'P1008', 'P1017'])

function isUniqueCollision(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
}

function translateVaultError(error: unknown): never {
  const errorRecord = error && typeof error === 'object' ? error : null
  const code =
    errorRecord && 'code' in errorRecord && typeof errorRecord.code === 'string'
      ? errorRecord.code
      : errorRecord && 'errorCode' in errorRecord && typeof errorRecord.errorCode === 'string'
        ? errorRecord.errorCode
        : null
  if (code && VAULT_UNAVAILABLE_CODES.has(code)) {
    throw new VaultUnavailableError()
  }
  throw error
}

function toRefRecord(row: {
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
  if (row.class !== 'ref' || !row.connectorId || !row.sourceId || !isEntityTypeSlug(row.entityType)) {
    return null
  }
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

function toValRecord(row: {
  id: string
  tenantId: string
  scopeType: 'conversation' | 'trace'
  scopeId: string
  entityType: string
  surrogate: string
  class: 'ref' | 'val'
  connectorId: string | null
  sourceId: string | null
  encryptedValue: string | null
  hmac: string
}): ValVaultRecord | null {
  if (
    row.class !== 'val' ||
    row.connectorId != null ||
    !row.sourceId ||
    !row.encryptedValue ||
    !isEntityTypeSlug(row.entityType)
  ) {
    return null
  }
  return {
    id: row.id,
    tenantId: row.tenantId,
    scopeType: row.scopeType,
    scopeId: row.scopeId,
    entityType: row.entityType,
    surrogate: row.surrogate,
    class: 'val',
    connectorId: '',
    sourceId: row.sourceId,
    encryptedValue: row.encryptedValue,
    hmac: row.hmac,
  }
}

export class PostgresSurrogateVault implements SurrogateVault {
  constructor(private readonly resolveTenantKey: TenantHmacKeyResolver) {}

  private async run<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work()
    } catch (error) {
      return translateVaultError(error)
    }
  }

  async findByEntity(
    tenantId: string,
    scope: PrivacyScope,
    entity: RefEntityRef,
  ): Promise<VaultLookup> {
    return this.run(async () => {
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
      const record = row ? toRefRecord(row) : null
      return record
        ? authenticateRefVaultRecord(record, this.resolveTenantKey(tenantId))
        : { status: 'miss' }
    })
  }

  async findBySurrogate(
    tenantId: string,
    scope: PrivacyScope,
    surrogate: string,
  ): Promise<VaultLookup> {
    return this.run(async () => {
      const row = await prisma.surrogateMap.findFirst({
        where: { tenantId, scopeType: scope.type, scopeId: scope.id, surrogate },
        select: REF_SELECT,
      })
      const record = row ? toRefRecord(row) : null
      return record
        ? authenticateRefVaultRecord(record, this.resolveTenantKey(tenantId))
        : { status: 'miss' }
    })
  }

  async findHitsBySurrogateInTenant(
    tenantId: string,
    surrogate: string,
  ): Promise<RefVaultRecord[]> {
    return this.run(async () => {
      const rows = await prisma.surrogateMap.findMany({
        where: { tenantId, surrogate },
        select: REF_SELECT,
      })
      return this.authenticated(rows, tenantId)
    })
  }

  async listByScope(tenantId: string, scope: PrivacyScope): Promise<RefVaultRecord[]> {
    return this.run(async () => {
      const rows = await prisma.surrogateMap.findMany({
        where: { tenantId, scopeType: scope.type, scopeId: scope.id },
        select: REF_SELECT,
      })
      return this.authenticated(rows, tenantId)
    })
  }

  async maxOrdinal(
    tenantId: string,
    scope: PrivacyScope,
    entityType: SurrogateEntityType,
    sourceSlot?: string | null,
  ): Promise<number> {
    return this.run(async () => {
      const rows = await prisma.surrogateMap.findMany({
        where: { tenantId, scopeType: scope.type, scopeId: scope.id, entityType },
        select: { surrogate: true },
      })
      let max = 0
      for (const row of rows) {
        const parsed = parseSurrogate(row.surrogate)
        if (!parsed || parsed.entityType !== entityType) continue
        if ((parsed.sourceSlot ?? '') !== (sourceSlot ?? '')) continue
        if (parsed.ordinal > max) max = parsed.ordinal
      }
      return max
    })
  }

  async insertRef(input: InsertRefInput): Promise<RefVaultRecord> {
    return this.run(async () => {
      const hmac = computeSurrogateHmac(
        this.resolveTenantKey(input.tenantId),
        hmacFieldsFromInsert(input),
      )
      let allocated: { id: string; surrogate: string }
      try {
        allocated = await prisma.surrogateMap.create({
          data: {
            tenantId: input.tenantId,
            scopeType: input.scope.type,
            scopeId: input.scope.id,
            entityType: input.entityType,
            surrogate: input.surrogate,
            class: 'ref',
            connectorId: input.connectorId,
            sourceId: input.sourceId,
            hmac,
          },
          select: { id: true, surrogate: true },
        })
      } catch (error) {
        if (!isUniqueCollision(error)) throw error
        const existing = await prisma.surrogateMap.findFirst({
          where: {
            tenantId: input.tenantId,
            scopeType: input.scope.type,
            scopeId: input.scope.id,
            entityType: input.entityType,
            connectorId: input.connectorId,
            sourceId: input.sourceId,
          },
          select: { id: true, surrogate: true },
        })
        if (!existing) throw new SurrogateTakenError(input.surrogate)
        allocated = existing
      }

      const row = await prisma.surrogateMap.findUnique({
        where: { id: allocated.id },
        select: REF_SELECT,
      })
      const record = row ? toRefRecord(row) : null
      if (!record) throw new Error('vault-sor allokáció után nem olvasható')
      const verified = authenticateRefVaultRecord(
        record,
        this.resolveTenantKey(input.tenantId),
      )
      if (verified.status !== 'hit') throw new Error('vault-sor HMAC-je érvénytelen')
      return verified.record
    })
  }

  async insertRefs(inputs: InsertRefInput[]): Promise<RefVaultRecord[]> {
    if (inputs.length === 0) return []
    if (inputs.length === 1) return [await this.insertRef(inputs[0]!)]
    return this.run(async () => {
      const data = inputs.map((input) => ({
        tenantId: input.tenantId,
        scopeType: input.scope.type,
        scopeId: input.scope.id,
        entityType: input.entityType,
        surrogate: input.surrogate,
        class: 'ref' as const,
        connectorId: input.connectorId,
        sourceId: input.sourceId,
        hmac: computeSurrogateHmac(
          this.resolveTenantKey(input.tenantId),
          hmacFieldsFromInsert(input),
        ),
      }))

      return prisma.$transaction(async (tx) => {
        await tx.surrogateMap.createMany({ data, skipDuplicates: true })
        const wanted = new Set(inputs.map(identityOfInsert))
        const found: RefVaultRecord[] = []
        for (const group of groupInsertsByScope(inputs)) {
          const rows = await tx.surrogateMap.findMany({
            where: {
              tenantId: group.tenantId,
              scopeType: group.scope.type,
              scopeId: group.scope.id,
            },
            select: REF_SELECT,
          })
          for (const record of this.authenticated(rows, group.tenantId, true)) {
            if (wanted.has(identityOfRecord(record))) found.push(record)
          }
        }
        return found
      })
    })
  }

  async saveDisplayValues(
    tenantId: string,
    scope: PrivacyScope,
    rows: readonly SurrogateDisplayValueRow[],
  ): Promise<void> {
    if (rows.length === 0) return
    await this.run(async () => {
      await prisma.$transaction(
        rows.map((row) =>
          prisma.surrogateMap.updateMany({
            where: {
              tenantId,
              scopeType: scope.type,
              scopeId: scope.id,
              surrogate: row.surrogate,
            },
            data: { displayValueEnc: row.displayValueEnc },
          }),
        ),
      )
    })
  }

  async listDisplayValues(
    tenantId: string,
    scope: PrivacyScope,
  ): Promise<SurrogateDisplayValueRow[]> {
    return this.run(async () => {
      const rows = await prisma.surrogateMap.findMany({
        where: {
          tenantId,
          scopeType: scope.type,
          scopeId: scope.id,
          displayValueEnc: { not: null },
        },
        select: { surrogate: true, displayValueEnc: true },
      })
      return rows.flatMap((row) =>
        row.displayValueEnc
          ? [{ surrogate: row.surrogate, displayValueEnc: row.displayValueEnc }]
          : [],
      )
    })
  }

  async saveObservePreviews(
    tenantId: string,
    scope: PrivacyScope,
    rows: readonly ObservePreviewRow[],
  ): Promise<void> {
    if (rows.length === 0 || scope.type !== 'conversation') return
    await this.run(async () => {
      await prisma.$transaction(
        rows.map((row) =>
          prisma.conversationObserveEntity.upsert({
            where: {
              conversationId_entityType_valueFingerprint: {
                conversationId: scope.id,
                entityType: row.entityType,
                valueFingerprint: row.valueFingerprint,
              },
            },
            create: {
              conversationId: scope.id,
              tenantId,
              entityType: row.entityType,
              valueFingerprint: row.valueFingerprint,
              previewOrdinal: row.previewOrdinal,
              displayValueEnc: row.displayValueEnc,
            },
            update: {
              previewOrdinal: row.previewOrdinal,
              displayValueEnc: row.displayValueEnc,
            },
          }),
        ),
      )
    })
  }

  async listObservePreviews(
    tenantId: string,
    scope: PrivacyScope,
  ): Promise<ObservePreviewRow[]> {
    if (scope.type !== 'conversation') return []
    return this.run(async () => {
      const rows = await prisma.conversationObserveEntity.findMany({
        where: {
          tenantId,
          conversationId: scope.id,
        },
        select: {
          entityType: true,
          valueFingerprint: true,
          previewOrdinal: true,
          displayValueEnc: true,
        },
      })
      return rows.map((row) => ({
        entityType: row.entityType as SurrogateEntityType,
        valueFingerprint: row.valueFingerprint,
        previewOrdinal: row.previewOrdinal,
        displayValueEnc: row.displayValueEnc,
      }))
    })
  }

  private authenticated(
    rows: Array<Parameters<typeof toRefRecord>[0]>,
    tenantId: string,
    rejectTampered = false,
  ): RefVaultRecord[] {
    const hits: RefVaultRecord[] = []
    const tenantKey = this.resolveTenantKey(tenantId)
    for (const row of rows) {
      const record = toRefRecord(row)
      if (!record) continue
      const verified = authenticateRefVaultRecord(record, tenantKey)
      if (verified.status === 'tampered' && rejectTampered) {
        throw new Error('a meglévő vault-sor HMAC-je érvénytelen, új álnév nem allokálható')
      }
      if (verified.status === 'hit') hits.push(verified.record)
    }
    return hits
  }

  async findValByFingerprint(
    tenantId: string,
    scope: PrivacyScope,
    entityType: SurrogateEntityType,
    fingerprint: string,
  ): Promise<ValVaultLookup> {
    return this.run(async () => {
      const row = await prisma.surrogateMap.findFirst({
        where: {
          tenantId,
          scopeType: scope.type,
          scopeId: scope.id,
          entityType,
          class: 'val',
          sourceId: fingerprint,
        },
        select: VAL_SELECT,
      })
      const record = row ? toValRecord(row) : null
      return record
        ? authenticateValVaultRecord(record, this.resolveTenantKey(tenantId))
        : { status: 'miss' }
    })
  }

  async findValBySurrogate(
    tenantId: string,
    scope: PrivacyScope,
    surrogate: string,
  ): Promise<ValVaultLookup> {
    return this.run(async () => {
      const row = await prisma.surrogateMap.findFirst({
        where: { tenantId, scopeType: scope.type, scopeId: scope.id, surrogate, class: 'val' },
        select: VAL_SELECT,
      })
      const record = row ? toValRecord(row) : null
      return record
        ? authenticateValVaultRecord(record, this.resolveTenantKey(tenantId))
        : { status: 'miss' }
    })
  }

  async insertVal(input: InsertValInput): Promise<ValVaultRecord> {
    return this.run(async () => {
      const hmac = computeSurrogateHmac(
        this.resolveTenantKey(input.tenantId),
        hmacFieldsFromValInsert(input),
      )
      let allocated: { id: string; surrogate: string }
      try {
        allocated = await prisma.surrogateMap.create({
          data: {
            tenantId: input.tenantId,
            scopeType: input.scope.type,
            scopeId: input.scope.id,
            entityType: input.entityType,
            surrogate: input.surrogate,
            class: 'val',
            connectorId: null,
            sourceId: input.fingerprint,
            encryptedValue: input.encryptedValue,
            hmac,
          },
          select: { id: true, surrogate: true },
        })
      } catch (error) {
        if (!isUniqueCollision(error)) throw error
        const existing = await prisma.surrogateMap.findFirst({
          where: {
            tenantId: input.tenantId,
            scopeType: input.scope.type,
            scopeId: input.scope.id,
            entityType: input.entityType,
            class: 'val',
            sourceId: input.fingerprint,
          },
          select: { id: true, surrogate: true },
        })
        if (!existing) throw new SurrogateTakenError(input.surrogate)
        allocated = existing
      }

      const row = await prisma.surrogateMap.findUnique({
        where: { id: allocated.id },
        select: VAL_SELECT,
      })
      const record = row ? toValRecord(row) : null
      if (!record) throw new Error('val vault-sor allokáció után nem olvasható')
      const verified = authenticateValVaultRecord(
        record,
        this.resolveTenantKey(input.tenantId),
      )
      if (verified.status !== 'hit') throw new Error('val vault-sor HMAC-je érvénytelen')
      return verified.record
    })
  }
}

function identityOfInsert(input: InsertRefInput): string {
  return `${input.tenantId}\0${input.scope.type}\0${input.scope.id}\0${input.entityType}\0${input.connectorId}\0${input.sourceId}`
}

function identityOfRecord(record: RefVaultRecord): string {
  return `${record.tenantId}\0${record.scopeType}\0${record.scopeId}\0${record.entityType}\0${record.connectorId}\0${record.sourceId}`
}

function groupInsertsByScope(inputs: InsertRefInput[]): Array<{
  tenantId: string
  scope: PrivacyScope
}> {
  const seen = new Map<string, { tenantId: string; scope: PrivacyScope }>()
  for (const input of inputs) {
    const key = `${input.tenantId}\0${input.scope.type}\0${input.scope.id}`
    if (!seen.has(key)) seen.set(key, { tenantId: input.tenantId, scope: input.scope })
  }
  return [...seen.values()]
}
