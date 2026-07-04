/**
 * Determinisztikus teszt a Sandbox verziózás / promóció / graduation feature-höz
 * (Feature-spec — SandboxVersioning-Graduation §11). Futtatás: npm run test:sandbox-versioning
 *
 * DB és élő hálózat NÉLKÜL igazolja a §11.1 funkcionális kritériumokat (SV1–SV10)
 * és a §11.2 kötelező negatív teszteket (N1–N11). A kód-fa és adat-snapshot store a
 * process-global stub (SANDBOX_VERSIONING_STUB=true); a repository és az audit fake.
 */
process.env.SANDBOX_VERSIONING_STUB = 'true'

import assert from 'node:assert/strict'
import type {
  AuditLog,
  SandboxCommit,
  SandboxDataSnapshot,
  SandboxExport,
  SandboxProject,
  SandboxPromotion,
} from '@prisma/client'
import type {
  AuditRepository,
  CreateSandboxCommitInput,
  CreateSandboxExportInput,
  CreateSandboxProjectInput,
  CreateSandboxPromotionInput,
  CreateSandboxSnapshotInput,
  SandboxProjectPointers,
  SandboxVersioningRepository,
} from '../src/repositories/interfaces'
import {
  SandboxVersioningService,
  type SandboxActor,
} from '../src/domain/sandbox-versioning/sandbox-versioning-service'
import { GcsCodeTreeStore, GcsDataSnapshotStore } from '../src/domain/sandbox-versioning/stores'
import { SandboxVersionError } from '../src/domain/sandbox-versioning/errors'
import { assertAuditActionRegistered } from '../src/lib/audit/event-catalog'
import { assertAuditMetadataSafe } from '../src/lib/audit/payload-guard'
import { evaluateGraduationReadiness } from '../src/lib/sandbox-portability'

let failures = 0
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    console.log(`  ✅ ${name}`)
  } catch (e) {
    failures++
    console.log(`  ❌ ${name}: ${e instanceof Error ? e.message : String(e)}`)
  }
}

async function expectError(code: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn()
  } catch (e) {
    if (e instanceof SandboxVersionError) {
      assert.equal(e.code, code, `expected ${code}, got ${e.code}`)
      return
    }
    throw e
  }
  throw new Error(`expected SandboxVersionError(${code}), but no error thrown`)
}

// ── Fake-ek ───────────────────────────────────────────────────────────────────

class FakeAudit implements AuditRepository {
  events: AuditLog[] = []
  async append(data: Parameters<AuditRepository['append']>[0]): Promise<AuditLog> {
    // Production-parity: ismeretlen action és nyers tartalom fail-fast (SV8/SV10/N10).
    assertAuditActionRegistered(data.action)
    assertAuditMetadataSafe(data.metadata)
    const row = {
      ...data,
      id: `audit-${this.events.length + 1}`,
      seq: BigInt(this.events.length + 1),
      createdAt: new Date(),
      hash: null,
      prevHash: null,
      tenantId: (data as { tenantId?: string | null }).tenantId ?? null,
      ticketId: null,
      conversationId: null,
    } as unknown as AuditLog
    this.events.push(row)
    return row
  }
  async findMany(filter?: { action?: string | string[] }) {
    return this.events.filter((e) => !filter?.action || e.action === filter.action)
  }
  async findAll() {
    return this.events
  }
  async getActionCounts(): Promise<Record<string, number>> {
    const out: Record<string, number> = {}
    for (const e of this.events) out[e.action] = (out[e.action] ?? 0) + 1
    return out
  }
  byAction(action: string) {
    return this.events.filter((e) => e.action === action)
  }
}

class FakeRepo implements SandboxVersioningRepository {
  projects = new Map<string, SandboxProject>()
  commits: SandboxCommit[] = []
  promotions = new Map<string, SandboxPromotion>()
  snapshots = new Map<string, SandboxDataSnapshot>()
  exports = new Map<string, SandboxExport>()
  private n = 0
  private id(prefix: string) {
    return `${prefix}-${++this.n}`
  }

  async createProject(input: CreateSandboxProjectInput): Promise<SandboxProject> {
    const p = {
      id: this.id('proj'),
      tenantId: input.tenantId,
      sandboxId: input.sandboxId,
      name: input.name,
      description: input.description,
      testCommitId: null,
      liveCommitId: null,
      headCommitId: null,
      dataBinding: input.dataBinding ?? {},
      portability: input.portability ?? {},
      createdAt: new Date(),
      updatedAt: new Date(),
      archivedAt: null,
    } as unknown as SandboxProject
    this.projects.set(p.id, p)
    return p
  }
  async findProjectById(id: string) {
    return this.projects.get(id) ?? null
  }
  async findProjectByName(tenantId: string | null, sandboxId: string | null, name: string) {
    return (
      [...this.projects.values()].find(
        (p) => p.tenantId === tenantId && p.sandboxId === sandboxId && p.name === name,
      ) ?? null
    )
  }
  async listProjects(filter: { tenantId: string | null; sandboxId?: string; limit?: number }) {
    return [...this.projects.values()].filter(
      (p) => p.tenantId === filter.tenantId && !p.archivedAt,
    )
  }
  async updateProjectPointers(id: string, pointers: SandboxProjectPointers) {
    const p = this.projects.get(id)!
    if (pointers.testCommitId !== undefined) p.testCommitId = pointers.testCommitId
    if (pointers.liveCommitId !== undefined) p.liveCommitId = pointers.liveCommitId
    if (pointers.headCommitId !== undefined) p.headCommitId = pointers.headCommitId
    return p
  }
  async archiveProject(id: string) {
    const p = this.projects.get(id)!
    p.archivedAt = new Date()
    return p
  }

  async createCommit(input: CreateSandboxCommitInput): Promise<SandboxCommit> {
    const seq =
      Math.max(0, ...this.commits.filter((c) => c.projectId === input.projectId).map((c) => c.seq)) + 1
    const c = {
      id: this.id('commit'),
      tenantId: input.tenantId,
      projectId: input.projectId,
      seq,
      parentCommitId: input.parentCommitId,
      basedOnCommitId: input.basedOnCommitId,
      source: input.source,
      changeSummary: input.changeSummary,
      treeRef: input.treeRef,
      treeHash: input.treeHash,
      fileCount: input.fileCount,
      totalSizeBytes: BigInt(input.totalSizeBytes),
      createdByType: input.createdByType,
      createdByUserId: input.createdByUserId,
      createdByAgentId: input.createdByAgentId,
      createdFromTicketId: input.createdFromTicketId,
      createdFromRunId: input.createdFromRunId,
      buildCost: input.buildCost ?? {},
      createdAt: new Date(),
    } as unknown as SandboxCommit
    this.commits.push(c)
    return c
  }
  async findCommitById(id: string) {
    return this.commits.find((c) => c.id === id) ?? null
  }
  async findCommitByTreeHash(projectId: string, treeHash: string) {
    return this.commits.find((c) => c.projectId === projectId && c.treeHash === treeHash) ?? null
  }
  async listCommits(filter: { projectId: string; limit?: number; beforeSeq?: number }) {
    return this.commits
      .filter((c) => c.projectId === filter.projectId && (filter.beforeSeq === undefined || c.seq < filter.beforeSeq))
      .sort((a, b) => b.seq - a.seq)
      .slice(0, filter.limit ?? 50)
  }

  async createPromotion(input: CreateSandboxPromotionInput): Promise<SandboxPromotion> {
    const p = {
      id: this.id('promo'),
      tenantId: input.tenantId,
      projectId: input.projectId,
      fromCommitId: input.fromCommitId,
      prevLiveCommitId: input.prevLiveCommitId,
      prePromotionSnapshotId: null,
      status: 'pending_approval',
      requestedByType: input.requestedByType,
      requestedByUserId: input.requestedByUserId,
      requestedByAgentId: input.requestedByAgentId,
      approvedByUserId: null,
      reason: input.reason,
      requestedAt: new Date(),
      decidedAt: null,
      promotedAt: null,
    } as unknown as SandboxPromotion
    this.promotions.set(p.id, p)
    return p
  }
  async findPromotionById(id: string) {
    return this.promotions.get(id) ?? null
  }
  async listPromotions(filter: { projectId: string; status?: SandboxPromotion['status'] }) {
    return [...this.promotions.values()].filter(
      (p) => p.projectId === filter.projectId && (!filter.status || p.status === filter.status),
    )
  }
  async updatePromotion(id: string, data: Partial<SandboxPromotion>) {
    const p = this.promotions.get(id)!
    Object.assign(p, data)
    return p
  }

  async createSnapshot(input: CreateSandboxSnapshotInput): Promise<SandboxDataSnapshot> {
    const s = {
      id: this.id('snap'),
      tenantId: input.tenantId,
      projectId: input.projectId,
      env: input.env,
      kind: input.kind,
      status: input.status,
      snapshotRef: input.snapshotRef,
      schemaHash: input.schemaHash,
      rowCount: input.rowCount != null ? BigInt(input.rowCount) : null,
      sizeBytes: input.sizeBytes != null ? BigInt(input.sizeBytes) : null,
      createdByType: input.createdByType,
      createdByUserId: input.createdByUserId,
      linkedPromotionId: input.linkedPromotionId,
      createdAt: new Date(),
      expiresAt: input.expiresAt,
    } as unknown as SandboxDataSnapshot
    this.snapshots.set(s.id, s)
    return s
  }
  async findSnapshotById(id: string) {
    return this.snapshots.get(id) ?? null
  }
  async listSnapshots(filter: { projectId: string; env?: SandboxDataSnapshot['env'] }) {
    return [...this.snapshots.values()].filter(
      (s) => s.projectId === filter.projectId && (!filter.env || s.env === filter.env),
    )
  }
  async updateSnapshot(
    id: string,
    data: Partial<{
      status: SandboxDataSnapshot['status']
      snapshotRef: string
      schemaHash: string
      rowCount: number | null
      sizeBytes: number | null
    }>,
  ) {
    const s = this.snapshots.get(id)!
    if (data.status !== undefined) s.status = data.status
    if (data.snapshotRef !== undefined) s.snapshotRef = data.snapshotRef
    if (data.schemaHash !== undefined) s.schemaHash = data.schemaHash
    if (data.rowCount !== undefined) s.rowCount = data.rowCount != null ? BigInt(data.rowCount) : null
    if (data.sizeBytes !== undefined) s.sizeBytes = data.sizeBytes != null ? BigInt(data.sizeBytes) : null
    return s
  }

  async createExport(input: CreateSandboxExportInput): Promise<SandboxExport> {
    const e = {
      id: this.id('exp'),
      tenantId: input.tenantId,
      projectId: input.projectId,
      scope: input.scope,
      sourceCommitId: input.sourceCommitId,
      sourceSnapshotId: input.sourceSnapshotId,
      status: 'requested',
      packageRef: null,
      packageHash: null,
      manifest: input.manifest ?? {},
      responsibilityTransferred: input.responsibilityTransferred,
      requestedByUserId: input.requestedByUserId,
      requestedAt: new Date(),
      completedAt: null,
    } as unknown as SandboxExport
    this.exports.set(e.id, e)
    return e
  }
  async findExportById(id: string) {
    return this.exports.get(id) ?? null
  }
  async listExports(filter: { projectId: string }) {
    return [...this.exports.values()].filter((e) => e.projectId === filter.projectId)
  }
  async updateExport(
    id: string,
    data: Partial<{
      status: SandboxExport['status']
      packageRef: string | null
      packageHash: string | null
      manifest: unknown
      completedAt: Date | null
    }>,
  ) {
    const e = this.exports.get(id)!
    Object.assign(e, data)
    return e
  }
}

// ── Harness ─────────────────────────────────────────────────────────────────

const TENANT = 'tenant-1'
const OTHER_TENANT = 'tenant-2'

function makeService() {
  const repo = new FakeRepo()
  const audit = new FakeAudit()
  const svc = new SandboxVersioningService(
    repo,
    new GcsCodeTreeStore('stub'),
    new GcsDataSnapshotStore('stub'),
    audit,
    async (ref) => (ref.startsWith('inline:') ? ref.slice('inline:'.length) : `content://${ref}`),
  )
  return { repo, audit, svc }
}

const operator: SandboxActor = { userId: 'user-op', tenantId: TENANT, role: 'operator' }
const admin: SandboxActor = { userId: 'user-admin', tenantId: TENANT, role: 'admin' }
const agent: SandboxActor = { agentId: 'agent-1', tenantId: TENANT, agentVersion: 3 }
const otherTenantOp: SandboxActor = { userId: 'user-x', tenantId: OTHER_TENANT, role: 'operator' }

function file(path: string, content: string) {
  return { path, contentRef: `inline:${content}` }
}

async function bootstrapProject(svc: SandboxVersioningService, actor = operator) {
  const { projectId } = await svc.createSandboxProject(
    { name: 'CRM modul', description: 'teszt', dataBinding: { stores: ['crm_rows'] } },
    actor,
  )
  return projectId
}

async function main() {
  console.log('Sandbox verziózás / promóció / graduation — feature teszt\n')

  // SV1: commit + determinisztikus tree_hash, csak a test fa mozdul
  await test('SV1: commit ad seq + determinisztikus tree_hash; csak test mozdul', async () => {
    const { svc, repo } = makeService()
    const projectId = await bootstrapProject(svc)
    const r1 = await svc.createSandboxCommit(
      { projectId, files: [file('app/crm.jsx', 'v1'), file('README.md', 'hello')], changeSummary: 'init' },
      operator,
    )
    assert.equal(r1.seq, 1)
    assert.match(r1.treeHash, /^sha256:[0-9a-f]{64}$/)
    const proj = await repo.findProjectById(projectId)
    assert.equal(proj!.testCommitId, r1.commitId)
    assert.equal(proj!.liveCommitId, null, 'live must not move on commit')

    // determinizmus: ugyanaz a fa egy másik projektben ugyanazt a hash-t adja
    const p2 = await bootstrapProject(svc)
    const r2 = await svc.createSandboxCommit(
      { projectId: p2, files: [file('README.md', 'hello'), file('app/crm.jsx', 'v1')], changeSummary: 'init2' },
      operator,
    )
    assert.equal(r2.treeHash, r1.treeHash, 'tree hash sorrend-független és determinisztikus')
  })

  // SV2: diff — szöveg sor-szint, bináris "changed"
  await test('SV2: diff szöveg sor-szintű, bináris binary_changed', async () => {
    const { svc } = makeService()
    const projectId = await bootstrapProject(svc)
    const c1 = await svc.createSandboxCommit(
      { projectId, files: [file('a.txt', 'egy\nketto'), file('bin.dat', 'AAA BBB')], changeSummary: 'c1' },
      operator,
    )
    const c2 = await svc.createSandboxCommit(
      { projectId, files: [file('a.txt', 'egy\nharom'), file('bin.dat', 'AAA CCC')], changeSummary: 'c2' },
      operator,
    )
    const { changedFiles } = await svc.diffSandboxCommits(
      { projectId, fromCommitId: c1.commitId, toCommitId: c2.commitId },
      operator,
    )
    const a = changedFiles.find((f) => f.path === 'a.txt')!
    assert.equal(a.changeType, 'modified')
    assert.ok(a.textDiff!.includes('- ketto') && a.textDiff!.includes('+ harom'))
    const bin = changedFiles.find((f) => f.path === 'bin.dat')!
    assert.equal(bin.changeType, 'binary_changed')
    assert.equal(bin.textDiff, undefined)
  })

  // SV3 / N9: rollback = új commit egy régi fára; history immutable; adat érintetlen
  await test('SV3/N9: rollback új commitot hoz létre régi fára, history immutable', async () => {
    const { svc, repo } = makeService()
    const projectId = await bootstrapProject(svc)
    const c1 = await svc.createSandboxCommit(
      { projectId, files: [file('a.txt', 'egy')], changeSummary: 'c1' },
      operator,
    )
    const c2 = await svc.createSandboxCommit(
      { projectId, files: [file('a.txt', 'ketto')], changeSummary: 'c2' },
      operator,
    )
    const before = repo.commits.length
    const rb = await svc.rollbackSandboxCode(
      { projectId, toCommitId: c1.commitId, reason: 'regresszió' },
      operator,
    )
    assert.equal(repo.commits.length, before + 1, 'rollback új commitot ad, nem töröl')
    const rbCommit = await repo.findCommitById(rb.commitId)
    assert.equal(rbCommit!.basedOnCommitId, c1.commitId)
    assert.equal(rbCommit!.treeHash, (await repo.findCommitById(c1.commitId))!.treeHash)
    // history megvan: c1 és c2 is
    assert.ok(await repo.findCommitById(c2.commitId))
    const proj = await repo.findProjectById(projectId)
    assert.equal(proj!.testCommitId, rb.commitId)
    assert.equal(proj!.liveCommitId, null, 'rollback nem érinti a live-ot')
  })

  // SV4: adat-snapshot készül és visszaállítható a kód-commit módosítása nélkül
  await test('SV4: data snapshot create + restore, kód érintetlen', async () => {
    const { svc, repo } = makeService()
    const projectId = await bootstrapProject(svc)
    const c1 = await svc.createSandboxCommit(
      { projectId, files: [file('a.txt', 'egy')], changeSummary: 'c1' },
      operator,
    )
    const snap = await svc.createDataSnapshot({ projectId, env: 'test', label: 'kézi' }, operator)
    assert.equal(snap.status, 'available')
    assert.match(snap.schemaHash, /^sha256:/)
    const headBefore = (await repo.findProjectById(projectId))!.headCommitId
    await svc.restoreDataSnapshot({ projectId, snapshotId: snap.snapshotId, targetEnv: 'test', reason: 'r' }, operator)
    const headAfter = (await repo.findProjectById(projectId))!.headCommitId
    assert.equal(headBefore, headAfter, 'restore nem változtat kódot')
    assert.equal(headAfter, c1.commitId)
  })

  // SV5 / SV6: promóció csak ember jóváhagyással; pre-promotion snapshot kötelező
  await test('SV5/SV6: promóció ember-jóváhagyással + kötelező pre-promotion live snapshot', async () => {
    const { svc, repo, audit } = makeService()
    const projectId = await bootstrapProject(svc)
    const c1 = await svc.createSandboxCommit(
      { projectId, files: [file('a.txt', 'egy')], changeSummary: 'c1' },
      operator,
    )
    const req = await svc.requestPromotion({ projectId, reason: 'élesítés' }, agent)
    assert.equal(req.status, 'pending_approval')
    const res = await svc.approvePromotion({ promotionId: req.promotionId, decision: 'approve' }, operator)
    assert.equal(res.status, 'promoted')
    assert.equal(res.liveCommitId, c1.commitId)
    const proj = await repo.findProjectById(projectId)
    assert.equal(proj!.liveCommitId, c1.commitId)
    // pre-promotion snapshot a live-ról jött létre
    const pre = [...repo.snapshots.values()].find((s) => s.kind === 'pre_promotion')
    assert.ok(pre, 'pre_promotion snapshot létrejött')
    assert.equal(pre!.env, 'live')
    const promo = await repo.findPromotionById(req.promotionId)
    assert.equal(promo!.approvedByUserId, 'user-op', 'jóváhagyó rögzül')
    assert.equal(promo!.prePromotionSnapshotId, pre!.id)
    assert.equal(audit.byAction('sandbox.promote.approve').length, 1)
  })

  // SV7: full export reprodukálható csomag + manifest hash-ekkel
  await test('SV7: full export reprodukálható package_hash + manifest hash-ek', async () => {
    const { svc, repo } = makeService()
    const projectId = await bootstrapProject(svc)
    await svc.createSandboxCommit({ projectId, files: [file('a.txt', 'egy')], changeSummary: 'c1' }, operator)
    const req = await svc.requestPromotion({ projectId }, operator)
    await svc.approvePromotion({ promotionId: req.promotionId, decision: 'approve' }, operator)
    const snap = await svc.createDataSnapshot({ projectId, env: 'live' }, operator)
    const exp = await svc.requestExport(
      { projectId, scope: 'full', sourceSnapshotId: snap.snapshotId },
      operator,
    )
    assert.equal(exp.status, 'ready')
    assert.match(exp.packageHash!, /^sha256:/)
    const got = await svc.getExport({ exportId: exp.exportId }, operator)
    const manifest = got.manifest as Record<string, unknown>
    assert.ok(manifest.treeHash, 'manifest tartalmaz tree_hash-t')
    assert.equal(manifest.schemaHash, snap.schemaHash)
    assert.equal(manifest.scope, 'full')
    // reprodukálhatóság: azonos forrásból azonos package_hash
    const exp2 = await svc.requestExport(
      { projectId, scope: 'full', sourceSnapshotId: snap.snapshotId },
      operator,
    )
    assert.equal(exp2.packageHash, exp.packageHash, 'ugyanaz a forrás → ugyanaz a checksum')
    assert.equal(repo.exports.size, 2)
  })

  // SV8 / SV10 / N10: minden művelet auditban, tartalom nélkül
  await test('SV8/SV10/N10: audit lefedi a műveleteket, tartalom nélkül', async () => {
    const { svc, audit } = makeService()
    const projectId = await bootstrapProject(svc)
    await svc.createSandboxCommit({ projectId, files: [file('a.txt', 'titkos üzleti adat')], changeSummary: 'c1' }, operator)
    const actions = new Set(audit.events.map((e) => e.action))
    assert.ok(actions.has('sandbox.commit'))
    // egyetlen audit metadata sem tartalmazza a nyers fájltartalmat
    for (const e of audit.events) {
      assert.ok(!JSON.stringify(e.metadata ?? {}).includes('titkos üzleti adat'), 'nyers tartalom nem szivárog auditba')
    }
  })

  // SV9: agent commitolhat és kérhet promóciót
  await test('SV9: agent commitolhat és kérhet promóciót', async () => {
    const { svc } = makeService()
    const projectId = await bootstrapProject(svc)
    const c = await svc.createSandboxCommit(
      { projectId, files: [file('a.txt', 'egy')], changeSummary: 'agent commit', createdFromTicketId: 'tk-1' },
      agent,
    )
    assert.equal(c.seq, 1)
    const req = await svc.requestPromotion({ projectId, reason: 'kész' }, agent)
    assert.equal(req.status, 'pending_approval')
  })

  // N1: cross-tenant hozzáférés
  await test('N1: más tenant projektje → SANDBOX_NOT_FOUND_OR_FORBIDDEN + access_denied', async () => {
    const { svc, audit } = makeService()
    const projectId = await bootstrapProject(svc)
    await expectError('SANDBOX_NOT_FOUND_OR_FORBIDDEN', () =>
      svc.getSandboxHistory({ projectId }, otherTenantOp),
    )
    assert.equal(audit.byAction('sandbox.access_denied').length, 1)
  })

  // N2: agent approvePromotion
  await test('N2: agent approvePromotion → TOOL_NOT_AUTHORIZED', async () => {
    const { svc } = makeService()
    const projectId = await bootstrapProject(svc)
    await svc.createSandboxCommit({ projectId, files: [file('a.txt', 'egy')], changeSummary: 'c' }, operator)
    const req = await svc.requestPromotion({ projectId }, operator)
    await expectError('TOOL_NOT_AUTHORIZED', () =>
      svc.approvePromotion({ promotionId: req.promotionId, decision: 'approve' }, agent),
    )
  })

  // N3: agent requestExport
  await test('N3: agent requestExport → TOOL_NOT_AUTHORIZED', async () => {
    const { svc } = makeService()
    const projectId = await bootstrapProject(svc)
    await svc.createSandboxCommit({ projectId, files: [file('a.txt', 'egy')], changeSummary: 'c' }, operator)
    await expectError('TOOL_NOT_AUTHORIZED', () =>
      svc.requestExport({ projectId, scope: 'code_only' }, agent),
    )
  })

  // N4: approvePromotion approved_by_user nélkül nem lehetséges (ember-only kikényszerítve)
  await test('N4: promóció nem lehet promoted jóváhagyó ember nélkül', async () => {
    const { svc, repo } = makeService()
    const projectId = await bootstrapProject(svc)
    await svc.createSandboxCommit({ projectId, files: [file('a.txt', 'egy')], changeSummary: 'c' }, operator)
    const req = await svc.requestPromotion({ projectId }, agent)
    // agent nem tud jóváhagyni → a promóció pending marad, live változatlan
    await expectError('TOOL_NOT_AUTHORIZED', () =>
      svc.approvePromotion({ promotionId: req.promotionId, decision: 'approve' }, agent),
    )
    const promo = await repo.findPromotionById(req.promotionId)
    assert.equal(promo!.status, 'pending_approval')
    assert.equal(promo!.approvedByUserId, null)
    assert.equal((await repo.findProjectById(projectId))!.liveCommitId, null)
  })

  // N5: pre-promotion snapshot meghiúsul → PROMOTION_FAILED_NO_SNAPSHOT, live változatlan
  await test('N5: pre-promotion snapshot hiba → PROMOTION_FAILED_NO_SNAPSHOT, live változatlan', async () => {
    const repo = new FakeRepo()
    const audit = new FakeAudit()
    // adat-store, ami a snapshotnál dob
    const failingDataStore = {
      async snapshot() {
        throw new Error('storage down')
      },
      async restore() {},
    }
    const svc = new SandboxVersioningService(
      repo,
      new GcsCodeTreeStore('stub'),
      failingDataStore,
      audit,
      async (ref) => ref.slice('inline:'.length),
    )
    const { projectId } = await svc.createSandboxProject({ name: 'proj-fail' }, operator)
    await svc.createSandboxCommit({ projectId, files: [file('a.txt', 'egy')], changeSummary: 'c' }, operator)
    const req = await svc.requestPromotion({ projectId }, operator)
    await expectError('PROMOTION_FAILED_NO_SNAPSHOT', () =>
      svc.approvePromotion({ promotionId: req.promotionId, decision: 'approve' }, operator),
    )
    assert.equal((await repo.findProjectById(projectId))!.liveCommitId, null, 'live nem változott')
    assert.equal((await repo.findPromotionById(req.promotionId))!.status, 'rejected')
  })

  // N6: kód-rollback után az élő adat érintetlen (kettős sín)
  await test('N6: kód-rollback után az élő adat változatlan (kettős sín)', async () => {
    const { svc, repo } = makeService()
    const projectId = await bootstrapProject(svc)
    const c1 = await svc.createSandboxCommit({ projectId, files: [file('a.txt', 'egy')], changeSummary: 'c1' }, operator)
    await svc.createSandboxCommit({ projectId, files: [file('a.txt', 'ketto')], changeSummary: 'c2' }, operator)
    const req = await svc.requestPromotion({ projectId }, operator)
    await svc.approvePromotion({ promotionId: req.promotionId, decision: 'approve' }, operator)
    const liveSnap = await svc.createDataSnapshot({ projectId, env: 'live' }, operator)
    const snapsBefore = repo.snapshots.size
    await svc.rollbackSandboxCode({ projectId, toCommitId: c1.commitId, reason: 'r' }, operator)
    // a rollback nem hozott létre és nem törölt adat-snapshotot
    assert.equal(repo.snapshots.size, snapsBefore, 'rollback nem nyúl az adat-sínhez')
    assert.ok(await repo.findSnapshotById(liveSnap.snapshotId), 'a live adat-snapshot megvan')
  })

  // N7: agent live-env snapshot/restore
  await test('N7: agent live snapshot/restore → TOOL_NOT_AUTHORIZED', async () => {
    const { svc } = makeService()
    const projectId = await bootstrapProject(svc)
    await svc.createSandboxCommit({ projectId, files: [file('a.txt', 'egy')], changeSummary: 'c' }, operator)
    await expectError('TOOL_NOT_AUTHORIZED', () => svc.createDataSnapshot({ projectId, env: 'live' }, agent))
    await expectError('TOOL_NOT_AUTHORIZED', () =>
      svc.restoreDataSnapshot({ projectId, snapshotId: 'x', targetEnv: 'live', reason: 'r' }, agent),
    )
    // de test env snapshotot csinálhat
    const ok = await svc.createDataSnapshot({ projectId, env: 'test' }, agent)
    assert.equal(ok.status, 'available')
  })

  // N8: full export sourceSnapshotId nélkül
  await test('N8: full export sourceSnapshotId nélkül → EXPORT_SNAPSHOT_REQUIRED', async () => {
    const { svc } = makeService()
    const projectId = await bootstrapProject(svc)
    await svc.createSandboxCommit({ projectId, files: [file('a.txt', 'egy')], changeSummary: 'c' }, operator)
    const req = await svc.requestPromotion({ projectId }, operator)
    await svc.approvePromotion({ promotionId: req.promotionId, decision: 'approve' }, operator)
    await expectError('EXPORT_SNAPSHOT_REQUIRED', () => svc.requestExport({ projectId, scope: 'full' }, operator))
  })

  // N11: sandbox-committal capability/RBAC bővítés — a commit nem érinti a jog-réteget
  await test('N11: commit nem érint capability/RBAC réteget (nincs jog-mellékhatás)', async () => {
    const { svc, audit } = makeService()
    const projectId = await bootstrapProject(svc)
    await svc.createSandboxCommit(
      { projectId, files: [file('policy/rbac.json', '{"grant":"admin"}')], changeSummary: 'bővítés kísérlet' },
      agent,
    )
    // a szolgáltatás CSAK sandbox.* auditot ír; nincs capability.update / user.role.* esemény
    for (const e of audit.events) {
      assert.ok(
        e.action.startsWith('sandbox.'),
        `commit nem válthat ki jogosultsági eseményt, kaptunk: ${e.action}`,
      )
    }
  })

  // Extra: responsibility transfer csak admin (§7.3)
  await test('Extra: responsibilityTransfer csak admin, operator → FORBIDDEN_ROLE', async () => {
    const { svc } = makeService()
    const projectId = await bootstrapProject(svc)
    await svc.createSandboxCommit({ projectId, files: [file('a.txt', 'egy')], changeSummary: 'c' }, operator)
    const req = await svc.requestPromotion({ projectId }, operator)
    await svc.approvePromotion({ promotionId: req.promotionId, decision: 'approve' }, operator)
    const snap = await svc.createDataSnapshot({ projectId, env: 'live' }, operator)
    await expectError('FORBIDDEN_ROLE', () =>
      svc.requestExport(
        { projectId, scope: 'full', sourceSnapshotId: snap.snapshotId, markResponsibilityTransfer: true },
        operator,
      ),
    )
    const ok = await svc.requestExport(
      { projectId, scope: 'full', sourceSnapshotId: snap.snapshotId, markResponsibilityTransfer: true },
      admin,
    )
    assert.equal(ok.status, 'ready')
  })

  // Extra: graduation-readiness kiértékelés (§7.2 / §9.1 UI-jelző)
  await test('Extra: graduation-readiness — üres → unassessed, minden pass → ready, egy fail → at_risk', async () => {
    const empty = evaluateGraduationReadiness({})
    assert.equal(empty.status, 'unassessed')
    assert.equal(empty.tone, 'neutral')

    const ready = evaluateGraduationReadiness({ noPlatformApi: true, schemaSelfContained: 'ok' })
    assert.equal(ready.status, 'ready')
    assert.equal(ready.tone, 'success')
    assert.equal(ready.passed, 2)

    const risk = evaluateGraduationReadiness({
      noPlatformApi: true,
      schemaSelfContained: { ok: false, label: 'Séma nem önálló DDL' },
    })
    assert.equal(risk.status, 'at_risk')
    assert.equal(risk.tone, 'warning')
    assert.equal(risk.failed, 1)
    assert.deepEqual(risk.failingChecks, ['Séma nem önálló DDL'])

    // nem-objektum / tömb input sem dob, unassessed
    assert.equal(evaluateGraduationReadiness(null).status, 'unassessed')
    assert.equal(evaluateGraduationReadiness([1, 2]).status, 'unassessed')
  })

  console.log(`\n${failures === 0 ? '✅ MIND ZÖLD' : `❌ ${failures} teszt bukott`}`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
