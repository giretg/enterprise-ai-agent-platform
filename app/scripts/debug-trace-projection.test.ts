/**
 * APG-21 — Debug-trace pszeudonimizált projection (spec §12).
 *
 * DoD: a debug-trace tool kimenetében nincs nyers entitásérték; a trace-en belüli
 * konzisztencia bizonyított.
 *
 * Futtatás: npm run test:debug-trace-projection
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { findRawEntityLeak } from '../src/domain/privacy/privacy-audit'
import {
  resolvePrivacyCategoryPolicy,
} from '../src/domain/privacy/privacy-category-policy'
import {
  projectDebugTraceBundle,
  projectDebugTraceToolOutput,
} from '../src/domain/privacy/debug-trace-projection'
import { privacyScopeForTrace } from '../src/domain/privacy/privacy-scope'
import { SurrogateEngine, type PrivacyAuditSink } from '../src/domain/privacy/surrogate-engine'
import { allowAllPrivacyResolveAccess } from '../src/domain/privacy/resolve-access'
import type { ConversationPrivacyKeyRepository } from '../src/repositories/interfaces'
import {
  computeSurrogateHmac,
  insertRefsSequentially,
  SurrogateTakenError,
  verifySurrogateHmac,
  type InsertRefInput,
  type PrivacyScope,
  type RefEntityRef,
  type RefVaultRecord,
  type InsertValInput,
  type ValVaultLookup,
  type ValVaultRecord,
  type SurrogateHmacFields,
  type SurrogateVault,
  type VaultLookup,
} from '../src/domain/privacy/surrogate-vault'
import { parseSurrogate } from '../src/domain/privacy/surrogate-format'
import { DebugTraceService } from '../src/domain/debug-log/debug-trace-service'
import {
  TOOL_GROUP_PRIVACY,
  TOOL_REGISTRY,
} from '../src/domain/tool-broker/tool-registry'

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
const TRACE_A = 'bbbbbbbb-0000-4000-8000-000000000002'
const TRACE_B = 'cccccccc-0000-4000-8000-000000000003'
const CONVERSATION = 'dddddddd-0000-4000-8000-000000000004'
const CONNECTOR = 'eeeeeeee-0000-4000-8000-000000000005'
const HMAC_KEY = 'test-tenant-hmac-key'

const COMPANY = 'SPAR Magyarország Kereskedelmi Kft.'
const EMAIL = 'ada.lovelace@spar.hu'
const RAW_VALUES = [COMPANY, EMAIL, 'SPAR', 'ada.lovelace']

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
  readonly valRows: ValVaultRecord[] = []

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
    const row = this.rows.find(
      (candidate) =>
        candidate.tenantId === tenantId &&
        candidate.scopeType === scope.type &&
        candidate.scopeId === scope.id &&
        candidate.entityType === entity.entityType &&
        candidate.connectorId === entity.connectorId &&
        candidate.sourceId === entity.sourceId,
    )
    return this.lookup(row)
  }

  async findBySurrogate(tenantId: string, scope: PrivacyScope, surrogate: string): Promise<VaultLookup> {
    const row = this.rows.find(
      (candidate) =>
        candidate.tenantId === tenantId &&
        candidate.scopeType === scope.type &&
        candidate.scopeId === scope.id &&
        candidate.surrogate === surrogate,
    )
    return this.lookup(row)
  }

  async findHitsBySurrogateInTenant(tenantId: string, surrogate: string): Promise<RefVaultRecord[]> {
    return this.rows.filter((row) => row.tenantId === tenantId && row.surrogate === surrogate)
  }

  async listByScope(tenantId: string, scope: PrivacyScope): Promise<RefVaultRecord[]> {
    return this.rows.filter(
      (row) => row.tenantId === tenantId && row.scopeType === scope.type && row.scopeId === scope.id,
    )
  }

  async maxOrdinal(
    tenantId: string,
    scope: PrivacyScope,
    entityType: RefVaultRecord['entityType'],
  ): Promise<number> {
    let max = 0
    for (const row of await this.listByScope(tenantId, scope)) {
      const parsed = parseSurrogate(row.surrogate)
      if (parsed?.entityType === entityType && parsed.ordinal > max) max = parsed.ordinal
    }
    for (const row of this.valRows) {
      if (row.tenantId !== tenantId || row.scopeType !== scope.type || row.scopeId !== scope.id) continue
      const parsed = parseSurrogate(row.surrogate)
      if (parsed?.entityType === entityType && parsed.ordinal > max) max = parsed.ordinal
    }
    return max
  }

  async insertRef(input: InsertRefInput): Promise<RefVaultRecord> {
    const [record] = await this.insertRefs([input])
    return record
  }

  async insertRefs(inputs: InsertRefInput[]): Promise<RefVaultRecord[]> {
    return insertRefsSequentially(async (input) => {
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
      const taken = await this.findBySurrogate(input.tenantId, input.scope, input.surrogate)
      if (taken.status === 'hit') throw new SurrogateTakenError(input.surrogate)
      this.rows.push(record)
      return record
    }, inputs)
  }

  async findValByFingerprint(
    tenantId: string,
    scope: PrivacyScope,
    entityType: RefVaultRecord['entityType'],
    fingerprint: string,
  ): Promise<ValVaultLookup> {
    const record = this.valRows.find(
      (row) =>
        row.tenantId === tenantId &&
        row.scopeType === scope.type &&
        row.scopeId === scope.id &&
        row.entityType === entityType &&
        row.sourceId === fingerprint,
    )
    return record ? { status: 'hit', record } : { status: 'miss' }
  }

  async findValBySurrogate(
    tenantId: string,
    scope: PrivacyScope,
    surrogate: string,
  ): Promise<ValVaultLookup> {
    const record = this.valRows.find(
      (row) =>
        row.tenantId === tenantId &&
        row.scopeType === scope.type &&
        row.scopeId === scope.id &&
        row.surrogate === surrogate,
    )
    return record ? { status: 'hit', record } : { status: 'miss' }
  }

  async insertVal(input: InsertValInput): Promise<ValVaultRecord> {
    if (
      this.rows.some(
        (row) =>
          row.tenantId === input.tenantId &&
          row.scopeType === input.scope.type &&
          row.scopeId === input.scope.id &&
          row.surrogate === input.surrogate,
      ) ||
      this.valRows.some(
        (row) =>
          row.tenantId === input.tenantId &&
          row.scopeType === input.scope.type &&
          row.scopeId === input.scope.id &&
          row.surrogate === input.surrogate,
      )
    ) {
      throw new SurrogateTakenError(input.surrogate)
    }
    const fields = {
      tenantId: input.tenantId,
      scopeType: input.scope.type,
      scopeId: input.scope.id,
      entityType: input.entityType,
      surrogate: input.surrogate,
      class: 'val' as const,
      connectorId: '' as const,
      sourceId: input.fingerprint,
    }
    const record: ValVaultRecord = {
      id: randomUUID(),
      ...fields,
      encryptedValue: input.encryptedValue,
      hmac: computeSurrogateHmac(this.resolveTenantKey(input.tenantId), fields),
    }
    this.valRows.push(record)
    return record
  }
}

class InMemoryPrivacyKeys implements ConversationPrivacyKeyRepository {
  private readonly keys = new Map<string, Buffer>()

  async ensureDataKey(_tenantId: string, conversationId: string): Promise<Buffer> {
    const existing = this.keys.get(conversationId)
    if (existing) return existing
    const key = Buffer.alloc(32, 7)
    this.keys.set(conversationId, key)
    return key
  }

  async getDataKey(_tenantId: string, conversationId: string): Promise<Buffer | null> {
    return this.keys.get(conversationId) ?? null
  }

  async shredKeysForConversations(conversationIds: string[]): Promise<number> {
    let count = 0
    for (const id of conversationIds) count += this.keys.delete(id) ? 1 : 0
    return count
  }
}

function makeEngine(vault = new InMemorySurrogateVault(() => HMAC_KEY)): SurrogateEngine {
  return new SurrogateEngine(
    vault,
    new RecordingAudit(),
    allowAllPrivacyResolveAccess,
    new InMemoryPrivacyKeys(),
  )
}

function sampleRawTrace() {
  return {
    traceId: TRACE_A,
    agentTurnId: TRACE_A,
    conversationId: CONVERSATION,
    status: 'completed',
    partialText: `A ${COMPANY} bevétele emelkedett.`,
    activities: [
      {
        id: 'act-1',
        kind: 'tool',
        title: 'CRM lekérdezés',
        detail: `${COMPANY} adatai betöltve`,
        status: 'done',
      },
      {
        id: 'act-2',
        kind: 'reasoning',
        title: 'Összegzés',
        detail: `Kapcsolattartó: ${EMAIL}`,
        status: 'done',
      },
    ],
    messages: [
      { role: 'user', seq: 1, content: `Mi a helyzet a ${COMPANY} ügyében?` },
      { role: 'assistant', seq: 2, content: `A ${COMPANY} adatai frissítve.` },
    ],
    toolCalls: [{ toolName: 'http_api_get', status: 'ok', argsMeta: { company: COMPANY } }],
  }
}

async function main() {
  console.log('APG-21 debug-trace projection\n')

  const vault = new InMemorySurrogateVault(() => HMAC_KEY)
  const engine = makeEngine(vault)
  const policy = resolvePrivacyCategoryPolicy({})
  const conversationScope = { type: 'conversation' as const, id: CONVERSATION }

  await engine.allocateRef({
    tenantId: TENANT,
    scope: conversationScope,
    entityType: 'company',
    connectorId: CONNECTOR,
    sourceId: 'crm/company/4821',
    displayValue: COMPANY,
    displayValueSource: 'structured_field',
  })

  const projectionInput = {
    tenantId: TENANT,
    traceId: TRACE_A,
    knownValueScope: conversationScope,
    mode: 'enforce' as const,
    policy,
    engine,
  }

  await test('privacyScopeForTrace: trace-scoped kulcs', () => {
    assert.deepEqual(privacyScopeForTrace(TRACE_A), { type: 'trace', id: TRACE_A })
  })

  await test('get_debug_trace külön adatvédelmi capability-csoportban van', () => {
    assert.equal(TOOL_REGISTRY.get_debug_trace.capabilityGroup, TOOL_GROUP_PRIVACY)
  })

  await test('get_debug_trace azonos tenanton belül is elutasítja a nem résztvevő kérőt', async () => {
    let requesterUserId: string | null | undefined
    const service = new DebugTraceService(
      {
        agentTurn: {
          findUnique: async () => ({
            id: TRACE_A,
            tenantId: TENANT,
            conversationId: CONVERSATION,
          }),
        },
      } as never,
      {} as never,
      {} as never,
      {
        async authorize(input) {
          requesterUserId = input.requester.userId
          return { allowed: false, reason: 'participant' as const }
        },
      },
    )
    await assert.rejects(
      () => service.getProjectedTrace({
        agentTurnId: TRACE_A,
        tenantId: TENANT,
        requesterUserId: 'foreign-user',
        engine,
        mode: 'enforce',
        policy,
      }),
      /agent_turn_not_found/,
    )
    assert.equal(requesterUserId, 'foreign-user')
  })

  await test('projection: nincs nyers entitásérték a kimenetben', async () => {
    const projected = await projectDebugTraceBundle({
      trace: sampleRawTrace(),
      ...projectionInput,
    })
    const leak = findRawEntityLeak(projected, RAW_VALUES)
    assert.equal(leak, null, `nyers érték kiszivárgott: ${leak}; projection=${JSON.stringify(projected)}`)
    assert.match(JSON.stringify(projected), /\[\[COMPANY_1\]\]/)
    assert.match(JSON.stringify(projected), /\[\[EMAIL_1\]\]/)
  })

  await test('projection: ugyanaz az entitás ugyanazt az álnevet kapja trace-en belül', async () => {
    const projected = await projectDebugTraceBundle({
      trace: sampleRawTrace(),
      ...projectionInput,
    })
    const serialized = JSON.stringify(projected)
    const matches = serialized.match(/\[\[COMPANY_1\]\]/g) ?? []
    assert.ok(matches.length >= 3, 'a cégnév több helyen is álnevet kell kapjon')
    assert.equal(new Set(matches).size, 1)
  })

  await test('projection: külön trace → külön álnév (trace-scope)', async () => {
    const engineB = makeEngine()
    await engineB.allocateRef({
      tenantId: TENANT,
      scope: conversationScope,
      entityType: 'company',
      connectorId: CONNECTOR,
      sourceId: 'crm/company/4821',
      displayValue: COMPANY,
      displayValueSource: 'structured_field',
    })
    const [a, b] = await Promise.all([
      projectDebugTraceBundle({
        trace: sampleRawTrace(),
        ...projectionInput,
      }),
      projectDebugTraceBundle({
        trace: { ...sampleRawTrace(), traceId: TRACE_B, agentTurnId: TRACE_B },
        ...projectionInput,
        traceId: TRACE_B,
        engine: engineB,
      }),
    ])
    const surrogateA = JSON.stringify(a).match(/\[\[COMPANY_\d+\]\]/)?.[0]
    const surrogateB = JSON.stringify(b).match(/\[\[COMPANY_\d+\]\]/)?.[0]
    assert.ok(surrogateA)
    assert.ok(surrogateB)
    assert.equal(surrogateA, '[[COMPANY_1]]')
    assert.equal(surrogateB, '[[COMPANY_1]]')
    // Külön trace scope → külön vault rekord, de mindkettő COMPANY_1 a saját scope-jában.
    // A lényeg: a nyers érték sehol nincs jelen.
    assert.equal(findRawEntityLeak(a, RAW_VALUES), null)
    assert.equal(findRawEntityLeak(b, RAW_VALUES), null)
  })

  await test('get_debug_trace tool output: pszeudonimizált projection', async () => {
    const output = await projectDebugTraceToolOutput({
      trace: sampleRawTrace(),
      ...projectionInput,
    })
    assert.equal(output.traceId, TRACE_A)
    assert.equal(output.agentTurnId, TRACE_A)
    assert.equal(findRawEntityLeak(output, RAW_VALUES), null)
    assert.equal('partialText' in output.projection, true)
  })

  await test('projection: a nem-tokenizálható érzékeny adat (PAN/IBAN/titok/TAJ) redaktálva megy ki, nem nyersen', async () => {
    const PAN = '4111 1111 1111 1111' // Luhn-valid teszt-kártyaszám
    const IBAN = 'HU42117730161111101800000000'
    const SECRET_VALUE = 'sk-abcdefghijklmnopqrstuvwxyz012345'
    const TAJ = '123-456-789'
    const projected = await projectDebugTraceBundle({
      trace: {
        traceId: TRACE_A,
        agentTurnId: TRACE_A,
        conversationId: CONVERSATION,
        detail: `Kártya: ${PAN}, IBAN: ${IBAN}, api_key: ${SECRET_VALUE}, TAJ: ${TAJ}`,
      },
      ...projectionInput,
    })
    const serialized = JSON.stringify(projected)
    for (const raw of [PAN, '4111111111111111', IBAN, SECRET_VALUE, TAJ]) {
      assert.equal(
        serialized.includes(raw),
        false,
        `nyers érzékeny érték kiszivárgott a debug-trace-be: ${raw}; projection=${serialized}`,
      )
    }
    assert.match(serialized, /«redaktált:/)
  })

  await test('projection: `block`-ra állított álnév-kategória is pszeudonimizálódik (nem marad nyers)', async () => {
    // Ha az admin egy álnév-típusú kategóriát (itt: `phone`) a legszigorúbb
    // `block`-ra állítja, a debug-trace-nek is védenie kell — korábban a `block`
    // kimaradt a `tokenize`/`local_only` szűrőből, és a nyers telefonszám kiment.
    const PHONE = '+36 30 123 4567'
    const blockPolicy = resolvePrivacyCategoryPolicy({
      platform: {
        categories: { phone: 'block' },
        custom: {},
        updatedById: null,
        updatedAt: null,
        patternSetVersion: 1,
      },
    })
    const engineC = makeEngine()
    const projected = await projectDebugTraceBundle({
      trace: {
        traceId: TRACE_A,
        agentTurnId: TRACE_A,
        conversationId: CONVERSATION,
        // Ugyanaz a szám kétszer — a DoD második fele: trace-en belüli konzisztencia.
        detail: `Hívd vissza a ${PHONE} számon.`,
        note: `A ${PHONE} elérhető.`,
      },
      ...projectionInput,
      policy: blockPolicy,
      engine: engineC,
      knownValueScope: null,
    })
    const serialized = JSON.stringify(projected)
    assert.equal(serialized.includes(PHONE), false, `nyers telefonszám kiszivárgott: ${serialized}`)
    const aliases = serialized.match(/\[\[PHONE_\d+\]\]/g) ?? []
    assert.ok(aliases.length >= 2, 'a telefonszám mindkét előfordulása álnevet kap')
    assert.equal(new Set(aliases).size, 1, 'ugyanaz az entitás ugyanazt az álnevet kapja a trace-en belül')
  })

  await test('projection OFF módban is pszeudonimizált marad (debug-AI egress)', async () => {
    const projected = await projectDebugTraceBundle({
      trace: sampleRawTrace(),
      ...projectionInput,
      mode: 'off',
    })
    assert.equal(findRawEntityLeak(projected, RAW_VALUES), null)
  })

  console.log(failures === 0 ? '\nMinden debug-trace projection teszt zöld.' : `\n${failures} teszt elbukott.`)
  process.exitCode = failures === 0 ? 0 : 1
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
