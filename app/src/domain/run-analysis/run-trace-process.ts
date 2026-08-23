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
  RunTraceTruncatedPayload,
  RunTraceView,
} from './run-trace-types'

/** Egy nyers payload (folyamat be-/kimenet, lépés-eredmény, él-metaadat) felső mérete. */
export const MAX_PROCESS_PAYLOAD_CHARS = 4_000
/** Egy `instructionTemplate` felső mérete a spec-vetületben. */
export const MAX_INSTRUCTION_TEMPLATE_CHARS = 2_000
/** Lépés-lap alapmérete és plafonja a `detail` folyamat-nézetben. */
export const DEFAULT_PROCESS_PAGE_LIMIT = 50
export const MAX_PROCESS_PAGE_LIMIT = 200

/**
 * Nyers payload méret-korlátozása. A csonkolás LÁTHATÓ: a hívó `truncated: true`-t
 * és az eredeti méretet kapja, nem egy csendben megvágott objektumot.
 */
export function truncatePayload(
  value: unknown,
  maxChars = MAX_PROCESS_PAYLOAD_CHARS,
): { value: unknown | RunTraceTruncatedPayload; truncated: boolean } {
  if (value == null) return { value, truncated: false }
  let serialized: string
  try {
    serialized = JSON.stringify(value) ?? ''
  } catch {
    return {
      value: { truncated: true, totalChars: 0, preview: '[nem szerializálható]' },
      truncated: true,
    }
  }
  if (serialized.length <= maxChars) return { value, truncated: false }
  return {
    value: {
      truncated: true,
      totalChars: serialized.length,
      preview: serialized.slice(0, maxChars),
    },
    truncated: true,
  }
}

function truncateText(value: string | undefined, maxChars: number): string | undefined {
  if (value == null) return value
  if (value.length <= maxChars) return value
  return `${value.slice(0, maxChars)}… [csonkolva, teljes hossz: ${value.length}]`
}

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
    instructionTemplate: truncateText(step.instructionTemplate, MAX_INSTRUCTION_TEMPLATE_CHARS),
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

/**
 * Folyamat-nézet felépítése.
 *
 * A `slotGaps` MINDIG a teljes lépéssoron, a NYERS payloadokból számolódik — ez a
 * spec fő használati esete (a hibás átadás lépés- és slot-szintű megnevezése), ezért
 * nem eshet ki lapozás miatt. A nyers be-/kimenet viszont lapozott és méret-korlátos:
 * `summary` (alap) payload nélküli fejlécek, `detail` a kért lap nyers payloaddal.
 */
export function buildProcessTraceView(input: {
  process: RunTraceProcessInstance
  steps: RunTraceProcessStep[]
  delegations: RunTraceDelegationEdge[]
  playbookSpec: RunTracePlaybookSpec
  entryStepId: string
  transitions: Array<{ fromStepId: string; toStepId: string }>
  processInput: Record<string, unknown>
  view?: RunTraceView
  limit?: number
  offset?: number
}): RunTraceProcessResult {
  const slotGaps = analyzeProcessSlotGaps({
    playbookSteps: input.playbookSpec.steps,
    stepInstances: input.steps.map((s) => ({ stepId: s.stepId, resultPayload: s.resultPayload })),
    processInput: input.processInput,
    entryStepId: input.entryStepId,
    transitions: input.transitions,
  })

  const detail: RunTraceView = input.view === 'detail' ? 'detail' : 'summary'
  const limit = Math.min(Math.max(1, input.limit ?? DEFAULT_PROCESS_PAGE_LIMIT), MAX_PROCESS_PAGE_LIMIT)
  const offset = Math.max(0, input.offset ?? 0)

  const stepCount = input.steps.length
  const delegationCount = input.delegations.length
  const truncatedFields: string[] = []

  const pagedSteps = detail === 'detail' ? input.steps.slice(offset, offset + limit) : input.steps
  const pagedStepIds = new Set(pagedSteps.map((step) => step.stepId))
  const pagedDelegations =
    detail === 'detail'
      ? input.delegations.filter(
          (edge) => pagedStepIds.has(edge.fromStepId) || pagedStepIds.has(edge.toStepId),
        )
      : input.delegations

  const process = projectPayloads(
    input.process,
    detail,
    ['inputPayload', 'outputPayload'],
    'process',
    truncatedFields,
  )
  const steps = pagedSteps.map((step, index) =>
    projectPayloads(step, detail, ['resultPayload'], `steps[${offset + index}]`, truncatedFields),
  )
  const delegations = pagedDelegations.map((edge, index) =>
    projectPayloads(edge, detail, ['metadata'], `delegations[${index}]`, truncatedFields),
  )

  return {
    view: 'process',
    runId: input.process.id,
    grain: 'process',
    detail,
    process,
    steps,
    delegations,
    playbookSpec: input.playbookSpec,
    slotGaps,
    stepCount,
    delegationCount,
    returnedStepCount: steps.length,
    limit,
    offset: detail === 'detail' ? offset : 0,
    truncated: detail === 'detail' ? offset + steps.length < stepCount : false,
    truncatedFields,
  }
}

/**
 * `summary`: a nyers payload-mezők helyére a méretük kerül (`omitted`), hogy a
 * fejléc-nézet garantáltan kicsi legyen. `detail`: a nyers érték, méret-korláttal.
 */
function projectPayloads<T extends Record<string, unknown>>(
  row: T,
  detail: RunTraceView,
  payloadKeys: Array<keyof T & string>,
  path: string,
  truncatedFields: string[],
): T {
  const next = { ...row }
  for (const key of payloadKeys) {
    const raw = next[key]
    if (raw == null) continue
    if (detail === 'summary') {
      next[key] = { omitted: true, totalChars: safeLength(raw) } as T[keyof T & string]
      continue
    }
    const { value, truncated } = truncatePayload(raw)
    next[key] = value as T[keyof T & string]
    if (truncated) truncatedFields.push(`${path}.${key}`)
  }
  return next
}

function safeLength(value: unknown): number {
  try {
    return (JSON.stringify(value) ?? '').length
  } catch {
    return 0
  }
}
