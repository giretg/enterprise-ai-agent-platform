/**
 * RA-05 — `run_trace` folyamat-nézet: tiszta leképezés és slot-gap elemzés.
 */
import {
  missingRequiredInputSlots,
  resolveStepInputPayload,
} from '@/lib/playbook-v2/process-step-payload'
import { parsePlaybookSpecV2, type PlaybookSpecV2 } from '@/lib/playbook-v2/spec'
import type {
  RunTraceDelegationEdge,
  RunTracePlaybookSpec,
  RunTracePlaybookStepSpec,
  RunTraceProcessInstance,
  RunTraceProcessResult,
  RunTraceProcessStep,
  RunTraceStepSlotGap,
} from './run-trace-types'

export function projectPlaybookSpecForTrace(input: {
  playbookVersionId: string
  contentHash: string
  spec: unknown
}): RunTracePlaybookSpec {
  const parsed = parsePlaybookSpecV2(input.spec)
  return {
    playbookVersionId: input.playbookVersionId,
    contentHash: input.contentHash,
    criticality: parsed.criticality,
    steps: parsed.steps.map(projectStepSpec),
    gates: parsed.gates.map((gate) => ({
      id: gate.id,
      type: gate.type,
      criticality: gate.criticality,
      blocking: gate.blocking,
    })),
  }
}

function projectStepSpec(step: PlaybookSpecV2['steps'][number]): RunTracePlaybookStepSpec {
  return {
    id: step.id,
    name: step.name,
    instructionTemplate: step.instructionTemplate,
    inputSlots: step.inputSlots?.map((slot) => ({
      name: slot.name,
      type: slot.type,
      required: slot.required,
      source: slot.source,
      description: slot.description,
    })),
  }
}

export function mapProcessInstance(row: {
  id: string
  processType: string
  status: string
  triggerType: string | null
  startedByType: string
  startedByUserId: string | null
  startedByAgentId: string | null
  inputPayload: unknown
  outputPayload: unknown
  rootTicketId: string | null
  conversationId: string | null
  startedAt: Date
  completedAt: Date | null
  failedAt: Date | null
}): RunTraceProcessInstance {
  return {
    id: row.id,
    processType: row.processType,
    status: row.status,
    triggerType: row.triggerType,
    startedByType: row.startedByType,
    startedByUserId: row.startedByUserId,
    startedByAgentId: row.startedByAgentId,
    inputPayload: row.inputPayload,
    outputPayload: row.outputPayload,
    rootTicketId: row.rootTicketId,
    conversationId: row.conversationId,
    startedAt: row.startedAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    failedAt: row.failedAt?.toISOString() ?? null,
  }
}

export function mapProcessStep(row: {
  stepId: string
  stepName: string
  status: string
  assignedRole: string
  assignedAgentId: string | null
  assignedUserId: string | null
  ticketId: string | null
  resultPayload: unknown
  startedAt: Date | null
  completedAt: Date | null
  failedAt: Date | null
}): RunTraceProcessStep {
  return {
    stepId: row.stepId,
    stepName: row.stepName,
    status: row.status,
    assignedRole: row.assignedRole,
    assignedAgentId: row.assignedAgentId,
    assignedUserId: row.assignedUserId,
    ticketId: row.ticketId,
    resultPayload: row.resultPayload,
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    failedAt: row.failedAt?.toISOString() ?? null,
  }
}

export function mapDelegationEdge(row: {
  id: string
  fromStepId: string
  toStepId: string
  fromActorType: string
  fromAgentId: string | null
  fromUserId: string | null
  toActorType: string
  toAgentId: string | null
  toUserId: string | null
  status: string
  createdAt: Date
  deliveredAt: Date | null
  acceptedAt: Date | null
  doneAt: Date | null
  failedAt: Date | null
  metadata: unknown
}): RunTraceDelegationEdge {
  return {
    id: row.id,
    fromStepId: row.fromStepId,
    toStepId: row.toStepId,
    fromActorType: row.fromActorType,
    fromAgentId: row.fromAgentId,
    fromUserId: row.fromUserId,
    toActorType: row.toActorType,
    toAgentId: row.toAgentId,
    toUserId: row.toUserId,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    deliveredAt: row.deliveredAt?.toISOString() ?? null,
    acceptedAt: row.acceptedAt?.toISOString() ?? null,
    doneAt: row.doneAt?.toISOString() ?? null,
    failedAt: row.failedAt?.toISOString() ?? null,
    metadata: row.metadata,
  }
}

/**
 * A playbook lépéssorrendjében ellenőrzi, mely lépéshez hiányoznak kötelező input-slotok
 * az előző lépés kimenete / folyamat-bemenet alapján.
 */
export function analyzeProcessSlotGaps(input: {
  playbookSteps: RunTracePlaybookStepSpec[]
  stepInstances: Array<{ stepId: string; resultPayload: unknown }>
  processInput: Record<string, unknown>
  entryStepId: string
  transitions: Array<{ fromStepId: string; toStepId: string }>
}): RunTraceStepSlotGap[] {
  const specById = new Map(input.playbookSteps.map((s) => [s.id, s]))
  const resultByStepId = new Map(
    input.stepInstances.map((s) => [s.stepId, asRecord(s.resultPayload)]),
  )

  const order = topologicalStepOrder(
    input.entryStepId,
    input.transitions,
    input.playbookSteps.map((s) => s.id),
  )

  const gaps: RunTraceStepSlotGap[] = []
  let previousResult: Record<string, unknown> = {}

  for (const stepId of order) {
    const rule = specById.get(stepId)
    if (!rule) continue

    const resolved = resolveStepInputPayload(
      { inputSlots: rule.inputSlots ?? [] },
      {
        processInput: input.processInput,
        previousStepResult: previousResult,
      },
    )
    const missing = missingRequiredInputSlots({ inputSlots: rule.inputSlots ?? [] }, resolved)
    if (missing.length > 0) {
      gaps.push({ stepId, missingRequiredSlots: missing })
    }

    const stepResult = resultByStepId.get(stepId)
    if (stepResult) previousResult = stepResult
  }

  return gaps
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return {}
}

/** BFS a playbook entryStepId-től — ismeretlen ág esetén a spec lépéssorrendje fallback. */
function topologicalStepOrder(
  entryStepId: string,
  transitions: Array<{ fromStepId: string; toStepId: string }>,
  allStepIds: string[],
): string[] {
  const adjacency = new Map<string, string[]>()
  for (const t of transitions) {
    const list = adjacency.get(t.fromStepId) ?? []
    list.push(t.toStepId)
    adjacency.set(t.fromStepId, list)
  }

  const order: string[] = []
  const seen = new Set<string>()
  const queue = [entryStepId]
  while (queue.length > 0) {
    const id = queue.shift()!
    if (seen.has(id)) continue
    seen.add(id)
    order.push(id)
    for (const next of adjacency.get(id) ?? []) {
      if (!seen.has(next)) queue.push(next)
    }
  }

  for (const id of allStepIds) {
    if (!seen.has(id)) order.push(id)
  }
  return order
}

export function buildProcessTraceView(input: {
  process: RunTraceProcessInstance
  steps: RunTraceProcessStep[]
  delegations: RunTraceDelegationEdge[]
  playbookSpec: RunTracePlaybookSpec
  entryStepId: string
  transitions: Array<{ fromStepId: string; toStepId: string }>
  processInput: Record<string, unknown>
}): RunTraceProcessResult {
  const slotGaps = analyzeProcessSlotGaps({
    playbookSteps: input.playbookSpec.steps,
    stepInstances: input.steps.map((s) => ({ stepId: s.stepId, resultPayload: s.resultPayload })),
    processInput: input.processInput,
    entryStepId: input.entryStepId,
    transitions: input.transitions,
  })

  return {
    view: 'process',
    runId: input.process.id,
    grain: 'process',
    process: input.process,
    steps: input.steps,
    delegations: input.delegations,
    playbookSpec: input.playbookSpec,
    slotGaps,
  }
}
