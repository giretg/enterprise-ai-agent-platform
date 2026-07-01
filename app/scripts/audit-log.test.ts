/**
 * Audit Log & Observability — DB nélküli, tiszta logikai tesztek (Feature-spec §9).
 * Futtatás: npm run test:audit-log
 */
import assert from 'node:assert/strict'
import type { AuditLog } from '@prisma/client'
import { assertAuditMetadataSafe, UnsafeAuditPayloadError } from '../src/lib/audit/payload-guard'
import { assertAuditActionRegistered, UnregisteredAuditActionError } from '../src/lib/audit/event-catalog'
import { deriveAuditAttribution } from '../src/lib/audit/attribution'
import { computeAuditHash, GENESIS_HASH } from '../src/lib/crypto/hash-chain'
import { AuditChainService } from '../src/domain/audit/audit-chain-service'
import type { AuditRepository } from '../src/repositories/interfaces'

let passed = 0
let failed = 0

function check(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  OK  ${name}`)
    passed += 1
  } catch (e) {
    console.log(`  FAIL  ${name} — ${e instanceof Error ? e.message : String(e)}`)
    failed += 1
  }
}

async function checkAsync(name: string, fn: () => Promise<void>) {
  try {
    await fn()
    console.log(`  OK  ${name}`)
    passed += 1
  } catch (e) {
    console.log(`  FAIL  ${name} — ${e instanceof Error ? e.message : String(e)}`)
    failed += 1
  }
}

// ── content/metadata szétválasztás (invariáns #5) ──────────────────────────

check('assertAuditMetadataSafe: null/undefined engedett', () => {
  assertAuditMetadataSafe(null)
  assertAuditMetadataSafe(undefined)
})

check('assertAuditMetadataSafe: sima metaadat engedett', () => {
  assertAuditMetadataSafe({ tokens: 123, note: 'ok', ref: { contentRef: 'gcs://x', tokenHash: 'abc' } })
})

check('assertAuditMetadataSafe: nyers "content" kulcs elutasítva', () => {
  assert.throws(() => assertAuditMetadataSafe({ content: 'raw text leaked here' }), UnsafeAuditPayloadError)
})

check('assertAuditMetadataSafe: nyers "secret" kulcs elutasítva (nested)', () => {
  assert.throws(
    () => assertAuditMetadataSafe({ outer: { secret: 'sk-live-xxx' } }),
    UnsafeAuditPayloadError,
  )
})

check('assertAuditMetadataSafe: ref/hash/alias formájú kulcsok NEM tiltottak', () => {
  assertAuditMetadataSafe({ secretAlias: 'vault:abc', contentHash: 'sha256:...', tokenHash: 'sha256:...' })
})

check('assertAuditMetadataSafe: túl hosszú nyers string elutasítva', () => {
  assert.throws(() => assertAuditMetadataSafe('x'.repeat(5000)), UnsafeAuditPayloadError)
})

check('assertAuditMetadataSafe: tömbön belüli tiltott kulcs is elkapva', () => {
  assert.throws(
    () => assertAuditMetadataSafe({ items: [{ ok: 1 }, { password: 'hunter2' }] }),
    UnsafeAuditPayloadError,
  )
})

// ── kötelező eseménytípus-katalógus (§5) ────────────────────────────────────

check('assertAuditActionRegistered: regisztrált típus átmegy', () => {
  assertAuditActionRegistered('ticket.transition')
  assertAuditActionRegistered('tool.call.denied')
})

check('assertAuditActionRegistered: ismeretlen típus elutasítva', () => {
  assert.throws(
    () => assertAuditActionRegistered('made.up.action'),
    UnregisteredAuditActionError,
  )
})

// ── explicit tenant/ticket/conversation attribúció (§3.1/§3.2) ─────────────

check('deriveAuditAttribution: ticket targetType-ból derivál', () => {
  const result = deriveAuditAttribution({
    targetType: 'ticket',
    targetId: 'aaaaaaaa-bbbb-4000-8000-000000000001',
    metadata: null,
  })
  assert.equal(result.ticketId, 'aaaaaaaa-bbbb-4000-8000-000000000001')
  assert.equal(result.conversationId, null)
})

check('deriveAuditAttribution: metadata ticketId/tenantId kulcsból derivál', () => {
  const result = deriveAuditAttribution({
    targetType: 'monitor',
    targetId: null,
    metadata: {
      ticketId: 'aaaaaaaa-bbbb-4000-8000-000000000002',
      tenant_id: 'aaaaaaaa-bbbb-4000-8000-000000000003',
    },
  })
  assert.equal(result.ticketId, 'aaaaaaaa-bbbb-4000-8000-000000000002')
  assert.equal(result.tenantId, 'aaaaaaaa-bbbb-4000-8000-000000000003')
})

check('deriveAuditAttribution: explicit érték felülírja a derivációt', () => {
  const result = deriveAuditAttribution({
    targetType: 'ticket',
    targetId: 'aaaaaaaa-bbbb-4000-8000-000000000001',
    metadata: null,
    ticketId: 'aaaaaaaa-bbbb-4000-8000-000000000099',
  })
  assert.equal(result.ticketId, 'aaaaaaaa-bbbb-4000-8000-000000000099')
})

check('deriveAuditAttribution: nem-uuid metadata érték figyelmen kívül hagyva', () => {
  const result = deriveAuditAttribution({
    targetType: 'monitor',
    targetId: null,
    metadata: { ticketId: 'not-a-uuid' },
  })
  assert.equal(result.ticketId, null)
})

// ── verifyChain: teljes lánc, szegmens, tamper-detekció (§6.2, §9) ─────────

function makeRow(overrides: Partial<AuditLog> = {}): AuditLog {
  return {
    id: crypto.randomUUID(),
    seq: BigInt(1),
    actorType: 'agent',
    actorId: null,
    agentVersion: null,
    action: 'model.call',
    targetType: 'conversation',
    targetId: null,
    modelUsed: null,
    inputRef: null,
    outputRef: null,
    policyDecision: null,
    metadata: null,
    prevHash: GENESIS_HASH,
    hash: null,
    createdAt: new Date('2026-07-01T12:00:00.000Z'),
    tenantId: null,
    ticketId: null,
    conversationId: null,
    ...overrides,
  } as AuditLog
}

function hashFor(row: AuditLog, prevHash: string): string {
  return computeAuditHash({
    seq: row.seq,
    prevHash,
    actorType: row.actorType,
    actorId: row.actorId,
    action: row.action,
    targetType: row.targetType,
    targetId: row.targetId,
    createdAt: row.createdAt,
  })
}

function buildChain(n: number): AuditLog[] {
  const rows: AuditLog[] = []
  let prevHash = GENESIS_HASH
  for (let i = 1; i <= n; i++) {
    const row = makeRow({ seq: BigInt(i), prevHash, action: i % 2 === 0 ? 'tool.call' : 'model.call' })
    row.hash = hashFor(row, prevHash)
    rows.push(row)
    prevHash = row.hash
  }
  return rows
}

class FakeAuditRepository implements AuditRepository {
  constructor(private rows: AuditLog[]) {}
  async append(): Promise<AuditLog> {
    throw new Error('not used in this test')
  }
  async findMany(): Promise<AuditLog[]> {
    return this.rows
  }
  async findAll(range?: { fromSeq?: bigint; toSeq?: bigint }): Promise<AuditLog[]> {
    return this.rows.filter(
      (r) => (range?.fromSeq === undefined || r.seq >= range.fromSeq) && (range?.toSeq === undefined || r.seq <= range.toSeq),
    )
  }
  async getActionCounts(): Promise<Record<string, number>> {
    return {}
  }
}

async function main() {
  await checkAsync('verifyChain: teljes lánc zöld', async () => {
    const svc = new AuditChainService(new FakeAuditRepository(buildChain(10)))
    const result = await svc.verifyChain()
    assert.equal(result.ok, true)
    if (result.ok) assert.equal(result.checked, 10)
  })

  await checkAsync('verifyChain: manipulált sor pirosra fut (tamper-detekció, N-teszt)', async () => {
    // A hash-formula jelenleg a seq/prevHash/actorType/actorId/action/targetType/targetId/
    // createdAt mezőket fedi (lásd computeAuditHash) — a targetId módosítása ezért
    // ténylegesen megváltoztatja a várt hash-t, a metadata-módosítás NEM (lásd külön
    // "metadata nincs hash-fedve" teszt lejjebb — ismert, dokumentált rés).
    const rows = buildChain(10)
    rows[4] = { ...rows[4], targetId: crypto.randomUUID() }
    const svc = new AuditChainService(new FakeAuditRepository(rows))
    const result = await svc.verifyChain()
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.firstBreakSeq, '5')
  })

  await checkAsync('verifyChain: metadata NINCS hash-fedve (ismert, dokumentált rés)', async () => {
    // Ez a teszt SZÁNDÉKOSAN dokumentálja a jelenlegi implementáció korlátját: a
    // spec §2/5 szerint a teljes payloadnak hash-fedettnek kellene lennie, de a
    // computeAuditHash (src/lib/crypto/hash-chain.ts) a metadata/modelUsed/inputRef/
    // outputRef/policyDecision/agentVersion mezőket NEM veszi bele — a metadata
    // közvetlen módosítása ezért nem buktatja meg a verifyChain-t. A formula bővítése
    // csak egy teljes lánc-rehash migrációval biztonságos (lásd feljegyzés a PR-ben).
    const rows = buildChain(10)
    rows[4] = { ...rows[4], metadata: { tampered: true } }
    const svc = new AuditChainService(new FakeAuditRepository(rows))
    const result = await svc.verifyChain()
    assert.equal(result.ok, true)
  })

  await checkAsync('verifyChain: szegmens [4..7] zöld, ha a lánc konzisztens', async () => {
    const svc = new AuditChainService(new FakeAuditRepository(buildChain(10)))
    const result = await svc.verifyChain(BigInt(4), BigInt(7))
    assert.equal(result.ok, true)
    if (result.ok) assert.equal(result.checked, 4)
  })

  await checkAsync('verifyChain: szegmens is jelzi a belső tampert', async () => {
    const rows = buildChain(10)
    rows[5] = { ...rows[5], targetId: crypto.randomUUID() }
    const svc = new AuditChainService(new FakeAuditRepository(rows))
    const result = await svc.verifyChain(BigInt(4), BigInt(8))
    assert.equal(result.ok, false)
  })

  console.log(failed === 0 ? `\nMinden teszt zöld (${passed}).` : `\n${failed} teszt bukott (${passed} zöld).`)
  if (failed > 0) process.exit(1)
}

main()
