/**
 * Tartós agent-memória — WP-6 `MemoryApprovalService` regressziós teszt.
 *
 * Kontextus: a WP-4 `memory_propose` tool kizárólag T1 `MemoryCandidate` sort
 * ír (`status: 'proposed'`) — ez a teszt a hiányzó jóváhagyási magot fedi:
 * inline write-gate consume vs. ticket-elágazás (§6.3), a candidate→chunk T2
 * írás (create/update/supersede/archive/delete_request), a scope/tenant
 * fail-closed őrök (S6), és a §14.1 audit-eseménysor.
 *
 * In-memory fake repository-kkal fut (a `tool-broker-tenant-isolation.test.ts`
 * mintáját követve) — a WriteGateService/EvalService/TicketService konkrét
 * osztályok duck-typed fake-ekkel vagy (TicketService esetén) valódi
 * példánnyal, fake TicketRepository fölé kötve.
 *
 * Futtatás: npm run test:memory-approval
 */
import assert from 'node:assert/strict'
import type { Agent, MemoryCandidate, MemoryChunk, MemoryVersion, RolePermission, Ticket } from '@prisma/client'
import { MemoryApprovalService } from '../src/domain/memory/memory-approval-service'
import { TicketService } from '../src/domain/ticket/ticket-service'
import { computeDiffHash } from '../src/lib/crypto/hash-chain'
import type {
  AgentRepository,
  AuditRepository,
  MemoryCandidateRepository,
  MemoryChunkRepository,
  MemoryVersionRepository,
  RolePermissionRepository,
  TicketRepository,
} from '../src/repositories/interfaces'
import type { WriteGateService } from '../src/domain/writegate/write-gate-service'
import type { EvalService } from '../src/domain/eval/eval-service'

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

const TENANT_A = 'aaaaaaaa-0000-4000-8000-000000000001'
const TENANT_B = 'bbbbbbbb-0000-4000-8000-000000000002'
const AGENT_ID = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1'
const MEMORY_ID = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1'
const APPROVER_ID = 'd1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1'
const OPERATOR_ID = 'e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1'
const APPROVER = { id: APPROVER_ID, tenantId: TENANT_A, role: 'approver' as const }
const OPERATOR = { id: OPERATOR_ID, tenantId: TENANT_A, role: 'operator' as const }

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: AGENT_ID,
    tenantId: TENANT_A,
    memoryId: MEMORY_ID,
    currentVersion: 1,
    selfEvolutionProfile: null,
    ...overrides,
  } as unknown as Agent
}

// ── Fake repository-k / szolgáltatások ──────────────────────────────────────

function makeFakes(opts: { evalActive?: boolean; evalPasses?: boolean } = {}) {
  const chunkStore = new Map<string, MemoryChunk>()
  const candidateStore = new Map<string, MemoryCandidate>()
  const ticketStore = new Map<string, Ticket>()
  const auditLog: Array<Record<string, unknown>> = []
  let chunkSeq = 0
  let ticketSeq = 0
  let tokenSeq = 0

  const chunks: MemoryChunkRepository = {
    searchActive: async () => [],
    listRecentActive: async () => [],
    findActiveFocus: async () => null,
    listActiveByType: async () => [],
    markRetrieved: async () => {},
    findById: async (id) => chunkStore.get(id) ?? null,
    create: async (data) => {
      const chunk = { id: `chunk-${++chunkSeq}`, status: 'active', ...data } as unknown as MemoryChunk
      chunkStore.set(chunk.id, chunk)
      return chunk
    },
    updateStatus: async (id, patch) => {
      const existing = chunkStore.get(id)
      if (!existing) throw new Error('chunk not found')
      const updated = { ...existing, ...patch } as MemoryChunk
      chunkStore.set(id, updated)
      return updated
    },
    listActiveIds: async () =>
      [...chunkStore.values()].filter((c) => c.status === 'active').map((c) => c.id),
    setStatusMany: async (ids, status) => {
      for (const id of ids) {
        const existing = chunkStore.get(id)
        if (existing) chunkStore.set(id, { ...existing, status } as MemoryChunk)
      }
    },
    findByContentHash: async (params) =>
      [...chunkStore.values()].find(
        (c) =>
          c.memoryId === params.memoryId &&
          c.projectKey === params.projectKey &&
          c.contentHash === params.contentHash,
      ) ?? null,
    demoteSalience: async (id, factor) => {
      const existing = chunkStore.get(id)
      if (!existing) throw new Error('chunk not found')
      const updated = { ...existing, salience: Math.max((existing.salience ?? 0.5) * factor, 0.05) } as MemoryChunk
      chunkStore.set(id, updated)
      return updated
    },
  }

  const versionStore = new Map<string, MemoryVersion>()
  let versionSeq = 0
  const versions: MemoryVersionRepository = {
    nextVersionNumber: async () => ++versionSeq,
    create: async (data) => {
      const version = { id: `version-${versionSeq}`, createdAt: new Date(), ...data } as unknown as MemoryVersion
      versionStore.set(version.id, version)
      return version
    },
    findLatestForScope: async () => null,
    findByVersion: async () => null,
    listForScope: async () => [],
  }

  const candidates: MemoryCandidateRepository = {
    create: async () => {
      throw new Error('not used in this test — candidates are seeded directly')
    },
    findById: async (id) => candidateStore.get(id) ?? null,
    listByRun: async () => [],
    updateStatus: async (id, patch) => {
      const existing = candidateStore.get(id)
      if (!existing) throw new Error('candidate not found')
      const updated = { ...existing, ...patch } as MemoryCandidate
      candidateStore.set(id, updated)
      return updated
    },
  }

  const audit: AuditRepository = {
    append: async (entry: Record<string, unknown>) => {
      auditLog.push(entry)
      return {} as Awaited<ReturnType<AuditRepository['append']>>
    },
  } as unknown as AuditRepository

  const agentsById = new Map<string, Agent>()
  const agents: AgentRepository = {
    findById: async (id: string) => agentsById.get(id) ?? null,
  } as unknown as AgentRepository

  const permissionsByKey = new Map<string, RolePermission>()
  const rolePermissions: RolePermissionRepository = {
    findAll: async () => [...permissionsByKey.values()],
    findByKey: async (key: string) => permissionsByKey.get(key) ?? null,
    findByKeys: async (keys: string[]) =>
      keys.map((key) => permissionsByKey.get(key)).filter((p): p is RolePermission => Boolean(p)),
    upsert: async () => {
      throw new Error('not used')
    },
  }

  const tickets: TicketRepository = {
    findById: async (id: string) => ticketStore.get(id) ?? null,
    create: async (data: {
      state: string
      type: string
      payload: unknown
      agentId?: string | null
      createdById?: string
      tenantId?: string | null
    }) => {
      const ticket = {
        id: `ticket-${++ticketSeq}`,
        state: data.state,
        type: data.type,
        payload: data.payload,
        agentId: data.agentId,
        createdById: data.createdById,
        tenantId: data.tenantId,
      } as unknown as Ticket
      ticketStore.set(ticket.id, ticket)
      return ticket
    },
    update: async (id: string, patch: Record<string, unknown>) => {
      const existing = ticketStore.get(id)
      if (!existing) throw new Error('ticket not found')
      const updated = { ...existing, ...patch } as Ticket
      ticketStore.set(id, updated)
      return updated
    },
    recordTransition: async () => {},
    releaseDispatchLock: async () => {},
  } as unknown as TicketRepository

  const ticketService = new TicketService(tickets, audit)

  // Duck-typed write-gate fake — ugyanazt a "pontosan egyik horgony" és
  // hash-egyezés invariánst kényszeríti ki, mint a valódi WriteGateService.
  const tokenStore = new Map<string, { status: string; expectedDiffHash: string }>()
  const writeGate: WriteGateService = {
    issue: async (params: {
      trainingTicketId?: string
      memoryCandidateId?: string
      agentId: string
      targetMemoryId: string
      proposedContent: string
    }) => {
      const subjectId = params.trainingTicketId ?? params.memoryCandidateId
      if (!subjectId || (params.trainingTicketId && params.memoryCandidateId)) {
        throw new Error('write_gate: exactly one of trainingTicketId/memoryCandidateId is required')
      }
      const id = `token-${++tokenSeq}`
      const expectedDiffHash = computeDiffHash(params.proposedContent)
      tokenStore.set(id, { status: 'issued', expectedDiffHash })
      return { id, status: 'issued', expectedDiffHash } as unknown as ReturnType<WriteGateService['issue']>
    },
    consume: async (params: { tokenId: string; actualProposedContent: string }) => {
      const token = tokenStore.get(params.tokenId)
      if (!token) throw new Error('write_gate: token not found')
      if (token.status !== 'issued') throw new Error(`write_gate: token already ${token.status}`)
      const actualHash = computeDiffHash(params.actualProposedContent)
      if (actualHash !== token.expectedDiffHash) {
        throw new Error('write_gate: content hash mismatch — approved diff does not match')
      }
      token.status = 'consumed'
      return { ...token, id: params.tokenId } as unknown as ReturnType<WriteGateService['consume']>
    },
  } as unknown as WriteGateService

  const evalService = {
    findActiveForAgent: async () => (opts.evalActive ? { id: 'eval-1' } : null),
    run: async () => {
      if (!opts.evalActive) throw new Error('eval not used in this test')
      return { id: 'evalrun-1', passed: opts.evalPasses ?? true, score: 0.95, details: {} }
    },
  } as unknown as EvalService

  const service = new MemoryApprovalService(
    agents,
    candidates,
    chunks,
    audit,
    writeGate,
    evalService,
    rolePermissions,
    tickets,
    ticketService,
    versions,
  )

  return {
    service,
    chunkStore,
    candidateStore,
    ticketStore,
    versionStore,
    auditLog,
    agentsById,
    permissionsByKey,
  }
}

function seedCandidate(
  store: Map<string, MemoryCandidate>,
  overrides: Partial<MemoryCandidate> & { id: string },
): MemoryCandidate {
  const candidate = {
    memoryId: MEMORY_ID,
    agentId: AGENT_ID,
    tenantId: TENANT_A,
    projectKey: 'proj-1',
    workstreamKey: null,
    operation: 'create',
    status: 'proposed',
    payload: {
      type: 'decision',
      path: 'agent-memory/decisions',
      title: 'Teszt döntés',
      summary: 'Teszt összefoglaló',
      text: 'Teszt szöveg',
      tags: ['test'],
      salienceHint: 'normal',
      confidence: 'normal',
      supersedes: null,
      reviewAfter: null,
      expiresAt: null,
      sourceRefs: [],
      evidence: null,
      reason: 'teszt',
      workstreamKey: null,
    },
    approvedBy: null,
    approvedAt: null,
    rejectedBy: null,
    rejectedAt: null,
    ticketId: null,
    writeGateTokenId: null,
    ...overrides,
  } as unknown as MemoryCandidate
  store.set(candidate.id, candidate)
  return candidate
}

function setupPermissions(p: Map<string, RolePermission>) {
  p.set('memory.inline_approve', { permissionKey: 'memory.inline_approve', minRole: 'approver' } as RolePermission)
  p.set('memory.ticket_approve', { permissionKey: 'memory.ticket_approve', minRole: 'approver' } as RolePermission)
  p.set('memory.delete_approve', { permissionKey: 'memory.delete_approve', minRole: 'admin' } as RolePermission)
}

async function run() {
  await test('inline-approve (create): chunk létrejön, candidate approved, write-gate consumed, audit sor', async () => {
    const f = makeFakes()
    setupPermissions(f.permissionsByKey)
    f.agentsById.set(AGENT_ID, agent())
    seedCandidate(f.candidateStore, { id: 'cand-1' })

    const result = await f.service.approve('cand-1', APPROVER)
    assert.equal(result.ok, true)
    assert.equal((result as { outcome: string }).outcome, 'approved')

    const candidate = f.candidateStore.get('cand-1')!
    assert.equal(candidate.status, 'approved')
    assert.equal(candidate.approvedBy, APPROVER_ID)
    assert.ok(candidate.writeGateTokenId)

    const chunkId = (result as { chunkId: string }).chunkId
    const chunk = f.chunkStore.get(chunkId)!
    assert.equal(chunk.status, 'active')
    assert.equal(chunk.title, 'Teszt döntés')

    const actions = f.auditLog.map((a) => a.action)
    assert.ok(actions.includes('memory.candidate.approved'))
    assert.ok(actions.includes('memory.chunk.created'))
  })

  await test('inline-approve (archive): a cél chunk archivált lesz, nincs új chunk', async () => {
    const f = makeFakes()
    setupPermissions(f.permissionsByKey)
    f.agentsById.set(AGENT_ID, agent())
    f.chunkStore.set(
      'chunk-target',
      {
        id: 'chunk-target', status: 'active', memoryId: MEMORY_ID, agentId: AGENT_ID,
        tenantId: TENANT_A, projectKey: 'proj-1', workstreamKey: null,
      } as unknown as MemoryChunk,
    )
    const seeded = seedCandidate(f.candidateStore, {
      id: 'cand-archive',
      operation: 'archive',
    })
    f.candidateStore.set('cand-archive', {
      ...seeded,
      payload: { ...(seeded.payload as Record<string, unknown>), supersedes: 'chunk-target' },
    } as unknown as MemoryCandidate)

    const result = await f.service.approve('cand-archive', APPROVER)
    assert.equal(result.ok, true)
    assert.equal((result as { chunkId: string }).chunkId, 'chunk-target')
    assert.equal(f.chunkStore.get('chunk-target')!.status, 'archived')
    const actions = f.auditLog.map((a) => a.action)
    assert.ok(actions.includes('memory.chunk.archived'))
  })

  await test('nincs inline jog (operator) → ticket keletkezik, candidate ticketed', async () => {
    const f = makeFakes()
    setupPermissions(f.permissionsByKey)
    f.agentsById.set(AGENT_ID, agent())
    seedCandidate(f.candidateStore, { id: 'cand-2' })

    const result = await f.service.approve('cand-2', OPERATOR)
    assert.equal(result.ok, true)
    assert.equal((result as { outcome: string }).outcome, 'ticketed')

    const candidate = f.candidateStore.get('cand-2')!
    assert.equal(candidate.status, 'ticketed')
    assert.ok(candidate.ticketId)

    const ticket = f.ticketStore.get(candidate.ticketId!)!
    assert.equal(ticket.state, 'awaiting_human')
    assert.equal(ticket.tenantId, TENANT_A)
    assert.equal((ticket.payload as { kind: string }).kind, 'memory_candidate')

    const actions = f.auditLog.map((a) => a.action)
    assert.ok(actions.includes('memory.candidate.ticketed'))
  })

  await test('RBAC-kapu: auto_after_eval profil + inline-jog nélküli aktor → ticket, NEM inline írás (S6/§6.3)', async () => {
    // Regresszió: korábban a `memory.inline_approve` kaput csak
    // `requiresHumanApproval(profile)` mellett futott, így a nem-emberi-jóváhagyású
    // (`eval_only`/`auto_after_eval`) profiloknál egy inline-jog nélküli aktor is
    // közvetlenül T2-be írt. A sikeres eval UTÁN is a capability dönt.
    const f = makeFakes({ evalActive: true, evalPasses: true })
    setupPermissions(f.permissionsByKey)
    f.agentsById.set(
      AGENT_ID,
      agent({ selfEvolutionProfile: { scope: ['memory'], approval_mode: 'auto_after_eval' } as never }),
    )
    seedCandidate(f.candidateStore, { id: 'cand-rbac' })

    const result = await f.service.approve('cand-rbac', OPERATOR)
    assert.equal(result.ok, true)
    assert.equal((result as { outcome: string }).outcome, 'ticketed')
    assert.equal(f.candidateStore.get('cand-rbac')!.status, 'ticketed')
    // Nem született chunk (nem volt inline írás).
    assert.equal(f.chunkStore.size, 0)
    const actions = f.auditLog.map((a) => a.action)
    assert.ok(actions.includes('user.authz.deny'))
  })

  await test('approveTicketedCandidate: a ticketes candidate is T2-be íródik, ticket done lesz', async () => {
    const f = makeFakes()
    setupPermissions(f.permissionsByKey)
    f.agentsById.set(AGENT_ID, agent())
    seedCandidate(f.candidateStore, { id: 'cand-3' })

    const ticketed = await f.service.approve('cand-3', OPERATOR)
    assert.equal((ticketed as { outcome: string }).outcome, 'ticketed')
    const ticketId = f.candidateStore.get('cand-3')!.ticketId!

    const approved = await f.service.approveTicketedCandidate(ticketId, APPROVER)
    assert.equal(approved.ok, true)
    assert.equal((approved as { outcome: string }).outcome, 'approved')
    assert.equal(f.candidateStore.get('cand-3')!.status, 'approved')
    assert.equal(f.ticketStore.get(ticketId)!.state, 'done')
  })

  await test('self_evolution_profile.scope kizárja a memóriát → deny, candidate változatlan', async () => {
    const f = makeFakes()
    setupPermissions(f.permissionsByKey)
    f.agentsById.set(AGENT_ID, agent({ selfEvolutionProfile: { scope: ['behavior'], approval_mode: 'human' } as never }))
    seedCandidate(f.candidateStore, { id: 'cand-4' })

    const result = await f.service.approve('cand-4', APPROVER)
    assert.equal(result.ok, false)
    assert.equal((result as { reason: string }).reason, 'self_evolution_scope_excludes_memory')
    assert.equal(f.candidateStore.get('cand-4')!.status, 'proposed')
  })

  await test('tenant-mismatch → fail-closed deny (S6)', async () => {
    const f = makeFakes()
    setupPermissions(f.permissionsByKey)
    f.agentsById.set(AGENT_ID, agent())
    seedCandidate(f.candidateStore, { id: 'cand-5', tenantId: TENANT_A })

    const result = await f.service.approve('cand-5', { ...APPROVER, tenantId: TENANT_B })
    assert.equal(result.ok, false)
    assert.equal((result as { reason: string }).reason, 'tenant_mismatch')
  })

  await test('cross-scope cél-chunk → write-gate előtt elutasítja (S6)', async () => {
    const f = makeFakes()
    setupPermissions(f.permissionsByKey)
    f.agentsById.set(AGENT_ID, agent())
    const seeded = seedCandidate(f.candidateStore, { id: 'cand-cross-scope', operation: 'archive' })
    f.candidateStore.set('cand-cross-scope', {
      ...seeded,
      payload: { ...(seeded.payload as Record<string, unknown>), supersedes: 'tenant-b-chunk' },
    } as unknown as MemoryCandidate)
    f.chunkStore.set(
      'tenant-b-chunk',
      {
        id: 'tenant-b-chunk', status: 'active', memoryId: 'other-memory', agentId: 'other-agent',
        tenantId: TENANT_B, projectKey: 'proj-1', workstreamKey: null,
      } as unknown as MemoryChunk,
    )

    await assert.rejects(() => f.service.approve('cand-cross-scope', APPROVER), /memory_target_not_found/)
    assert.equal(f.candidateStore.get('cand-cross-scope')!.status, 'proposed')
    assert.equal(f.chunkStore.get('tenant-b-chunk')!.status, 'active')
  })

  await test('reject: candidate rejected státuszba kerül, audit sor', async () => {
    const f = makeFakes()
    f.agentsById.set(AGENT_ID, agent())
    seedCandidate(f.candidateStore, { id: 'cand-6' })

    const result = await f.service.reject('cand-6', APPROVER, 'nem releváns')
    assert.equal(result.ok, true)
    assert.equal(f.candidateStore.get('cand-6')!.status, 'rejected')
    assert.ok(f.auditLog.some((a) => a.action === 'memory.candidate.rejected'))
  })

  await test('WP-8: minden inline-write után append-only manifest-snapshot készül', async () => {
    const f = makeFakes()
    setupPermissions(f.permissionsByKey)
    f.agentsById.set(AGENT_ID, agent())
    seedCandidate(f.candidateStore, { id: 'cand-8' })

    const result = await f.service.approve('cand-8', APPROVER)
    assert.equal(result.ok, true)
    const chunkId = (result as { chunkId: string }).chunkId

    assert.equal(f.versionStore.size, 1)
    const manifest = [...f.versionStore.values()][0]
    assert.equal(manifest.version, 1)
    assert.equal(manifest.projectKey, 'proj-1')
    assert.deepEqual(manifest.activeChunkIds, [chunkId])
  })

  await test('WP-8/G11: hash-egyezésű re-capture reaktivál egy archivált chunkot, nem duplikál', async () => {
    const f = makeFakes()
    setupPermissions(f.permissionsByKey)
    f.agentsById.set(AGENT_ID, agent())

    seedCandidate(f.candidateStore, { id: 'cand-9a' })
    const created = await f.service.approve('cand-9a', APPROVER)
    const chunkId = (created as { chunkId: string }).chunkId

    const archiveCand = seedCandidate(f.candidateStore, { id: 'cand-9b', operation: 'archive' })
    f.candidateStore.set('cand-9b', {
      ...archiveCand,
      payload: { ...(archiveCand.payload as Record<string, unknown>), supersedes: chunkId },
    } as unknown as MemoryCandidate)
    await f.service.approve('cand-9b', APPROVER)
    assert.equal(f.chunkStore.get(chunkId)!.status, 'archived')

    // Ugyanaz a tartalom (title/summary/text/tags/type/path) mint cand-9a — a
    // canonicalContent-hash egyezik, tehát reaktiválás várt, nem új chunk.
    seedCandidate(f.candidateStore, { id: 'cand-9c' })
    const recaptured = await f.service.approve('cand-9c', APPROVER)
    assert.equal(recaptured.ok, true)
    assert.equal((recaptured as { chunkId: string }).chunkId, chunkId)
    assert.equal(f.chunkStore.get(chunkId)!.status, 'active')
    assert.equal(f.chunkStore.size, 1)
  })

  await test('modify: payload finomítás, candidate modified státuszban marad jóváhagyhatónak', async () => {
    const f = makeFakes()
    setupPermissions(f.permissionsByKey)
    f.agentsById.set(AGENT_ID, agent())
    seedCandidate(f.candidateStore, { id: 'cand-7' })

    const modified = await f.service.modify('cand-7', APPROVER, { summary: 'Frissített összefoglaló' })
    assert.equal(modified.ok, true)
    assert.equal(f.candidateStore.get('cand-7')!.status, 'modified')
    assert.equal((f.candidateStore.get('cand-7')!.payload as { summary: string }).summary, 'Frissített összefoglaló')

    // 'modified' státuszból is jóváhagyható.
    const approved = await f.service.approve('cand-7', APPROVER)
    assert.equal(approved.ok, true)
  })

  await test('T23: operator_can_activate — operator elfogadhatja a projektmemória-javaslatot', async () => {
    const f = makeFakes()
    setupPermissions(f.permissionsByKey)
    f.agentsById.set(
      AGENT_ID,
      agent({
        selfEvolutionProfile: {
          scope: ['memory'],
          approval_mode: 'human',
          durable_memory_approval_policy: { activation_mode: 'operator_can_activate', four_eyes_required: false },
        } as never,
      }),
    )
    seedCandidate(f.candidateStore, { id: 'cand-t23' })
    const result = await f.service.approve('cand-t23', OPERATOR)
    assert.equal(result.ok, true)
    assert.equal((result as { outcome: string }).outcome, 'approved')
    assert.equal(f.versionStore.size, 1)
  })

  await test('T23/T21: négy szem — a javaslattevő nem fogadhatja el saját projektmemóriáját', async () => {
    const f = makeFakes()
    setupPermissions(f.permissionsByKey)
    f.agentsById.set(AGENT_ID, agent())
    seedCandidate(f.candidateStore, { id: 'cand-eyes', proposedBy: APPROVER_ID })
    const result = await f.service.approve('cand-eyes', APPROVER)
    assert.equal(result.ok, false)
    assert.equal((result as { reason: string }).reason, 'four_eyes_required')
    assert.equal(f.candidateStore.get('cand-eyes')!.status, 'proposed')
  })

  if (failures > 0) {
    console.error(`\n${failures} teszt megbukott.`)
    process.exit(1)
  }
  console.log('\nMinden teszt sikeres.')
}

void run()
