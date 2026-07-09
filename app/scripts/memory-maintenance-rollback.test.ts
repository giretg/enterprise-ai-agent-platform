/**
 * Tartós agent-memória — WP-8 `MemoryRollbackService` + `MemoryMaintenanceService`
 * regressziós teszt. In-memory fake repository-kkal fut (a
 * `memory-approval-service.test.ts` mintáját követve).
 *
 * Futtatás: npm run test:memory-maintenance-rollback
 */
import assert from 'node:assert/strict'
import type { Agent, MemoryCandidate, MemoryChunk, MemoryVersion } from '@prisma/client'
import { MemoryRollbackService } from '../src/domain/memory/memory-rollback-service'
import { MemoryMaintenanceService } from '../src/domain/memory/memory-maintenance-service'
import type {
  AgentRepository,
  AuditRepository,
  MemoryCandidateRepository,
  MemoryChunkRepository,
  MemoryVersionRepository,
} from '../src/repositories/interfaces'

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

const MEMORY_ID = 'mem-1'
const PROJECT_KEY = 'proj-1'
const ACTOR_ID = 'actor-1'

function chunk(overrides: Partial<MemoryChunk> & { id: string }): MemoryChunk {
  return {
    memoryId: MEMORY_ID,
    agentId: 'agent-1',
    tenantId: 'tenant-1',
    projectKey: PROJECT_KEY,
    workstreamKey: null,
    type: 'decision',
    path: 'p/1',
    title: 'T',
    section: null,
    text: 'text',
    summary: null,
    tags: [],
    metadata: null,
    status: 'active',
    salience: 0.5,
    confidence: 'normal',
    sourceRefs: null,
    evidence: null,
    approvedBy: null,
    approvedAt: null,
    reviewAfter: null,
    expiresAt: null,
    supersedes: null,
    supersededBy: null,
    retrievedCount: 0,
    usedInAnswerCount: 0,
    userConfirmedHelpfulCount: 0,
    userCorrectedCount: 0,
    lastRetrievedAt: null,
    lastUsedAt: null,
    lastValidatedAt: null,
    contentHash: 'hash',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as unknown as MemoryChunk
}

function makeChunkRepo(store: Map<string, MemoryChunk>): MemoryChunkRepository {
  return {
    searchActive: async () => [],
    listRecentActive: async (params) =>
      [...store.values()].filter(
        (c) =>
          c.memoryId === params.memoryId &&
          c.projectKey === params.projectKey &&
          c.status === 'active',
      ),
    findActiveFocus: async () => null,
    listActiveByType: async () => [],
    markRetrieved: async () => {},
    findById: async (id) => store.get(id) ?? null,
    create: async () => {
      throw new Error('not used in this test')
    },
    updateStatus: async (id, patch) => {
      const existing = store.get(id)
      if (!existing) throw new Error('chunk not found')
      const updated = { ...existing, ...patch } as MemoryChunk
      store.set(id, updated)
      return updated
    },
    listActiveIds: async (params) =>
      [...store.values()]
        .filter((c) => c.memoryId === params.memoryId && c.projectKey === params.projectKey && c.status === 'active')
        .map((c) => c.id),
    setStatusMany: async (ids, status) => {
      for (const id of ids) {
        const existing = store.get(id)
        if (existing) store.set(id, { ...existing, status } as MemoryChunk)
      }
    },
    findByContentHash: async () => null,
    demoteSalience: async (id, factor) => {
      const existing = store.get(id)
      if (!existing) throw new Error('chunk not found')
      const updated = { ...existing, salience: Math.max(existing.salience * factor, 0.05) } as MemoryChunk
      store.set(id, updated)
      return updated
    },
  }
}

function makeVersionRepo(store: Map<string, MemoryVersion>) {
  let seq = 0
  const repo: MemoryVersionRepository = {
    nextVersionNumber: async (memoryId) => {
      const existing = [...store.values()].filter((v) => v.memoryId === memoryId)
      return existing.length === 0 ? 1 : Math.max(...existing.map((v) => v.version)) + 1
    },
    create: async (data) => {
      const version = { id: `version-${++seq}`, createdAt: new Date(), ...data } as unknown as MemoryVersion
      store.set(version.id, version)
      return version
    },
    findLatestForScope: async (params) => {
      const rows = [...store.values()]
        .filter((v) => v.memoryId === params.memoryId && v.projectKey === params.projectKey)
        .sort((a, b) => b.version - a.version)
      return rows[0] ?? null
    },
    findByVersion: async (params) =>
      [...store.values()].find((v) => v.memoryId === params.memoryId && v.version === params.version) ?? null,
    listForScope: async (params) =>
      [...store.values()]
        .filter((v) => v.memoryId === params.memoryId && v.projectKey === params.projectKey)
        .sort((a, b) => b.version - a.version)
        .slice(0, params.limit),
  }
  return repo
}

function makeAudit(): { audit: AuditRepository; log: Array<Record<string, unknown>> } {
  const log: Array<Record<string, unknown>> = []
  const audit: AuditRepository = {
    append: async (entry: Record<string, unknown>) => {
      log.push(entry)
      return {} as Awaited<ReturnType<AuditRepository['append']>>
    },
  } as unknown as AuditRepository
  return { audit, log }
}

async function run() {
  await test('rollback: set-diff a cél manifest és a jelenlegi aktív halmaz között, új N+1 manifest', async () => {
    const chunkStore = new Map<string, MemoryChunk>()
    const versionStore = new Map<string, MemoryVersion>()
    chunkStore.set('a', chunk({ id: 'a', status: 'active' }))
    chunkStore.set('b', chunk({ id: 'b', status: 'archived' })) // N-kor aktív volt, azóta archiválták
    chunkStore.set('c', chunk({ id: 'c', status: 'active' })) // N után jött létre

    const chunks = makeChunkRepo(chunkStore)
    const versions = makeVersionRepo(versionStore)
    // N manifest: {a, b} volt aktív
    await versions.create({
      memoryId: MEMORY_ID,
      version: 1,
      projectKey: PROJECT_KEY,
      workstreamKey: null,
      activeChunkIds: ['a', 'b'],
      changeSet: { operation: 'create' },
      sourceCandidateIds: [],
      approvedById: ACTOR_ID,
    })
    const { audit, log } = makeAudit()
    const service = new MemoryRollbackService(chunks, versions, audit)

    const result = await service.rollback({
      memoryId: MEMORY_ID,
      projectKey: PROJECT_KEY,
      workstreamKey: null,
      toVersion: 1,
      actorId: ACTOR_ID,
      tenantId: 'tenant-1',
    })

    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.deepEqual(result.archivedChunkIds.sort(), ['c'])
    assert.deepEqual(result.restoredChunkIds.sort(), ['b'])
    assert.equal(chunkStore.get('b')!.status, 'active')
    assert.equal(chunkStore.get('c')!.status, 'archived')
    assert.equal(chunkStore.get('a')!.status, 'active') // változatlan

    assert.equal(result.newVersion, 2)
    const newManifest = [...versionStore.values()].find((v) => v.version === 2)!
    assert.deepEqual([...(newManifest.activeChunkIds as string[])].sort(), ['a', 'b'])
    // Az N manifest FIZIKAILAG változatlan (append-only).
    const n1 = await versions.findByVersion({ memoryId: MEMORY_ID, version: 1 })
    assert.deepEqual(n1!.activeChunkIds, ['a', 'b'])

    assert.ok(log.some((e) => e.action === 'memory.rollback'))
  })

  await test('rollback: ismeretlen verzió → ok:false', async () => {
    const chunks = makeChunkRepo(new Map())
    const versions = makeVersionRepo(new Map())
    const { audit } = makeAudit()
    const service = new MemoryRollbackService(chunks, versions, audit)
    const result = await service.rollback({
      memoryId: MEMORY_ID,
      projectKey: PROJECT_KEY,
      workstreamKey: null,
      toVersion: 99,
      actorId: ACTOR_ID,
      tenantId: null,
    })
    assert.equal(result.ok, false)
  })

  await test('maintenance: refresh_needed (lejárt reviewAfter), archive (alacsony salience+rég nem lekérdezett), demote (nettó negatív feedback) javaslatok', async () => {
    const chunkStore = new Map<string, MemoryChunk>()
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000)
    const veryOld = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
    chunkStore.set('refresh-me', chunk({ id: 'refresh-me', reviewAfter: past }))
    chunkStore.set(
      'archive-me',
      chunk({ id: 'archive-me', salience: 0.05, lastRetrievedAt: veryOld, createdAt: veryOld }),
    )
    chunkStore.set('demote-me', chunk({ id: 'demote-me', userCorrectedCount: 3, userConfirmedHelpfulCount: 1 }))
    chunkStore.set('fine', chunk({ id: 'fine', salience: 0.8 }))

    const chunks = makeChunkRepo(chunkStore)
    const candidateStore = new Map<string, MemoryCandidate>()
    let candSeq = 0
    const candidates: MemoryCandidateRepository = {
      create: async (data) => {
        const candidate = { id: `cand-${++candSeq}`, createdAt: new Date(), updatedAt: new Date(), ...data } as unknown as MemoryCandidate
        candidateStore.set(candidate.id, candidate)
        return candidate
      },
      findById: async (id) => candidateStore.get(id) ?? null,
      listByRun: async () => [],
      updateStatus: async (id, patch) => {
        const existing = candidateStore.get(id)!
        const updated = { ...existing, ...patch } as MemoryCandidate
        candidateStore.set(id, updated)
        return updated
      },
    }
    const { audit, log } = makeAudit()
    const service = new MemoryMaintenanceService(chunks, candidates, audit)

    const result = await service.run({
      memoryId: MEMORY_ID,
      agentId: 'agent-1',
      tenantId: 'tenant-1',
      projectKey: PROJECT_KEY,
      actorId: ACTOR_ID,
    })

    const ops = [...candidateStore.values()].map((c) => ({ op: c.operation, target: (c.payload as { supersedes: string }).supersedes }))
    assert.ok(ops.some((o) => o.op === 'refresh_needed' && o.target === 'refresh-me'))
    assert.ok(ops.some((o) => o.op === 'archive' && o.target === 'archive-me'))
    assert.ok(ops.some((o) => o.op === 'demote' && o.target === 'demote-me'))
    assert.ok(!ops.some((o) => o.target === 'fine'))
    assert.ok([...candidateStore.values()].every((c) => c.proposedBy === 'maintenance_job'))
    assert.equal(result.proposedCandidateIds.length, ops.length)
    assert.ok(log.some((e) => e.action === 'memory.maintenance.started'))
    assert.ok(log.some((e) => e.action === 'memory.maintenance.proposed'))
  })

  await test('maintenance: conflict_review javaslat WP-7 high-risk konfliktusból', async () => {
    const chunkStore = new Map<string, MemoryChunk>()
    chunkStore.set('dup-1', chunk({ id: 'dup-1', path: 'same/path' }))
    chunkStore.set('dup-2', chunk({ id: 'dup-2', path: 'same/path' }))

    const chunks = makeChunkRepo(chunkStore)
    const candidateStore = new Map<string, MemoryCandidate>()
    let candSeq = 0
    const candidates: MemoryCandidateRepository = {
      create: async (data) => {
        const candidate = { id: `cand-${++candSeq}`, createdAt: new Date(), updatedAt: new Date(), ...data } as unknown as MemoryCandidate
        candidateStore.set(candidate.id, candidate)
        return candidate
      },
      findById: async (id) => candidateStore.get(id) ?? null,
      listByRun: async () => [],
      updateStatus: async () => {
        throw new Error('not used')
      },
    }
    const { audit } = makeAudit()
    const service = new MemoryMaintenanceService(chunks, candidates, audit)
    await service.run({ memoryId: MEMORY_ID, agentId: 'agent-1', tenantId: 'tenant-1', projectKey: PROJECT_KEY, actorId: ACTOR_ID })

    const conflictProposals = [...candidateStore.values()].filter((c) => c.operation === 'conflict_review')
    assert.equal(conflictProposals.length, 1)
  })

  await test('maintenance: token-budget cap → egy ponton túl skippedByBudget nő, nem generál végtelen candidate-et', async () => {
    const chunkStore = new Map<string, MemoryChunk>()
    for (let i = 0; i < 5; i++) {
      chunkStore.set(`demote-${i}`, chunk({ id: `demote-${i}`, userCorrectedCount: 2, userConfirmedHelpfulCount: 0 }))
    }
    const chunks = makeChunkRepo(chunkStore)
    const candidateStore = new Map<string, MemoryCandidate>()
    let candSeq = 0
    const candidates: MemoryCandidateRepository = {
      create: async (data) => {
        const candidate = { id: `cand-${++candSeq}`, createdAt: new Date(), updatedAt: new Date(), ...data } as unknown as MemoryCandidate
        candidateStore.set(candidate.id, candidate)
        return candidate
      },
      findById: async (id) => candidateStore.get(id) ?? null,
      listByRun: async () => [],
      updateStatus: async () => {
        throw new Error('not used')
      },
    }
    const { audit } = makeAudit()
    const agents: AgentRepository = {
      findById: async () =>
        ({
          id: 'agent-1',
          selfEvolutionProfile: { scope: ['memory'], approval_mode: 'human', memory: { maintenanceTokenBudget: 10 } },
        }) as unknown as Agent,
    } as unknown as AgentRepository
    const service = new MemoryMaintenanceService(chunks, candidates, audit, agents)

    const result = await service.run({ memoryId: MEMORY_ID, agentId: 'agent-1', tenantId: 'tenant-1', projectKey: PROJECT_KEY, actorId: ACTOR_ID })
    assert.ok(result.skippedByBudget > 0)
    assert.ok(result.proposedCandidateIds.length < 5)
  })

  if (failures > 0) {
    console.error(`\n${failures} teszt megbukott.`)
    process.exit(1)
  }
  console.log('\nMinden teszt sikeres.')
}

void run()
