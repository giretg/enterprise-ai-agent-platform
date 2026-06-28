/**
 * Determinisztikus integrációs teszt a Fázis 2 Playbook PROCESS RUNTIME-hoz
 * (Feature-spec — Playbook §7.2, §7.3, §8.2, §8.3, §12 F2-C, §13).
 * Futtatás: npm run test:playbook-v2-process
 *
 * DB és LLM NÉLKÜL, in-memory fake repókkal egy teljes agent → human → done
 * folyamatot futtat végig, és igazolja:
 *   - P4  — startProcess default assignmenttel, Playbook-verzió PIN-elve;
 *   - P5  — agent befejezi a belépő stepet → következő (emberi) step + ticket + delegacio;
 *   - P6  — agent NEM lépheti át a blocking emberi kaput (gate.bypass_denied), állapot marad;
 *   - P8  — rossz role / hiányzó bizonyíték → DENY;
 *   - P7  — jogosult approver átengedi a kaput (gate.approve);
 *   - P11 — a folyamat végigfut, process.complete, delegacio done;
 *   - P9  — futás közben v2 publikálása NEM hat a futó (v1-re pin-elt) processre.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type {
  AuditLog,
  DelegationEdge,
  PlaybookAssignment,
  PlaybookV2,
  PlaybookVersionV2,
  ProcessInstance,
  ProcessStepInstance,
  Ticket,
} from '@prisma/client'
import type {
  AuditRepository,
  CreateDelegationEdgeInput,
  CreatePlaybookAssignmentInput,
  CreatePlaybookV2Input,
  CreatePlaybookVersionV2Input,
  CreateProcessInstanceInput,
  CreateProcessStepInput,
  PlaybookV2Repository,
  PlaybookV2WithVersions,
  ProcessInstanceDetail,
  ProcessRepository,
  TicketRepository,
} from '../src/repositories/interfaces'
import { PlaybookV2Service } from '../src/domain/playbook/playbook-v2-service'
import { ProcessService } from '../src/domain/playbook/process-service'
import {
  TicketStateMachine,
  TicketTransitionDenied,
} from '../src/domain/playbook/ticket-state-machine'

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

// --- In-memory fakes --------------------------------------------------------

class FakeAuditRepository implements AuditRepository {
  entries: AuditLog[] = []
  async append(data: Omit<AuditLog, 'id' | 'seq' | 'createdAt' | 'hash' | 'prevHash'>) {
    const row = {
      ...data,
      id: randomUUID(),
      seq: BigInt(this.entries.length + 1),
      createdAt: new Date(),
      hash: null,
      prevHash: null,
    } as AuditLog
    this.entries.push(row)
    return row
  }
  async findMany() {
    return this.entries
  }
  async findAll() {
    return this.entries
  }
  async getActionCounts() {
    return {}
  }
  byAction(action: string) {
    return this.entries.filter((e) => e.action === action)
  }
}

class FakePlaybookV2Repository implements PlaybookV2Repository {
  playbooks: PlaybookV2[] = []
  versions: PlaybookVersionV2[] = []
  assignments: PlaybookAssignment[] = []

  async createPlaybook(input: CreatePlaybookV2Input): Promise<PlaybookV2> {
    const pb = {
      id: randomUUID(),
      tenantId: input.tenantId,
      key: input.key,
      name: input.name,
      description: input.description ?? null,
      processType: input.processType,
      status: 'draft',
      currentPublishedVersionId: null,
      ownerUserId: input.ownerUserId ?? null,
      createdAt: new Date(),
      updatedAt: new Date(),
      archivedAt: null,
    } as PlaybookV2
    this.playbooks.push(pb)
    return pb
  }
  async findPlaybook(tenantId: string | null, id: string) {
    return this.playbooks.find((p) => p.id === id && p.tenantId === tenantId) ?? null
  }
  async findPlaybookByKey(tenantId: string | null, key: string) {
    return this.playbooks.find((p) => p.key === key && p.tenantId === tenantId) ?? null
  }
  async listPlaybooks(tenantId: string | null): Promise<PlaybookV2WithVersions[]> {
    return this.playbooks
      .filter((p) => p.tenantId === tenantId)
      .map((p) => ({ ...p, versions: this.versions.filter((v) => v.playbookId === p.id) }))
  }
  async updatePlaybook(id: string, data: Record<string, unknown>) {
    const pb = this.playbooks.find((p) => p.id === id)!
    Object.assign(pb, data)
    return pb
  }
  async createVersion(input: CreatePlaybookVersionV2Input): Promise<PlaybookVersionV2> {
    const v = {
      id: randomUUID(),
      tenantId: input.tenantId,
      playbookId: input.playbookId,
      version: input.version,
      status: 'draft',
      spec: input.spec,
      compiledSpec: null,
      validationResult: input.validationResult,
      changeSummary: input.changeSummary,
      contentHash: input.contentHash,
      createdById: input.createdById,
      approvedById: null,
      approvedAt: null,
      publishedAt: null,
      retiredAt: null,
      createdAt: new Date(),
    } as unknown as PlaybookVersionV2
    this.versions.push(v)
    return v
  }
  async findVersion(tenantId: string | null, id: string) {
    return this.versions.find((v) => v.id === id && v.tenantId === tenantId) ?? null
  }
  async findVersionByContentHash(tenantId: string | null, playbookId: string, contentHash: string) {
    return (
      this.versions.find(
        (v) => v.tenantId === tenantId && v.playbookId === playbookId && v.contentHash === contentHash,
      ) ?? null
    )
  }
  async listVersions(playbookId: string) {
    return this.versions.filter((v) => v.playbookId === playbookId).sort((a, b) => b.version - a.version)
  }
  async nextVersionNumber(playbookId: string) {
    const max = this.versions
      .filter((v) => v.playbookId === playbookId)
      .reduce((m, v) => Math.max(m, v.version), 0)
    return max + 1
  }
  async updateVersion(id: string, data: Record<string, unknown>) {
    const v = this.versions.find((x) => x.id === id)!
    Object.assign(v, data)
    return v
  }
  async publishVersion(input: {
    versionId: string
    playbookId: string
    approverId: string
    compiledSpec: unknown
  }) {
    const now = new Date()
    for (const v of this.versions) {
      if (v.playbookId === input.playbookId && v.status === 'published') {
        v.status = 'retired' as PlaybookVersionV2['status']
        v.retiredAt = now
      }
    }
    const target = this.versions.find((v) => v.id === input.versionId)!
    target.status = 'published' as PlaybookVersionV2['status']
    target.approvedById = input.approverId
    target.approvedAt = now
    target.publishedAt = now
    target.compiledSpec = input.compiledSpec as PlaybookVersionV2['compiledSpec']
    const pb = this.playbooks.find((p) => p.id === input.playbookId)!
    pb.status = 'published' as PlaybookV2['status']
    pb.currentPublishedVersionId = target.id
    return target
  }
  async createAssignment(input: CreatePlaybookAssignmentInput): Promise<PlaybookAssignment> {
    if (input.isDefault) {
      for (const a of this.assignments) {
        if (
          a.tenantId === input.tenantId &&
          a.assignmentType === input.assignmentType &&
          a.assignmentKey === input.assignmentKey &&
          a.isDefault &&
          a.revokedAt === null
        ) {
          a.revokedAt = new Date()
        }
      }
    }
    const assignment = {
      id: randomUUID(),
      tenantId: input.tenantId,
      playbookId: input.playbookId,
      playbookVersionId: input.playbookVersionId,
      assignmentType: input.assignmentType,
      assignmentKey: input.assignmentKey,
      isDefault: input.isDefault,
      createdById: input.createdById,
      createdAt: new Date(),
      revokedAt: null,
    } as PlaybookAssignment
    this.assignments.push(assignment)
    return assignment
  }
  async findDefaultAssignment(tenantId: string | null, assignmentType: string, assignmentKey: string) {
    return (
      this.assignments.find(
        (a) =>
          a.tenantId === tenantId &&
          a.assignmentType === assignmentType &&
          a.assignmentKey === assignmentKey &&
          a.isDefault &&
          a.revokedAt === null,
      ) ?? null
    )
  }
}

class FakeProcessRepository implements ProcessRepository {
  processes: ProcessInstance[] = []
  steps: ProcessStepInstance[] = []
  delegations: DelegationEdge[] = []

  async createProcess(input: CreateProcessInstanceInput): Promise<ProcessInstance> {
    const p = {
      id: randomUUID(),
      tenantId: input.tenantId,
      processType: input.processType,
      status: 'created',
      playbookId: input.playbookId,
      playbookVersionId: input.playbookVersionId,
      playbookRef: input.playbookRef,
      playbookContentHash: input.playbookContentHash,
      startedByType: input.startedByType,
      startedByUserId: input.startedByUserId ?? null,
      startedByAgentId: input.startedByAgentId ?? null,
      conversationId: input.conversationId ?? null,
      rootTicketId: null,
      inputPayload: input.inputPayload,
      outputPayload: {},
      startedAt: new Date(),
      completedAt: null,
      failedAt: null,
    } as unknown as ProcessInstance
    this.processes.push(p)
    return p
  }
  async findProcess(tenantId: string | null, id: string) {
    return this.processes.find((p) => p.id === id && p.tenantId === tenantId) ?? null
  }
  async findProcessDetail(tenantId: string | null, id: string): Promise<ProcessInstanceDetail | null> {
    const p = await this.findProcess(tenantId, id)
    if (!p) return null
    return {
      ...p,
      steps: this.steps.filter((s) => s.processInstanceId === id),
      delegations: this.delegations.filter((d) => d.processInstanceId === id),
    }
  }
  async listProcesses(tenantId: string | null) {
    return this.processes.filter((p) => p.tenantId === tenantId)
  }
  async updateProcess(id: string, data: Record<string, unknown>) {
    const p = this.processes.find((x) => x.id === id)!
    Object.assign(p, data)
    return p
  }
  async createStep(input: CreateProcessStepInput): Promise<ProcessStepInstance> {
    const s = {
      id: randomUUID(),
      tenantId: input.tenantId,
      processInstanceId: input.processInstanceId,
      stepId: input.stepId,
      stepName: input.stepName,
      status: input.status ?? 'pending',
      assignedRole: input.assignedRole,
      assignedAgentId: input.assignedAgentId ?? null,
      assignedUserId: input.assignedUserId ?? null,
      ticketId: input.ticketId ?? null,
      startedAt: null,
      completedAt: null,
      failedAt: null,
      resultPayload: {},
    } as unknown as ProcessStepInstance
    this.steps.push(s)
    return s
  }
  async findStep(processInstanceId: string, stepId: string) {
    return this.steps.find((s) => s.processInstanceId === processInstanceId && s.stepId === stepId) ?? null
  }
  async findStepByTicket(tenantId: string | null, ticketId: string) {
    return this.steps.find((s) => s.tenantId === tenantId && s.ticketId === ticketId) ?? null
  }
  async listSteps(processInstanceId: string) {
    return this.steps.filter((s) => s.processInstanceId === processInstanceId)
  }
  async updateStep(id: string, data: Record<string, unknown>) {
    const s = this.steps.find((x) => x.id === id)!
    Object.assign(s, data)
    return s
  }
  async createDelegation(input: CreateDelegationEdgeInput): Promise<DelegationEdge> {
    const d = {
      id: randomUUID(),
      tenantId: input.tenantId,
      processInstanceId: input.processInstanceId,
      fromStepId: input.fromStepId,
      toStepId: input.toStepId,
      fromTicketId: input.fromTicketId ?? null,
      toTicketId: input.toTicketId ?? null,
      fromActorType: input.fromActorType,
      fromAgentId: input.fromAgentId ?? null,
      fromUserId: input.fromUserId ?? null,
      toActorType: input.toActorType,
      toAgentId: input.toAgentId ?? null,
      toUserId: input.toUserId ?? null,
      status: 'pending',
      createdAt: new Date(),
      deliveredAt: null,
      acceptedAt: null,
      doneAt: null,
      failedAt: null,
      metadata: input.metadata ?? {},
    } as unknown as DelegationEdge
    this.delegations.push(d)
    return d
  }
  async listDelegations(processInstanceId: string) {
    return this.delegations.filter((d) => d.processInstanceId === processInstanceId)
  }
  async updateDelegation(id: string, data: Record<string, unknown>) {
    const d = this.delegations.find((x) => x.id === id)!
    Object.assign(d, data)
    return d
  }
}

class FakeTicketRepository {
  tickets: Ticket[] = []
  transitions: Array<{ ticketId: string; fromState: string; toState: string }> = []

  async findById(id: string) {
    return this.tickets.find((t) => t.id === id) ?? null
  }
  async create(data: Record<string, unknown>) {
    const t = {
      id: randomUUID(),
      createdAt: new Date(),
      updatedAt: new Date(),
      lockToken: null,
      lockedAt: null,
      executeAfter: null,
      dueBy: null,
      source: 'system',
      ...data,
    } as unknown as Ticket
    this.tickets.push(t)
    return t
  }
  async update(id: string, data: Record<string, unknown>) {
    const t = this.tickets.find((x) => x.id === id)!
    Object.assign(t, data)
    return t
  }
  async recordTransition(data: { ticketId: string; fromState: string; toState: string }) {
    this.transitions.push({ ticketId: data.ticketId, fromState: data.fromState, toState: data.toState })
    return data as never
  }
}

// --- Spec fixtura -----------------------------------------------------------

function demoSpec(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: '1.0',
    key: 'invoice-processing',
    name: 'Bejövő számla feldolgozás',
    processType: 'invoice_processing',
    entryStepId: 'extract',
    roles: [
      { key: 'extractor', type: 'agent_role' },
      { key: 'approver', type: 'human_role', requiredPermissions: ['ticket:approve'] },
    ],
    steps: [
      {
        id: 'extract',
        name: 'Számlaadatok kinyerése',
        ticketType: 'invoice_extract',
        assignedRole: 'extractor',
        allowedStates: ['ready', 'in_progress', 'done'],
        onComplete: [{ condition: 'default', nextStepId: 'approval' }],
      },
      {
        id: 'approval',
        name: 'Könyvelési jóváhagyás',
        ticketType: 'human_approval',
        assignedRole: 'approver',
        allowedStates: ['awaiting_human', 'approved'],
        requiredGateIds: ['approve_posting'],
      },
    ],
    gates: [
      {
        id: 'approve_posting',
        type: 'human_approval',
        requiredActorRole: 'approver',
        blocking: true,
        criticality: 'L1',
        evidenceRequired: true,
      },
    ],
    transitions: [{ fromStepId: 'extract', toStepId: 'approval', trigger: 'step.completed' }],
    outputContract: { requiredFields: ['decision'] },
    ...overrides,
  }
}

const TENANT = randomUUID()
const AUTHOR = randomUUID()
const APPROVER_USER = randomUUID()
const AGENT = randomUUID()

/** Publikál egy Playbookot + default assignmentet, és visszaadja a wired service-eket. */
async function setupPublished(spec: Record<string, unknown>) {
  const pbRepo = new FakePlaybookV2Repository()
  const procRepo = new FakeProcessRepository()
  const ticketRepo = new FakeTicketRepository()
  const audit = new FakeAuditRepository()

  const registry = new PlaybookV2Service(pbRepo, audit)
  const pb = await registry.createPlaybook({
    tenantId: TENANT,
    key: spec.key as string,
    name: 'demo',
    processType: spec.processType as string,
    actorUserId: AUTHOR,
  })
  const { version } = await registry.createPlaybookVersion({
    tenantId: TENANT,
    playbookId: pb.id,
    spec,
    changeSummary: 'init',
    actorUserId: AUTHOR,
  })
  await registry.submitForApproval({ tenantId: TENANT, playbookVersionId: version.id, actorUserId: AUTHOR })
  await registry.publishPlaybookVersion({
    tenantId: TENANT,
    playbookVersionId: version.id,
    approverUserId: APPROVER_USER,
  })
  await registry.assignPlaybook({
    tenantId: TENANT,
    playbookVersionId: version.id,
    assignmentType: 'process_type',
    assignmentKey: spec.processType as string,
    isDefault: true,
    actorUserId: AUTHOR,
  })

  const ticketRepoTyped = ticketRepo as unknown as TicketRepository
  const processService = new ProcessService(procRepo, pbRepo, ticketRepoTyped, audit)
  const stateMachine = new TicketStateMachine(ticketRepoTyped, pbRepo, procRepo, audit, processService)

  return { pbRepo, procRepo, ticketRepo, audit, registry, processService, stateMachine, versionId: version.id }
}

async function main() {
  console.log('Playbook V2 Process runtime (F2-C) tesztek\n')

  await test('P4 — startProcess default assignmenttel, verzió PIN-elve', async () => {
    const ctx = await setupPublished(demoSpec())
    const proc = await ctx.processService.startProcess({
      tenantId: TENANT,
      processType: 'invoice_processing',
      inputPayload: { invoiceId: 'INV-1' },
      startedBy: { type: 'user', id: AUTHOR },
    })
    assert.equal(proc.status, 'running')
    assert.equal(proc.playbookVersionId, ctx.versionId)
    assert.ok(proc.rootTicketId, 'nincs root ticket')
    assert.equal(ctx.audit.byAction('process.start').length, 1)

    const entryTicket = ctx.ticketRepo.tickets.find((t) => t.id === proc.rootTicketId)!
    assert.equal(entryTicket.state, 'ready')
    assert.equal(entryTicket.assigneeType, 'agent')
    assert.equal(entryTicket.playbookStepId, 'extract')
    assert.equal(entryTicket.playbookVersionId, ctx.versionId)
  })

  await test('P5 — agent befejezi a belépő stepet → emberi step + ticket + delegacio (delivered)', async () => {
    const ctx = await setupPublished(demoSpec())
    const proc = await ctx.processService.startProcess({
      tenantId: TENANT,
      processType: 'invoice_processing',
      inputPayload: {},
      startedBy: { type: 'agent', id: AGENT },
    })
    const entry = ctx.ticketRepo.tickets.find((t) => t.id === proc.rootTicketId)!

    await ctx.stateMachine.transitionTicket({
      tenantId: TENANT,
      ticketId: entry.id,
      toState: 'in_progress',
      actor: { type: 'agent', id: AGENT },
    })
    await ctx.stateMachine.transitionTicket({
      tenantId: TENANT,
      ticketId: entry.id,
      toState: 'done',
      actor: { type: 'agent', id: AGENT },
      outputPayload: { decision: 'post', invoiceNumber: 'INV-1' },
    })

    // Következő (emberi) ticket létrejött, PIN-elt verzióval és kapuval.
    const approvalTicket = ctx.ticketRepo.tickets.find((t) => t.playbookStepId === 'approval')!
    assert.ok(approvalTicket, 'nincs approval ticket')
    assert.equal(approvalTicket.state, 'awaiting_human')
    assert.equal(approvalTicket.assigneeType, 'human')
    assert.equal(approvalTicket.requiredGateId, 'approve_posting')
    assert.equal(approvalTicket.playbookVersionId, ctx.versionId)

    // Delegacio él: extract → approval, delivered.
    const delegation = ctx.procRepo.delegations.find((d) => d.toStepId === 'approval')!
    assert.ok(delegation, 'nincs delegacios él')
    assert.equal(delegation.status, 'delivered')
    assert.equal(ctx.audit.byAction('process.step.create').length, 2) // entry + approval
    assert.equal(ctx.audit.byAction('delegation.create').length, 1)
  })

  await test('P6 — agent NEM lépheti át a blocking emberi kaput (gate.bypass_denied)', async () => {
    const ctx = await setupPublished(demoSpec())
    const proc = await ctx.processService.startProcess({
      tenantId: TENANT,
      processType: 'invoice_processing',
      inputPayload: {},
      startedBy: { type: 'agent', id: AGENT },
    })
    const entry = ctx.ticketRepo.tickets.find((t) => t.id === proc.rootTicketId)!
    await ctx.stateMachine.transitionTicket({ tenantId: TENANT, ticketId: entry.id, toState: 'in_progress', actor: { type: 'agent', id: AGENT } })
    await ctx.stateMachine.transitionTicket({
      tenantId: TENANT,
      ticketId: entry.id,
      toState: 'done',
      actor: { type: 'agent', id: AGENT },
      outputPayload: { decision: 'post' },
    })
    const approvalTicket = ctx.ticketRepo.tickets.find((t) => t.playbookStepId === 'approval')!

    // Az agent megpróbálja jóváhagyni (kapumegkerülés) → DENY, állapot marad.
    await assert.rejects(
      () =>
        ctx.stateMachine.transitionTicket({
          tenantId: TENANT,
          ticketId: approvalTicket.id,
          toState: 'approved',
          actor: { type: 'agent', id: AGENT },
        }),
      (e: unknown) => e instanceof TicketTransitionDenied && e.detail.denyCode === 'GATE_BYPASS_DENIED',
    )
    const after = await ctx.ticketRepo.findById(approvalTicket.id)
    assert.equal(after?.state, 'awaiting_human', 'a tiltott átmenet után megváltozott az állapot')
    assert.equal(ctx.audit.byAction('gate.bypass_denied').length, 1)
    assert.equal(ctx.audit.byAction('ticket.transition.denied').length, 1)
  })

  await test('P8 — rossz role és hiányzó bizonyíték → DENY', async () => {
    const ctx = await setupPublished(demoSpec())
    const proc = await ctx.processService.startProcess({
      tenantId: TENANT,
      processType: 'invoice_processing',
      inputPayload: {},
      startedBy: { type: 'agent', id: AGENT },
    })
    const entry = ctx.ticketRepo.tickets.find((t) => t.id === proc.rootTicketId)!
    await ctx.stateMachine.transitionTicket({ tenantId: TENANT, ticketId: entry.id, toState: 'in_progress', actor: { type: 'agent', id: AGENT } })
    await ctx.stateMachine.transitionTicket({ tenantId: TENANT, ticketId: entry.id, toState: 'done', actor: { type: 'agent', id: AGENT }, outputPayload: { decision: 'post' } })
    const approvalTicket = ctx.ticketRepo.tickets.find((t) => t.playbookStepId === 'approval')!

    // Rossz role
    await assert.rejects(
      () =>
        ctx.stateMachine.transitionTicket({
          tenantId: TENANT,
          ticketId: approvalTicket.id,
          toState: 'approved',
          actor: { type: 'user', id: APPROVER_USER, roles: ['viewer'] },
          approvalEvidence: { note: 'ok' },
        }),
      (e: unknown) => e instanceof TicketTransitionDenied && e.detail.denyCode === 'GATE_ACTOR_ROLE',
    )
    // Jó role, de nincs bizonyíték
    await assert.rejects(
      () =>
        ctx.stateMachine.transitionTicket({
          tenantId: TENANT,
          ticketId: approvalTicket.id,
          toState: 'approved',
          actor: { type: 'user', id: APPROVER_USER, roles: ['approver'] },
        }),
      (e: unknown) => e instanceof TicketTransitionDenied && e.detail.denyCode === 'GATE_EVIDENCE_REQUIRED',
    )
  })

  await test('P7 + P11 — jogosult approver átengedi a kaput, a folyamat lezárul', async () => {
    const ctx = await setupPublished(demoSpec())
    const proc = await ctx.processService.startProcess({
      tenantId: TENANT,
      processType: 'invoice_processing',
      inputPayload: {},
      startedBy: { type: 'agent', id: AGENT },
    })
    const entry = ctx.ticketRepo.tickets.find((t) => t.id === proc.rootTicketId)!
    await ctx.stateMachine.transitionTicket({ tenantId: TENANT, ticketId: entry.id, toState: 'in_progress', actor: { type: 'agent', id: AGENT } })
    await ctx.stateMachine.transitionTicket({ tenantId: TENANT, ticketId: entry.id, toState: 'done', actor: { type: 'agent', id: AGENT }, outputPayload: { decision: 'post' } })
    const approvalTicket = ctx.ticketRepo.tickets.find((t) => t.playbookStepId === 'approval')!

    await ctx.stateMachine.transitionTicket({
      tenantId: TENANT,
      ticketId: approvalTicket.id,
      toState: 'approved',
      actor: { type: 'user', id: APPROVER_USER, roles: ['approver'] },
      approvalEvidence: { signature: 'sig-123' },
    })

    const finalTicket = await ctx.ticketRepo.findById(approvalTicket.id)
    assert.equal(finalTicket?.state, 'approved')
    assert.equal(ctx.audit.byAction('gate.approve').length, 1)

    const finishedProc = await ctx.processService.getProcess(TENANT, proc.id)
    assert.equal(finishedProc.status, 'completed')
    assert.equal(ctx.audit.byAction('process.complete').length, 1)

    // A delegacios él lezárult (done).
    const delegation = ctx.procRepo.delegations.find((d) => d.toStepId === 'approval')!
    assert.equal(delegation.status, 'done')

    // Mindkét step completed.
    const steps = await ctx.procRepo.listSteps(proc.id)
    assert.ok(steps.every((s) => s.status === 'completed'), 'nem minden step completed')
  })

  await test('P9 — futás közbeni v2 publikálás NEM hat a futó (v1-re pin-elt) processre', async () => {
    const ctx = await setupPublished(demoSpec())
    const v1 = ctx.versionId

    // Indítunk egy folyamatot v1-en, és eljutunk az approval lépésig.
    const proc = await ctx.processService.startProcess({
      tenantId: TENANT,
      processType: 'invoice_processing',
      inputPayload: {},
      startedBy: { type: 'agent', id: AGENT },
    })
    const entry = ctx.ticketRepo.tickets.find((t) => t.id === proc.rootTicketId)!
    await ctx.stateMachine.transitionTicket({ tenantId: TENANT, ticketId: entry.id, toState: 'in_progress', actor: { type: 'agent', id: AGENT } })
    await ctx.stateMachine.transitionTicket({ tenantId: TENANT, ticketId: entry.id, toState: 'done', actor: { type: 'agent', id: AGENT }, outputPayload: { decision: 'post' } })

    // Új tartalmú v2 publikálása + default átállítás v2-re.
    const pb = ctx.pbRepo.playbooks[0]
    const { version: v2 } = await ctx.registry.createPlaybookVersion({
      tenantId: TENANT,
      playbookId: pb.id,
      spec: demoSpec({ name: 'v2 módosítás' }),
      changeSummary: 'v2',
      actorUserId: AUTHOR,
    })
    await ctx.registry.submitForApproval({ tenantId: TENANT, playbookVersionId: v2.id, actorUserId: AUTHOR })
    await ctx.registry.publishPlaybookVersion({ tenantId: TENANT, playbookVersionId: v2.id, approverUserId: APPROVER_USER })
    await ctx.registry.assignPlaybook({
      tenantId: TENANT,
      playbookVersionId: v2.id,
      assignmentType: 'process_type',
      assignmentKey: 'invoice_processing',
      isDefault: true,
      actorUserId: AUTHOR,
    })

    // A futó process minden ticketje továbbra is v1-re pin-elt.
    const runningTickets = ctx.ticketRepo.tickets.filter((t) => t.processInstanceId === proc.id)
    assert.ok(runningTickets.length >= 2)
    assert.ok(runningTickets.every((t) => t.playbookVersionId === v1), 'futó process ticketje nem v1-en van')
    const runningProc = await ctx.processService.getProcess(TENANT, proc.id)
    assert.equal(runningProc.playbookVersionId, v1)

    // Új process viszont már v2-t pin-eli.
    const proc2 = await ctx.processService.startProcess({
      tenantId: TENANT,
      processType: 'invoice_processing',
      inputPayload: {},
      startedBy: { type: 'agent', id: AGENT },
    })
    assert.equal(proc2.playbookVersionId, v2.id)
  })

  await test('P10 — másik tenant processe NOT_FOUND_OR_FORBIDDEN', async () => {
    const ctx = await setupPublished(demoSpec())
    const proc = await ctx.processService.startProcess({
      tenantId: TENANT,
      processType: 'invoice_processing',
      inputPayload: {},
      startedBy: { type: 'user', id: AUTHOR },
    })
    await assert.rejects(() => ctx.processService.getProcess(randomUUID(), proc.id))
  })

  console.log(`\n${failures === 0 ? '✅ Mind zöld' : `❌ ${failures} bukott teszt`}`)
  if (failures > 0) process.exit(1)
}

void main()
