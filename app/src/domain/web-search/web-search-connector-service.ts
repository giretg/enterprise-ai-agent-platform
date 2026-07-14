/**
 * Web Search connector lifecycle — két egymástól elválasztott konfigurációs sík.
 *
 * A platform connector kizárólag a tenant nélküli system agenteké (provisioning
 * web-discovery / web-egress). Minden tenant saját `custom_search_api` connectort,
 * endpointot és secretet kap; tenant connector nem hivatkozhat a platform kulcsára.
 */
import type { Connector, Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import { upsertConnectorByTypeName } from '@/lib/connector-upsert'
import {
  DEFAULT_WEB_SEARCH_CONFIG,
  parseWebSearchConfig,
  type WebSearchConnectorConfig,
} from './web-search-types'

export const PLATFORM_WEB_SEARCH_CONNECTOR_NAME = 'Platform Web Search'
const LEGACY_PLATFORM_WEB_SEARCH_CONNECTOR_NAME = 'Platform Hosted Web Search'
export const TENANT_WEB_SEARCH_CONNECTOR_NAME = 'Web Search'

export function defaultTenantWebSearchConfig(
  overrides: Partial<WebSearchConnectorConfig> = {},
): WebSearchConnectorConfig {
  return {
    ...DEFAULT_WEB_SEARCH_CONFIG,
    allowGeneralWeb: true,
    ...overrides,
    // A scope-határt override sem írhatja felül.
    provider: 'custom_search_api',
  }
}

export async function findPlatformWebSearchConnector(): Promise<Connector | null> {
  return prisma.connector.findFirst({
    where: {
      type: 'web_search',
      tenantId: null,
      name: { in: [PLATFORM_WEB_SEARCH_CONNECTOR_NAME, LEGACY_PLATFORM_WEB_SEARCH_CONNECTOR_NAME] },
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
 * Platform connector — a tenant nélküli system agentek web-search policy-ja és
 * hitelesítő adatai (API URL + secret-ref). Nem tenant policy és tenant nem örökli.
 */
export async function ensurePlatformWebSearchConnector(
  configOverrides: Partial<WebSearchConnectorConfig> = {},
): Promise<Connector> {
  const existing = await findPlatformWebSearchConnector()
  if (existing) {
    return prisma.connector.update({
      where: { id: existing.id },
      data: { name: PLATFORM_WEB_SEARCH_CONNECTOR_NAME, lifecycleState: 'active' },
    })
  }

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
      name: PLATFORM_WEB_SEARCH_CONNECTOR_NAME,
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
  if (existing) {
    const existingConfig = parseWebSearchConfig(existing.config)
    if (existingConfig.provider === 'custom_search_api') return existing

    // Deploy/backfill migráció: a korábbi platform_hosted_search/stub tenant-konfigot
    // leválasztjuk a platform connectorról. Policy-mezők maradnak, platform endpoint és
    // secret viszont nem kerül át; a tenant adminnak saját endpointot/kulcsot kell megadnia.
    delete existingConfig.providerApiUrl
    existingConfig.provider = 'custom_search_api'
    return prisma.connector.update({
      where: { id: existing.id },
      data: {
        config: existingConfig as unknown as Prisma.InputJsonValue,
        secretAlias: null,
        version: { increment: 1 },
      },
    })
  }

  const config = defaultTenantWebSearchConfig(configOverrides)

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
    await ensureTenantWebSearchConnector(id)
    if (!before) created++
  }
  return created
}
