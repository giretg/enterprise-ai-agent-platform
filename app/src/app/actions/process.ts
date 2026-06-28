'use server'

/**
 * Operator-facing server actions a Fázis 2 Playbook process runtime-hoz
 * (Feature-spec — Playbook §8.2, §8.3, §9.2). A folyamatinditas/transition mindig
 * tenant-scope-olt; a kötelező kapukat NEM ezek, hanem a `TicketStateMachine`
 * szerveroldali állapotgépe kényszeríti ki (§2.5, §11.3, P6).
 */
import { requireRole } from '@/auth'
import { services } from '@/domain'
import { repositories } from '@/repositories/postgres'
import { fail, ok } from '@/lib/result'
import {
  startProcessSchema,
  processIdSchema,
  cancelProcessSchema,
  transitionProcessTicketSchema,
} from '@/lib/validators/actions'
import { reconstructActualFlow } from '@/lib/playbook-v2/runtime'
import type { CompiledSpec } from '@/domain/playbook/playbook-compiler'
import {
  ProcessServiceError,
} from '@/domain/playbook/process-service'
import {
  TicketStateMachineError,
  TicketTransitionDenied,
} from '@/domain/playbook/ticket-state-machine'

type AuthedUser = Awaited<ReturnType<typeof requireRole>>
function tenantOf(user: AuthedUser): string {
  return user.tenantId ?? user.id
}

export async function startProcess(input: unknown) {
  try {
    const user = await requireRole('operator')
    const parsed = startProcessSchema.parse(input)
    const process = await services.processes.startProcess({
      tenantId: tenantOf(user),
      processType: parsed.processType,
      playbookVersionId: parsed.playbookVersionId,
      inputPayload: parsed.inputPayload ?? {},
      startedBy: { type: 'user', id: user.id },
    })
    return ok({ id: process.id })
  } catch (e) {
    if (e instanceof ProcessServiceError) return fail(e.message)
    return fail(e instanceof Error ? e.message : 'Nem sikerült elindítani a folyamatot')
  }
}

export async function listProcesses() {
  try {
    const user = await requireRole('viewer')
    const processes = await services.processes.listProcesses(tenantOf(user))
    return ok(
      processes.map((p) => ({
        id: p.id,
        processType: p.processType,
        status: p.status,
        playbookRef: p.playbookRef,
        startedByType: p.startedByType,
        startedAt: p.startedAt.toISOString(),
        completedAt: p.completedAt?.toISOString() ?? null,
      })),
    )
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült betölteni a folyamatokat')
  }
}

export async function getProcessDetail(input: unknown) {
  try {
    const user = await requireRole('viewer')
    const parsed = processIdSchema.parse(input)
    const tenantId = tenantOf(user)
    const detail = await services.processes.getProcess(tenantId, parsed.id)
    const tickets = await repositories.tickets.findMany({
      tenantId,
      processInstanceId: detail.id,
    })

    // A PIN-elt verzió compiled spec-je a szándékolt flow-hoz (§9.2 intended vs actual).
    const version = await repositories.playbooksV2.findVersion(tenantId, detail.playbookVersionId)
    const compiled = (version?.compiledSpec ?? null) as CompiledSpec | null
    const gateById = new Map((compiled?.gates ?? []).map((g) => [g.gateId, g]))
    const actualFlow = compiled
      ? reconstructActualFlow(
          detail.steps.map((s) => ({
            stepId: s.stepId,
            status: s.status,
            assignedRole: s.assignedRole,
          })),
          detail.delegations.map((d) => ({
            fromStepId: d.fromStepId,
            toStepId: d.toStepId,
            fromActorType: d.fromActorType,
          })),
          compiled,
        )
      : null

    return ok({
      process: {
        id: detail.id,
        processType: detail.processType,
        status: detail.status,
        playbookRef: detail.playbookRef,
        playbookContentHash: detail.playbookContentHash,
        startedByType: detail.startedByType,
        startedAt: detail.startedAt.toISOString(),
        completedAt: detail.completedAt?.toISOString() ?? null,
        rootTicketId: detail.rootTicketId,
      },
      steps: detail.steps.map((s) => ({
        id: s.id,
        stepId: s.stepId,
        stepName: s.stepName,
        status: s.status,
        assignedRole: s.assignedRole,
        ticketId: s.ticketId,
        startedAt: s.startedAt?.toISOString() ?? null,
        completedAt: s.completedAt?.toISOString() ?? null,
      })),
      delegations: detail.delegations.map((d) => ({
        id: d.id,
        fromStepId: d.fromStepId,
        toStepId: d.toStepId,
        fromActorType: d.fromActorType,
        toActorType: d.toActorType,
        status: d.status,
        createdAt: d.createdAt.toISOString(),
        doneAt: d.doneAt?.toISOString() ?? null,
      })),
      gateTickets: tickets
        .filter((t) => t.requiredGateId && t.playbookStepId)
        .map((t) => {
          const gate = gateById.get(t.requiredGateId!)
          return {
            ticketId: t.id,
            stepId: t.playbookStepId!,
            gateId: t.requiredGateId!,
            state: t.state,
            requiredActorRole: gate?.requiredActorRole ?? null,
            criticality: gate?.criticality ?? null,
            evidenceRequired: gate?.evidenceRequired ?? false,
            blocking: gate?.blocking ?? true,
          }
        }),
      actualFlow,
      // §9.2 szándékolt flow: a compiled spec lépés-sorrendje és routing-élei.
      intended: compiled
        ? {
            entryStepId: compiled.entryStepId,
            steps: compiled.ticketRules.map((r) => ({
              stepId: r.stepId,
              stepName: r.stepName,
              ticketType: r.ticketType,
              assignedRole: r.assignedRole,
            })),
            routes: compiled.routingRules.map((r) => ({
              fromStepId: r.fromStepId,
              toStepId: r.toStepId ?? null,
              gateId: r.gateId ?? null,
            })),
            gates: compiled.gates.map((g) => ({
              gateId: g.gateId,
              stepId: g.stepId,
              requiredActorRole: g.requiredActorRole ?? null,
              criticality: g.criticality ?? null,
              evidenceRequired: g.evidenceRequired,
              blocking: g.blocking,
            })),
          }
        : null,
    })
  } catch (e) {
    if (e instanceof ProcessServiceError) return fail(e.message)
    return fail(e instanceof Error ? e.message : 'Nem sikerült betölteni a folyamatot')
  }
}

export async function transitionProcessTicket(input: unknown) {
  try {
    const user = await requireRole('operator')
    const parsed = transitionProcessTicketSchema.parse(input)
    await services.ticketStateMachine.transitionTicket({
      tenantId: tenantOf(user),
      ticketId: parsed.ticketId,
      toState: parsed.toState,
      // Emberi actor; a gate requiredActorRole-ját az operator/approver jog képviseli.
      // (A finomszemcsés Playbook-role ↔ user tagság külön IAM-bővítés tárgya.)
      actor: { type: 'user', id: user.id, roles: user.role ? [user.role] : undefined },
      note: parsed.note,
      outputPayload: parsed.outputPayload,
      approvalEvidence: parsed.approvalEvidence,
    })
    return ok({ ticketId: parsed.ticketId, toState: parsed.toState })
  } catch (e) {
    if (e instanceof TicketTransitionDenied) {
      return fail(`Tiltott átmenet (${e.detail.denyCode}): ${e.detail.reason}`)
    }
    if (e instanceof TicketStateMachineError) return fail(e.message)
    return fail(e instanceof Error ? e.message : 'Nem sikerült végrehajtani az átmenetet')
  }
}

export async function cancelProcess(input: unknown) {
  try {
    const user = await requireRole('admin')
    const parsed = cancelProcessSchema.parse(input)
    await services.processes.cancelProcess({
      tenantId: tenantOf(user),
      processInstanceId: parsed.id,
      reason: parsed.reason,
      actorUserId: user.id,
    })
    return ok({ id: parsed.id })
  } catch (e) {
    if (e instanceof ProcessServiceError) return fail(e.message)
    return fail(e instanceof Error ? e.message : 'Nem sikerült visszavonni a folyamatot')
  }
}
