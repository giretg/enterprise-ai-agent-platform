'use server'

/**
 * Operator-facing server actions a Fázis 2 Playbook process runtime-hoz
 * (Feature-spec — Playbook §8.2, §8.3, §9.2). A folyamatinditas/transition mindig
 * tenant-scope-olt; a kötelező kapukat NEM ezek, hanem a `TicketStateMachine`
 * szerveroldali állapotgépe kényszeríti ki (§2.5, §11.3, P6).
 */
import { requireTenantRole } from '@/auth/tenant-context'
import { hasMinimumRole } from '@/auth/types'
import { services } from '@/domain'
import { repositories } from '@/repositories/postgres'
import { fail, ok } from '@/lib/result'
import {
  startProcessSchema,
  processIdSchema,
  cancelProcessSchema,
  transitionProcessTicketSchema,
  listProcessDefinitionsSchema,
  processDefinitionIdSchema,
  createProcessDefinitionSchema,
  updateProcessDefinitionBindingsSchema,
  replaceActiveProcessDefinitionSchema,
  attachProcessTriggerSchema,
  detachProcessTriggerSchema,
  startProcessFromTicketSchema,
  suitableAgentsSchema,
  chatTriggerableProcessDefinitionsSchema,
} from '@/lib/validators/actions'
import { reconstructActualFlow } from '@/lib/playbook-v2/runtime'
import { parsePlaybookSpecV2 } from '@/lib/playbook-v2/spec'
import { chatTriggerSlotDescriptors, resolveTicketTriggerInputPayload } from '@/lib/playbook-v2/trigger-input'
import { isAgentSuitable } from '@/domain/playbook/suitability'
import type { CompiledSpec } from '@/domain/playbook/playbook-compiler'
import {
  ProcessServiceError,
} from '@/domain/playbook/process-service'
import { ProcessDefinitionServiceError } from '@/domain/playbook/process-definition-service'
import {
  TicketStateMachineError,
  TicketTransitionDenied,
} from '@/domain/playbook/ticket-state-machine'

export async function startProcess(input: unknown) {
  try {
    const user = await requireTenantRole('operator')
    const parsed = startProcessSchema.parse(input)
    const process = await services.processes.startProcess({
      tenantId: user.activeTenantId,
      processType: parsed.processType,
      processDefinitionId: parsed.processDefinitionId,
      triggerType: parsed.triggerType ?? (parsed.processDefinitionId ? 'manual' : undefined),
      playbookVersionId: parsed.playbookVersionId,
      inputPayload: parsed.inputPayload ?? {},
      startedBy: { type: 'user', id: user.user.id },
      conversationId: parsed.conversationId ?? null,
      rootTicketId: parsed.rootTicketId ?? null,
    })
    return ok({ id: process.id })
  } catch (e) {
    if (e instanceof ProcessServiceError) return fail(e.message)
    return fail(e instanceof Error ? e.message : 'Nem sikerült elindítani a folyamatot')
  }
}

export async function listProcessDefinitions(input: unknown = {}) {
  try {
    const user = await requireTenantRole('viewer')
    const parsed = listProcessDefinitionsSchema.parse(input)
    const defs = await services.processDefinitions.listDefinitions(user.activeTenantId, parsed.status)
    return ok(
      defs.map((d) => ({
        id: d.id,
        name: d.name,
        description: d.description,
        status: d.status,
        playbookId: d.playbookId,
        playbookVersionId: d.playbookVersionId,
        roleBindings: d.roleBindings,
        configValues: d.configValues,
        approvedAt: d.approvedAt?.toISOString() ?? null,
        updatedAt: d.updatedAt.toISOString(),
        triggers: d.triggers.map((t) => ({
          id: t.id,
          type: t.type,
          enabled: t.enabled,
          inputMap: t.inputMap,
          monitorDefinitionId: t.monitorDefinitionId,
          createdAt: t.createdAt.toISOString(),
        })),
      })),
    )
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült betölteni a Folyamatokat')
  }
}

/**
 * Chatből indítható Folyamatok egy agenthez (feature-spec §4.4, §4.6): aktív
 * Folyamat, engedélyezett chat trigger, és az agent szerepelt a szerep-kötésben.
 * A `roleBindings` sima Json ({ roleKey: agentId }), nem relációs FK, ezért
 * alkalmazás-oldalon szűrünk (a tenantonkénti Folyamat-darabszám kicsi).
 */
export async function listChatTriggerableProcessDefinitions(input: unknown) {
  try {
    const user = await requireTenantRole('operator')
    const parsed = chatTriggerableProcessDefinitionsSchema.parse(input)
    const tenantId = user.activeTenantId
    const defs = await services.processDefinitions.listDefinitions(tenantId, 'active')
    const eligible = defs.filter((d) => {
      const hasChatTrigger = d.triggers.some((t) => t.type === 'chat' && t.enabled)
      if (!hasChatTrigger) return false
      const bindings = (d.roleBindings ?? {}) as Record<string, string>
      return Object.values(bindings).includes(parsed.agentId)
    })

    const result = []
    for (const def of eligible) {
      const version = await repositories.playbooksV2.findVersion(tenantId, def.playbookVersionId)
      const compiled = (version?.compiledSpec ?? null) as CompiledSpec | null
      result.push({
        id: def.id,
        name: def.name,
        description: def.description,
        slots: compiled ? chatTriggerSlotDescriptors(compiled, compiled.entryStepId) : [],
      })
    }
    return ok(result)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült betölteni a chatből indítható Folyamatokat')
  }
}

export async function createProcessDefinition(input: unknown) {
  try {
    const user = await requireTenantRole('operator')
    const parsed = createProcessDefinitionSchema.parse(input)
    const def = await services.processDefinitions.createDraft({
      tenantId: user.activeTenantId,
      name: parsed.name,
      description: parsed.description ?? null,
      playbookVersionId: parsed.playbookVersionId,
      createdBy: { userId: user.user.id },
    })
    return ok({ id: def.id })
  } catch (e) {
    if (e instanceof ProcessDefinitionServiceError) return fail(e.message)
    return fail(e instanceof Error ? e.message : 'Nem sikerült létrehozni a Folyamat-draftot')
  }
}

export async function updateProcessDefinitionBindings(input: unknown) {
  try {
    const user = await requireTenantRole('operator')
    const parsed = updateProcessDefinitionBindingsSchema.parse(input)
    const def = await services.processDefinitions.updateBindings({
      tenantId: user.activeTenantId,
      processDefinitionId: parsed.id,
      roleBindings: parsed.roleBindings,
      configValues: parsed.configValues ?? {},
      actorUserId: user.user.id,
    })
    return ok({ id: def.id, status: def.status })
  } catch (e) {
    if (e instanceof ProcessDefinitionServiceError) return fail(e.message)
    return fail(e instanceof Error ? e.message : 'Nem sikerült frissíteni a Folyamat kötéseit')
  }
}

/** Aktív Folyamat cseréje: új példány + régi archiválása (a futó Futások érintetlenek). */
export async function replaceActiveProcessDefinition(input: unknown) {
  try {
    const user = await requireTenantRole('operator')
    const parsed = replaceActiveProcessDefinitionSchema.parse(input)
    const activateNew = hasMinimumRole(user.activeTenantRole, 'approver')
    const result = await services.processDefinitions.replaceActiveDefinition({
      tenantId: user.activeTenantId,
      sourceProcessDefinitionId: parsed.id,
      roleBindings: parsed.roleBindings,
      configValues: parsed.configValues ?? {},
      triggerType: parsed.triggerType,
      triggerInputMap: parsed.triggerInputMap ?? {},
      monitorDefinitionId: parsed.monitorDefinitionId,
      actorUserId: user.user.id,
      activateNew,
    })
    return ok({
      id: result.newDefinition.id,
      status: result.newDefinition.status,
      supersededId: result.supersededDefinitionId,
      activated: result.activated,
      message: result.activated
        ? 'Új Folyamat aktiválva, a régi leállítva.'
        : 'Új Folyamat-draft létrejött, a régi leállítva. Aktiválás approver jogosultsággal szükséges.',
    })
  } catch (e) {
    if (e instanceof ProcessDefinitionServiceError) {
      return fail(`${e.message}${e.details ? ` — ${JSON.stringify(e.details)}` : ''}`)
    }
    return fail(e instanceof Error ? e.message : 'Nem sikerült lecserélni a Folyamatot')
  }
}

export async function attachProcessTrigger(input: unknown) {
  try {
    const user = await requireTenantRole('operator')
    const parsed = attachProcessTriggerSchema.parse(input)
    const trigger = await services.processDefinitions.attachTrigger({
      tenantId: user.activeTenantId,
      processDefinitionId: parsed.processDefinitionId,
      type: parsed.type,
      inputMap: parsed.inputMap ?? {},
      monitorDefinitionId: parsed.monitorDefinitionId ?? null,
      actorUserId: user.user.id,
    })
    return ok({ id: trigger.id })
  } catch (e) {
    if (e instanceof ProcessDefinitionServiceError) return fail(e.message)
    return fail(e instanceof Error ? e.message : 'Nem sikerült csatolni a triggert')
  }
}

export async function detachProcessTrigger(input: unknown) {
  try {
    const user = await requireTenantRole('operator')
    const parsed = detachProcessTriggerSchema.parse(input)
    await services.processDefinitions.detachTrigger({
      tenantId: user.activeTenantId,
      processDefinitionId: parsed.processDefinitionId,
      triggerId: parsed.triggerId,
      actorUserId: user.user.id,
    })
    return ok({ id: parsed.triggerId })
  } catch (e) {
    if (e instanceof ProcessDefinitionServiceError) return fail(e.message)
    return fail(e instanceof Error ? e.message : 'Nem sikerült leválasztani a triggert')
  }
}

export async function startProcessFromTicket(input: unknown) {
  try {
    const user = await requireTenantRole('operator')
    const parsed = startProcessFromTicketSchema.parse(input)
    const tenantId = user.activeTenantId
    const ticket = await repositories.tickets.findById(parsed.ticketId)
    if (!ticket || ticket.tenantId !== tenantId) {
      return fail('A trigger-ticket nem található.')
    }

    const def = await services.processDefinitions.getDefinition(tenantId, parsed.processDefinitionId)
    const trigger = def.triggers.find((candidate) => {
      if (candidate.type !== 'ticket' || !candidate.enabled) return false
      return parsed.triggerId ? candidate.id === parsed.triggerId : true
    })
    if (!trigger) {
      return fail('A Folyamathoz nincs aktív ticket-trigger csatolva.')
    }

    const inputPayload = resolveTicketTriggerInputPayload(trigger.inputMap, ticket)
    const process = await services.processes.startProcess({
      tenantId,
      processDefinitionId: def.id,
      triggerType: 'ticket',
      inputPayload,
      startedBy: { type: 'user', id: user.user.id },
      rootTicketId: ticket.id,
    })

    return ok({ id: process.id, rootTicketId: ticket.id, inputPayload })
  } catch (e) {
    if (e instanceof ProcessDefinitionServiceError || e instanceof ProcessServiceError) return fail(e.message)
    return fail(e instanceof Error ? e.message : 'Nem sikerült ticketből Futást indítani')
  }
}

export async function activateProcessDefinition(input: unknown) {
  try {
    const user = await requireTenantRole('approver')
    const parsed = processDefinitionIdSchema.parse(input)
    const def = await services.processDefinitions.activate({
      tenantId: user.activeTenantId,
      processDefinitionId: parsed.id,
      actorUserId: user.user.id,
    })
    return ok({ id: def.id, status: def.status })
  } catch (e) {
    if (e instanceof ProcessDefinitionServiceError) {
      return fail(`${e.message}${e.details ? ` — ${JSON.stringify(e.details)}` : ''}`)
    }
    return fail(e instanceof Error ? e.message : 'Nem sikerült aktiválni a Folyamatot')
  }
}

export async function archiveProcessDefinition(input: unknown) {
  try {
    const user = await requireTenantRole('admin')
    const parsed = processDefinitionIdSchema.parse(input)
    const def = await services.processDefinitions.archive({
      tenantId: user.activeTenantId,
      processDefinitionId: parsed.id,
      actorUserId: user.user.id,
    })
    return ok({ id: def.id, status: def.status })
  } catch (e) {
    if (e instanceof ProcessDefinitionServiceError) return fail(e.message)
    return fail(e instanceof Error ? e.message : 'Nem sikerült archiválni a Folyamatot')
  }
}

export async function listSuitableAgents(input: unknown) {
  try {
    const user = await requireTenantRole('operator')
    const parsed = suitableAgentsSchema.parse(input)
    const processTenantId = user.activeTenantId
    // NOTE: requireTenantRole NO_TENANT-ot dob, mielőtt idáig érne — tisztán platform-
    // szintű (tenant nélküli) superadmin ezt az endpointot többé nem éri el.
    const registryTenantId: string | null = user.activeTenantId
    const version = await repositories.playbooksV2.findVersion(processTenantId, parsed.playbookVersionId)
    if (!version) return fail('A Playbook-verzió nem található.')
    const role = parsePlaybookSpecV2(version.spec).roles.find((r) => r.key === parsed.roleKey)
    if (!role || role.type !== 'agent_role') return fail('A megadott agent-szerep nem található.')

    const agents = await repositories.agents.findMany({ tenantId: registryTenantId })
    const capabilitySets = await Promise.all(
      agents.map((agent) => repositories.toolBroker.findCapabilitiesForAgent(agent.id)),
    )
    const suitable = []
    for (const [i, agent] of agents.entries()) {
      const result = isAgentSuitable(
        { status: agent.status, tenantId: agent.tenantId, capabilities: capabilitySets[i] },
        { requiredCapabilities: role.requiredCapabilities },
        registryTenantId,
      )
      if (result.ok) suitable.push({ id: agent.id, name: agent.name, status: agent.status, role: agent.role })
    }
    return ok(suitable)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült betölteni az alkalmas agenteket')
  }
}

export async function listAssignableProcessUsers() {
  try {
    const user = await requireTenantRole('operator')
    const users = await repositories.users.findMany({ tenantId: user.activeTenantId, status: 'active' })
    return ok(
      users
        .filter((u) => u.role !== null)
        .map((u) => ({
          id: u.id,
          name: u.name,
          email: u.email,
          role: u.role!,
        })),
    )
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült betölteni a hozzárendelhető usereket')
  }
}

export async function listProcesses() {
  try {
    const user = await requireTenantRole('viewer')
    const processes = await services.processes.listProcesses(user.activeTenantId)
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
    const user = await requireTenantRole('viewer')
    const parsed = processIdSchema.parse(input)
    const tenantId = user.activeTenantId
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
    const blockedEvents = detail.status === 'blocked'
      ? await repositories.audit.findMany({
          action: 'process.blocked',
          targetType: 'process_instance',
          targetId: detail.id,
          tenantId,
          limit: 5,
        })
      : []

    return ok({
      process: {
        id: detail.id,
        processType: detail.processType,
        status: detail.status,
        processDefinitionId: detail.processDefinitionId,
        triggerType: detail.triggerType,
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
        assignedAgentId: s.assignedAgentId,
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
      blockedReasons: blockedEvents.map((event) => {
        const metadata = event.metadata && typeof event.metadata === 'object'
          ? (event.metadata as Record<string, unknown>)
          : {}
        return {
          createdAt: event.createdAt.toISOString(),
          stepId: typeof metadata.step_id === 'string' ? metadata.step_id : null,
          reason: typeof metadata.reason === 'string' ? metadata.reason : 'Ismeretlen blokk-ok.',
        }
      }),
      // WP-1 §4 — a PIN-elt authored spec a folyamat-trace SVG-gráfjához (read-only overlay).
      spec: version ? parsePlaybookSpecV2(version.spec) : null,
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
    const user = await requireTenantRole('operator')
    const parsed = transitionProcessTicketSchema.parse(input)
    await services.ticketStateMachine.transitionTicket({
      tenantId: user.activeTenantId,
      ticketId: parsed.ticketId,
      toState: parsed.toState,
      // Emberi actor; a gate requiredActorRole-ját az operator/approver jog képviseli.
      // (A finomszemcsés Playbook-role ↔ user tagság külön IAM-bővítés tárgya.)
      actor: { type: 'user', id: user.user.id, roles: [user.activeTenantRole] },
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
    const user = await requireTenantRole('admin')
    const parsed = cancelProcessSchema.parse(input)
    await services.processes.cancelProcess({
      tenantId: user.activeTenantId,
      processInstanceId: parsed.id,
      reason: parsed.reason,
      actorUserId: user.user.id,
    })
    return ok({ id: parsed.id })
  } catch (e) {
    if (e instanceof ProcessServiceError) return fail(e.message)
    return fail(e instanceof Error ? e.message : 'Nem sikerült visszavonni a folyamatot')
  }
}
