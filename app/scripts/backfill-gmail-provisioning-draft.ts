/**
 * Aktív tenant-scope Gmail connectorokhoz hiányzó connector_draft sor pótlása.
 *
 * Futtatás: cd app && npx tsx scripts/backfill-gmail-provisioning-draft.ts --production
 */
import { config } from 'dotenv'
import { resolve } from 'node:path'
import { BUILTIN_CONNECTOR_TEMPLATES } from '../src/domain/connector-template/builtin-templates'
import { ensureGmailProvisioningDraft } from '../src/lib/seed-gmail-connector'

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
  const rawDescriptor = BUILTIN_CONNECTOR_TEMPLATES.find((t) => t.key === 'google-workspace')
  if (!rawDescriptor) throw new Error('builtin google-workspace template missing')

  const activeGmail = await prisma.connector.findMany({
    where: { type: 'gmail', lifecycleState: 'active', tenantId: { not: null } },
    orderBy: { createdAt: 'asc' },
  })

  if (activeGmail.length === 0) {
    console.log('Nincs aktív tenant-scope Gmail connector.')
    return
  }

  for (const connector of activeGmail) {
    const existingDraft = await prisma.connectorDraft.findUnique({
      where: { connectorId: connector.id },
    })
    if (existingDraft) {
      console.log(`Már van draft: ${connector.name} (${connector.id})`)
      continue
    }
    if (!connector.tenantId) continue

    await ensureGmailProvisioningDraft(prisma, {
      tenantId: connector.tenantId,
      connectorId: connector.id,
      templateKey: 'google-workspace',
      templateDescriptor: rawDescriptor,
    })
    console.log(`Draft létrehozva: ${connector.name} (${connector.id})`)
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
