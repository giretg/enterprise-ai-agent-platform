/**
 * Aktív tenant(ek)hez hiányzó Google Drive connector + provisioning draft pótlása.
 *
 * Futtatás: cd app && npx tsx scripts/backfill-google-drive-connector.ts
 * Éles DB:  cd app && npx tsx scripts/backfill-google-drive-connector.ts --production
 */
import { config } from 'dotenv'
import { resolve } from 'node:path'
import { ensureTenantGoogleDriveConnector } from '../src/lib/seed-google-drive-connector'

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

  const tenantIds = new Set<string>()
  const gmailConnectors = await prisma.connector.findMany({
    where: { type: 'gmail', lifecycleState: 'active', tenantId: { not: null } },
    select: { tenantId: true },
  })
  for (const row of gmailConnectors) {
    if (row.tenantId) tenantIds.add(row.tenantId)
  }

  if (tenantIds.size === 0) {
    const tenants = await prisma.tenant.findMany({ select: { id: true, slug: true } })
    for (const tenant of tenants) tenantIds.add(tenant.id)
    console.log(`Nincs aktív Gmail connector — ${tenantIds.size} tenant ellenőrizve.`)
  }

  if (tenantIds.size === 0) {
    console.log('Nincs tenant a backfillhez.')
    return
  }

  for (const tenantId of tenantIds) {
    const existing = await prisma.connector.findFirst({
      where: { type: 'google_drive', tenantId, lifecycleState: 'active' },
    })
    if (existing) {
      console.log(`Már van aktív Google Drive connector: ${existing.name} (${existing.id})`)
      continue
    }

    const connector = await ensureTenantGoogleDriveConnector(prisma, tenantId)
    console.log(`Google Drive connector létrehozva: ${connector.name} (${connector.id}) · tenant ${tenantId}`)
  }
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
