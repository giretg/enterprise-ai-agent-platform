/**
 * Audit Log — DB nélküli, tiszta logikai tesztek (Phase F restore).
 * Futtatás: npm run test:audit-log
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { AuditLog } from '@prisma/client'
import { assertAuditMetadataSafe, UnsafeAuditPayloadError } from '../src/lib/audit/payload-guard'
import {
  assertAuditActionRegistered,
  CORE_MVP_AUDIT_ACTIONS,
  REGISTERED_AUDIT_ACTIONS,
  UnregisteredAuditActionError,
} from '../src/lib/audit/event-catalog'
import { deriveAuditAttribution } from '../src/lib/audit/attribution'
import { computeAuditHash, computeAuditHashV2, GENESIS_HASH } from '../src/lib/crypto/hash-chain'
import { AuditChainService } from '../src/domain/audit/audit-chain-service'
import type { AuditAppendInput, AuditRepository } from '../src/repositories/interfaces'

const APPEND_ACTION_RE = /audit\.append\(\{[\s\S]*?\baction: '([^']+)'/g
const WRITE_AUDIT_ACTION_RE = /writeAudit\([^,]+,\s*\{[\s\S]*?\baction: '([^']+)'/g
const THIS_APPEND_ACTION_RE = /this\.append\(\{[\s\S]*?\baction: '([^']+)'/g

function collectSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return collectSourceFiles(full)
    return /\.tsx?$/.test(entry.name) ? [full] : []
  })
}

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

check('assertAuditMetadataSafe: nyers "token" kulcs elutasítva', () => {
  assert.throws(() => assertAuditMetadataSafe({ token: 'ya29.secret' }), UnsafeAuditPayloadError)
})

check('assertAuditMetadataSafe: nyers "secret" kulcs elutasítva (nested)', () => {
  assert.throws(
    () => assertAuditMetadataSafe({ outer: { secret: 'sk-live-xxx' } }),
    UnsafeAuditPayloadError,
  )
})

check('assertAuditMetadataSafe: nyers emberi indoklás elutasítva', () => {
  assert.throws(() => assertAuditMetadataSafe({ reason: 'ügyfél adatot tartalmaz' }), UnsafeAuditPayloadError)
})

check('assertAuditMetadataSafe: tokenRef kulcs elutasítva', () => {
  assert.throws(() => assertAuditMetadataSafe({ tokenRef: 'stub-drive-token' }), UnsafeAuditPayloadError)
})

check('assertAuditMetadataSafe: ref/hash/alias formájú kulcsok NEM tiltottak', () => {
  assertAuditMetadataSafe({ secretAlias: 'vault:abc', contentHash: 'sha256:...', tokenHash: 'sha256:...' })
})

check('assertAuditMetadataSafe: túl hosszú nyers string elutasítva', () => {
  assert.throws(() => assertAuditMetadataSafe('x'.repeat(5000)), UnsafeAuditPayloadError)
})

check('assertAuditActionRegistered: Core MVP típus átmegy', () => {
  assertAuditActionRegistered('mcp.auth.ok')
  assertAuditActionRegistered('gateway.operation.enqueued')
})

check('assertAuditActionRegistered: ismeretlen típus elutasítva', () => {
  assert.throws(() => assertAuditActionRegistered('made.up.action'), UnregisteredAuditActionError)
})

check('required MCP/tool/operation action names are registered', () => {
  for (const action of CORE_MVP_AUDIT_ACTIONS) {
    assert.ok(REGISTERED_AUDIT_ACTIONS.has(action), action)
  }
})

const FLOAT_FIXTURE = {
  seq: BigInt(42),
  prevHash: '2:aaaa',
  actorType: 'agent' as const,
  actorId: 'a1',
  agentVersion: 1,
  action: 'mcp.auth.ok',
  targetType: 'tenant',
  targetId: 't1',
  modelUsed: null,
  inputRef: null,
  outputRef: null,
  policyDecision: 'allowed',
  tenantId: 'tn',
  ticketId: null,
  conversationId: null,
  createdAt: new Date('2026-07-09T08:47:00.083Z'),
}

check('v2 hash: a 17-jegyű double ugyanazt adja, mint a DB-be ténylegesen kerülő 16-jegyű', () => {
  const inMemory = 0.13781565621305947
  const asStored = 0.1378156562130595
  assert.notEqual(inMemory, asStored, 'a fixtúra értelmét veszti, ha ez a két érték egyenlő')
  assert.equal(
    computeAuditHashV2({ ...FLOAT_FIXTURE, metadata: { scores: { c1: inMemory } } }),
    computeAuditHashV2({ ...FLOAT_FIXTURE, metadata: { scores: { c1: asStored } } }),
  )
})

check('computeAuditHashV2 formula file is unchanged', () => {
  const src = readFileSync(path.join(__dirname, '..', 'src/lib/crypto/hash-chain.ts'))
  assert.equal(
    createHash('sha256').update(src).digest('hex'),
    '71d708cbddc738225fb20d7b0bb2e4cc5f48f08cd670b7a282dd920e23299007',
  )
})

check('v2 hash: ticketId/conversationId üres stringként hash-elődik', () => {
  const a = computeAuditHashV2({ ...FLOAT_FIXTURE, ticketId: null, conversationId: null, metadata: null })
  const b = computeAuditHashV2({ ...FLOAT_FIXTURE, ticketId: '', conversationId: '', metadata: null })
  assert.equal(a, b)
})

check('deriveAuditAttribution: tenantId explicit vagy metadata-ból', () => {
  const explicit = deriveAuditAttribution({
    targetType: 'mcp',
    targetId: null,
    tenantId: 'aaaaaaaa-bbbb-4000-8000-000000000001',
    metadata: null,
  })
  assert.equal(explicit.tenantId, 'aaaaaaaa-bbbb-4000-8000-000000000001')
  const fromMeta = deriveAuditAttribution({
    targetType: 'mcp',
    targetId: null,
    metadata: { tenantId: 'aaaaaaaa-bbbb-4000-8000-000000000002' },
  })
  assert.equal(fromMeta.tenantId, 'aaaaaaaa-bbbb-4000-8000-000000000002')
})

function makeRow(overrides: Partial<AuditLog> = {}): AuditLog {
  return {
    id: crypto.randomUUID(),
    seq: BigInt(1),
    actorType: 'human',
    actorId: null,
    agentVersion: null,
    action: 'mcp.auth.ok',
    targetType: 'tenant',
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
    ticketId: null,
    conversationId: null,
    createdAt: row.createdAt,
  })
}

function buildChain(n: number): AuditLog[] {
  const rows: AuditLog[] = []
  let prevHash = GENESIS_HASH
  for (let i = 1; i <= n; i++) {
    const row = makeRow({ seq: BigInt(i), prevHash, action: i % 2 === 0 ? 'mcp.tools.call' : 'mcp.auth.ok' })
    row.hash = hashFor(row, prevHash)
    rows.push(row)
    prevHash = row.hash
  }
  return rows
}

function buildChainV2(n: number): AuditLog[] {
  const rows: AuditLog[] = []
  let prevHash = GENESIS_HASH
  for (let i = 1; i <= n; i++) {
    const row = makeRow({
      seq: BigInt(i),
      prevHash,
      action: i % 2 === 0 ? 'enterprise.tool.ok' : 'mcp.auth.ok',
      policyDecision: i % 2 === 0 ? 'allowed' : null,
      metadata: { step: i },
    })
    row.hash = hashForV2(row, prevHash)
    rows.push(row)
    prevHash = row.hash
  }
  return rows
}

class FakeAuditRepository implements AuditRepository {
  lastFindAllFilter: { fromSeq?: bigint; toSeq?: bigint; tenantId?: string; since?: Date } | undefined
  constructor(private rows: AuditLog[]) {}
  async append(): Promise<AuditLog> {
    throw new Error('not used in this test')
  }
  async findMany(): Promise<AuditLog[]> {
    return this.rows
  }
  async findAll(filter?: {
    fromSeq?: bigint
    toSeq?: bigint
    tenantId?: string
    since?: Date
  }): Promise<AuditLog[]> {
    this.lastFindAllFilter = filter
    return this.rows.filter(
      (r) =>
        (filter?.fromSeq === undefined || r.seq >= filter.fromSeq) &&
        (filter?.toSeq === undefined || r.seq <= filter.toSeq) &&
        (filter?.tenantId === undefined || r.tenantId === filter.tenantId) &&
        (filter?.since === undefined || r.createdAt >= filter.since),
    )
  }
  async listHashChain(filter?: { fromSeq?: bigint; toSeq?: bigint }) {
    return this.rows
      .filter(
        (r) =>
          (filter?.fromSeq === undefined || r.seq >= filter.fromSeq) &&
          (filter?.toSeq === undefined || r.seq <= filter.toSeq),
      )
      .map((r) => ({ seq: r.seq, hash: r.hash }))
  }
  async getActionCounts(): Promise<Record<string, number>> {
    return {}
  }
}

class MemoryChainedAudit implements AuditRepository {
  rows: AuditLog[] = []
  private seq = 0n
  private queue: Promise<void> = Promise.resolve()

  async append(data: AuditAppendInput): Promise<AuditLog> {
    let created!: AuditLog
    this.queue = this.queue.then(async () => {
      this.seq += 1n
      const prevHash = this.rows.at(-1)?.hash ?? GENESIS_HASH
      const createdAt = new Date()
      const row = makeRow({
        seq: this.seq,
        prevHash,
        actorType: data.actorType,
        actorId: data.actorId ?? null,
        agentVersion: data.agentVersion ?? null,
        action: data.action,
        targetType: data.targetType,
        targetId: data.targetId ?? null,
        modelUsed: data.modelUsed ?? null,
        inputRef: data.inputRef ?? null,
        outputRef: data.outputRef ?? null,
        policyDecision: data.policyDecision ?? null,
        metadata: (data.metadata ?? null) as AuditLog['metadata'],
        tenantId: data.tenantId ?? null,
        createdAt,
      })
      row.hash = hashForV2(row, prevHash)
      this.rows.push(row)
      created = row
    })
    await this.queue
    return created
  }

  async findMany(): Promise<AuditLog[]> {
    return [...this.rows].reverse()
  }
  async findAll(): Promise<AuditLog[]> {
    return [...this.rows]
  }
  async listHashChain() {
    return this.rows.map((r) => ({ seq: r.seq, hash: r.hash }))
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

  await checkAsync('verifyChain: manipulált váz-mező pirosra fut (v1)', async () => {
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

  await checkAsync('verifyChain: v2 metadata módosítás TAMPER', async () => {
    const rows = buildChainV2(10)
    rows[4] = { ...rows[4], metadata: { tampered: true } }
    const svc = new AuditChainService(new FakeAuditRepository(rows))
    const result = await svc.verifyChain()
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.firstBreakSeq, '5')
  })

  await checkAsync('verifyChain: tenant filter only returns that tenant', async () => {
    const tenantA = 'aaaaaaaa-bbbb-4000-8000-000000000001'
    const tenantB = 'bbbbbbbb-cccc-4000-8000-000000000002'
    const rows = buildChainV2(2)
    rows[0] = { ...rows[0], tenantId: tenantA }
    rows[1] = { ...rows[1], tenantId: tenantB }
    const audit = new FakeAuditRepository(rows)
    const svc = new AuditChainService(audit)
    const jsonLines = await svc.exportJsonLines({ tenantId: tenantA })
    assert.deepEqual(audit.lastFindAllFilter, { tenantId: tenantA })
    assert.equal(jsonLines.includes(tenantB), false)
    assert.equal(jsonLines.includes(tenantA), true)
  })

  await checkAsync('verifyChain: tenant walk follows global predecessor hash', async () => {
    const tenantA = 'aaaaaaaa-bbbb-4000-8000-000000000001'
    const tenantB = 'bbbbbbbb-cccc-4000-8000-000000000002'
    const rows: AuditLog[] = []
    let prevHash = GENESIS_HASH
    const tenants = [tenantA, tenantB, tenantA]
    for (let i = 0; i < tenants.length; i++) {
      const row = makeRow({
        seq: BigInt(i + 1),
        prevHash,
        action: 'mcp.auth.ok',
        tenantId: tenants[i],
        metadata: { step: i + 1 },
      })
      row.hash = hashForV2(row, prevHash)
      rows.push(row)
      prevHash = row.hash
    }
    const svc = new AuditChainService(new FakeAuditRepository(rows))
    const result = await svc.verifyChain(undefined, undefined, tenantA)
    assert.equal(result.ok, true)
    if (result.ok) assert.equal(result.checked, 2)
  })

  await checkAsync('verifyChain: tenant walk fails when a global insert breaks prevHash', async () => {
    const tenantA = 'aaaaaaaa-bbbb-4000-8000-000000000001'
    const rows: AuditLog[] = []
    let prevHash = GENESIS_HASH
    for (let i = 1; i <= 2; i++) {
      const row = makeRow({
        seq: BigInt(i),
        prevHash,
        action: 'mcp.auth.ok',
        tenantId: tenantA,
      })
      row.hash = hashForV2(row, prevHash)
      rows.push(row)
      prevHash = row.hash
    }
    const forged = makeRow({
      seq: BigInt(3),
      prevHash: GENESIS_HASH,
      action: 'mcp.auth.ok',
      tenantId: tenantA,
    })
    forged.hash = hashForV2(forged, GENESIS_HASH)
    rows.push(forged)
    const svc = new AuditChainService(new FakeAuditRepository(rows))
    const result = await svc.verifyChain(undefined, undefined, tenantA)
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.firstBreakSeq, '3')
  })

  await checkAsync('concurrent appends still verify', async () => {
    const repo = new MemoryChainedAudit()
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        repo.append({
          actorType: 'human',
          actorId: null,
          agentVersion: null,
          action: 'mcp.auth.ok',
          targetType: 'tenant',
          targetId: null,
          modelUsed: null,
          inputRef: String(i),
          outputRef: null,
          policyDecision: 'allowed',
          metadata: { i },
          tenantId: 'aaaaaaaa-bbbb-4000-8000-000000000001',
        }),
      ),
    )
    const svc = new AuditChainService(repo)
    const result = await svc.verifyChain()
    assert.equal(result.ok, true)
    if (result.ok) assert.equal(result.checked, 20)
  })

  check('0004 migration installs append-only UPDATE/DELETE trigger', () => {
    const sqlPath = path.join(__dirname, '..', 'prisma', 'migrations', '0004_audit_log', 'migration.sql')
    assert.equal(existsSync(sqlPath), true)
    const sql = readFileSync(sqlPath, 'utf8')
    assert.match(sql, /CREATE TABLE "audit_log"/)
    assert.match(sql, /audit_log_deny_mutation/)
    assert.match(sql, /CREATE UNIQUE INDEX "audit_log_seq_key"/)
    assert.match(sql, /ON DELETE RESTRICT/)
    assert.doesNotMatch(sql, /ON DELETE SET NULL/)
  })

  check('audit control plane: lista és SIEM export az aktív tenanttal szűr', () => {
    const source = readFileSync(path.join(__dirname, '..', 'src', 'app', 'actions', 'audit.ts'), 'utf8')
    assert.match(source, /requireTenantRole\('approver'\)/)
    assert.match(source, /tenantId: user\.activeTenantId/)
    assert.match(source, /exportJsonLines\(\{\s*tenantId: user\.activeTenantId/)
    const page = readFileSync(
      path.join(__dirname, '..', 'src', 'app', 'control-plane', 'audit', 'page.tsx'),
      'utf8',
    )
    assert.match(page, /requireTenantRole\('approver'\)/)
  })

  check('platform IAM audit trail strips BigInt seq before the client panel', () => {
    const source = readFileSync(path.join(__dirname, '..', 'src', 'app', 'actions', 'tenant.ts'), 'utf8')
    assert.match(source, /createdAt: entry\.createdAt\.toISOString\(\)/)
    assert.doesNotMatch(source, /return ok\(entries\)/)
  })

  check('event-catalog: minden audit.append/writeAudit action-literál szerepel a katalógusban', () => {
    const unregistered: string[] = []
    for (const file of collectSourceFiles(path.join(__dirname, '..', 'src'))) {
      const source = readFileSync(file, 'utf8')
      for (const re of [APPEND_ACTION_RE, WRITE_AUDIT_ACTION_RE, THIS_APPEND_ACTION_RE]) {
        re.lastIndex = 0
        for (const [, action] of source.matchAll(re)) {
          if (!REGISTERED_AUDIT_ACTIONS.has(action)) {
            unregistered.push(`${path.relative(path.join(__dirname, '..'), file)}: '${action}'`)
          }
        }
      }
    }
    assert.deepEqual(unregistered, [])
  })

  const AUDIT_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[4-9a-f][0-9a-f]{3}-[0-9a-f]{12}$/i
  const TARGET_ID_LITERAL_RE = /\btargetId:\s*'([^']*)'/g

  check('audit.append targetId literál UUID', () => {
    const bad: string[] = []
    for (const file of collectSourceFiles(path.join(__dirname, '..', 'src'))) {
      const rel = path.relative(path.join(__dirname, '..'), file)
      const source = readFileSync(file, 'utf8')
      TARGET_ID_LITERAL_RE.lastIndex = 0
      for (const [, value] of source.matchAll(TARGET_ID_LITERAL_RE)) {
        if (value !== '' && !AUDIT_UUID_RE.test(value)) {
          bad.push(`${rel}: '${value}'`)
        }
      }
    }
    assert.deepEqual(bad, [])
  })

  console.log(failed === 0 ? `\nMinden teszt zöld (${passed}).` : `\n${failed} teszt bukott (${passed} zöld).`)
  if (failed > 0) process.exit(1)
}

main()
