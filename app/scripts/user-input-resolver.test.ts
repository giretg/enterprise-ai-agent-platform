/**
 * APG-17 — User-input resolver + connector `resolve()` contract.
 *
 * DoD: mindhárom resolve() kimenet; tool-boundary második kísérlet, ha az első nem talált.
 *
 * Futtatás: npm run test:user-input-resolver
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import {
  normalizeEntityResolveResponse,
  type ConnectorEntityResolver,
  type EntityResolveResponse,
} from '../src/domain/privacy/entity-resolve-contract'
import { extractEntityCandidates, stemForResolve } from '../src/domain/privacy/extract-entity-candidates'
import { resolveUserInputEntities } from '../src/domain/privacy/user-input-resolver'
import { resolveEntityNamesInToolArgs } from '../src/domain/privacy/resolve-tool-entity-names'
import { PrivacyTransformBlockedError } from '../src/domain/privacy/privacy-transform-failure'
import { SurrogateEngine, type PrivacyAuditSink } from '../src/domain/privacy/surrogate-engine'
import {
  computeSurrogateHmac,
  insertRefsSequentially,
  SurrogateTakenError,
  verifySurrogateHmac,
  type InsertRefInput,
  type PrivacyScope,
  type RefEntityRef,
  type RefVaultRecord,
  type SurrogateHmacFields,
  type SurrogateVault,
  type VaultLookup,
} from '../src/domain/privacy/surrogate-vault'
import { valVaultMethodStubs } from './test-surrogate-vault-val-stubs'

import { parseSurrogate } from '../src/domain/privacy/surrogate-format'

let failures = 0
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failures += 1
    console.error(`  ✗ ${name}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

const TENANT = 'aaaaaaaa-0000-4000-8000-000000000001'
const CONNECTOR = 'dddddddd-0000-4000-8000-000000000004'
const CONVERSATION = 'eeeeeeee-0000-4000-8000-000000000005'
const HMAC_KEY = 'test-tenant-hmac-key'
const SCOPE: PrivacyScope = { type: 'conversation', id: CONVERSATION }
const SOURCE_ID = 'crm/company/4821'

class RecordingAudit implements PrivacyAuditSink {
  async recordUnknownSurrogate(): Promise<void> {}
  async recordResolveDenied(): Promise<void> {}
}

class InMemorySurrogateVault implements SurrogateVault {
  readonly rows: RefVaultRecord[] = []
  constructor(private readonly resolveTenantKey: (tenantId: string) => string) {}

  private lookup(row: RefVaultRecord | undefined): VaultLookup {
    if (!row) return { status: 'miss' }
    const fields: SurrogateHmacFields = {
      tenantId: row.tenantId,
      scopeType: row.scopeType,
      scopeId: row.scopeId,
      entityType: row.entityType,
      surrogate: row.surrogate,
      class: row.class,
      connectorId: row.connectorId,
      sourceId: row.sourceId,
    }
    if (!verifySurrogateHmac(this.resolveTenantKey(row.tenantId), fields, row.hmac)) {
      return { status: 'tampered' }
    }
    return { status: 'hit', record: row }
  }

  async findByEntity(tenantId: string, scope: PrivacyScope, entity: RefEntityRef): Promise<VaultLookup> {
    return this.lookup(
      this.rows.find(
        (row) =>
          row.tenantId === tenantId &&
          row.scopeType === scope.type &&
          row.scopeId === scope.id &&
          row.entityType === entity.entityType &&
          row.connectorId === entity.connectorId &&
          row.sourceId === entity.sourceId,
      ),
    )
  }

  async findBySurrogate(tenantId: string, scope: PrivacyScope, surrogate: string): Promise<VaultLookup> {
    return this.lookup(
      this.rows.find(
        (row) =>
          row.tenantId === tenantId &&
          row.scopeType === scope.type &&
          row.scopeId === scope.id &&
          row.surrogate === surrogate,
      ),
    )
  }

  async findHitsBySurrogateInTenant(tenantId: string, surrogate: string): Promise<RefVaultRecord[]> {
    const hits: RefVaultRecord[] = []
    for (const row of this.rows) {
      if (row.tenantId !== tenantId || row.surrogate !== surrogate) continue
      const result = this.lookup(row)
      if (result.status === 'hit') hits.push(result.record)
    }
    return hits
  }

  async maxOrdinal(tenantId: string, scope: PrivacyScope, entityType: string): Promise<number> {
    let max = 0
    for (const row of this.rows) {
      if (row.tenantId !== tenantId || row.scopeType !== scope.type || row.scopeId !== scope.id) continue
      const parsed = parseSurrogate(row.surrogate)
      if (parsed && parsed.entityType === entityType && parsed.ordinal > max) max = parsed.ordinal
    }
    return max
  }

  async insertRef(input: InsertRefInput): Promise<RefVaultRecord> {
    const entityHit = this.rows.find(
      (row) =>
        row.tenantId === input.tenantId &&
        row.scopeType === input.scope.type &&
        row.scopeId === input.scope.id &&
        row.entityType === input.entityType &&
        row.connectorId === input.connectorId &&
        row.sourceId === input.sourceId,
    )
    if (entityHit) return entityHit
    const surrogateHit = this.rows.find(
      (row) =>
        row.tenantId === input.tenantId &&
        row.scopeType === input.scope.type &&
        row.scopeId === input.scope.id &&
        row.surrogate === input.surrogate,
    )
    if (surrogateHit) throw new SurrogateTakenError(input.surrogate)
    const fields: SurrogateHmacFields = {
      tenantId: input.tenantId,
      scopeType: input.scope.type,
      scopeId: input.scope.id,
      entityType: input.entityType,
      surrogate: input.surrogate,
      class: 'ref',
      connectorId: input.connectorId,
      sourceId: input.sourceId,
    }
    const record: RefVaultRecord = {
      ...fields,
      id: randomUUID(),
      hmac: computeSurrogateHmac(this.resolveTenantKey(input.tenantId), fields),
    }
    this.rows.push(record)
    return record
  }

  async listByScope(tenantId: string, scope: PrivacyScope): Promise<RefVaultRecord[]> {
    const hits: RefVaultRecord[] = []
    for (const row of this.rows) {
      if (row.tenantId !== tenantId || row.scopeType !== scope.type || row.scopeId !== scope.id) continue
      const result = this.lookup(row)
      if (result.status === 'hit') hits.push(result.record)
    }
    return hits
  }

  async insertRefs(inputs: InsertRefInput[]): Promise<RefVaultRecord[]> {
    return insertRefsSequentially((input) => this.insertRef(input), inputs)
  }

  findValByFingerprint = valVaultMethodStubs.findValByFingerprint
  findValBySurrogate = valVaultMethodStubs.findValBySurrogate
  insertVal = valVaultMethodStubs.insertVal
}

function makeEngine(): SurrogateEngine {
  return new SurrogateEngine(new InMemorySurrogateVault(() => HMAC_KEY), new RecordingAudit())
}

function mockResolver(responses: Record<string, EntityResolveResponse>): ConnectorEntityResolver {
  return {
    async resolve(input) {
      const key = input.text.trim()
      return responses[key] ?? { status: 'none', candidates: [] }
    },
  }
}

const CRM_FIELDS = {
  id: { type: 'integer' as const, privacy: 'pass' as const },
  company_name: {
    type: 'string' as const,
    privacy: 'tokenize' as const,
    entity_type: 'company' as const,
    source_id: 'crm/company/{id}',
  },
}

async function main() {
  console.log('APG-17 user-input resolver + connector resolve() contract\n')

  await test('normalizeEntityResolveResponse: match / ambiguous / none', () => {
    assert.equal(
      normalizeEntityResolveResponse({
        status: 'match',
        candidates: [
          {
            source_id: SOURCE_ID,
            entity_type: 'company',
            display_name: 'SPAR Magyarország Kft.',
            confidence: 0.96,
          },
        ],
      }).status,
      'match',
    )
    assert.equal(
      normalizeEntityResolveResponse({
        status: 'ambiguous',
        candidates: [
          {
            source_id: 'crm/company/1',
            entity_type: 'company',
            display_name: 'SPAR A',
            confidence: 0.8,
          },
          {
            source_id: 'crm/company/2',
            entity_type: 'company',
            display_name: 'SPAR B',
            confidence: 0.78,
          },
        ],
      }).status,
      'ambiguous',
    )
    assert.equal(
      normalizeEntityResolveResponse({
        status: 'match',
        candidates: [
          {
            source_id: 'crm/company/1',
            entity_type: 'company',
            display_name: 'SPAR Magyarország Kft.',
            confidence: 0.96,
          },
          {
            source_id: 'crm/company/2',
            entity_type: 'company',
            display_name: 'SPAR Ausztria',
            confidence: 0.61,
          },
        ],
      }).status,
      'match',
    )
    assert.equal(
      normalizeEntityResolveResponse({
        status: 'match',
        candidates: [
          {
            source_id: 'crm/company/1',
            entity_type: 'company',
            display_name: 'SPAR Magyarország Kft.',
            confidence: 0.9,
          },
          {
            source_id: 'crm/company/2',
            entity_type: 'company',
            display_name: 'SPAR Ausztria',
            confidence: 0.88,
          },
        ],
      }).status,
      'ambiguous',
    )
    assert.equal(
      normalizeEntityResolveResponse({
        status: 'none',
        candidates: [],
      }).status,
      'none',
    )
  })

  await test('candidate extraction: SPAR a magyar mondatból', () => {
    const text = 'Készíts kimutatást a SPAR idei forgalmáról.'
    const candidates = extractEntityCandidates(text)
    assert.ok(candidates.some((c) => c.matchedText === 'SPAR'))
    assert.equal(stemForResolve('SPAR-nak'), 'SPAR')
  })

  await test('resolve() match → surrogate a user promptban', async () => {
    const engine = makeEngine()
    const resolver = mockResolver({
      SPAR: {
        status: 'match',
        candidates: [
          {
            source_id: SOURCE_ID,
            entity_type: 'company',
            display_name: 'SPAR Magyarország Kft.',
            confidence: 0.96,
          },
        ],
      },
    })
    const result = await resolveUserInputEntities({
      text: 'Készíts kimutatást a SPAR idei forgalmáról.',
      mode: 'enforce',
      engine,
      tenantId: TENANT,
      scope: SCOPE,
      resolution: { connectorId: CONNECTOR, resolver, entityTypeHint: 'company' },
    })
    assert.equal(result.applied, true)
    assert.match(result.text, /\[\[COMPANY_1\]\]/)
    assert.equal(result.resolveAttempts, 1)
  })

  await test('resolve() ambiguous → nyers név marad (fail-open)', async () => {
    const engine = makeEngine()
    const resolver = mockResolver({
      SPAR: {
        status: 'ambiguous',
        candidates: [
          {
            source_id: 'crm/company/1',
            entity_type: 'company',
            display_name: 'SPAR A',
            confidence: 0.8,
          },
          {
            source_id: 'crm/company/2',
            entity_type: 'company',
            display_name: 'SPAR B',
            confidence: 0.78,
          },
        ],
      },
    })
    const original = 'Készíts kimutatást a SPAR idei forgalmáról.'
    const result = await resolveUserInputEntities({
      text: original,
      mode: 'enforce',
      engine,
      tenantId: TENANT,
      scope: SCOPE,
      resolution: { connectorId: CONNECTOR, resolver },
    })
    assert.equal(result.applied, false)
    assert.equal(result.text, original)
  })

  await test('resolve() none → nyers név marad (fail-open)', async () => {
    const engine = makeEngine()
    const resolver = mockResolver({})
    const original = 'Készíts kimutatást a SPAR idei forgalmáról.'
    const result = await resolveUserInputEntities({
      text: original,
      mode: 'enforce',
      engine,
      tenantId: TENANT,
      scope: SCOPE,
      resolution: { connectorId: CONNECTOR, resolver },
    })
    assert.equal(result.applied, false)
    assert.equal(result.text, original)
    assert.equal(result.resolveAttempts, 1)
  })

  await test('tool-boundary: prompt none után második resolve match → source ID', async () => {
    const engine = makeEngine()
    let calls = 0
    const resolver: ConnectorEntityResolver = {
      async resolve(input) {
        calls += 1
        if (calls === 1) return { status: 'none', candidates: [] }
        if (input.text === 'SPAR') {
          return {
            status: 'match',
            candidates: [
              {
                source_id: SOURCE_ID,
                entity_type: 'company',
                display_name: 'SPAR Magyarország Kft.',
                confidence: 0.96,
              },
            ],
          }
        }
        return { status: 'none', candidates: [] }
      },
    }

    const promptResult = await resolveUserInputEntities({
      text: 'Készíts kimutatást a SPAR idei forgalmáról.',
      mode: 'enforce',
      engine,
      tenantId: TENANT,
      scope: SCOPE,
      resolution: { connectorId: CONNECTOR, resolver },
    })
    assert.equal(promptResult.applied, false)

    const toolResult = await resolveEntityNamesInToolArgs({
      args: { company: 'SPAR' },
      engine,
      tenantId: TENANT,
      scope: SCOPE,
      connectorId: CONNECTOR,
      connectorConfig: { fields: CRM_FIELDS, privacy: { entity_resolution: true } },
      resolver,
    })
    assert.equal(calls, 2, 'a tool-boundary második resolve-hívást indítja')
    assert.equal(toolResult.resolvedCount, 1)
    assert.deepEqual(toolResult.args, { company: SOURCE_ID })
  })

  await test('hibás tokenize mező a tool-boundary-n fail-closed, nem néma fail-open', async () => {
    await assert.rejects(
      () =>
        resolveEntityNamesInToolArgs({
          args: { company: 'SPAR' },
          engine: {} as SurrogateEngine,
          tenantId: TENANT,
          scope: SCOPE,
          connectorId: CONNECTOR,
          connectorConfig: {
            fields: { revenue: { type: 'number', privacy: 'tokenize', entity_type: 'company' } },
          },
          resolver: { async resolve() { return { status: 'none', candidates: [] } } },
        }),
      (err: unknown) => err instanceof PrivacyTransformBlockedError,
    )
  })

  console.log(failures === 0 ? '\nMinden APG-17 teszt zöld.' : `\n${failures} teszt elbukott.`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
