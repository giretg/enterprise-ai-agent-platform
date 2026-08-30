/**
 * MemoryTraining v1.1 — tanítási workspace (revízió, policy, CAS).
 *
 * Futtatás: npm run test:training-workspace
 */
import assert from 'node:assert/strict'
import type { Agent, Ticket, UserRole } from '@prisma/client'
import { TrainingService, type TrainingActor } from '../src/domain/training/training-service'
import type { TeachAnalyzer } from '../src/domain/training/teach-analyzer'
import { TrainingGateError } from '../src/domain/training/durable-memory-policy'
import { TicketService } from '../src/domain/ticket/ticket-service'
import { serializeMemoryItems } from '../src/domain/training/memory-items'
import { computeDiffHash } from '../src/lib/crypto/hash-chain'
import type {
  AgentRepository,
  AuditRepository,
  TicketRepository,
} from '../src/repositories/interfaces'
import type { WriteGateService } from '../src/domain/writegate/write-gate-service'
import type { EvalService } from '../src/domain/eval/eval-service'
import type { SelfEvolutionGuard } from '../src/domain/training/self-evolution-guard'
import type {
  AgentTrainingContext,
  InstructionVersionRow,
  RevisionRow,
  TrainingMetaRow,
  TrainingStore,
} from '../src/domain/training/training-store'

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

const TENANT = 'aaaaaaaa-0000-4000-8000-000000000001'
const AGENT_ID = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1'
const MEMORY_ID = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1'
const OPERATOR_ID = 'e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1'
const APPROVER_ID = 'd1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1'
const APPROVER_B = 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1'
const VIEWER_ID = 'f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f1'
const V3_CONTENT = serializeMemoryItems(['Magyarul válaszolj', 'ÁFA-t ellenőrizd'])

const operator: TrainingActor = { id: OPERATOR_ID, tenantId: TENANT, role: 'operator' }
const approver: TrainingActor = { id: APPROVER_ID, tenantId: TENANT, role: 'approver' }
const approverB: TrainingActor = { id: APPROVER_B, tenantId: TENANT, role: 'approver' }
const viewer: TrainingActor = { id: VIEWER_ID, tenantId: TENANT, role: 'viewer' }

function actor(role: UserRole, id: string): TrainingActor {
  return { id, tenantId: TENANT, role }
}

function makeHarness(opts: {
  profile?: unknown
  evalActive?: boolean
  evalPasses?: boolean
  casMissOnActivate?: boolean
  ticketCreateRace?: boolean
  teachAnalyzer?: TeachAnalyzer | null
} = {}) {
  const instructionVersions = new Map<string, InstructionVersionRow>()
  const trainingMeta = new Map<string, TrainingMetaRow>()
  const revisions = new Map<string, RevisionRow>()
  const tickets = new Map<string, Ticket>()
  const auditLog: Array<Record<string, unknown>> = []
  const users = new Set([OPERATOR_ID, APPROVER_ID, APPROVER_B, VIEWER_ID])
  let versionSeq = 3
  let ticketSeq = 0
  let revisionSeq = 0
  let tokenSeq = 0
  const tokenStore = new Map<string, { status: string; expectedDiffHash: string }>()

  const v3: InstructionVersionRow = {
    id: 'ver-3',
    memoryId: MEMORY_ID,
    version: 3,
    content: V3_CONTENT,
    status: 'active',
    source: 'seed',
    approvedById: APPROVER_ID,
    parentVersion: 2,
    createdAt: new Date(),
  }
  instructionVersions.set(v3.id, v3)
  let currentInstructionId: string | null = v3.id
  const projectManifestCurrentId: string | null = 'proj-12'

  const ctx = (): AgentTrainingContext => ({
    id: AGENT_ID,
    tenantId: TENANT,
    name: 'Teszt agent',
    currentVersion: 1,
    selfEvolutionProfile: opts.profile ?? {
      scope: ['memory'],
      approval_mode: 'human',
      durable_memory_approval_policy: { activation_mode: 'approver_required', four_eyes_required: true },
    },
    memoryId: MEMORY_ID,
    currentInstruction: currentInstructionId ? instructionVersions.get(currentInstructionId) ?? null : null,
  })

  const store: TrainingStore = {
    findAgentContext: async () => ctx(),
    nextInstructionVersion: async () => {
      const max = [...instructionVersions.values()].reduce((m, v) => Math.max(m, v.version), 0)
      return max + 1
    },
    listInstructionVersions: async () =>
      [...instructionVersions.values()].sort((a, b) => b.version - a.version),
    findInstructionVersion: async (_memoryId, version) =>
      [...instructionVersions.values()].find((v) => v.version === version) ?? null,
    findTrainingMeta: async (ticketId) => trainingMeta.get(ticketId) ?? null,
    createTrainingMeta: async (data) => {
      trainingMeta.set(data.ticketId, {
        ticketId: data.ticketId,
        proposedDiff: data.proposedDiff,
        writeGateTokenRef: null,
        evalResult: null,
        evalRequired: data.evalRequired,
        origin: data.origin,
        scopeClass: data.scopeClass,
        targetMemoryVersion: data.targetMemoryVersion,
        currentRevisionId: null,
      })
    },
    updateTrainingMeta: async (ticketId, data) => {
      const existing = trainingMeta.get(ticketId)
      if (!existing) throw new Error('meta missing')
      trainingMeta.set(ticketId, { ...existing, ...data })
    },
    listRevisions: async (ticketId) =>
      [...revisions.values()].filter((r) => r.trainingTicketId === ticketId).sort((a, b) => a.revision - b.revision),
    findRevision: async (id) => revisions.get(id) ?? null,
    createRevision: async (data) => {
      const row: RevisionRow = {
        id: data.id ?? `rev-${++revisionSeq}`,
        trainingTicketId: data.trainingTicketId,
        revision: data.revision,
        baseVersionId: data.baseVersionId,
        proposedVersionRef: data.proposedVersionRef,
        changeSummary: data.changeSummary,
        impactResult: data.impactResult,
        compositionMode: data.compositionMode,
        status: data.status ?? 'current',
        targetMemoryVersion: data.targetMemoryVersion,
        writeGateTokenRef: data.writeGateTokenRef ?? null,
        tokenStatus: data.tokenStatus ?? 'unissued',
        tokenExpiresAt: data.tokenExpiresAt ?? null,
        createdById: data.createdById,
        createdAt: new Date(),
      }
      revisions.set(row.id, row)
      return row
    },
    supersedeCurrentRevisions: async (ticketId) => {
      let count = 0
      for (const row of revisions.values()) {
        if (
          row.trainingTicketId === ticketId &&
          row.status === 'current' &&
          row.tokenStatus === 'unissued'
        ) {
          row.status = 'superseded'
          row.tokenStatus = 'revoked'
          count++
        }
      }
      return count
    },
    updateRevision: async (id, data) => {
      const row = revisions.get(id)
      if (!row) throw new Error('revision missing')
      Object.assign(row, data)
    },
    claimRevisionActivation: async (id) => {
      const row = revisions.get(id)
      if (!row || row.status !== 'current' || row.tokenStatus !== 'unissued') return false
      row.tokenStatus = 'issued'
      return true
    },
    releaseRevisionActivationClaim: async (id) => {
      const row = revisions.get(id)
      if (row?.status === 'current' && row.tokenStatus === 'issued') {
        row.tokenStatus = 'unissued'
        row.writeGateTokenRef = null
      }
    },
    activateInstructionVersion: async (data) => {
      if (opts.casMissOnActivate || currentInstructionId !== data.expectedCurrentVersionId) {
        return null
      }
      const row: InstructionVersionRow = {
        id: `ver-${++versionSeq}`,
        memoryId: data.memoryId,
        version: data.version,
        content: data.content,
        status: 'active',
        source: data.source,
        approvedById: data.approvedById,
        parentVersion: data.parentVersion,
        createdAt: new Date(),
      }
      instructionVersions.set(row.id, row)
      if (data.expectedCurrentVersionId) {
        const previous = instructionVersions.get(data.expectedCurrentVersionId)
        if (previous) previous.status = 'rolled_back'
      }
      currentInstructionId = row.id
      return row
    },
    restoreInstructionVersion: async (params) => {
      if (currentInstructionId !== params.expectedCurrentVersionId) return false
      if (params.expectedCurrentVersionId && params.expectedCurrentVersionId !== params.targetId) {
        const prev = instructionVersions.get(params.expectedCurrentVersionId)
        if (prev) prev.status = 'rolled_back'
      }
      const target = instructionVersions.get(params.targetId)
      if (target) target.status = 'active'
      currentInstructionId = params.targetId
      return true
    },
    findUser: async (id) => (users.has(id) ? { id } : null),
  }

  const ticketRepo: TicketRepository = {
    findById: async (id: string) => tickets.get(id) ?? null,
    findMany: async (filter?: { agentId?: string; type?: Ticket['type'] }) =>
      [...tickets.values()].filter((t) => {
        if (filter?.agentId && t.agentId !== filter.agentId) return false
        if (filter?.type && t.type !== filter.type) return false
        return true
      }),
    create: async (data: {
      state: Ticket['state']
      type: Ticket['type']
      payload: unknown
      agentId?: string | null
      createdById: string
      tenantId?: string | null
      title: string
    }) => {
      if (opts.ticketCreateRace && tickets.size === 0) {
        const competing = {
          id: 'ticket-competing',
          state: 'awaiting_human',
          type: 'training',
          payload: {},
          agentId: AGENT_ID,
          createdById: APPROVER_B,
          tenantId: TENANT,
          title: 'Párhuzamos tanítás',
        } as unknown as Ticket
        tickets.set(competing.id, competing)
        throw new Error('unique constraint: one open instruction training ticket per agent')
      }
      const ticket = {
        id: `ticket-${++ticketSeq}`,
        state: data.state,
        type: data.type,
        payload: data.payload,
        agentId: data.agentId,
        createdById: data.createdById,
        tenantId: data.tenantId ?? TENANT,
        title: data.title,
      } as unknown as Ticket
      tickets.set(ticket.id, ticket)
      return ticket
    },
    update: async (id: string, patch: Record<string, unknown>) => {
      const existing = tickets.get(id)
      if (!existing) throw new Error('ticket not found')
      const updated = { ...existing, ...patch } as Ticket
      tickets.set(id, updated)
      return updated
    },
    recordTransition: async () => {},
    releaseDispatchLock: async () => {},
  } as unknown as TicketRepository

  const audit: AuditRepository = {
    append: async (entry: Record<string, unknown>) => {
      auditLog.push(entry)
      return {} as Awaited<ReturnType<AuditRepository['append']>>
    },
  } as unknown as AuditRepository

  const agents: AgentRepository = {
    findById: async (id: string) =>
      id === AGENT_ID ? ({ id: AGENT_ID, tenantId: TENANT, name: 'Teszt agent' } as unknown as Agent) : null,
  } as unknown as AgentRepository

  const ticketService = new TicketService(ticketRepo, audit)
  const writeGate: WriteGateService = {
    issue: async (params: { proposedContent: string; trainingTicketId?: string; memoryCandidateId?: string }) => {
      const id = `token-${++tokenSeq}`
      tokenStore.set(id, { status: 'issued', expectedDiffHash: computeDiffHash(params.proposedContent) })
      return { id, status: 'issued' } as unknown as ReturnType<WriteGateService['issue']>
    },
    consume: async (params: { tokenId: string; actualProposedContent: string }) => {
      const token = tokenStore.get(params.tokenId)
      if (!token) throw new Error('write_gate: token not found')
      if (token.status !== 'issued') throw new Error(`write_gate: token already ${token.status}`)
      if (computeDiffHash(params.actualProposedContent) !== token.expectedDiffHash) {
        throw new Error('write_gate: content hash mismatch')
      }
      token.status = 'consumed'
      return { id: params.tokenId, status: 'consumed' } as unknown as ReturnType<WriteGateService['consume']>
    },
  } as unknown as WriteGateService

  const evalService = {
    findActiveForAgent: async () => (opts.evalActive ? { id: 'eval-1' } : null),
    run: async () => ({
      id: 'evalrun-1',
      passed: opts.evalPasses ?? true,
      score: opts.evalPasses === false ? 0.1 : 0.95,
      details: {},
    }),
  } as unknown as EvalService

  const service = new TrainingService(
    ticketRepo,
    audit,
    ticketService,
    writeGate,
    evalService,
    agents,
    {} as SelfEvolutionGuard,
    store,
    opts.teachAnalyzer ?? null,
  )

  return {
    service,
    auditLog,
    instructionVersions,
    get currentInstructionId() {
      return currentInstructionId
    },
    get projectManifestCurrentId() {
      return projectManifestCurrentId
    },
    tickets,
    revisions,
    trainingMeta,
    tokenStore,
    setCurrentInstruction(id: string | null) {
      currentInstructionId = id
    },
  }
}

async function run() {
  await test('T13: operator tanít approver_required agentet — javaslat létrejön, aktiválás tiltott', async () => {
    const h = makeHarness()
    const preview = await h.service.previewTrainingChange({
      agentId: AGENT_ID,
      instruction: { kind: 'teach', text: 'PDF-et csatolj' },
      actor: operator,
    })
    assert.equal(preview.impactResult.verdict, 'complements')
    const submitted = await h.service.submitTrainingProposal({ previewId: preview.previewId, actor: operator })
    assert.equal(submitted.ticket.state, 'awaiting_human')
    const ws = await h.service.getTrainingWorkspace({ agentId: AGENT_ID, actor: operator })
    assert.equal(ws.allowedActions.includes('activate'), false)
    assert.equal(ws.pendingProposal?.nextStep, 'Jóváhagyó döntésére vár')
    await assert.rejects(
      () =>
        h.service.activateTraining({
          ticketId: submitted.ticket.id,
          revisionId: submitted.currentRevision.id,
          actor: operator,
        }),
      (e: unknown) => e instanceof TrainingGateError && e.code === 'activation_forbidden',
    )
    assert.equal(h.currentInstructionId, 'ver-3')
  })

  await test('T14: operator_can_activate — operator aktiválhat a write-gate úton', async () => {
    const h = makeHarness({
      profile: {
        scope: ['memory'],
        approval_mode: 'human',
        durable_memory_approval_policy: { activation_mode: 'operator_can_activate', four_eyes_required: false },
      },
    })
    const preview = await h.service.previewTrainingChange({
      agentId: AGENT_ID,
      instruction: { kind: 'teach', text: 'PDF-et csatolj' },
      actor: operator,
    })
    const submitted = await h.service.submitTrainingProposal({ previewId: preview.previewId, actor: operator })
    const result = await h.service.activateTraining({
      ticketId: submitted.ticket.id,
      revisionId: submitted.currentRevision.id,
      actor: operator,
    })
    assert.equal(result.memoryVersion.version, 4)
    assert.ok(h.auditLog.some((a) => a.action === 'memory.update'))
    assert.ok(h.auditLog.some((a) => a.action === 'training.approved'))
    assert.equal(h.projectManifestCurrentId, 'proj-12')
  })

  await test('user-kezdeményezett tanítást az általános eval mód nem blokkolja', async () => {
    const h = makeHarness({
      profile: {
        scope: ['memory'],
        approval_mode: 'eval_only',
        durable_memory_approval_policy: { activation_mode: 'operator_can_activate', four_eyes_required: false },
      },
      evalActive: false,
    })
    const preview = await h.service.previewTrainingChange({
      agentId: AGENT_ID,
      instruction: { kind: 'teach', text: 'PDF-et csatolj' },
      actor: operator,
    })
    const submitted = await h.service.submitTrainingProposal({ previewId: preview.previewId, actor: operator })
    const result = await h.service.activateTraining({
      ticketId: submitted.ticket.id,
      revisionId: submitted.currentRevision.id,
      actor: operator,
    })
    assert.equal(result.memoryVersion.version, 4)
    assert.equal(result.evalRun, null)
  })

  await test('T15: viewer csak olvashat, action tiltott', async () => {
    const h = makeHarness()
    const ws = await h.service.getTrainingWorkspace({ agentId: AGENT_ID, actor: viewer })
    assert.deepEqual(ws.allowedActions, [])
    await assert.rejects(
      () =>
        h.service.previewTrainingChange({
          agentId: AGENT_ID,
          instruction: { kind: 'teach', text: 'X' },
          actor: viewer,
        }),
      (e: unknown) => e instanceof TrainingGateError,
    )
  })

  await test('ellentmondó tanítás a meglévő szabályt átírja, nem fűzi mellé', async () => {
    const h = makeHarness({
      teachAnalyzer: {
        async analyze({ existingItems, teaching }) {
          const from = existingItems.find((item) => item.includes('Magyarul')) ?? existingItems[0]!
          return {
            added: [],
            rewritten: [{ from, to: teaching }],
            removed: [],
          }
        },
      },
    })
    const preview = await h.service.previewTrainingChange({
      agentId: AGENT_ID,
      instruction: { kind: 'teach', text: 'Angolul válaszolj' },
      actor: operator,
    })
    assert.equal(preview.impactResult.verdict, 'changes')
    assert.equal(preview.changeSummary.rewritten.length, 1)
    assert.equal(preview.changeSummary.rewritten[0]?.to, 'Angolul válaszolj')
    assert.doesNotMatch(preview.proposedVersion, /Magyarul válaszolj/)
    assert.match(preview.proposedVersion, /Angolul válaszolj/)
    assert.match(preview.proposedVersion, /ÁFA-t ellenőrizd/)
  })

  await test('nyitott ticket tartalom nélkül nem kér composition választást, és az előnézet lefut', async () => {
    const h = makeHarness()
    h.tickets.set('orphan', {
      id: 'orphan',
      state: 'awaiting_human',
      type: 'training',
      payload: { source: 'teach' },
      agentId: AGENT_ID,
      createdById: OPERATOR_ID,
      tenantId: TENANT,
      title: 'Árva tanítás',
    } as unknown as Ticket)
    const ws = await h.service.getTrainingWorkspace({ agentId: AGENT_ID, actor: operator })
    assert.equal(ws.pendingProposal, null)
    const preview = await h.service.previewTrainingChange({
      agentId: AGENT_ID,
      instruction: { kind: 'teach', text: 'PDF-et csatolj' },
      actor: operator,
    })
    assert.equal(preview.impactResult.verdict, 'complements')
    assert.ok(preview.changeSummary.added.includes('PDF-et csatolj'))
  })

  await test('nyitott javaslat tartalommal compositionMode nélkül elutasít', async () => {
    const h = makeHarness()
    const first = await h.service.previewTrainingChange({
      agentId: AGENT_ID,
      instruction: { kind: 'teach', text: 'PDF-et csatolj' },
      actor: operator,
    })
    await h.service.submitTrainingProposal({ previewId: first.previewId, actor: operator })
    await assert.rejects(
      () =>
        h.service.previewTrainingChange({
          agentId: AGENT_ID,
          instruction: { kind: 'teach', text: 'Dátumot ISO-ban írj' },
          actor: operator,
        }),
      (e: unknown) => e instanceof TrainingGateError && e.code === 'composition_required',
    )
  })

  await test('T16: Beépítem nyitott v4/r1 mellé → v4/r2 a függő+új tanítás', async () => {
    const h = makeHarness()
    const first = await h.service.previewTrainingChange({
      agentId: AGENT_ID,
      instruction: { kind: 'teach', text: 'PDF-et csatolj' },
      actor: operator,
    })
    await h.service.submitTrainingProposal({ previewId: first.previewId, actor: operator })
    const second = await h.service.previewTrainingChange({
      agentId: AGENT_ID,
      instruction: { kind: 'teach', text: 'Dátumot ISO-ban írj' },
      compositionMode: 'build_on_pending',
      actor: operator,
    })
    const submitted = await h.service.submitTrainingProposal({ previewId: second.previewId, actor: operator })
    assert.equal(submitted.currentRevision.revision, 2)
    assert.match(submitted.currentRevision.proposedVersionRef, /PDF-et csatolj/)
    assert.match(submitted.currentRevision.proposedVersionRef, /Dátumot ISO-ban írj/)
    const revs = [...h.revisions.values()]
    assert.equal(revs.filter((r) => r.status === 'current').length, 1)
    assert.equal(revs.find((r) => r.revision === 1)?.status, 'superseded')
  })

  await test('T17: Lecserélem nyitott v4/r1 mellé → v4/r2 az aktív+új tanítás', async () => {
    const h = makeHarness()
    const first = await h.service.previewTrainingChange({
      agentId: AGENT_ID,
      instruction: { kind: 'teach', text: 'PDF-et csatolj' },
      actor: operator,
    })
    await h.service.submitTrainingProposal({ previewId: first.previewId, actor: operator })
    const second = await h.service.previewTrainingChange({
      agentId: AGENT_ID,
      instruction: { kind: 'teach', text: 'Dátumot ISO-ban írj' },
      compositionMode: 'replace_pending',
      actor: operator,
    })
    const submitted = await h.service.submitTrainingProposal({ previewId: second.previewId, actor: operator })
    assert.doesNotMatch(submitted.currentRevision.proposedVersionRef, /PDF-et csatolj/)
    assert.match(submitted.currentRevision.proposedVersionRef, /Dátumot ISO-ban írj/)
    assert.match(submitted.currentRevision.proposedVersionRef, /Magyarul válaszolj/)
  })

  await test('párhuzamos első submitnál a DB-guard vesztesét új előnézetre küldi', async () => {
    const h = makeHarness({ ticketCreateRace: true })
    const preview = await h.service.previewTrainingChange({
      agentId: AGENT_ID,
      instruction: { kind: 'teach', text: 'PDF-et csatolj' },
      actor: operator,
    })
    await assert.rejects(
      () => h.service.submitTrainingProposal({ previewId: preview.previewId, actor: operator }),
      (e: unknown) => e instanceof TrainingGateError && e.code === 'composition_required',
    )
    assert.equal(h.tickets.size, 1)
  })

  await test('T18: elavult revízió aktiválása elutasítva', async () => {
    const h = makeHarness()
    const first = await h.service.previewTrainingChange({
      agentId: AGENT_ID,
      instruction: { kind: 'teach', text: 'PDF-et csatolj' },
      actor: operator,
    })
    const r1 = await h.service.submitTrainingProposal({ previewId: first.previewId, actor: operator })
    const second = await h.service.previewTrainingChange({
      agentId: AGENT_ID,
      instruction: { kind: 'teach', text: 'Dátumot ISO-ban írj' },
      compositionMode: 'build_on_pending',
      actor: operator,
    })
    const r2 = await h.service.submitTrainingProposal({ previewId: second.previewId, actor: operator })
    await assert.rejects(
      () =>
        h.service.activateTraining({
          ticketId: r2.ticket.id,
          revisionId: r1.currentRevision.id,
          actor: approverB,
        }),
      (e: unknown) => e instanceof TrainingGateError && e.code === 'stale_revision',
    )
  })

  await test('needs_info ticketen aktiválás nem ír memóriát (awaiting_human kapu)', async () => {
    const h = makeHarness({
      profile: {
        scope: ['memory'],
        approval_mode: 'human',
        durable_memory_approval_policy: { activation_mode: 'operator_can_activate', four_eyes_required: false },
      },
    })
    const preview = await h.service.previewTrainingChange({
      agentId: AGENT_ID,
      instruction: { kind: 'teach', text: 'PDF-et csatolj' },
      actor: operator,
    })
    const submitted = await h.service.submitTrainingProposal({ previewId: preview.previewId, actor: operator })
    const ticket = h.tickets.get(submitted.ticket.id)
    assert.ok(ticket)
    // Board / pontosítás: awaiting_human → needs_info. A workspace továbbra is
    // mutatja a pendinget (OPEN_TICKET_STATES), az aktiválás gomb is elérhető.
    h.tickets.set(submitted.ticket.id, { ...ticket, state: 'needs_info' })
    const ws = await h.service.getTrainingWorkspace({ agentId: AGENT_ID, actor: operator })
    assert.equal(ws.pendingProposal?.ticketId, submitted.ticket.id)
    assert.equal(ws.allowedActions.includes('activate'), true)

    await assert.rejects(
      () =>
        h.service.activateTraining({
          ticketId: submitted.ticket.id,
          revisionId: submitted.currentRevision.id,
          actor: operator,
        }),
      (e: unknown) => e instanceof TrainingGateError && e.code === 'not_awaiting_approval',
    )
    assert.equal(h.currentInstructionId, 'ver-3')
    assert.equal(h.instructionVersions.size, 1)
    assert.equal(h.tickets.get(submitted.ticket.id)?.state, 'needs_info')
    assert.equal(h.revisions.get(submitted.currentRevision.id)?.tokenStatus, 'unissued')
  })

  await test('T19: elavult alapverzió nem írható felül', async () => {
    const h = makeHarness()
    const preview = await h.service.previewTrainingChange({
      agentId: AGENT_ID,
      instruction: { kind: 'teach', text: 'PDF-et csatolj' },
      actor: operator,
    })
    const submitted = await h.service.submitTrainingProposal({ previewId: preview.previewId, actor: operator })
    const extra: InstructionVersionRow = {
      id: 'ver-other',
      memoryId: MEMORY_ID,
      version: 4,
      content: V3_CONTENT,
      status: 'active',
      source: 'other',
      approvedById: APPROVER_ID,
      parentVersion: 3,
      createdAt: new Date(),
    }
    h.instructionVersions.set(extra.id, extra)
    h.setCurrentInstruction(extra.id)
    await assert.rejects(
      () =>
        h.service.activateTraining({
          ticketId: submitted.ticket.id,
          revisionId: submitted.currentRevision.id,
          actor: approverB,
        }),
      (e: unknown) => e instanceof TrainingGateError && e.code === 'base_version_stale',
    )
  })

  await test('T19/CAS: a precheck utáni konkurens pointerváltás sem írható felül', async () => {
    const h = makeHarness({
      profile: {
        scope: ['memory'],
        approval_mode: 'human',
        durable_memory_approval_policy: { activation_mode: 'operator_can_activate', four_eyes_required: false },
      },
      casMissOnActivate: true,
    })
    const preview = await h.service.previewTrainingChange({
      agentId: AGENT_ID,
      instruction: { kind: 'teach', text: 'PDF-et csatolj' },
      actor: operator,
    })
    const submitted = await h.service.submitTrainingProposal({ previewId: preview.previewId, actor: operator })
    await assert.rejects(
      () =>
        h.service.activateTraining({
          ticketId: submitted.ticket.id,
          revisionId: submitted.currentRevision.id,
          actor: operator,
        }),
      (e: unknown) => e instanceof TrainingGateError && e.code === 'base_version_stale',
    )
    assert.equal(h.currentInstructionId, 'ver-3')
    assert.equal(h.instructionVersions.size, 1)
    assert.equal(
      h.revisions.get(submitted.currentRevision.id)?.tokenStatus,
      'unissued',
      'a CAS-vesztes próbálkozás után a javaslat újrapróbálható marad',
    )
  })

  await test('T19/approval-claim: két párhuzamos jóváhagyás csak egy tokent és egy memóriaírást indít', async () => {
    const h = makeHarness({
      profile: {
        scope: ['memory'],
        approval_mode: 'human',
        durable_memory_approval_policy: { activation_mode: 'operator_can_activate', four_eyes_required: false },
      },
    })
    const preview = await h.service.previewTrainingChange({
      agentId: AGENT_ID,
      instruction: { kind: 'teach', text: 'PDF-et csatolj' },
      actor: operator,
    })
    const submitted = await h.service.submitTrainingProposal({ previewId: preview.previewId, actor: operator })

    const attempts = await Promise.allSettled([
      h.service.activateTraining({
        ticketId: submitted.ticket.id,
        revisionId: submitted.currentRevision.id,
        actor: operator,
      }),
      h.service.activateTraining({
        ticketId: submitted.ticket.id,
        revisionId: submitted.currentRevision.id,
        actor: operator,
      }),
    ])

    assert.equal(attempts.filter((attempt) => attempt.status === 'fulfilled').length, 1)
    assert.equal(attempts.filter((attempt) => attempt.status === 'rejected').length, 1)
    const rejected = attempts.find((attempt) => attempt.status === 'rejected')
    assert.ok(
      rejected?.status === 'rejected' &&
        rejected.reason instanceof TrainingGateError &&
        rejected.reason.code === 'activation_in_progress',
    )
    assert.equal(h.instructionVersions.size, 2, 'csak egy új instruction verzió születhet')
    assert.equal(h.tokenStore.size, 1, 'csak a foglalást megszerző kérés kap write-gate tokent')
    assert.equal(h.auditLog.filter((entry) => entry.action === 'training.approved').length, 1)
    assert.equal(h.revisions.get(submitted.currentRevision.id)?.tokenStatus, 'consumed')
  })

  await test('T19/approval-claim: foglalt jóváhagyást sem szerkesztés, sem visszautasítás nem írhat felül', async () => {
    const h = makeHarness()
    const first = await h.service.previewTrainingChange({
      agentId: AGENT_ID,
      instruction: { kind: 'teach', text: 'PDF-et csatolj' },
      actor: operator,
    })
    const submitted = await h.service.submitTrainingProposal({ previewId: first.previewId, actor: operator })
    const claimed = h.revisions.get(submitted.currentRevision.id)
    assert.ok(claimed)
    claimed.tokenStatus = 'issued'

    const replacement = await h.service.previewTrainingChange({
      agentId: AGENT_ID,
      instruction: { kind: 'teach', text: 'Dátumot ISO-ban írj' },
      compositionMode: 'replace_pending',
      actor: operator,
    })
    await assert.rejects(
      () => h.service.submitTrainingProposal({ previewId: replacement.previewId, actor: operator }),
      (e: unknown) => e instanceof TrainingGateError && e.code === 'activation_in_progress',
    )
    await assert.rejects(
      () => h.service.rejectTraining({ ticketId: submitted.ticket.id, actor: approver }),
      (e: unknown) => e instanceof TrainingGateError && e.code === 'activation_in_progress',
    )
    assert.equal(h.tickets.get(submitted.ticket.id)?.state, 'awaiting_human')
    assert.equal(h.revisions.get(submitted.currentRevision.id)?.status, 'current')
  })

  await test('T20: instruction aktiválás nem nyúl a projektmemória current pointerhez', async () => {
    const h = makeHarness({
      profile: {
        scope: ['memory'],
        approval_mode: 'human',
        durable_memory_approval_policy: { activation_mode: 'operator_can_activate', four_eyes_required: false },
      },
    })
    const preview = await h.service.previewTrainingChange({
      agentId: AGENT_ID,
      instruction: { kind: 'teach', text: 'PDF-et csatolj' },
      actor: operator,
    })
    const submitted = await h.service.submitTrainingProposal({ previewId: preview.previewId, actor: operator })
    await h.service.activateTraining({
      ticketId: submitted.ticket.id,
      revisionId: submitted.currentRevision.id,
      actor: operator,
    })
    assert.equal(h.projectManifestCurrentId, 'proj-12')
    assert.notEqual(h.currentInstructionId, 'ver-3')
  })

  await test('T21/T22: négy szem — saját javaslat tiltva, másik approver aktiválhat', async () => {
    const h = makeHarness()
    const preview = await h.service.previewTrainingChange({
      agentId: AGENT_ID,
      instruction: { kind: 'teach', text: 'PDF-et csatolj' },
      actor: actor('approver', APPROVER_ID),
    })
    const submitted = await h.service.submitTrainingProposal({
      previewId: preview.previewId,
      actor: actor('approver', APPROVER_ID),
    })
    const wsOwn = await h.service.getTrainingWorkspace({ agentId: AGENT_ID, actor: approver })
    assert.equal(wsOwn.allowedActions.includes('activate'), false)
    assert.equal(wsOwn.pendingProposal?.fourEyesWaiting, true)
    await assert.rejects(
      () =>
        h.service.activateTraining({
          ticketId: submitted.ticket.id,
          revisionId: submitted.currentRevision.id,
          actor: approver,
        }),
      (e: unknown) => e instanceof TrainingGateError && e.code === 'four_eyes_required',
    )
    const result = await h.service.activateTraining({
      ticketId: submitted.ticket.id,
      revisionId: submitted.currentRevision.id,
      actor: approverB,
    })
    assert.equal(result.memoryVersion.version, 4)
    const approved = h.auditLog.filter((a) => a.action === 'training.approved')
    assert.equal(approved.length, 1)
    assert.equal((approved[0]?.metadata as { revisionCreatedBy?: string }).revisionCreatedBy, APPROVER_ID)
    assert.equal(approved[0]?.actorId, APPROVER_B)
  })

  await test('T9: rejectTraining indok nélkül is megy; ha van indok, a ticket note-jába és az auditba kerül', async () => {
    const withoutReason = makeHarness()
    const previewA = await withoutReason.service.previewTrainingChange({
      agentId: AGENT_ID,
      instruction: { kind: 'teach', text: 'PDF-et csatolj' },
      actor: operator,
    })
    const submittedA = await withoutReason.service.submitTrainingProposal({
      previewId: previewA.previewId,
      actor: operator,
    })
    await withoutReason.service.rejectTraining({ ticketId: submittedA.ticket.id, actor: approver })
    const rejectedA = withoutReason.tickets.get(submittedA.ticket.id)
    assert.equal(rejectedA?.state, 'rejected')
    const payloadA = rejectedA?.payload as { transitionNote?: string }
    assert.equal(payloadA.transitionNote, undefined)
    const auditA = withoutReason.auditLog.find((entry) => entry.action === 'training.rejected')
    assert.ok(auditA)
    assert.equal(auditA?.inputRef, null)

    const withReason = makeHarness()
    const previewB = await withReason.service.previewTrainingChange({
      agentId: AGENT_ID,
      instruction: { kind: 'teach', text: 'PDF-et csatolj' },
      actor: operator,
    })
    const submittedB = await withReason.service.submitTrainingProposal({
      previewId: previewB.previewId,
      actor: operator,
    })
    await withReason.service.rejectTraining({
      ticketId: submittedB.ticket.id,
      reason: '  Nem illik a hangnemhez  ',
      actor: approver,
    })
    const rejectedB = withReason.tickets.get(submittedB.ticket.id)
    assert.equal(rejectedB?.state, 'rejected')
    const payloadB = rejectedB?.payload as { transitionNote?: string }
    assert.equal(payloadB.transitionNote, 'Nem illik a hangnemhez')
    const auditB = withReason.auditLog.find((entry) => entry.action === 'training.rejected')
    assert.equal(auditB?.inputRef, 'Nem illik a hangnemhez')
    assert.equal((auditB?.metadata as { reason?: string }).reason, 'Nem illik a hangnemhez')
  })

  await test('T8: rollback visszaállítja az instruction current pointert, projektmemória érintetlen', async () => {
    const h = makeHarness({
      profile: {
        scope: ['memory'],
        approval_mode: 'human',
        durable_memory_approval_policy: { activation_mode: 'operator_can_activate', four_eyes_required: false },
      },
    })
    const preview = await h.service.previewTrainingChange({
      agentId: AGENT_ID,
      instruction: { kind: 'teach', text: 'PDF-et csatolj' },
      actor: operator,
    })
    const submitted = await h.service.submitTrainingProposal({ previewId: preview.previewId, actor: operator })
    await h.service.activateTraining({
      ticketId: submitted.ticket.id,
      revisionId: submitted.currentRevision.id,
      actor: operator,
    })
    await h.service.rollbackMemory(AGENT_ID, 3, approver)
    assert.equal(h.currentInstructionId, 'ver-3')
    assert.equal(h.projectManifestCurrentId, 'proj-12')
    assert.ok(h.auditLog.some((a) => a.action === 'memory.rollback'))
  })

  if (failures > 0) {
    console.error(`\n${failures} teszt bukott`)
    process.exit(1)
  }
  console.log('\nÖsszes training-workspace teszt zöld')
}

run()
