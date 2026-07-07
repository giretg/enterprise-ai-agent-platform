/**
 * Audit Log & Observability — DB nélküli, tiszta logikai tesztek (Feature-spec §9).
 * Futtatás: npm run test:audit-log
 */
import assert from 'node:assert/strict'
import type { AuditLog } from '@prisma/client'
import { assertAuditMetadataSafe, UnsafeAuditPayloadError } from '../src/lib/audit/payload-guard'
import { assertAuditActionRegistered, UnregisteredAuditActionError } from '../src/lib/audit/event-catalog'
import { deriveAuditAttribution } from '../src/lib/audit/attribution'
import { computeAuditHash, computeAuditHashV2, GENESIS_HASH } from '../src/lib/crypto/hash-chain'
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

function hashForV2(row: AuditLog, prevHash: string): string {
  return computeAuditHashV2({
    seq: row.seq,
    prevHash,
    actorType: row.actorType,
    actorId: row.actorId,
    agentVersion: row.agentVersion,
    action: row.action,
    targetType: row.targetType,
    targetId: row.targetId,
    modelUsed: row.modelUsed,
    inputRef: row.inputRef,
    outputRef: row.outputRef,
    policyDecision: row.policyDecision,
    metadata: row.metadata,
    tenantId: row.tenantId,
    ticketId: row.ticketId,
    conversationId: row.conversationId,
    createdAt: row.createdAt,
  })
}

/** Legacy (v1) lánc — a formula csak a sor "vázát" fedi; visszamenőleg ellenőrizhető. */
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

/** v2 lánc — teljes soronkénti fedés (policyDecision/metadata/ref-ek/attribúció is). */
function buildChainV2(n: number): AuditLog[] {
  const rows: AuditLog[] = []
  let prevHash = GENESIS_HASH
  for (let i = 1; i <= n; i++) {
    const row = makeRow({
      seq: BigInt(i),
      prevHash,
      action: i % 2 === 0 ? 'tool.call' : 'model.call',
      policyDecision: i % 2 === 0 ? 'allow' : null,
      outputRef: `vault://out/${i}`,
      metadata: { step: i, note: `evidence-${i}` },
    })
    row.hash = hashForV2(row, prevHash)
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

  await checkAsync('verifyChain: manipulált váz-mező pirosra fut (v1 legacy, tamper-detekció)', async () => {
    // A v1 (legacy) formula a seq/prevHash/actorType/actorId/action/targetType/targetId/
    // createdAt mezőket fedi — a targetId módosítása ezért megváltoztatja a várt hash-t.
    const rows = buildChain(10)
    rows[4] = { ...rows[4], targetId: crypto.randomUUID() }
    const svc = new AuditChainService(new FakeAuditRepository(rows))
    const result = await svc.verifyChain()
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.firstBreakSeq, '5')
  })

  await checkAsync('verifyChain: v2 teljes lánc zöld', async () => {
    const svc = new AuditChainService(new FakeAuditRepository(buildChainV2(10)))
    const result = await svc.verifyChain()
    assert.equal(result.ok, true)
    if (result.ok) assert.equal(result.checked, 10)
  })

  await checkAsync('verifyChain: v2 — metadata módosítás TAMPER-t jelez (a rés lezárva)', async () => {
    // A korábbi ismert rés: a metadata nem volt hash-fedve. A v2 formula a metaadatot is
    // fedi, így a payload-bizonyíték módosítása megbuktatja a láncot.
    const rows = buildChainV2(10)
    rows[4] = { ...rows[4], metadata: { tampered: true } }
    const svc = new AuditChainService(new FakeAuditRepository(rows))
    const result = await svc.verifyChain()
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.firstBreakSeq, '5')
  })

  await checkAsync('verifyChain: v2 — policyDecision flip (deny→allow) TAMPER-t jelez', async () => {
    // A legkritikusabb eset: a governance-döntés utólagos átírása. v1-ben ez láthatatlan
    // maradt (policyDecision nem volt fedve); v2-ben a lánc megtörik.
    const rows = buildChainV2(10)
    rows[6] = { ...rows[6], policyDecision: 'allow' }
    const svc = new AuditChainService(new FakeAuditRepository(rows))
    const result = await svc.verifyChain()
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.firstBreakSeq, '7')
  })

  await checkAsync('verifyChain: v2 — output_ref (payload-mutató) átírása TAMPER-t jelez', async () => {
    const rows = buildChainV2(10)
    rows[2] = { ...rows[2], outputRef: 'vault://out/hamis' }
    const svc = new AuditChainService(new FakeAuditRepository(rows))
    const result = await svc.verifyChain()
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.firstBreakSeq, '3')
  })

  await checkAsync('verifyChain: vegyes v1+v2 lánc zöld (visszafelé kompatibilitás)', async () => {
    // Migráció közbeni valós állapot: régi v1 sorok, majd új v2 sorok ugyanabban a láncban.
    const rows: AuditLog[] = []
    let prevHash = GENESIS_HASH
    for (let i = 1; i <= 3; i++) {
      const row = makeRow({ seq: BigInt(i), prevHash, action: 'model.call' })
      row.hash = hashFor(row, prevHash)
      rows.push(row)
      prevHash = row.hash
    }
    for (let i = 4; i <= 6; i++) {
      const row = makeRow({
        seq: BigInt(i),
        prevHash,
        action: 'tool.call',
        policyDecision: 'deny',
        metadata: { step: i },
      })
      row.hash = hashForV2(row, prevHash)
      rows.push(row)
      prevHash = row.hash
    }
    const svc = new AuditChainService(new FakeAuditRepository(rows))
    const result = await svc.verifyChain()
    assert.equal(result.ok, true)
    if (result.ok) assert.equal(result.checked, 6)
  })

  await checkAsync('verifyChain: vegyes lánc — v2 sor metadata-tampere nem bújik el v1 formulával', async () => {
    // Kulcs-invariáns: egy v2 sort NEM lehet a v1 formulával (ami a metadatát figyelmen
    // kívül hagyja) átverni — a "2:" előfej rögzíti a verziót.
    const rows: AuditLog[] = []
    let prevHash = GENESIS_HASH
    for (let i = 1; i <= 2; i++) {
      const row = makeRow({ seq: BigInt(i), prevHash, action: 'model.call' })
      row.hash = hashFor(row, prevHash)
      rows.push(row)
      prevHash = row.hash
    }
    const v2row = makeRow({ seq: BigInt(3), prevHash, action: 'tool.call', metadata: { ok: true } })
    v2row.hash = hashForV2(v2row, prevHash)
    rows.push({ ...v2row, metadata: { tampered: true } })
    const svc = new AuditChainService(new FakeAuditRepository(rows))
    const result = await svc.verifyChain()
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.firstBreakSeq, '3')
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
