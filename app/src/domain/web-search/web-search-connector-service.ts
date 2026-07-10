/**
 * Web Search connector lifecycle — tenant-scoped policy + platform-hosted credentials.
 *
 * Minden tenant onboardingkor saját `web_search` connectort kap (policy).
 * A `platform_hosted_search` provider a platform default connector kulcsát/URL-jét
 * használja (költség-elkülönítés opcionálisan saját `custom_search_api` kulccsal).
 */
import type { Connector, Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import { upsertConnectorByTypeName } from '@/lib/connector-upsert'
import {
  DEFAULT_WEB_SEARCH_CONFIG,
  parseWebSearchConfig,
  type WebSearchConnectorConfig,
} from './web-search-types'

export const PLATFORM_HOSTED_WEB_SEARCH_CONNECTOR_NAME = 'Platform Hosted Web Search'
export const TENANT_WEB_SEARCH_CONNECTOR_NAME = 'Web Search'

export function defaultTenantWebSearchConfig(
  overrides: Partial<WebSearchConnectorConfig> = {},
): WebSearchConnectorConfig {
  return {
    ...DEFAULT_WEB_SEARCH_CONFIG,
    provider: 'platform_hosted_search',
    allowGeneralWeb: true,
    ...overrides,
  }
}

export async function findPlatformHostedWebSearchConnector(): Promise<Connector | null> {
  return prisma.connector.findFirst({
    where: {
      type: 'web_search',
      tenantId: null,
      name: PLATFORM_HOSTED_WEB_SEARCH_CONNECTOR_NAME,
      lifecycleState: 'active',
    },
    orderBy: { createdAt: 'asc' },
  })
}

export async function findTenantWebSearchConnector(tenantId: string): Promise<Connector | null> {
  return prisma.connector.findFirst({
    where: {
      type: 'web_search',
      tenantId,
      name: TENANT_WEB_SEARCH_CONNECTOR_NAME,
      lifecycleState: 'active',
    },
    orderBy: { createdAt: 'asc' },
  })
}

/**
 * Platform default connector — csak a platform_hosted_search provider hitelesítő adatai
 * (API URL + secret-ref). Nem tenant policy.
 */
export async function ensurePlatformHostedWebSearchConnector(
  configOverrides: Partial<WebSearchConnectorConfig> = {},
): Promise<Connector> {
  const config: WebSearchConnectorConfig = {
    ...DEFAULT_WEB_SEARCH_CONFIG,
    provider: 'custom_search_api',
    providerApiUrl: undefined,
    allowGeneralWeb: false,
    ...configOverrides,
  }

  return upsertConnectorByTypeName(prisma, {
    create: {
      type: 'web_search',
      name: PLATFORM_HOSTED_WEB_SEARCH_CONNECTOR_NAME,
      authMode: 'agent_owned',
      scope: 'global',
      tenantId: null,
      secretAlias: null,
      version: 1,
      config: config as unknown as Prisma.InputJsonValue,
      lifecycleState: 'active',
    },
    update: {
      lifecycleState: 'active',
    },
  })
}

/** Tenant onboarding — egy aktív web_search connector / tenant. */
export async function ensureTenantWebSearchConnector(
  tenantId: string,
  configOverrides: Partial<WebSearchConnectorConfig> = {},
): Promise<Connector> {
  const existing = await findTenantWebSearchConnector(tenantId)
  if (existing) return existing

  const platform = await findPlatformHostedWebSearchConnector()
  const platformConfig = platform ? parseWebSearchConfig(platform.config) : null
  const config = defaultTenantWebSearchConfig({
    allowedDomains: platformConfig?.allowedDomains ?? DEFAULT_WEB_SEARCH_CONFIG.allowedDomains,
    deniedDomains: platformConfig?.deniedDomains ?? DEFAULT_WEB_SEARCH_CONFIG.deniedDomains,
    allowGeneralWeb: platformConfig?.allowGeneralWeb ?? true,
    safeSearch: platformConfig?.safeSearch ?? 'strict',
    ...configOverrides,
  })

  return prisma.connector.create({
    data: {
      type: 'web_search',
      name: TENANT_WEB_SEARCH_CONNECTOR_NAME,
      authMode: 'agent_owned',
      scope: 'global',
      tenantId,
      secretAlias: null,
      version: 1,
      config: config as unknown as Prisma.InputJsonValue,
      lifecycleState: 'active',
    },
  })
}

/** Meglévő tenantok backfill — seed / deploy után futtatható. */
export async function ensureAllTenantsHaveWebSearchConnector(): Promise<number> {
  const tenants = await prisma.tenant.findMany({
    where: { status: { in: ['active', 'suspended', 'offboarding'] } },
    select: { id: true },
  })
  let created = 0
  for (const { id } of tenants) {
    const before = await findTenantWebSearchConnector(id)
    if (!before) {
      await ensureTenantWebSearchConnector(id)
      created++
    }
  }
  return created
}
