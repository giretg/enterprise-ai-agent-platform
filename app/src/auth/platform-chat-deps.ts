import type { UserRole } from '@prisma/client'
import { repositories } from '@/repositories/postgres'
import { services } from '@/domain/gateway-services'
import { isDispatchable } from '@/lib/agent-lifecycle'
import { canViewAgent } from '@/auth/mcp-server'
import { loadOpenRouterTenantKey } from '@/lib/openrouter-tenant-key'
import { chatTokenKeyFromEnv } from '@/domain/platform-chat/chat-token'
import type { ChatSessionDeps, ContinuationDeps } from '@/domain/platform-chat/session'
import { readPlatformChatSettings } from '@/lib/platform-chat-settings'
import type { PlatformChatGatewayDeps } from '@/domain/platform-chat/gateway'
import { PostgresPlatformChatGatewayRepository } from '@/repositories/postgres/platform-chat-gateway-repository'

const store = new PostgresPlatformChatGatewayRepository()

/** #1004: tenant-kapcsoló + keret a `Tenant.settings`-ből, agent-kapcsoló az `Agent`-ből. */
export async function loadPlatformChatAccess(input: { tenantId: string; agentId: string }) {
  const [tenant, agent] = await Promise.all([
    repositories.tenants.findById(input.tenantId),
    repositories.agents.findById(input.agentId, input.tenantId),
  ])
  const settings = readPlatformChatSettings(tenant?.settings)
  return {
    tenantEnabled: settings.enabled,
    dailyBudgetUsd: settings.dailyBudgetUsd,
    agentEnabled: agent?.platformChatEnabled ?? false,
  }
}

export function platformChatGatewayDeps(): PlatformChatGatewayDeps {
  const fallback = Number(process.env.PLATFORM_CHAT_FALLBACK_USD_PER_MTOK)
  return {
    store,
    audit: repositories.audit,
    loadAccess: loadPlatformChatAccess,
    ...(Number.isFinite(fallback) && fallback > 0 ? { fallbackUsdPerMTok: fallback } : {}),
  }
}

export { store as platformChatGatewayStore }

/** Publikált + látható agent: ugyanaz a szabály, mint a gateway-token `agentAccessible`-jében. */
async function canUseAgent(input: { tenantId: string; userId: string; role: UserRole; agentId: string }) {
  const def = await services.agentDefinitions.loadAgentDefinition({ tenantId: input.tenantId, agentId: input.agentId })
  return !!def && isDispatchable(def.status) && canViewAgent(input)
}

export function chatSessionDeps(): ChatSessionDeps {
  return {
    signingKey: chatTokenKeyFromEnv(),
    workerUrl: process.env.PLATFORM_CHAT_WORKER_URL || undefined,
    loadTenant: async (tenantId) => {
      const tenant = await repositories.tenants.findById(tenantId)
      return tenant ? { slug: tenant.slug, settings: readPlatformChatSettings(tenant.settings) } : null
    },
    // D2: a tenant SAJÁT kulcsa kell; a platform env-kulcsa nem számít (az nem a cég költsége).
    modelKeyConfigured: async (tenantId) => Boolean((await loadOpenRouterTenantKey(tenantId))?.trim()),
    loadAccess: loadPlatformChatAccess,
    canUseAgent,
    audit: repositories.audit,
  }
}

export function continuationDeps(): ContinuationDeps {
  return {
    signingKey: chatTokenKeyFromEnv(),
    loadAccess: loadPlatformChatAccess,
    canUseAgent,
    audit: repositories.audit,
    principal: {
      verifyOAuthToken: async () => null,
      users: repositories.users,
      tenants: repositories.tenants,
      memberships: repositories.tenantMemberships,
      platformMemberships: repositories.platformMemberships,
      audit: repositories.audit,
    },
  }
}
