/**
 * TicketStateMachine (Feature-spec — Playbook §8.3, §7.2, §13.1).
 *
 * A Playbook-folyamathoz kötött ticketek SZERVEROLDALI állapotgépe. A kötelező
 * sorrend (§7.2):
 *   1. tenant scope; 2. ticket betöltés; 3. ha process-hez tartozik, a PIN-elt
 *   verzió `compiled_spec`-jének betöltése; 4. (stepId, from→to, actor) átmenet
 *   engedélyezett-e; 5. gate blokkol-e; 6. output contract; 7. RBAC/role; 8. állapotváltás;
 *   9. audit ticket.transition / ticket.transition.denied; 10. ha step completed → advance.
 *
 * KRITIKUS invariáns (§2.5, §11.3, P6): az agent/system kimenete SOHA nem léphet
 * át blocking emberi kaput. A döntést a `evaluateTicketTransition` tiszta mag hozza
 * a `compiled_spec` alapján — a prompt/kimenet tartalma irreleváns.
 *
 * A nem-Playbook ticketek (process_instance_id == null) erre a rétegre NEM
 * kötelesek; azok a meglévő TicketService-en mennek.
 */
import type { Prisma, Ticket, TicketState, AuditActorType } from '@prisma/client'
import type { CompiledSpec } from '@/domain/playbook/playbook-compiler'
import { evaluateTicketTransition, type RuntimeActorType } from '@/lib/playbook-v2/runtime'
import type {
  AuditRepository,
  PlaybookV2Repository,
  ProcessRepository,
  TicketRepository,
} from '@/repositories/interfaces'
import type { ProcessService } from '@/domain/playbook/process-service'

export type StateMachineActor = {
  type: RuntimeActorType
  id?: string | null
  /** RBAC-role kulcsok; ha megadva, a kapu requiredActorRole-ját kényszerítjük (§11.1, P8). */
  roles?: string[]
}

export type TicketStateMachineErrorCode = 'NOT_FOUND_OR_FORBIDDEN' | 'NOT_PLAYBOOK_TICKET'

export class TicketStateMachineError extends Error {
  constructor(
    readonly code: TicketStateMachineErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'TicketStateMachineError'
  }
}

export type TransitionDeniedError = {
  denied: true
  denyCode: string
  reason: string
  gateBypassDenied?: boolean
}

export class TicketTransitionDenied extends Error {
  constructor(readonly detail: TransitionDeniedError) {
    super(detail.reason)
    this.name = 'TicketTransitionDenied'
  }
}

/** Kanonikus befejező cél-állapotok (→ ProcessService.advance, §7.2 10.). A terminál
 *  (kimenő átmenet nélküli) állapotok is befejezésnek számítanak. */
const STEP_COMPLETION_STATES = new Set<string>(['done', 'approved'])

export class TicketStateMachine {
  constructor(
    private readonly tickets: TicketRepository,
    private readonly playbooks: PlaybookV2Repository,
    private readonly processes: ProcessRepository,
    private readonly audit: AuditRepository,
    private readonly processService: ProcessService,
  ) {}

  async transitionTicket(input: {
    tenantId: string | null
    ticketId: string
    toState: string
    actor: StateMachineActor
    note?: string
    outputPayload?: Record<string, unknown>
    approvalEvidence?: Record<string, unknown>
  }): Promise<Ticket> {
    // §7.2.1–2 — tenant scope + ticket betöltés.
    const ticket = await this.tickets.findById(input.ticketId)
    if (!ticket || ticket.tenantId !== input.tenantId) {
      throw new TicketStateMachineError(
        'NOT_FOUND_OR_FORBIDDEN',
        'A ticket nem található vagy nincs jogosultság.',
      )
    }
    if (!ticket.processInstanceId || !ticket.playbookVersionId || !ticket.playbookStepId) {
      throw new TicketStateMachineError(
        'NOT_PLAYBOOK_TICKET',
        'A ticket nem Playbook-folyamathoz tartozik; használd a TicketService-t.',
      )
    }

    // §7.2.3 — a PIN-elt verzió compiled spec-je (SOHA nem a draft Playbook, §15/P9).
    const version = await this.playbooks.findVersion(input.tenantId, ticket.playbookVersionId)
    const compiled = version?.compiledSpec as CompiledSpec | undefined
    if (!compiled) {
      throw new TicketStateMachineError(
        'NOT_FOUND_OR_FORBIDDEN',
        'A pin-elt Playbook-verzió compiled spec-je nem érhető el.',
      )
    }

    const fromState = ticket.state as string
    // §7.2.4–6 — determinisztikus döntés a runtime-magban.
    const decision = evaluateTicketTransition(compiled, {
      stepId: ticket.playbookStepId,
      fromState,
      toState: input.toState,
      actor: { type: input.actor.type, roles: input.actor.roles },
      outputPayload: input.outputPayload,
      approvalEvidence: input.approvalEvidence,
    })

    if (!decision.allowed) {
      // §7.2.9 / §13.1 — tiltott átmenet: nincs állapotváltás, csak audit.
      if (decision.gateBypassDenied) {
        await this.append(input.tenantId, input.actor, {
          action: 'gate.bypass_denied',
          targetType: 'ticket',
          targetId: ticket.id,
          policyDecision: 'denied',
          metadata: {
            process_instance_id: ticket.processInstanceId,
            step_id: ticket.playbookStepId,
            gate_id: decision.gate?.gateId ?? ticket.requiredGateId,
            deny_code: decision.denyCode,
            from_state: fromState,
            to_state: input.toState,
          },
        })
      }
      await this.append(input.tenantId, input.actor, {
        action: 'ticket.transition.denied',
        targetType: 'ticket',
        targetId: ticket.id,
        policyDecision: 'denied',
        metadata: {
          process_instance_id: ticket.processInstanceId,
          step_id: ticket.playbookStepId,
          deny_code: decision.denyCode,
          reason: decision.reason,
          from_state: fromState,
          to_state: input.toState,
          missing_fields: decision.missingFields ?? null,
        },
      })
      throw new TicketTransitionDenied({
        denied: true,
        denyCode: decision.denyCode,
        reason: decision.reason,
        gateBypassDenied: decision.gateBypassDenied,
      })
    }

    // §7.2.8 — állapotváltás (+ output payload merge).
    const toState = input.toState as TicketState
    const mergedPayload =
      input.outputPayload != null
        ? { ...(ticket.payload as Record<string, unknown>), ...input.outputPayload }
        : undefined

    const updated = await this.tickets.update(ticket.id, {
      state: toState,
      ...(mergedPayload != null ? { payload: mergedPayload as Prisma.JsonObject } : {}),
    })

    const actorType = this.auditActorType(input.actor.type)
    await this.tickets.recordTransition({
      ticketId: ticket.id,
      fromState: ticket.state,
      toState,
      actorType,
      actorId: input.actor.id ?? null,
      agentVersion: null,
      note: input.note ?? null,
    })

    // §7.2.9 — sikeres átmenet audit; ha kapun keresztül történt, gate.approve is.
    if (decision.gate) {
      await this.append(input.tenantId, input.actor, {
        action: 'gate.approve',
        targetType: 'ticket',
        targetId: ticket.id,
        policyDecision: 'approved',
        metadata: {
          process_instance_id: ticket.processInstanceId,
          step_id: ticket.playbookStepId,
          gate_id: decision.gate.gateId,
          evidence: input.approvalEvidence ? Object.keys(input.approvalEvidence) : [],
        },
      })
    }
    await this.append(input.tenantId, input.actor, {
      action: 'ticket.transition',
      targetType: 'ticket',
      targetId: ticket.id,
      policyDecision: 'allowed',
      metadata: {
        process_instance_id: ticket.processInstanceId,
        step_id: ticket.playbookStepId,
        from_state: fromState,
        to_state: input.toState,
      },
    })

    // §7.2.10 — ha a step befejeződött (kanonikus vagy terminál állapot), a process tovább lép.
    const stepRule = compiled.ticketRules.find((r) => r.stepId === ticket.playbookStepId)
    const isTerminal =
      stepRule != null && !stepRule.allowedTransitions.some((t) => t.fromState === input.toState)
    if (STEP_COMPLETION_STATES.has(input.toState) || isTerminal) {
      const step = await this.processes.findStepByTicket(input.tenantId, ticket.id)
      const resultPayload =
        (mergedPayload as Record<string, unknown> | undefined) ??
        (updated.payload as Record<string, unknown>)
      await this.processService.advance({
        tenantId: input.tenantId,
        processInstanceId: ticket.processInstanceId,
        completedStepId: ticket.playbookStepId,
        actor: { type: input.actor.type, id: input.actor.id ?? null },
        resultPayload,
      })
      if (step && step.status !== 'completed') {
        // advance() lezárja a stepet; ha eltérő ticket-step párosítás miatt nem találta,
        // itt biztosítjuk a step completed-állapotát.
        await this.processes.updateStep(step.id, { status: 'completed', completedAt: new Date() })
      }
    }

    return updated
  }

  private auditActorType(type: RuntimeActorType): AuditActorType {
    return (type === 'user' ? 'human' : type) as AuditActorType
  }

  private async append(
    tenantId: string | null,
    actor: StateMachineActor,
    entry: {
      action: string
      targetType: string
      targetId: string
      policyDecision?: string | null
      metadata?: Record<string, unknown>
    },
  ) {
    await this.audit.append({
      actorType: this.auditActorType(actor.type),
      actorId: actor.id ?? null,
      agentVersion: null,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      modelUsed: null,
      inputRef: null,
      outputRef: null,
      policyDecision: entry.policyDecision ?? null,
      metadata: { tenantId, ...(entry.metadata ?? {}) },
    })
  }
}
