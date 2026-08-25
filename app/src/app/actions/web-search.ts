'use server'

import type { Connector, Prisma } from '@prisma/client'
import { getAuthContext } from '@/auth/context'
import { requirePlatformRole, requireTenantRole } from '@/auth/tenant-context'
import { services } from '@/domain'
import { repositories } from '@/repositories/postgres'
import {
  ensurePlatformWebSearchConnector,
  ensureTenantWebSearchConnector,
  PLATFORM_WEB_SEARCH_CONNECTOR_NAME,
} from '@/domain/web-search/web-search-connector-service'
import { parseWebSearchConfig, type WebSearchConnectorConfig } from '@/domain/web-search/web-search-types'
import { findForbiddenAllowedDomain } from '@/domain/web-research/fetch-trust'
import { prisma } from '@/lib/db'
import { fail, ok } from '@/lib/result'
import {
  agentIdSchema,
  setWebFetchControlsSchema,
  setWebSearchControlsSchema,
  setTenantWebSearchControlsSchema,
  updatePlatformWebSearchSchema,
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

function connectorToPolicyView(connector: Connector): {
  connectorId: string
  connectorName: string
  tenantId: string | null
  lifecycleState: string
  secretAlias: string | null
  config: WebSearchConnectorConfig
} {
  return {
    connectorId: connector.id,
    connectorName: connector.name,
    tenantId: connector.tenantId,
    lifecycleState: connector.lifecycleState,
    secretAlias: connector.secretAlias,
    config: parseWebSearchConfig(connector.config),
  }
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

async function resolveTenantWebSearchConnectorForContext(tenantId: string) {
  // Az ensure a létező legacy platform_hosted/stub tenant connectorokat is customra migrálja.
  return ensureTenantWebSearchConnector(tenantId)
}

/** Agent detail capability kártya (Feature-spec — WebSearchTool §7.1). */
export async function getAgentWebSearchCalls(input: { agentId: string }) {
  try {
    const ctx = await requireTenantRole('viewer')
    const { id: agentId } = agentIdSchema.parse({ id: input.agentId })
    // A Server Action közvetlen HTTP-belépő is: az agentId nem az UI-ból
    // érkező megbízható azonosító. Előbb az aktív tenantból oldjuk fel, és csak
    // utána kérjük le az audit-metaadatot.
    const agent = await repositories.agents.findById(agentId, ctx.activeTenantId)
    if (!agent) return fail('Agent not found')
    const rows = await repositories.toolBroker.listToolCallsByName('web_search', { agentId }, 10)
    return ok(rows.map(toCallView))
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült betölteni a web-search hívásokat')
  }
}

/** Platform kill-switch (minden tenant). */
export async function getWebSearchControls() {
  try {
    await requireTenantRole('viewer')
    const controls = await services.platformSettings.getWebSearchControls()
    return ok(controls)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült betölteni a web-search vezérlőit')
  }
}

export async function setWebSearchControls(input: unknown) {
  try {
    const user = (await requirePlatformRole('superadmin')).user
    const parsed = setWebSearchControlsSchema.parse(input)
    const controls = await services.platformSettings.setWebSearchControls(parsed, user.id)
    return ok(controls)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült menteni a web-search vezérlőit')
  }
}

/** Tenant kill-switch — tenant admin vagy superadmin (assume tenant kontextusban). */
export async function getTenantWebSearchControls() {
  try {
    const ctx = await requireTenantRole('viewer')
    const controls = await services.platformSettings.getTenantWebSearchControls(ctx.activeTenantId!)
    return ok(controls)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült betölteni a tenant web-search vezérlőit')
  }
}

export async function setTenantWebSearchControls(input: unknown) {
  try {
    const ctx = await requireTenantRole('admin')
    const parsed = setTenantWebSearchControlsSchema.parse(input)
    const controls = await services.platformSettings.setTenantWebSearchControls(
      ctx.activeTenantId!,
      parsed,
      ctx.user.id,
    )
    return ok(controls)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült menteni a tenant web-search vezérlőit')
  }
}

// ── Web Fetch (WS-D) platform-tool vezérlés (WebFetch-Egress §14) ─────────────

export async function getWebFetchControls() {
  try {
    await requireTenantRole('viewer')
    const controls = await services.platformSettings.getWebFetchControls()
    return ok(controls)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült betölteni a web-fetch vezérlőit')
  }
}

export async function setWebFetchControls(input: unknown) {
  try {
    const user = (await requirePlatformRole('superadmin')).user
    const parsed = setWebFetchControlsSchema.parse(input)
    const controls = await services.platformSettings.setWebFetchControls(parsed, user.id)
    return ok(controls)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült menteni a web-fetch vezérlőit')
  }
}

export type WebSearchPolicyView = ReturnType<typeof connectorToPolicyView>

/** Aktív tenant web search policy — minden agent ezt használja. */
export async function getWebSearchPolicy() {
  try {
    const ctx = await requireTenantRole('viewer')
    const connector = await resolveTenantWebSearchConnectorForContext(ctx.activeTenantId!)
    return ok(connectorToPolicyView(connector))
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült betölteni a web-search policyt')
  }
}

/** Platform web search hitelesítő adatai (URL + kulcs) — superadmin. */
export async function getPlatformWebSearchPolicy() {
  try {
    await requirePlatformRole('superadmin')
    const connector = await ensurePlatformWebSearchConnector()
    return ok(connectorToPolicyView(connector))
  } catch (e) {
    return fail(
      e instanceof Error ? e.message : 'Nem sikerült betölteni a platform web search beállítást',
    )
  }
}

export async function updatePlatformWebSearch(input: unknown) {
  try {
    const user = (await requirePlatformRole('superadmin')).user
    const parsed = updatePlatformWebSearchSchema.parse(input)
    const connector = await ensurePlatformWebSearchConnector()

    const previous = parseWebSearchConfig(connector.config)
    const nextConfig: WebSearchConnectorConfig = {
      ...previous,
      provider: 'custom_search_api',
      providerApiUrl: parsed.providerApiUrl ?? previous.providerApiUrl,
    }
    if (!nextConfig.providerApiUrl) {
      return fail('Platform web searchhez API URL szükséges.')
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
        name: PLATFORM_WEB_SEARCH_CONNECTOR_NAME,
        config: nextConfig as unknown as Prisma.InputJsonValue,
        secretAlias: nextSecretAlias,
        version: { increment: 1 },
        lifecycleState: 'active',
      },
    })

    await repositories.audit.append({
      actorType: 'human',
      actorId: user.id,
      agentVersion: null,
      action: 'web_search.platform_hosted.config_changed',
      targetType: 'connector',
      targetId: connector.id,
      modelUsed: null,
      inputRef: connector.name,
      outputRef: 'updated',
      policyDecision: 'allowed',
      metadata: {
        connectorId: connector.id,
        providerApiUrl: nextConfig.providerApiUrl ?? null,
        apiKeyRotated,
      } as Prisma.JsonValue,
      tenantId: null,
    })

    return ok(connectorToPolicyView(updated))
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült menteni a platform web search beállítást')
  }
}

export async function updateWebSearchPolicy(input: unknown) {
  try {
    const authCtx = await getAuthContext()
    const isSuperadmin = Boolean(authCtx?.platformRoles.includes('superadmin'))
    const parsed = updateWebSearchPolicySchema.parse(input)

    const connector = await prisma.connector.findUnique({ where: { id: parsed.connectorId } })
    if (!connector || connector.type !== 'web_search') {
      return fail('Web Search connector nem található.')
    }
    if (connector.tenantId === null) {
      return fail('Platform connector — használd a platform web search szerkesztőt.')
    }
    if (connector.lifecycleState !== 'active') {
      return fail('Csak aktív Web Search connector policy szerkeszthető.')
    }

    if (isSuperadmin) {
      await requirePlatformRole('superadmin')
    } else {
      const tenantCtx = await requireTenantRole('admin')
      if (connector.tenantId !== tenantCtx.activeTenantId) {
        return fail('Csak a saját tenant web search policy-ja szerkeszthető.')
      }
    }

    const actorId = authCtx?.user.id
    if (!actorId) return fail('Nincs bejelentkezve')

    const previous = parseWebSearchConfig(connector.config)
    const allowedDomains = normalizeDomains(parsed.allowedDomains)
    const forbidden = findForbiddenAllowedDomain(allowedDomains)
    if (forbidden) {
      return fail(
        `A(z) „${forbidden.pattern}" domain nem vehető fel: belső vagy tiltott cím (localhost, nyers IP, metadata-host, *.internal). Az engedélyezett lista letöltést is nyit, ezért ilyen minta mentése elutasítva.`,
      )
    }
    const nextConfig: WebSearchConnectorConfig = {
      ...previous,
      provider: 'custom_search_api',
      providerApiUrl: parsed.providerApiUrl,
      allowedDomains,
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
    if (!nextConfig.providerApiUrl) {
      return fail('custom_search_api providerhez API URL szükséges.')
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
      actorId,
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
        tenantId: connector.tenantId,
        provider: nextConfig.provider,
        previousProvider: previous.provider,
        allowGeneralWeb: nextConfig.allowGeneralWeb,
        previousAllowGeneralWeb: previous.allowGeneralWeb,
        allowedDomains: nextConfig.allowedDomains,
        allowedDomainsAdded: nextConfig.allowedDomains.filter((d) => !previous.allowedDomains.includes(d)),
        allowedDomainsRemoved: previous.allowedDomains.filter((d) => !nextConfig.allowedDomains.includes(d)),
        deniedDomains: nextConfig.deniedDomains,
        providerApiUrl: nextConfig.providerApiUrl ?? null,
        defaultMaxResults: nextConfig.defaultMaxResults,
        hardMaxResults: nextConfig.hardMaxResults,
        maxQueriesPerTicket: nextConfig.maxQueriesPerTicket,
        maxQueriesPerAgentDay: nextConfig.maxQueriesPerAgentDay,
        apiKeyRotated,
      } as Prisma.JsonValue,
      tenantId: connector.tenantId,
    })

    return ok(connectorToPolicyView(updated))
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

/** Governance dashboard web_search bontás (Feature-spec §7.3) — tenant scope. */
export async function getWebSearchGovernanceSummary(input?: { sinceDays?: number }) {
  try {
    const ctx = await requireTenantRole('viewer')
    const since = new Date(Date.now() - (input?.sinceDays ?? 30) * 24 * 60 * 60 * 1000)
    const rows = await prisma.toolCall.findMany({
      where: {
        toolName: 'web_search',
        createdAt: { gte: since },
        agent: { tenantId: ctx.activeTenantId },
      },
      orderBy: { createdAt: 'desc' },
      take: 1000,
    })

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
