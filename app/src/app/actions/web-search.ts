'use server'

import type { Prisma } from '@prisma/client'
import { requireRole } from '@/auth'
import { services } from '@/domain'
import { repositories } from '@/repositories/postgres'
import { parseWebSearchConfig, type WebSearchConnectorConfig } from '@/domain/web-search/web-search-types'
import { prisma } from '@/lib/db'
import { fail, ok } from '@/lib/result'
import {
  agentIdSchema,
  setWebFetchControlsSchema,
  setWebSearchControlsSchema,
  updateWebSearchPolicySchema,
} from '@/lib/validators/actions'

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

// ── Web Fetch (WS-D) platform-tool vezérlés (WebFetch-Egress §14) ─────────────

export async function getWebFetchControls() {
  try {
    await requireRole('viewer')
    const controls = await services.platformSettings.getWebFetchControls()
    return ok(controls)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült betölteni a web-fetch vezérlőit')
  }
}

export async function setWebFetchControls(input: unknown) {
  try {
    const user = await requireRole('admin')
    const parsed = setWebFetchControlsSchema.parse(input)
    const controls = await services.platformSettings.setWebFetchControls(parsed, user.id)
    return ok(controls)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült menteni a web-fetch vezérlőit')
  }
}

export type WebSearchPolicyView = {
  connectorId: string
  connectorName: string
  lifecycleState: string
  secretAlias: string | null
  config: WebSearchConnectorConfig
}

function normalizeDomains(values: string[]): string[] {
  return [
    ...new Set(
      values
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean)
        .map((value) => value.replace(/^https?:\/\//, '').replace(/\/.*$/, '')),
    ),
  ]
}

export async function getWebSearchPolicy() {
  try {
    await requireRole('viewer')
    const connector = await prisma.connector.findFirst({
      where: { type: 'web_search', lifecycleState: 'active' },
      orderBy: { createdAt: 'asc' },
    })
    if (!connector) return fail('Aktív Web Search connector nem található.')

    return ok({
      connectorId: connector.id,
      connectorName: connector.name,
      lifecycleState: connector.lifecycleState,
      secretAlias: connector.secretAlias,
      config: parseWebSearchConfig(connector.config),
    })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült betölteni a web-search policyt')
  }
}

export async function updateWebSearchPolicy(input: unknown) {
  try {
    const user = await requireRole('admin')
    const parsed = updateWebSearchPolicySchema.parse(input)
    const connector = await prisma.connector.findUnique({
      where: { id: parsed.connectorId },
    })
    if (!connector || connector.type !== 'web_search') {
      return fail('Web Search connector nem található.')
    }
    if (connector.lifecycleState !== 'active') {
      return fail('Csak aktív Web Search connector policy szerkeszthető.')
    }

    const previous = parseWebSearchConfig(connector.config)
    const nextConfig: WebSearchConnectorConfig = {
      ...previous,
      provider: parsed.provider,
      providerApiUrl: parsed.provider === 'custom_search_api' ? parsed.providerApiUrl : undefined,
      allowedDomains: normalizeDomains(parsed.allowedDomains),
      deniedDomains: normalizeDomains(parsed.deniedDomains),
      allowGeneralWeb: parsed.allowGeneralWeb,
      defaultLocale: parsed.defaultLocale,
      defaultRegion: parsed.defaultRegion,
      defaultMaxResults: parsed.defaultMaxResults,
      hardMaxResults: parsed.hardMaxResults,
      maxQueryLength: parsed.maxQueryLength,
      maxQueriesPerTicket: parsed.maxQueriesPerTicket,
      maxQueriesPerAgentDay: parsed.maxQueriesPerAgentDay,
      safeSearch: parsed.safeSearch,
      logRawQuery: parsed.logRawQuery,
      retentionDays: parsed.retentionDays,
      requireHumanApprovalForSensitiveQuery: parsed.requireHumanApprovalForSensitiveQuery,
    }
    if (parsed.provider === 'custom_search_api' && !nextConfig.providerApiUrl && !process.env.WEB_SEARCH_PROVIDER_API_URL?.trim()) {
      return fail('custom_search_api providerhez API URL szükséges, vagy WEB_SEARCH_PROVIDER_API_URL env beállítás.')
    }

    let nextSecretAlias = connector.secretAlias
    const apiKeyRotated = Boolean(parsed.apiKey)
    if (parsed.apiKey) {
      const { saveConnectorApiKey, buildConnectorSecretRef } = await import(
        '@/domain/connector/connector-secret-store'
      )
      await saveConnectorApiKey(connector.id, parsed.apiKey)
      nextSecretAlias = buildConnectorSecretRef(connector.id)
    }

    const updated = await prisma.connector.update({
      where: { id: connector.id },
      data: {
        config: nextConfig as unknown as Prisma.InputJsonValue,
        secretAlias: nextSecretAlias,
        version: { increment: 1 },
      },
    })

    await repositories.audit.append({
      actorType: 'human',
      actorId: user.id,
      agentVersion: null,
      action: 'web_search.config_changed',
      targetType: 'connector',
      targetId: connector.id,
      modelUsed: null,
      inputRef: connector.name,
      outputRef: 'updated',
      policyDecision: 'allowed',
      metadata: {
        connectorId: connector.id,
        provider: nextConfig.provider,
        previousProvider: previous.provider,
        allowGeneralWeb: nextConfig.allowGeneralWeb,
        previousAllowGeneralWeb: previous.allowGeneralWeb,
        allowedDomains: nextConfig.allowedDomains,
        deniedDomains: nextConfig.deniedDomains,
        providerApiUrl: nextConfig.providerApiUrl ?? null,
        defaultMaxResults: nextConfig.defaultMaxResults,
        hardMaxResults: nextConfig.hardMaxResults,
        maxQueriesPerTicket: nextConfig.maxQueriesPerTicket,
        maxQueriesPerAgentDay: nextConfig.maxQueriesPerAgentDay,
        apiKeyRotated,
      } as Prisma.JsonValue,
    })

    return ok({
      connectorId: updated.id,
      connectorName: updated.name,
      lifecycleState: updated.lifecycleState,
      secretAlias: updated.secretAlias,
      config: parseWebSearchConfig(updated.config),
    })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült menteni a web-search policyt')
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
