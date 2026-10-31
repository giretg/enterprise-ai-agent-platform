'use server'

import type { Prisma } from '@prisma/client'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireTenantRole } from '@/auth/tenant-context'
import { services } from '@/domain/gateway-services'
import { buildConnectorSecretRef, saveConnectorApiKey } from '@/domain/connector/connector-secret-store'
import { readExternalClientsEnabled, withExternalClientsEnabled } from '@/domain/enterprise-tools/harness-substitutes'
import { WEB_SEARCH_TOOL } from '@/domain/enterprise-tools/tool-definitions'
import {
  WEB_SEARCH_CONNECTOR_NAME,
  parseWebSearchConfig,
  webSearchConfigSchema,
  type WebSearchConfig,
} from '@/domain/web-search/web-search'
import { prisma } from '@/lib/db'
import { fail, ok } from '@/lib/result'
import { repositories } from '@/repositories/postgres'

export type WebSearchAdminView = {
  keyConfigured: boolean
  config: WebSearchConfig
  externalClients: boolean
  /** Munkatársak, akiknél a webes keresés be van kapcsolva. */
  agentsWithWebSearch: number
}

async function loadView(tenantId: string): Promise<WebSearchAdminView> {
  const [connector, tenant, agentsWithWebSearch] = await Promise.all([
    repositories.connectors.findByTenantTypeAndName(tenantId, 'web_search', WEB_SEARCH_CONNECTOR_NAME),
    repositories.tenants.findById(tenantId),
    prisma.agent.count({ where: { tenantId, capabilities: { some: { toolName: WEB_SEARCH_TOOL, allowed: true } } } }),
  ])
  return {
    keyConfigured: Boolean(connector?.secretAlias),
    config: parseWebSearchConfig(connector?.config),
    externalClients: readExternalClientsEnabled(tenant?.settings),
    agentsWithWebSearch,
  }
}

/** #1020: Beállítások → Webes keresés. */
export async function getWebSearchSettingsAction() {
  try {
    const ctx = await requireTenantRole('admin')
    return ok(await loadView(ctx.activeTenantId))
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'load_failed')
  }
}

const saveSchema = z.object({
  /** Üres = a meglévő kulcs marad. */
  apiKey: z.string().max(500).optional(),
  config: webSearchConfigSchema,
  externalClients: z.boolean(),
})

export async function saveWebSearchSettingsAction(input: z.input<typeof saveSchema>) {
  try {
    const ctx = await requireTenantRole('admin')
    const parsed = saveSchema.safeParse(input)
    if (!parsed.success) return fail('Ellenőrizd a mezőket: a domain például „mnb.hu” vagy „*.gov.hu” lehet.')
    const { config, externalClients } = parsed.data
    const apiKey = parsed.data.apiKey?.trim() ?? ''
    if (config.defaultMaxResults > config.hardMaxResults) {
      return fail('Az alapértelmezett találatszám nem lehet nagyobb a felső korlátnál.')
    }
    const tenantId = ctx.activeTenantId
    let connector = await repositories.connectors.findByTenantTypeAndName(tenantId, 'web_search', WEB_SEARCH_CONNECTOR_NAME)
    if (!connector && !apiKey) return fail('Az első mentéshez add meg a Brave Search API-kulcsot.')
    connector ??= await repositories.connectors.create({
      tenantId,
      type: 'web_search',
      name: WEB_SEARCH_CONNECTOR_NAME,
      authMode: 'service',
      scope: 'single',
      config: config as unknown as Prisma.InputJsonValue,
    })
    // A kulcs nem kerül a DB-be: Secret Manager, a connector csak a hivatkozást tartja.
    if (apiKey) await saveConnectorApiKey(connector.id, apiKey)
    await prisma.connector.update({
      where: { id: connector.id },
      data: {
        config: config as unknown as Prisma.InputJsonValue,
        ...(apiKey ? { secretAlias: buildConnectorSecretRef(connector.id) } : {}),
        lifecycleState: 'active',
      },
    })
    await prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.findUnique({ where: { id: tenantId }, select: { settings: true } })
      await tx.tenant.update({ where: { id: tenantId }, data: { settings: withExternalClientsEnabled(tenant?.settings, externalClients) } })
    })
    // A már web_search jogú munkatársak is megkapják a kötést; élesben az újraközzététel után érvényes.
    const agents = await prisma.agent.findMany({
      where: { tenantId, capabilities: { some: { toolName: WEB_SEARCH_TOOL, allowed: true } } },
      select: { id: true },
    })
    for (const agent of agents) {
      await repositories.agents.upsertConnectorBinding({ agentId: agent.id, connectorId: connector.id, accessMode: 'read' })
    }
    await services.audit.append({
      actorType: 'human',
      actorId: ctx.user.id,
      agentVersion: null,
      action: 'platform_setting.web_search_changed',
      targetType: 'tenant',
      targetId: tenantId,
      modelUsed: null,
      inputRef: null,
      outputRef: null,
      policyDecision: 'updated',
      metadata: { connectorId: connector.id, keyReplaced: Boolean(apiKey), config, externalClients, boundAgents: agents.length },
      tenantId,
    })
    revalidatePath('/control-plane/settings')
    return ok(await loadView(tenantId))
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'save_failed')
  }
}
