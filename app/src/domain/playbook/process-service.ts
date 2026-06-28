/**
 * ProcessService (Feature-spec — Playbook §8.2, §7.3, §12 F2-C).
 *
 * A Fázis 2 process runtime: folyamatinditas Playbook-verzio PIN-eléssel, a
 * következő step/ticket determinisztikus létrehozása a pin-elt `compiled_spec`
 * routing szabályai alapján, és a delegacios él-lánc (pending → delivered → done).
 *
 * KULCS-INVARIÁNSOK, amelyeket KÓDSZINTEN véd (§2):
 *  - egy folyamatinditas pontosan EGY `playbook_version_id`-t pin-el, és az a
 *    folyamat végéig nem cserélhető (§2.1, §2.2, P9);
 *  - a runtime SOHA nem a draft Playbookot olvassa, hanem a pin-elt verzió
 *    `compiled_spec`-jét (§15, P9);
 *  - a kötelező kapukat NEM itt, hanem a `TicketStateMachine` ticket-szinten
 *    kényszeríti ki; ez a réteg csak a routingot és a step/delegacio-vezetést végzi.
 *
 * A determinisztikus döntéseket a `@/lib/playbook-v2/runtime` (`evaluateAdvance`)
 * tiszta magja hozza; ez a service köti DB-hez és audithoz.
 */
import type { Prisma, ProcessInstance, TicketState } from '@prisma/client'
import type { CompiledSpec } from '@/domain/playbook/playbook-compiler'
import { evaluateAdvance } from '@/lib/playbook-v2/runtime'
import { formatPlaybookRefV2 } from '@/lib/playbook-v2/spec'
import type {
  AuditRepository,
  PlaybookV2Repository,
  ProcessRepository,
  TicketRepository,
} from '@/repositories/interfaces'

export type ProcessActor = { type: 'user' | 'agent' | 'system'; id?: string | null }

export type ProcessServiceErrorCode =
  | 'NOT_FOUND_OR_FORBIDDEN'
  | 'NO_PLAYBOOK_ASSIGNED'
  | 'VERSION_NOT_PUBLISHED'
  | 'COMPILED_SPEC_MISSING'
  | 'INVALID_STATE'

export class ProcessServiceError extends Error {
  constructor(
    readonly code: ProcessServiceErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'ProcessServiceError'
  }
}

export type ProcessAdvanceResult =
  | { kind: 'next_step'; stepId: string; ticketId: string }
  | { kind: 'await_gate'; gateId: string; ticketId: string }
  | { kind: 'completed' }

export class ProcessService {
  constructor(
    private readonly processes: ProcessRepository,
    private readonly playbooks: PlaybookV2Repository,
    private readonly tickets: TicketRepository,
    private readonly audit: AuditRepository,
  ) {}

  // --- §8.2 startProcess -----------------------------------------------------

  async startProcess(input: {
    tenantId: string | null
    processType: string
    playbookVersionId?: string
    inputPayload: Record<string, unknown>
    startedBy: ProcessActor
    conversationId?: string | null
  }): Promise<ProcessInstance> {
    // §8.2 — explicit verzió, vagy default assignment a process_type-hoz.
    const versionId = input.playbookVersionId ?? (await this.resolveDefaultVersionId(input.tenantId, input.processType))
    const version = await this.playbooks.findVersion(input.tenantId, versionId)
    if (!version) {
      throw new ProcessServiceError('NOT_FOUND_OR_FORBIDDEN', 'A Playbook-verzió nem található vagy nincs jogosultság.')
    }
    if (version.status !== 'published') {
      throw new ProcessServiceError('VERSION_NOT_PUBLISHED', 'Csak published Playbook-verzióval indítható folyamat.')
    }
    const playbook = await this.playbooks.findPlaybook(input.tenantId, version.playbookId)
    if (!playbook) {
      throw new ProcessServiceError('NOT_FOUND_OR_FORBIDDEN', 'A Playbook nem található.')
    }
    const compiled = this.requireCompiled(version.compiledSpec)
    const playbookRef = formatPlaybookRefV2(playbook.key, version.version)

    // §4.5 — process_instance létrehozás a PIN-elt verzióval.
    const process = await this.processes.createProcess({
      tenantId: input.tenantId,
      processType: input.processType,
      playbookId: playbook.id,
      playbookVersionId: version.id,
      playbookRef,
      playbookContentHash: version.contentHash,
      startedByType: input.startedBy.type,
      startedByUserId: input.startedBy.type === 'user' ? input.startedBy.id ?? null : null,
      startedByAgentId: input.startedBy.type === 'agent' ? input.startedBy.id ?? null : null,
      conversationId: input.conversationId ?? null,
      inputPayload: input.inputPayload as Prisma.InputJsonValue,
    })

    await this.append(input.tenantId, input.startedBy, {
      action: 'process.start',
      targetType: 'process_instance',
      targetId: process.id,
      inputRef: playbookRef,
      outputRef: version.contentHash,
      policyDecision: 'started',
      metadata: {
        process_instance_id: process.id,
        process_type: input.processType,
        playbook_id: playbook.id,
        playbook_version_id: version.id,
        playbook_ref: playbookRef,
        playbook_content_hash: version.contentHash,
        started_by_type: input.startedBy.type,
        conversation_id: input.conversationId ?? null,
      },
    })

    // Belépő step + root ticket létrehozása (§7.3 entryStepId).
    const entryRule = compiled.ticketRules.find((r) => r.stepId === compiled.entryStepId)
    if (!entryRule) {
      throw new ProcessServiceError('COMPILED_SPEC_MISSING', 'A compiled spec nem tartalmaz belépő stepet.')
    }
    const ticket = await this.createStepWithTicket(input.tenantId, process, compiled, entryRule.stepId, input.startedBy)

    await this.processes.updateProcess(process.id, { status: 'running', rootTicketId: ticket.id })
    return this.processes.findProcess(input.tenantId, process.id) as Promise<ProcessInstance>
  }

  // --- §8.2 advance ----------------------------------------------------------

  /**
   * §7.3 — a befejezett step routing-szabályai alapján létrehozza a következő
   * stepet/ticketet, vagy kaput nyit, vagy lezárja a folyamatot. A determinisztikus
   * választást az `evaluateAdvance` tiszta mag hozza a pin-elt compiled spec ellen.
   */
  async advance(input: {
    tenantId: string | null
    processInstanceId: string
    completedStepId: string
    completedGateId?: string | null
    actor: ProcessActor
    resultPayload?: Record<string, unknown>
  }): Promise<ProcessAdvanceResult> {
    const process = await this.processes.findProcess(input.tenantId, input.processInstanceId)
    if (!process) {
      throw new ProcessServiceError('NOT_FOUND_OR_FORBIDDEN', 'A folyamat nem található vagy nincs jogosultság.')
    }
    const version = await this.playbooks.findVersion(input.tenantId, process.playbookVersionId)
    const compiled = this.requireCompiled(version?.compiledSpec)

    const completedStep = await this.processes.findStep(process.id, input.completedStepId)
    if (completedStep && completedStep.status !== 'completed') {
      await this.processes.updateStep(completedStep.id, {
        status: 'completed',
        completedAt: new Date(),
        resultPayload: (input.resultPayload ?? {}) as Prisma.InputJsonValue,
      })
    }
    await this.append(input.tenantId, input.actor, {
      action: 'process.step.complete',
      targetType: 'process_step_instance',
      targetId: completedStep?.id ?? input.completedStepId,
      inputRef: process.playbookRef,
      policyDecision: 'completed',
      metadata: { process_instance_id: process.id, step_id: input.completedStepId },
    })

    // Az ebbe a stepbe vezető delegacios él(ek) lezárása (done).
    await this.closeIncomingDelegations(process.id, input.completedStepId)

    const decision = input.completedGateId
      ? this.evaluateGateAdvance(compiled, input.completedStepId, input.completedGateId)
      : evaluateAdvance(compiled, input.completedStepId, input.resultPayload ?? {})

    if (decision.kind === 'complete') {
      await this.processes.updateProcess(process.id, {
        status: 'completed',
        completedAt: new Date(),
        outputPayload: (input.resultPayload ?? {}) as Prisma.InputJsonValue,
      })
      await this.append(input.tenantId, input.actor, {
        action: 'process.complete',
        targetType: 'process_instance',
        targetId: process.id,
        inputRef: process.playbookRef,
        policyDecision: 'completed',
        metadata: { process_instance_id: process.id },
      })
      return { kind: 'completed' }
    }

    if (decision.kind === 'await_gate') {
      // §7.3 — kötelező kapu ág: a step kapura vár, a folyamat emberi jóváhagyásra.
      if (completedStep) {
        await this.processes.updateStep(completedStep.id, { status: 'awaiting_gate' })
      }
      const gate = compiled.gates.find((g) => g.gateId === decision.gateId)
      const gateTicket = await this.tickets.create({
        tenantId: input.tenantId,
        type: 'interaction',
        title: `Kapu jóváhagyás: ${decision.gateId}`,
        state: 'awaiting_human',
        assigneeType: 'human',
        assigneeId: null,
        agentId: null,
        payload: (input.resultPayload ?? {}) as Prisma.JsonObject,
        sourceDocumentId: null,
        executeAfter: null,
        dueBy: null,
        createdById: this.systemUserId(process),
        processInstanceId: process.id,
        playbookRef: process.playbookRef,
        playbookVersionId: process.playbookVersionId,
        playbookStepId: input.completedStepId,
        requiredGateId: decision.gateId,
      })
      await this.processes.updateProcess(process.id, { status: 'awaiting_human' })
      await this.append(input.tenantId, input.actor, {
        action: 'process.step.await_gate',
        targetType: 'process_instance',
        targetId: process.id,
        inputRef: process.playbookRef,
        policyDecision: 'awaiting_gate',
        metadata: {
          process_instance_id: process.id,
          gate_id: decision.gateId,
          required_actor_role: gate?.requiredActorRole ?? null,
          ticket_id: gateTicket.id,
        },
      })
      return { kind: 'await_gate', gateId: decision.gateId, ticketId: gateTicket.id }
    }

    // decision.kind === 'next_step'
    if (process.status !== 'running') {
      await this.processes.updateProcess(process.id, { status: 'running' })
    }
    const nextTicket = await this.createStepWithTicket(
      input.tenantId,
      process,
      compiled,
      decision.toStepId,
      input.actor,
      { fromStepId: input.completedStepId, fromTicketId: completedStep?.ticketId ?? null },
    )
    return { kind: 'next_step', stepId: decision.toStepId, ticketId: nextTicket.id }
  }

  private evaluateGateAdvance(
    compiled: CompiledSpec,
    completedStepId: string,
    completedGateId: string,
  ): Exclude<ReturnType<typeof evaluateAdvance>, { kind: 'await_gate' }> {
    const gateRule = compiled.routingRules.find(
      (r) => r.fromStepId === completedStepId && r.gateId === completedGateId,
    )
    if (!gateRule?.toStepId) return { kind: 'complete' }
    return { kind: 'next_step', toStepId: gateRule.toStepId, rule: gateRule }
  }

  // --- §8.2 cancelProcess ----------------------------------------------------

  async cancelProcess(input: {
    tenantId: string | null
    processInstanceId: string
    reason: string
    actorUserId: string
  }): Promise<ProcessInstance> {
    const process = await this.processes.findProcess(input.tenantId, input.processInstanceId)
    if (!process) {
      throw new ProcessServiceError('NOT_FOUND_OR_FORBIDDEN', 'A folyamat nem található vagy nincs jogosultság.')
    }
    if (process.status === 'completed' || process.status === 'cancelled') {
      throw new ProcessServiceError('INVALID_STATE', `Lezárt folyamat nem vonható vissza (${process.status}).`)
    }
    const updated = await this.processes.updateProcess(process.id, {
      status: 'cancelled',
      completedAt: new Date(),
    })
    await this.append(input.tenantId, { type: 'user', id: input.actorUserId }, {
      action: 'process.cancel',
      targetType: 'process_instance',
      targetId: process.id,
      inputRef: process.playbookRef,
      policyDecision: 'cancelled',
      metadata: { process_instance_id: process.id, reason: input.reason },
    })
    return updated
  }

  async getProcess(tenantId: string | null, processInstanceId: string) {
    const detail = await this.processes.findProcessDetail(tenantId, processInstanceId)
    if (!detail) {
      throw new ProcessServiceError('NOT_FOUND_OR_FORBIDDEN', 'A folyamat nem található vagy nincs jogosultság.')
    }
    return detail
  }

  async listProcesses(tenantId: string | null) {
    return this.processes.listProcesses(tenantId)
  }

  // --- Belső segédek ---------------------------------------------------------

  /** Step instance + a hozzá tartozó ticket létrehozása, opcionális delegacios éllel. */
  private async createStepWithTicket(
    tenantId: string | null,
    process: ProcessInstance,
    compiled: CompiledSpec,
    stepId: string,
    actor: ProcessActor,
    delegationFrom?: { fromStepId: string; fromTicketId: string | null },
  ) {
    const rule = compiled.ticketRules.find((r) => r.stepId === stepId)
    if (!rule) {
      throw new ProcessServiceError('COMPILED_SPEC_MISSING', `Nincs compiled szabály a(z) '${stepId}' stephez.`)
    }
    const isHuman = this.isHumanStep(rule)
    const requiredGateId = isHuman
      ? compiled.gates.find((g) => g.stepId === stepId && g.blocking)?.gateId ?? null
      : null

    const step = await this.processes.createStep({
      tenantId,
      processInstanceId: process.id,
      stepId: rule.stepId,
      stepName: rule.stepName,
      status: 'ready',
      assignedRole: rule.assignedRole,
    })

    // A belépő agent-step azonnal dispatch-elhető (ready); az emberi step awaiting_human.
    const ticketState: TicketState = isHuman ? 'awaiting_human' : 'ready'
    const ticket = await this.tickets.create({
      tenantId,
      type: 'interaction',
      title: rule.stepName,
      state: ticketState,
      assigneeType: isHuman ? 'human' : 'agent',
      assigneeId: null,
      agentId: null,
      payload: {} as Prisma.JsonObject,
      sourceDocumentId: null,
      executeAfter: null,
      dueBy: null,
      createdById: this.systemUserId(process),
      processInstanceId: process.id,
      playbookRef: process.playbookRef,
      playbookVersionId: process.playbookVersionId,
      playbookStepId: rule.stepId,
      requiredGateId,
    })

    await this.processes.updateStep(step.id, { ticketId: ticket.id, startedAt: new Date() })

    await this.append(tenantId, actor, {
      action: 'process.step.create',
      targetType: 'process_step_instance',
      targetId: step.id,
      inputRef: process.playbookRef,
      policyDecision: 'ready',
      metadata: {
        process_instance_id: process.id,
        step_id: rule.stepId,
        ticket_id: ticket.id,
        assignee_type: isHuman ? 'human' : 'agent',
        required_gate_id: requiredGateId,
      },
    })

    if (delegationFrom) {
      const delegation = await this.processes.createDelegation({
        tenantId,
        processInstanceId: process.id,
        fromStepId: delegationFrom.fromStepId,
        toStepId: rule.stepId,
        fromTicketId: delegationFrom.fromTicketId,
        toTicketId: ticket.id,
        fromActorType: actor.type,
        fromAgentId: actor.type === 'agent' ? actor.id ?? null : null,
        fromUserId: actor.type === 'user' ? actor.id ?? null : null,
        toActorType: isHuman ? 'user' : 'agent',
      })
      // A ready ticket egyúttal "delivered" a fogadó szereplőnek (§4.7 delegacios státusz).
      await this.processes.updateDelegation(delegation.id, {
        status: 'delivered',
        deliveredAt: new Date(),
      })
      await this.append(tenantId, actor, {
        action: 'delegation.create',
        targetType: 'delegation_edge',
        targetId: delegation.id,
        inputRef: process.playbookRef,
        policyDecision: 'delivered',
        metadata: {
          process_instance_id: process.id,
          from_step_id: delegationFrom.fromStepId,
          to_step_id: rule.stepId,
          to_ticket_id: ticket.id,
        },
      })
    }

    return ticket
  }

  /** Az adott stepbe vezető nyitott delegacios él(eke)t done-ra állítja (§4.7). */
  private async closeIncomingDelegations(processInstanceId: string, toStepId: string) {
    const delegations = await this.processes.listDelegations(processInstanceId)
    for (const d of delegations) {
      if (d.toStepId === toStepId && d.status !== 'done' && d.status !== 'failed') {
        await this.processes.updateDelegation(d.id, { status: 'done', doneAt: new Date() })
      }
    }
  }

  private async resolveDefaultVersionId(tenantId: string | null, processType: string): Promise<string> {
    const assignment = await this.playbooks.findDefaultAssignment(tenantId, 'process_type', processType)
    if (!assignment) {
      throw new ProcessServiceError(
        'NO_PLAYBOOK_ASSIGNED',
        `Nincs default Playbook a(z) '${processType}' folyamattípushoz.`,
      )
    }
    return assignment.playbookVersionId
  }

  private requireCompiled(compiledSpec: unknown): CompiledSpec {
    if (!compiledSpec || typeof compiledSpec !== 'object') {
      throw new ProcessServiceError('COMPILED_SPEC_MISSING', 'A pin-elt verziónak nincs compiled spec-je.')
    }
    return compiledSpec as CompiledSpec
  }

  private isHumanStep(rule: CompiledSpec['ticketRules'][number]): boolean {
    // A compiler a human role-os step átmeneteit kizárólag 'user' actornak engedi.
    const first = rule.allowedTransitions[0]
    if (!first) return false
    return first.allowedActorTypes.length === 1 && first.allowedActorTypes[0] === 'user'
  }

  private systemUserId(process: ProcessInstance): string {
    // A ticket.created_by NOT NULL; a folyamat indítóját (ha user) használjuk, különben rendszer-aktor.
    return process.startedByUserId ?? process.startedByAgentId ?? SYSTEM_ACTOR_ID
  }

  private async append(
    tenantId: string | null,
    actor: ProcessActor,
    entry: {
      action: string
      targetType: string
      targetId: string
      inputRef?: string | null
      outputRef?: string | null
      policyDecision?: string | null
      metadata?: Record<string, unknown>
    },
  ) {
    const actorType = actor.type === 'user' ? 'human' : actor.type
    await this.audit.append({
      actorType,
      actorId: actor.id ?? null,
      agentVersion: null,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      modelUsed: null,
      inputRef: entry.inputRef ?? null,
      outputRef: entry.outputRef ?? null,
      policyDecision: entry.policyDecision ?? null,
      metadata: { tenantId, ...(entry.metadata ?? {}) },
    })
  }
}

/** Rendszer-aktor placeholder, ha nincs emberi/agent indító user-id (pl. system-trigger). */
const SYSTEM_ACTOR_ID = '00000000-0000-0000-0000-000000000000'
