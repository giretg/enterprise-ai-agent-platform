/**
 * Web Search tenant-modell migráció:
 * - platform-hosted connector
 * - tenant connector / tenant
 * - agent link átkötése tenant connectorra (globális legacy link eltávolítása)
 *
 * Futtatás: npx tsx scripts/migrate-web-search-tenants.ts
 */
import { config } from 'dotenv'
import { PrismaClient } from '@prisma/client'
import {
  ensureAllTenantsHaveWebSearchConnector,
  ensurePlatformHostedWebSearchConnector,
  ensureTenantWebSearchConnector,
  findTenantWebSearchConnector,
  PLATFORM_HOSTED_WEB_SEARCH_CONNECTOR_NAME,
  TENANT_WEB_SEARCH_CONNECTOR_NAME,
} from '../src/domain/web-search/web-search-connector-service'

config({ path: '.env.local' })
config()

const prisma = new PrismaClient()

async function main() {
  await ensurePlatformHostedWebSearchConnector()
  console.log('✓ Platform Hosted Web Search connector')

  const created = await ensureAllTenantsHaveWebSearchConnector()
  console.log(`✓ Tenant connectors (új: ${created})`)

  const agents = await prisma.agent.findMany({
    where: { tenantId: { not: null } },
    select: { id: true, tenantId: true },
  })

  let relinked = 0
  for (const agent of agents) {
    if (!agent.tenantId) continue
    const tenantConnector = await findTenantWebSearchConnector(agent.tenantId)
    if (!tenantConnector) {
      await ensureTenantWebSearchConnector(agent.tenantId)
      continue
    }

    const legacyLinks = await prisma.agentConnector.findMany({
      where: {
        agentId: agent.id,
        connector: {
          type: 'web_search',
          OR: [{ tenantId: null }, { name: { not: TENANT_WEB_SEARCH_CONNECTOR_NAME } }],
        },
      },
      include: { connector: true },
    })

    for (const link of legacyLinks) {
      await prisma.agentConnector.delete({
        where: { agentId_connectorId: { agentId: agent.id, connectorId: link.connectorId } },
      })
      relinked++
    }

    await prisma.agentConnector.upsert({
      where: {
        agentId_connectorId: { agentId: agent.id, connectorId: tenantConnector.id },
      },
      create: { agentId: agent.id, connectorId: tenantConnector.id, accessMode: 'read' },
      update: { accessMode: 'read' },
    })
  }

  const archived = await prisma.connector.updateMany({
    where: {
      type: 'web_search',
      tenantId: null,
      name: { not: PLATFORM_HOSTED_WEB_SEARCH_CONNECTOR_NAME },
      lifecycleState: 'active',
    },
    data: { lifecycleState: 'archived' },
  })

  console.log(`✓ Agent link migráció (törölt legacy link: ${relinked})`)
  console.log(`✓ Archivált legacy globális connector: ${archived.count}`)
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
