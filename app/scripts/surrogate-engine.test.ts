/**
 * Surrogate Engine + vault mag (AI Privacy Gateway APG-02 / spec §5–§6, D1, R10, R16).
 *
 * DB nélkül: a vault-varrat in-memory adapteren át van tesztelve. A Postgres
 * bijektivitást az APG-01 `test:surrogate-map` fedi.
 *
 * Futtatás: npm run test:surrogate-engine
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  formatSurrogate,
  parseSurrogate,
  UnknownEntityTypeError,
} from '../src/domain/privacy/surrogate-format'
import { SurrogateEngine, type PrivacyAuditSink } from '../src/domain/privacy/surrogate-engine'
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

let failures = 0
function check(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`  OK  ${name}`)
    })
    .catch((e) => {
      failures += 1
      console.log(`  FAIL ${name}: ${e instanceof Error ? e.message : String(e)}`)
    })
}

const HMAC_FIXTURE_FIELDS: SurrogateHmacFields = {
  tenantId: '11111111-1111-1111-1111-111111111111',
  scopeType: 'conversation',
  scopeId: '22222222-2222-2222-2222-222222222222',
  entityType: 'company',
  surrogate: '[[COMPANY_1]]',
  class: 'ref',
  connectorId: '33333333-3333-3333-3333-333333333333',
  sourceId: 'crm/company/4821',
}
const HMAC_FIXTURE_KEY = 'test-tenant-hmac-key'
/** Előre számolt HMAC-SHA256(hex) a fenti kanonikus payloadra — független a produkciós kódtól. */
const HMAC_FIXTURE_DIGEST = 'bf2e5d5521d8b6c3dfab1b8a294739aa3ada78c35db3549487c2c79fabf29c74'

type AuditEvent =
  | Parameters<PrivacyAuditSink['recordUnknownSurrogate']>[0]
  | Parameters<PrivacyAuditSink['recordResolveDenied']>[0]

class RecordingAudit implements PrivacyAuditSink {
  readonly events: AuditEvent[] = []
  async recordUnknownSurrogate(event: Parameters<PrivacyAuditSink['recordUnknownSurrogate']>[0]): Promise<void> {
    this.events.push(event)
  }
  async recordResolveDenied(event: Parameters<PrivacyAuditSink['recordResolveDenied']>[0]): Promise<void> {
    this.events.push(event)
  }
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

  async findByEntity(
    tenantId: string,
    scope: PrivacyScope,
    entity: RefEntityRef,
  ): Promise<VaultLookup> {
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

  async findBySurrogate(
    tenantId: string,
    scope: PrivacyScope,
    surrogate: string,
  ): Promise<VaultLookup> {
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
      if (row.tenantId !== tenantId || row.scopeType !== scope.type || row.scopeId !== scope.id) {
        continue
      }
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
}

function keys(tenantId: string): string {
  return `key-for-${tenantId}`
}

function setup() {
  const vault = new InMemorySurrogateVault(keys)
  const audit = new RecordingAudit()
  const engine = new SurrogateEngine(vault, audit)
  const tenantId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
  const scope: PrivacyScope = { type: 'conversation', id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' }
  const requester = { tenantId, userId: 'ffffffff-ffff-ffff-ffff-ffffffffffff' }
  return { vault, audit, engine, tenantId, scope, requester }
}

function company(sourceId: string): RefEntityRef {
  return {
    entityType: 'company',
    connectorId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
    sourceId,
  }
}

async function main() {
  console.log('Surrogate Engine + vault mag\n')

  await check('formátum: company 1 → [[COMPANY_1]], HMAC nélkül', () => {
    assert.equal(formatSurrogate('company', 1), '[[COMPANY_1]]')
    assert.equal(formatSurrogate('person', 2), '[[PERSON_2]]')
    assert.equal(formatSurrogate('email', 3), '[[EMAIL_3]]')
    assert.equal(formatSurrogate('account', 1), '[[ACCOUNT_1]]')
    assert.equal(formatSurrogate('company', 1).includes('hmac'), false)
  })

  await check('parszolás: a spec példái visszaadják a típust és a sorszámot', () => {
    assert.deepEqual(parseSurrogate('[[COMPANY_1]]'), { entityType: 'company', ordinal: 1 })
    assert.deepEqual(parseSurrogate('[[PERSON_2]]'), { entityType: 'person', ordinal: 2 })
    assert.deepEqual(parseSurrogate('[[EMAIL_3]]'), { entityType: 'email', ordinal: 3 })
    assert.equal(parseSurrogate('[[COMPANY_01]]'), null)
    assert.equal(parseSurrogate('[[COMPANY_0]]'), null)
    assert.equal(parseSurrogate('[[company_1]]'), null)
    assert.equal(parseSurrogate('[[FOO_1]]'), null)
    assert.equal(parseSurrogate('prefix[[COMPANY_1]]'), null)
  })

  await check('típus-névtér: ismeretlen entitástípus nem formázható', () => {
    assert.throws(() => formatSurrogate('iban', 1), UnknownEntityTypeError)
  })

  await check('HMAC: ismert payload + tenant-kulcs a rögzített kivonatot adja', () => {
    assert.equal(computeSurrogateHmac(HMAC_FIXTURE_KEY, HMAC_FIXTURE_FIELDS), HMAC_FIXTURE_DIGEST)
    assert.equal(HMAC_FIXTURE_FIELDS.surrogate.includes(HMAC_FIXTURE_DIGEST), false)
  })

  await check('HMAC: a rögzített kivonat ellenőrizhető, hamisítás és idegen kulcs nem', () => {
    assert.equal(verifySurrogateHmac(HMAC_FIXTURE_KEY, HMAC_FIXTURE_FIELDS, HMAC_FIXTURE_DIGEST), true)
    const tampered = { ...HMAC_FIXTURE_FIELDS, sourceId: 'crm/company/9999' }
    assert.equal(verifySurrogateHmac(HMAC_FIXTURE_KEY, tampered, HMAC_FIXTURE_DIGEST), false)
    assert.equal(verifySurrogateHmac('other-tenant-key', HMAC_FIXTURE_FIELDS, HMAC_FIXTURE_DIGEST), false)
    const flipped = HMAC_FIXTURE_DIGEST.replace(/[0-9a-f]/, (ch) => (ch === '0' ? '1' : '0'))
    assert.equal(flipped.length, HMAC_FIXTURE_DIGEST.length)
    assert.equal(verifySurrogateHmac(HMAC_FIXTURE_KEY, HMAC_FIXTURE_FIELDS, flipped), false)
  })

  await check('sorszámozás: típusonként 1-től, person nem viszi a company számlálóját', async () => {
    const { engine, tenantId, scope } = setup()
    const first = await engine.allocateRef({ tenantId, scope, ...company('crm/company/1') })
    const second = await engine.allocateRef({ tenantId, scope, ...company('crm/company/2') })
    const person = await engine.allocateRef({
      tenantId,
      scope,
      entityType: 'person',
      connectorId: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
      sourceId: 'crm/person/1',
    })
    assert.equal(first, '[[COMPANY_1]]')
    assert.equal(second, '[[COMPANY_2]]')
    assert.equal(person, '[[PERSON_1]]')
  })

  await check('bijektivitás: ugyanaz az entitás ugyanazt az álnevet kapja, feloldása az eredeti ref', async () => {
    const { engine, tenantId, scope, requester } = setup()
    const entity = company('crm/company/4821')
    const first = await engine.allocateRef({ tenantId, scope, ...entity })
    const second = await engine.allocateRef({ tenantId, scope, ...entity })
    assert.equal(first, '[[COMPANY_1]]')
    assert.equal(second, '[[COMPANY_1]]')
    const resolved = await engine.resolveRef({ tenantId, scope, surrogate: first, requester })
    assert.equal(resolved.ok, true)
    if (!resolved.ok) return
    assert.equal(resolved.record.connectorId, entity.connectorId)
    assert.equal(resolved.record.sourceId, entity.sourceId)
    assert.equal(resolved.record.entityType, 'company')
  })

  await check('bijektivitás: két entitás a scope-on belül két álnevet kap', async () => {
    const { engine, tenantId, scope, requester } = setup()
    const a = await engine.allocateRef({ tenantId, scope, ...company('crm/company/1') })
    const b = await engine.allocateRef({ tenantId, scope, ...company('crm/company/2') })
    assert.notEqual(a, b)
    const resolvedA = await engine.resolveRef({ tenantId, scope, surrogate: a, requester })
    const resolvedB = await engine.resolveRef({ tenantId, scope, surrogate: b, requester })
    assert.equal(resolvedA.ok && resolvedA.record.sourceId, 'crm/company/1')
    assert.equal(resolvedB.ok && resolvedB.record.sourceId, 'crm/company/2')
  })

  await check('scope: ugyanaz az entitás másik beszélgetésben új sorszámozást kap, és ott oldható fel', async () => {
    const { engine, tenantId, scope, requester } = setup()
    const entity = company('crm/company/4821')
    const otherScope: PrivacyScope = { type: 'conversation', id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee' }
    await engine.allocateRef({ tenantId, scope, ...entity })
    const other = await engine.allocateRef({ tenantId, scope: otherScope, ...entity })
    assert.equal(other, '[[COMPANY_1]]')
    const leaked = await engine.resolveRef({
      tenantId,
      scope: otherScope,
      surrogate: '[[COMPANY_1]]',
      requester,
    })
    assert.equal(leaked.ok && leaked.record.sourceId, 'crm/company/4821')
    const cross = await engine.resolveRef({
      tenantId,
      scope: otherScope,
      surrogate: '[[COMPANY_2]]',
      requester,
    })
    assert.equal(cross.ok, false)
  })

  await check('kitalált álnév: [[COMPANY_99]] nem oldható fel, privacy.surrogate.unknown audit', async () => {
    const { engine, audit, tenantId, scope, requester } = setup()
    await engine.allocateRef({ tenantId, scope, ...company('crm/company/1') })
    const result = await engine.resolveRef({ tenantId, scope, surrogate: '[[COMPANY_99]]', requester })
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.reason, 'unknown')
    assert.equal(audit.events.length, 1)
    assert.equal(audit.events[0]?.action, 'privacy.surrogate.unknown')
    assert.equal(audit.events[0]?.surrogate, '[[COMPANY_99]]')
    assert.equal(audit.events[0]?.reason, 'unknown')
    assert.equal(audit.events[0]?.scope.id, scope.id)
  })

  await check('HMAC-ellenőrzés: meghamisított vault-sor nem oldható fel, audit hmac_invalid', async () => {
    const { engine, vault, audit, tenantId, scope, requester } = setup()
    const surrogate = await engine.allocateRef({ tenantId, scope, ...company('crm/company/4821') })
    const row = vault.rows.find((r) => r.surrogate === surrogate)
    assert.ok(row)
    row.hmac = '0'.repeat(64)
    const result = await engine.resolveRef({ tenantId, scope, surrogate, requester })
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.reason, 'hmac_invalid')
    assert.equal(audit.events[0]?.action, 'privacy.surrogate.unknown')
    assert.equal(audit.events[0]?.reason, 'hmac_invalid')
  })

  await check('allokált álnév szövege nem tartalmazza a HMAC-et', async () => {
    const { engine, vault, tenantId, scope } = setup()
    const surrogate = await engine.allocateRef({ tenantId, scope, ...company('crm/company/4821') })
    const row = vault.rows[0]
    assert.ok(row)
    assert.equal(surrogate, '[[COMPANY_1]]')
    assert.equal(surrogate.includes(row.hmac), false)
    assert.equal(row.hmac.length, 64)
  })

  await check('megjelenítési érték: allokációkor megjegyzett név peek-elhető, vault nélkül', async () => {
    const { engine, tenantId, scope, requester } = setup()
    const surrogate = await engine.allocateRef({
      tenantId,
      scope,
      ...company('crm/company/4821'),
      displayValue: 'SPAR',
    })
    assert.equal(surrogate, '[[COMPANY_1]]')
    assert.equal(engine.peekDisplayValue(tenantId, scope, surrogate), 'SPAR')
    const peeked = await engine.peekRef({ tenantId, scope, surrogate, requester })
    assert.equal(peeked.ok, true)
  })

  console.log(failures === 0 ? '\nMinden surrogate-engine teszt zöld.' : `\n${failures} teszt elbukott.`)
  process.exitCode = failures === 0 ? 0 : 1
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
