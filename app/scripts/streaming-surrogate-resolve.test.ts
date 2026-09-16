/**
 * APG-06 — megjelenítési feloldás streaming-biztosan (spec §10.2, §10.4).
 *
 * Karakterenkénti deltákkal a felhasználó sosem lát `[[COMP`-ot; finish() után
 * a puffer üres. A közös pufferelés a StreamingSensitiveTextRedactor mintája.
 *
 * Futtatás: npm run test:streaming-surrogate-resolve
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { STREAM_BUFFER_LIMITS } from '../src/domain/gateway/streaming-text-buffer'
import { StreamingSensitiveTextRedactor } from '../src/domain/gateway/sensitivity-router'
import { SurrogateEngine, type PrivacyAuditSink } from '../src/domain/privacy/surrogate-engine'
import {
  createWebUiDisplayLookup,
  resolveDisplayText,
} from '../src/domain/privacy/resolve-display-text'
import { StreamingSurrogateResolver } from '../src/domain/privacy/streaming-surrogate-resolver'
import { isSurrogatePrefix } from '../src/domain/privacy/surrogate-format'
import {
  computeSurrogateHmac,
  insertRefsSequentially,
  SurrogateTakenError,
  type InsertRefInput,
  type PrivacyScope,
  type RefEntityRef,
  type RefVaultRecord,
  type SurrogateHmacFields,
  type SurrogateVault,
  type VaultLookup,
} from '../src/domain/privacy/surrogate-vault'
import { valVaultMethodStubs } from './test-surrogate-vault-val-stubs'

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

const HMAC_KEY = 'test-tenant-hmac-key'

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
    const key = this.resolveTenantKey(row.tenantId)
    if (!verifyRow(key, fields, row.hmac)) return { status: 'tampered' }
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
      if (row.entityType !== entityType) continue
      const ordinal = Number(/_([1-9][0-9]*)\]\]$/.exec(row.surrogate)?.[1] ?? 0)
      if (ordinal > max) max = ordinal
    }
    return max
  }

  async insertRef(input: InsertRefInput): Promise<RefVaultRecord> {
    const existing = this.rows.find(
      (row) =>
        row.tenantId === input.tenantId &&
        row.scopeType === input.scope.type &&
        row.scopeId === input.scope.id &&
        row.surrogate === input.surrogate,
    )
    if (existing) throw new SurrogateTakenError(input.surrogate)
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
      id: randomUUID(),
      ...fields,
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

function verifyRow(key: string, fields: SurrogateHmacFields, hmac: string): boolean {
  return computeSurrogateHmac(key, fields) === hmac
}

async function collect(
  lookup: (surrogate: string) => Promise<string | null>,
  deltas: string[],
): Promise<{ emitted: string[]; joined: string; resolver: StreamingSurrogateResolver }> {
  const emitted: string[] = []
  const resolver = new StreamingSurrogateResolver(lookup, (text) => {
    emitted.push(text)
  })
  for (const delta of deltas) await resolver.push(delta)
  await resolver.finish()
  return { emitted, joined: emitted.join(''), resolver }
}

function mapLookup(map: Record<string, string>) {
  return async (surrogate: string) => map[surrogate] ?? null
}

async function main() {
  console.log('APG-06 streaming megjelenítési feloldás\n')

  await test('karakterenkénti delták: a felhasználó sosem lát [[COMP-ot', async () => {
    const seen: string[] = []
    const resolver = new StreamingSurrogateResolver(mapLookup({ '[[COMPANY_1]]': 'SPAR' }), (text) => {
      seen.push(text)
      const soFar = seen.join('')
      assert.equal(soFar.includes('[[COMP'), false, `töredék álnév kiment: ${JSON.stringify(soFar)}`)
    })
    for (const ch of 'A [[COMPANY_1]] forgalma.') {
      await resolver.push(ch)
    }
    await resolver.finish()
    assert.equal(seen.join(''), 'A SPAR forgalma.')
    assert.equal(resolver.isEmpty, true)
  })

  await test('szétszakadt álnév: [[COMP + ANY_1]] feloldódik, töredék nem jelenik meg', async () => {
    const seen: string[] = []
    const resolver = new StreamingSurrogateResolver(mapLookup({ '[[COMPANY_1]]': 'SPAR' }), (text) => {
      seen.push(text)
      assert.equal(seen.join('').includes('[[COMP'), false)
    })
    await resolver.push('lásd [[COMP')
    assert.equal(seen.join(''), 'lásd ')
    await resolver.push('ANY_1]] idén')
    await resolver.finish()
    assert.equal(seen.join(''), 'lásd SPAR idén')
    assert.equal(resolver.isEmpty, true)
  })

  await test('nyitott kód-span: `fajl-[[COMPANY_1]]` álnév a záró backtickig várakozik, nem oldódik fel', async () => {
    const { joined } = await collect(
      mapLookup({ '[[COMPANY_1]]': 'SPAR' }),
      ['📄 **`targyalasi-', '[[COMPANY_1]]', '-2026.html`** és [[COMPANY_1]] partner.'],
    )
    assert.equal(joined, '📄 **`targyalasi-[[COMPANY_1]]-2026.html`** és SPAR partner.')
  })

  await test('nyitott kód-span finish-kor kimegy (nem ragad be; lezáratlan backtick = sima szöveg)', async () => {
    const { joined } = await collect(mapLookup({ '[[COMPANY_1]]': 'SPAR' }), ['`x-', '[[COMPANY_1]]'])
    assert.equal(joined, '`x-SPAR')
  })

  await test('finish(): lezáratlan [[COMP töredék eldobódik, puffer üres', async () => {
    const { joined, resolver } = await collect(mapLookup({ '[[COMPANY_1]]': 'SPAR' }), [
      'Előtte [[COMP',
    ])
    assert.equal(joined, 'Előtte ')
    assert.equal(joined.includes('[[COMP'), false)
    assert.equal(resolver.isEmpty, true)
  })

  await test('ismeretlen teljes álnév változatlanul marad (nem töredék)', async () => {
    const { joined } = await collect(mapLookup({ '[[COMPANY_1]]': 'SPAR' }), [...'[[COMPANY_99]]'])
    assert.equal(joined, '[[COMPANY_99]]')
  })

  await test('[[hello nem álnév: a [[ kimegy, nincs beragadás', async () => {
    const { joined } = await collect(async () => null, ['[[hello]]'])
    assert.equal(joined, '[[hello]]')
  })

  await test('trailing [ finish-kor kimegy (nem álnév-töredék)', async () => {
    const { joined } = await collect(async () => null, ['ár [', ']'])
    assert.equal(joined, 'ár []')
  })

  await test('web UI lookup: vault + displayValue → teljes feloldás', async () => {
    const engine = new SurrogateEngine(new InMemorySurrogateVault(() => HMAC_KEY), new RecordingAudit())
    const tenantId = randomUUID()
    const scope: PrivacyScope = { type: 'conversation', id: randomUUID() }
    const surrogate = await engine.allocateRef({
      tenantId,
      scope,
      entityType: 'company',
      connectorId: randomUUID(),
      sourceId: 'crm/company/4821',
      displayValue: 'SPAR',
    })
    const lookup = createWebUiDisplayLookup({ engine, tenantId, scope })
    const { joined, resolver } = await collect(lookup, [...`Kimutatás: ${surrogate}.`])
    assert.equal(joined, 'Kimutatás: SPAR.')
    assert.equal(resolver.isEmpty, true)
    const whole = await resolveDisplayText(`A ${surrogate} és a ${surrogate}.`, lookup)
    assert.equal(whole, 'A SPAR és a SPAR.')
  })

  await test('másik conversation scope nem oldódik fel', async () => {
    const engine = new SurrogateEngine(new InMemorySurrogateVault(() => HMAC_KEY), new RecordingAudit())
    const tenantId = randomUUID()
    const scope: PrivacyScope = { type: 'conversation', id: randomUUID() }
    const other: PrivacyScope = { type: 'conversation', id: randomUUID() }
    await engine.allocateRef({
      tenantId,
      scope,
      entityType: 'company',
      connectorId: randomUUID(),
      sourceId: 'crm/company/4821',
      displayValue: 'SPAR',
    })
    const lookup = createWebUiDisplayLookup({ engine, tenantId, scope: other })
    const { joined } = await collect(lookup, [...'[[COMPANY_1]]'])
    assert.equal(joined, '[[COMPANY_1]]')
  })

  await test('közös puffer-limitek: a redactor ugyanazt a soft/hard/overlapot használja', () => {
    assert.equal(STREAM_BUFFER_LIMITS.SOFT_FLUSH_CHARS, 512)
    assert.equal(STREAM_BUFFER_LIMITS.PATTERN_OVERLAP_CHARS, 128)
    assert.equal(STREAM_BUFFER_LIMITS.HARD_BUFFER_CHARS, 4096)
    const emitted: string[] = []
    const guard = new StreamingSensitiveTextRedactor((text) => emitted.push(text))
    guard.push('Biztonságos gondolat '.repeat(40))
    assert.ok(emitted.length > 0, 'a közös soft-flush a redactorban is ürít')
    guard.finish()
  })

  await test('isSurrogatePrefix: [[COMP igaz, [[hello hamis', () => {
    assert.equal(isSurrogatePrefix('['), true)
    assert.equal(isSurrogatePrefix('[['), true)
    assert.equal(isSurrogatePrefix('[[COMP'), true)
    assert.equal(isSurrogatePrefix('[[COMPANY_1'), true)
    assert.equal(isSurrogatePrefix('[[COMPANY_1]'), true)
    assert.equal(isSurrogatePrefix('[[hello'), false)
    assert.equal(isSurrogatePrefix('[[COMPANY_1]]'), false)
  })

  console.log(failures === 0 ? '\nMinden streaming-surrogate-resolve teszt zöld.' : `\n${failures} teszt elbukott.`)
  process.exitCode = failures === 0 ? 0 : 1
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
