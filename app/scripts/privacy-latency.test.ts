/**
 * APG-10 — latency-budget: entitástérkép-cache + batchelt vault-írás.
 *
 * DoD: 100 KB-os szintetikus tool-válasz p95-je rögzítve (≤ 50 ms transzformáció,
 * ≤ 80 ms teljes forduló-overhead); N+1 vault-írás kizárva számlálóval.
 *
 * Futtatás: npm run test:privacy-latency
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { randomUUID } from 'node:crypto'

import { OSTOROSBOR_CRM_PRIVACY_FIELDS } from '../src/domain/privacy/connector-privacy'
import { SurrogateEngine, type PrivacyAuditSink } from '../src/domain/privacy/surrogate-engine'
import { transformStructuredOutput } from '../src/domain/privacy/structured-output-transform'
import {
  computeSurrogateHmac,
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
import { buildPrivacyAwareOutcomeChannels } from '../src/domain/tool-broker/tool-output-privacy'
import { privacyTransformDurationMs, registry } from '../src/lib/observability/metrics'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

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
const TARGET_BYTES = 100_000
const TRANSFORM_P95_MS = 50
const ROUND_P95_MS = 80
const BENCHMARK_ITERS = 24

const CRM_FIELDS = {
  ...OSTOROSBOR_CRM_PRIVACY_FIELDS,
  email: {
    type: 'string' as const,
    privacy: 'tokenize' as const,
    entity_type: 'email' as const,
    source_id: 'crm/email/{id}',
  },
}

class SilentAudit implements PrivacyAuditSink {
  async recordUnknownSurrogate(): Promise<void> {}
  async recordResolveDenied(): Promise<void> {}
}

class InMemorySurrogateVault implements SurrogateVault {
  readonly rows: RefVaultRecord[] = []
  private readonly byEntity = new Map<string, RefVaultRecord>()
  private readonly bySurrogate = new Map<string, RefVaultRecord>()

  constructor(private readonly resolveTenantKey: (tenantId: string) => string) {}

  private entityIdentity(input: {
    tenantId: string
    scopeType: string
    scopeId: string
    entityType: string
    connectorId: string
    sourceId: string
  }): string {
    return `${input.tenantId}\0${input.scopeType}\0${input.scopeId}\0${input.entityType}\0${input.connectorId}\0${input.sourceId}`
  }

  private surrogateIdentity(tenantId: string, scope: PrivacyScope, surrogate: string): string {
    return `${tenantId}\0${scope.type}\0${scope.id}\0${surrogate}`
  }

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

  async findByEntity(
    tenantId: string,
    scope: PrivacyScope,
    entity: RefEntityRef,
  ): Promise<VaultLookup> {
    return this.lookup(
      this.byEntity.get(
        this.entityIdentity({
          tenantId,
          scopeType: scope.type,
          scopeId: scope.id,
          entityType: entity.entityType,
          connectorId: entity.connectorId,
          sourceId: entity.sourceId,
        }),
      ),
    )
  }

  async findBySurrogate(
    tenantId: string,
    scope: PrivacyScope,
    surrogate: string,
  ): Promise<VaultLookup> {
    return this.lookup(this.bySurrogate.get(this.surrogateIdentity(tenantId, scope, surrogate)))
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

  async listByScope(tenantId: string, scope: PrivacyScope): Promise<RefVaultRecord[]> {
    const hits: RefVaultRecord[] = []
    for (const row of this.rows) {
      if (row.tenantId !== tenantId || row.scopeType !== scope.type || row.scopeId !== scope.id) {
        continue
      }
      const result = this.lookup(row)
      if (result.status === 'hit') hits.push(result.record)
    }
    return hits
  }

  async maxOrdinal(tenantId: string, scope: PrivacyScope, entityType: string): Promise<number> {
    let max = 0
    for (const row of this.rows) {
      if (row.tenantId !== tenantId || row.scopeType !== scope.type || row.scopeId !== scope.id) {
        continue
      }
      const parsed = parseSurrogate(row.surrogate)
      if (parsed && parsed.entityType === entityType && parsed.ordinal > max) max = parsed.ordinal
    }
    return max
  }

  async insertRef(input: InsertRefInput): Promise<RefVaultRecord> {
    return this.insertRefSync(input)
  }

  async insertRefs(inputs: InsertRefInput[]): Promise<RefVaultRecord[]> {
    const records: RefVaultRecord[] = []
    for (const input of inputs) records.push(this.insertRefSync(input))
    return records
  }

  private insertRefSync(input: InsertRefInput): RefVaultRecord {
    const entityKey = this.entityIdentity({
      tenantId: input.tenantId,
      scopeType: input.scope.type,
      scopeId: input.scope.id,
      entityType: input.entityType,
      connectorId: input.connectorId,
      sourceId: input.sourceId,
    })
    const entityHit = this.byEntity.get(entityKey)
    if (entityHit) return entityHit
    const surrogateKey = this.surrogateIdentity(input.tenantId, input.scope, input.surrogate)
    if (this.bySurrogate.has(surrogateKey)) throw new SurrogateTakenError(input.surrogate)
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
    this.byEntity.set(entityKey, record)
    this.bySurrogate.set(surrogateKey, record)
    return record
  }

  findValByFingerprint = valVaultMethodStubs.findValByFingerprint
  findValBySurrogate = valVaultMethodStubs.findValBySurrogate
  insertVal = valVaultMethodStubs.insertVal
}

class CountingVault implements SurrogateVault {
  insertRefCalls = 0
  insertRefsCalls = 0
  insertRefsRows = 0
  listByScopeCalls = 0
  findByEntityCalls = 0
  maxOrdinalCalls = 0

  constructor(private readonly inner: InMemorySurrogateVault) {}

  resetCounts(): void {
    this.insertRefCalls = 0
    this.insertRefsCalls = 0
    this.insertRefsRows = 0
    this.listByScopeCalls = 0
    this.findByEntityCalls = 0
    this.maxOrdinalCalls = 0
  }

  async findByEntity(
    tenantId: string,
    scope: PrivacyScope,
    entity: RefEntityRef,
  ): Promise<VaultLookup> {
    this.findByEntityCalls += 1
    return this.inner.findByEntity(tenantId, scope, entity)
  }

  findBySurrogate(tenantId: string, scope: PrivacyScope, surrogate: string): Promise<VaultLookup> {
    return this.inner.findBySurrogate(tenantId, scope, surrogate)
  }

  findHitsBySurrogateInTenant(tenantId: string, surrogate: string): Promise<RefVaultRecord[]> {
    return this.inner.findHitsBySurrogateInTenant(tenantId, surrogate)
  }

  async listByScope(tenantId: string, scope: PrivacyScope): Promise<RefVaultRecord[]> {
    this.listByScopeCalls += 1
    return this.inner.listByScope(tenantId, scope)
  }

  async maxOrdinal(tenantId: string, scope: PrivacyScope, entityType: string): Promise<number> {
    this.maxOrdinalCalls += 1
    return this.inner.maxOrdinal(tenantId, scope, entityType)
  }

  async insertRef(input: InsertRefInput): Promise<RefVaultRecord> {
    this.insertRefCalls += 1
    return this.inner.insertRef(input)
  }

  async insertRefs(inputs: InsertRefInput[]): Promise<RefVaultRecord[]> {
    this.insertRefsCalls += 1
    this.insertRefsRows += inputs.length
    return this.inner.insertRefs(inputs)
  }

  findValByFingerprint = valVaultMethodStubs.findValByFingerprint
  findValBySurrogate = valVaultMethodStubs.findValBySurrogate
  insertVal = valVaultMethodStubs.insertVal
}

function setup() {
  const inner = new InMemorySurrogateVault(() => HMAC_KEY)
  const vault = new CountingVault(inner)
  const engine = new SurrogateEngine(vault, new SilentAudit())
  const scope: PrivacyScope = { type: 'conversation', id: CONVERSATION }
  return { inner, vault, engine, scope }
}

function syntheticCrmList(minBytes: number): {
  payload: { ok: true; status: number; body: Array<{ id: number; company_name: string; email: string }> }
  bytes: number
} {
  const body: Array<{ id: number; company_name: string; email: string }> = []
  const payload = { ok: true as const, status: 200, body }
  let bytes = Buffer.byteLength(JSON.stringify(payload), 'utf8')
  let i = 1
  while (bytes < minBytes) {
    body.push({
      id: i,
      company_name: `Cég ${String(i).padStart(5, '0')} Kereskedelmi Kft.`,
      email: `kapcsolat.${String(i).padStart(5, '0')}@example.hu`,
    })
    i += 1
    bytes = Buffer.byteLength(JSON.stringify(payload), 'utf8')
  }
  return { payload, bytes }
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  if (sorted.length === 0) return 0
  const rank = Math.ceil((p / 100) * sorted.length) - 1
  return sorted[Math.max(0, rank)] ?? 0
}

async function main() {
  console.log('privacy latency-budget (APG-10)\n')

  const transformSrc = readFileSync(join(root, 'src/domain/privacy/structured-output-transform.ts'), 'utf8')
  // A batchelt írás a Postgres ADAPTERBEN van, nem a domain-szerződésben — a
  // korábbi assert a szerződésfájlt olvasta, ezért mindig elbukott.
  const vaultSrc = readFileSync(
    join(root, 'src/repositories/postgres/surrogate-vault-repository.ts'),
    'utf8',
  )
  const metricsSrc = readFileSync(join(root, 'src/lib/observability/metrics.ts'), 'utf8')
  const { payload, bytes } = syntheticCrmList(TARGET_BYTES)

  await test('a transzformáció allocateRefs-t hív, nem rekordonkénti allocateRef-et', () => {
    assert.match(transformSrc, /\.allocateRefs\(/)
    assert.doesNotMatch(transformSrc, /\.allocateRef\(/)
  })

  await test('a Postgres vault createMany-t egy tranzakcióban használ', () => {
    assert.match(vaultSrc, /async insertRefs\(/)
    assert.match(vaultSrc, /\$transaction/)
    assert.match(vaultSrc, /createMany/)
  })

  await test('a metrika a meglévő observability-rétegben van', () => {
    assert.match(metricsSrc, /privacy_transform_duration_ms/)
    assert.match(metricsSrc, /privacyTransformDurationMs/)
  })

  await test('N entitás egy vault-írás-tranzakció, nem N insertRef', async () => {
    const { vault, engine, scope } = setup()
    const output = {
      ok: true,
      body: [
        { id: 1, company_name: 'Alfa Kft.', email: 'a@x.hu' },
        { id: 2, company_name: 'Béta Zrt.', email: 'b@x.hu' },
        { id: 3, company_name: 'Gamma Bt.', email: 'c@x.hu' },
        { id: 1, company_name: 'Alfa Kft.', email: 'a@x.hu' },
      ],
    }
    const result = await transformStructuredOutput({
      output,
      fields: CRM_FIELDS,
      engine,
      tenantId: TENANT,
      connectorId: CONNECTOR,
      scope,
      apply: true,
    })
    const body = (result.output as typeof output).body
    assert.equal(body[0]?.company_name, '[[COMPANY_1]]')
    assert.equal(body[1]?.company_name, '[[COMPANY_2]]')
    assert.equal(body[2]?.company_name, '[[COMPANY_3]]')
    assert.equal(body[0]?.company_name, body[3]?.company_name)
    assert.equal(body[0]?.email, '[[EMAIL_1]]')
    assert.equal(vault.insertRefCalls, 0)
    assert.equal(vault.findByEntityCalls, 0)
    assert.equal(vault.maxOrdinalCalls, 0)
    assert.equal(vault.listByScopeCalls, 1)
    assert.equal(vault.insertRefsCalls, 1)
    assert.equal(vault.insertRefsRows, 6)
  })

  await test('append-only prefix: a második forduló csak az új entitást írja', async () => {
    const { vault, engine, scope } = setup()
    const first = {
      ok: true,
      body: [
        { id: 1, company_name: 'Alfa Kft.' },
        { id: 2, company_name: 'Béta Zrt.' },
      ],
    }
    const firstResult = await transformStructuredOutput({
      output: first,
      fields: CRM_FIELDS,
      engine,
      tenantId: TENANT,
      connectorId: CONNECTOR,
      scope,
      apply: true,
    })
    vault.resetCounts()
    const second = {
      ok: true,
      body: [
        { id: 1, company_name: 'Alfa Kft.' },
        { id: 2, company_name: 'Béta Zrt.' },
        { id: 3, company_name: 'Gamma Bt.' },
      ],
    }
    const secondResult = await transformStructuredOutput({
      output: second,
      fields: CRM_FIELDS,
      engine,
      tenantId: TENANT,
      connectorId: CONNECTOR,
      scope,
      apply: true,
    })
    const firstBody = (firstResult.output as typeof first).body
    const secondBody = (secondResult.output as typeof second).body
    assert.equal(secondBody[0]?.company_name, firstBody[0]?.company_name)
    assert.equal(secondBody[1]?.company_name, firstBody[1]?.company_name)
    assert.equal(secondBody[2]?.company_name, '[[COMPANY_3]]')
    assert.equal(vault.listByScopeCalls, 0)
    assert.equal(vault.insertRefCalls, 0)
    assert.equal(vault.insertRefsCalls, 1)
    assert.equal(vault.insertRefsRows, 1)
  })

  await test('100 KB szintetikus tool-válasz: p95 transzformáció ≤ 50 ms, forduló ≤ 80 ms', async () => {
    privacyTransformDurationMs.reset()
    const transformMs: number[] = []
    const roundMs: number[] = []
    for (let i = 0; i < 3; i += 1) {
      const warm = setup()
      await transformStructuredOutput({
        output: payload,
        fields: CRM_FIELDS,
        engine: warm.engine,
        tenantId: TENANT,
        connectorId: CONNECTOR,
        scope: warm.scope,
        apply: true,
      })
    }
    for (let i = 0; i < BENCHMARK_ITERS; i += 1) {
      const coldTransform = setup()
      const started = performance.now()
      const transformed = await transformStructuredOutput({
        output: payload,
        fields: CRM_FIELDS,
        engine: coldTransform.engine,
        tenantId: TENANT,
        connectorId: CONNECTOR,
        scope: coldTransform.scope,
        apply: true,
      })
      transformMs.push(performance.now() - started)

      const coldRound = setup()
      const roundStarted = performance.now()
      const channels = await buildPrivacyAwareOutcomeChannels({
        tool: 'http_api_get',
        trust: 'external_untrusted',
        output: payload,
        contract: undefined,
        sideEffecting: false,
        connector: { id: CONNECTOR, tenantId: TENANT, config: { fields: CRM_FIELDS } },
        conversationId: CONVERSATION,
        actingTenantId: TENANT,
        engine: coldRound.engine,
        mode: 'enforce',
      })
      roundMs.push(performance.now() - roundStarted)

      const first = (transformed.output as typeof payload).body[0]
      assert.equal(first?.company_name, '[[COMPANY_1]]')
      assert.equal(channels.modelText.includes('Kereskedelmi Kft.'), false)
      assert.match(channels.modelText, /\[\[COMPANY_1\]\]/)
    }

    const p95Transform = percentile(transformMs, 95)
    const p95Round = percentile(roundMs, 95)
    console.log(
      `    rögzített p95: transform=${p95Transform.toFixed(1)} ms / ${bytes} byte` +
        ` (budget ${TRANSFORM_P95_MS}) · round=${p95Round.toFixed(1)} ms (budget ${ROUND_P95_MS})` +
        ` · rows=${payload.body.length} · iters=${BENCHMARK_ITERS}`,
    )
    assert.ok(
      p95Transform <= TRANSFORM_P95_MS,
      `transform p95 ${p95Transform.toFixed(1)} ms > ${TRANSFORM_P95_MS} ms`,
    )
    assert.ok(p95Round <= ROUND_P95_MS, `round p95 ${p95Round.toFixed(1)} ms > ${ROUND_P95_MS} ms`)
    assert.match(registry.render(), /privacy_transform_duration_ms/)
    assert.match(registry.render(), /privacy_transform_duration_ms_count/)
  })

  if (failures > 0) {
    console.error(`\n${failures} teszt elbukott`)
    process.exit(1)
  }
  console.log('\nOK')
}

void main()
