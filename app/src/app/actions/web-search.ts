'use server'

import { requireRole } from '@/auth'
import { services } from '@/domain'
import { repositories } from '@/repositories/postgres'
import { fail, ok } from '@/lib/result'
import { agentIdSchema, setWebSearchControlsSchema } from '@/lib/validators/actions'

export type WebSearchCallView = {
  id: string
  status: string
  policyDecision: string | null
  latencyMs: number
  resultCount: number | null
  resultDomains: string[]
  createdAt: string
}

function toCallView(row: {
  id: string
  status: string
  policyDecision: string | null
  latencyMs: number
  resultMeta: unknown
  createdAt: Date
}): WebSearchCallView {
  const meta = (row.resultMeta ?? {}) as Record<string, unknown>
  return {
    id: row.id,
    status: row.status,
    policyDecision: row.policyDecision,
    latencyMs: row.latencyMs,
    resultCount: typeof meta.resultCount === 'number' ? meta.resultCount : null,
    resultDomains: Array.isArray(meta.resultDomains)
      ? meta.resultDomains.filter((d): d is string => typeof d === 'string')
      : [],
    createdAt: row.createdAt.toISOString(),
  }
}

/** Agent detail capability kártya (Feature-spec — WebSearchTool §7.1). */
export async function getAgentWebSearchCalls(input: { agentId: string }) {
  try {
    await requireRole('viewer')
    const { id: agentId } = agentIdSchema.parse({ id: input.agentId })
    const rows = await repositories.toolBroker.listToolCallsByName('web_search', { agentId }, 10)
    return ok(rows.map(toCallView))
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült betölteni a web-search hívásokat')
  }
}

export async function getWebSearchControls() {
  try {
    await requireRole('viewer')
    const controls = await services.platformSettings.getWebSearchControls()
    return ok(controls)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült betölteni a web-search vezérlőit')
  }
}

export async function setWebSearchControls(input: unknown) {
  try {
    const user = await requireRole('admin')
    const parsed = setWebSearchControlsSchema.parse(input)
    const controls = await services.platformSettings.setWebSearchControls(parsed, user.id)
    return ok(controls)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült menteni a web-search vezérlőit')
  }
}

export type WebSearchGovernanceSummary = {
  totalCalls: number
  okCalls: number
  deniedCalls: number
  errorCalls: number
  deniedRate: number
  avgLatencyMs: number
  topDenyReasons: Array<{ reason: string; count: number }>
  topResultDomains: Array<{ domain: string; count: number }>
}

/** Governance dashboard web_search bontás (Feature-spec §7.3). */
export async function getWebSearchGovernanceSummary(input?: { sinceDays?: number }) {
  try {
    await requireRole('viewer')
    const since = new Date(Date.now() - (input?.sinceDays ?? 30) * 24 * 60 * 60 * 1000)
    const rows = await repositories.toolBroker.listToolCallsByName('web_search', { since }, 1000)

    const denyReasonCounts = new Map<string, number>()
    const domainCounts = new Map<string, number>()
    let okCalls = 0
    let deniedCalls = 0
    let errorCalls = 0
    let latencySum = 0

    for (const row of rows) {
      latencySum += row.latencyMs
      if (row.status === 'ok') {
        okCalls++
        const meta = (row.resultMeta ?? {}) as Record<string, unknown>
        const domains = Array.isArray(meta.resultDomains) ? meta.resultDomains : []
        for (const domain of domains) {
          if (typeof domain !== 'string') continue
          domainCounts.set(domain, (domainCounts.get(domain) ?? 0) + 1)
        }
      } else if (row.status === 'denied') {
        deniedCalls++
        const reason = row.policyDecision ?? 'unknown'
        denyReasonCounts.set(reason, (denyReasonCounts.get(reason) ?? 0) + 1)
      } else {
        errorCalls++
      }
    }

    const summary: WebSearchGovernanceSummary = {
      totalCalls: rows.length,
      okCalls,
      deniedCalls,
      errorCalls,
      deniedRate: rows.length > 0 ? deniedCalls / rows.length : 0,
      avgLatencyMs: rows.length > 0 ? Math.round(latencySum / rows.length) : 0,
      topDenyReasons: [...denyReasonCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([reason, count]) => ({ reason, count })),
      topResultDomains: [...domainCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([domain, count]) => ({ domain, count })),
    }

    return ok(summary)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült betölteni a web-search összesítőt')
  }
}
