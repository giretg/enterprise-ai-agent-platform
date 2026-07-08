/**
 * Globális (tenantId=null) aktív Gmail connectorok leszerelése — duplikátum takarítás
 * a tenant-scoped provisioning Gmail után.
 *
 * Futtatás: cd app && npx tsx scripts/decommission-orphan-gmail.ts
 */
import { config } from 'dotenv'
import { resolve } from 'node:path'

config({ path: resolve(process.cwd(), '.env.local') })
config({ path: resolve(process.cwd(), '.env') })

const useProduction = process.argv.includes('--production')
const testDbUrl = process.env.DATABASE_URL_TEST?.trim()
if (!useProduction && testDbUrl) {
  process.env.DATABASE_URL = testDbUrl
  process.env.DIRECT_URL = process.env.DIRECT_URL_TEST?.trim() ?? testDbUrl
  console.log('Cél: teszt DB (DATABASE_URL_TEST)')
} else {
  console.log('Cél: éles DB (DATABASE_URL)')
}

async function main() {
  const { prisma } = await import('../src/lib/db')
  const { services } = await import('../src/domain')

  const orphans = await prisma.connector.findMany({
    where: { type: 'gmail', lifecycleState: 'active', tenantId: null },
    orderBy: { createdAt: 'asc' },
  })

  if (orphans.length === 0) {
    console.log('Nincs globális aktív Gmail connector — nincs teendő.')
    return
  }

  const admin = await prisma.user.findFirst({
    where: { role: 'admin', status: 'active' },
    orderBy: { createdAt: 'asc' },
  })
  if (!admin) {
    throw new Error('Nincs aktív admin user a leszereléshez')
  }

  const tenant = await prisma.tenant.findFirst({ orderBy: { createdAt: 'asc' } })
  const actor = {
    type: 'user' as const,
    userId: admin.id,
    role: 'admin' as const,
    tenantId: tenant?.id ?? null,
  }

  for (const connector of orphans) {
    console.log(`Leszerelés: ${connector.name} (${connector.id})`)
    const res = await services.provisioning.decommissionActiveConnector(
      {
        connectorId: connector.id,
        reason: 'Globális Gmail duplikátum takarítás (provisioning refaktor után)',
      },
      actor,
    )
    console.log(`  → archived, érintett agentek: ${res.affectedAgentIds.length}`)
  }

  const remaining = await prisma.connector.count({
    where: { type: 'gmail', lifecycleState: 'active' },
  })
  console.log(`Kész. Aktív Gmail connectorok száma: ${remaining}`)
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    const { prisma } = await import('../src/lib/db')
    await prisma.$disconnect()
  })
