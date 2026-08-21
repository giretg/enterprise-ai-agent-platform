/**
 * issue #237 — a hatékonysági kártya DB-oldali hívója.
 *
 * A detektor tiszta; ide tartozik a korlátos lekérdezés, a tenant-szűrés és a
 * futás-csoportosítás. Ablak: 30 nap vagy a legutóbbi 20 futás, amelyik szűkebb.
 * Részletes sorok csak a kiválasztott futásokra, felső korláttal.
 */
import type { Prisma } from '@prisma/client'
import {
  evaluateEfficiencyAdvisor,
  type EfficiencyAdvisorView,
  type EfficiencyHintKind,
  type EfficiencyRun,
  type EfficiencyRunKind,
} from '@/domain/agent/efficiency-advisor'
import { prisma } from '@/lib/db'
import { isAgentReachableFromTenant } from '@/lib/tenant-reachability'

const WINDOW_DAYS = 30
const MAX_RUNS = 20
const MAX_MODEL_ROWS = 2_000
const MAX_TOOL_ROWS = 4_000

export const EFFICIENCY_ADVISOR_UNDO_KEY = 'efficiencyAdvisorUndo'

type RunKey = { kind: EfficiencyRunKind; id: string }

function runKeyOf(row: {
  agentTurnId: string | null
  ticketId: string | null
  conversationId: string | null
}): RunKey | null {
  if (row.agentTurnId) return { kind: 'turn', id: row.agentTurnId }
  if (row.ticketId) return { kind: 'ticket', id: row.ticketId }
  if (row.conversationId) return { kind: 'conversation', id: row.conversationId }
  return null
}

function runKeyString(key: RunKey): string {
  return `${key.kind}:${key.id}`
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function appliedFromModelConfig(modelConfig: unknown): Partial<Record<EfficiencyHintKind, boolean>> {
  const undo = asRecord(asRecord(modelConfig)[EFFICIENCY_ADVISOR_UNDO_KEY])
  const applied: Partial<Record<EfficiencyHintKind, boolean>> = {}
  for (const kind of Object.keys(undo) as EfficiencyHintKind[]) {
    applied[kind] = true
  }
  return applied
}

export async function loadEfficiencyAdvisorCard(input: {
  agentId: string
  tenantId: string
}): Promise<EfficiencyAdvisorView> {
  const agent = await prisma.agent.findUnique({
    where: { id: input.agentId },
    select: { id: true, tenantId: true, modelConfig: true },
  })
  if (!agent || !isAgentReachableFromTenant(agent.tenantId, input.tenantId)) {
    throw new Error('Agent not found')
  }

  const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000)
  const modelRows = await prisma.modelCall.findMany({
    where: { agentId: input.agentId, createdAt: { gte: since } },
    select: {
      agentTurnId: true,
      ticketId: true,
      conversationId: true,
      promptTokens: true,
      completionTokens: true,
      cachedPromptTokens: true,
      costEstimate: true,
      createdAt: true,
      model: true,
    },
    orderBy: { createdAt: 'desc' },
    take: MAX_MODEL_ROWS,
  })

  const groups = new Map<
    string,
    { key: RunKey; latest: Date; modelCalls: EfficiencyRun['modelCalls'] }
  >()
  for (const row of modelRows) {
    const key = runKeyOf(row)
    if (!key) continue
    const id = runKeyString(key)
    const existing = groups.get(id)
    const call = {
      createdAt: row.createdAt,
      promptTokens: row.promptTokens,
      completionTokens: row.completionTokens,
      cachedPromptTokens: row.cachedPromptTokens,
      costEstimate: Number(row.costEstimate),
      model: row.model,
    }
    if (!existing) {
      groups.set(id, { key, latest: row.createdAt, modelCalls: [call] })
    } else {
      existing.modelCalls.push(call)
      if (row.createdAt > existing.latest) existing.latest = row.createdAt
    }
  }

  const selected = [...groups.values()]
    .sort((a, b) => b.latest.getTime() - a.latest.getTime())
    .slice(0, MAX_RUNS)

  const turnIds = selected.filter((g) => g.key.kind === 'turn').map((g) => g.key.id)
  const ticketIds = selected.filter((g) => g.key.kind === 'ticket').map((g) => g.key.id)
  const conversationIds = selected.filter((g) => g.key.kind === 'conversation').map((g) => g.key.id)

  const toolOr: Prisma.ToolCallWhereInput[] = []
  if (turnIds.length) toolOr.push({ agentTurnId: { in: turnIds } })
  if (ticketIds.length) toolOr.push({ ticketId: { in: ticketIds }, agentTurnId: null })
  if (conversationIds.length) {
    toolOr.push({ conversationId: { in: conversationIds }, agentTurnId: null, ticketId: null })
  }

  const toolRows =
    toolOr.length === 0
      ? []
      : await prisma.toolCall.findMany({
          where: { agentId: input.agentId, createdAt: { gte: since }, OR: toolOr },
          select: {
            agentTurnId: true,
            ticketId: true,
            conversationId: true,
            toolName: true,
            argsMeta: true,
            resultMeta: true,
          },
          orderBy: { createdAt: 'desc' },
          take: MAX_TOOL_ROWS,
        })

  const toolsByRun = new Map<string, EfficiencyRun['toolCalls']>()
  for (const row of toolRows) {
    const key = runKeyOf(row)
    if (!key) continue
    const id = runKeyString(key)
    const list = toolsByRun.get(id) ?? []
    list.push({
      toolName: row.toolName,
      argsMeta: asRecord(row.argsMeta),
      resultMeta: row.resultMeta ? asRecord(row.resultMeta) : null,
    })
    toolsByRun.set(id, list)
  }

  const runs: EfficiencyRun[] = selected.map((group) => ({
    id: group.key.id,
    kind: group.key.kind,
    modelCalls: group.modelCalls,
    toolCalls: toolsByRun.get(runKeyString(group.key)) ?? [],
  }))

  return {
    card: evaluateEfficiencyAdvisor(runs),
    applied: appliedFromModelConfig(agent.modelConfig),
  }
}
