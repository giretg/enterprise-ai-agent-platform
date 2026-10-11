/**
 * Kódból seedelt connector-sablonok (beépített + custom) szinkronizálása a DB-be.
 * A cégre szabott sablonok (pl. Ostorosbor CRM) csak a saját tenantjukba kerülnek.
 * Futtatás: cd app && npx tsx scripts/sync-custom-templates.ts --production
 */
import { config } from 'dotenv'
import { resolve } from 'node:path'
import { BUILTIN_CONNECTOR_TEMPLATES } from '../src/domain/connector-template/builtin-templates'
import {
  CUSTOM_CONNECTOR_TEMPLATES,
  CUSTOM_TEMPLATE_TENANT_SLUG_BY_KEY,
} from '../src/domain/connector-template/custom-template-seeds'
import { syncConnectorTemplates } from '../prisma/template-sync'

config({ path: resolve(process.cwd(), '.env.local') })
config({ path: resolve(process.cwd(), '.env') })

const useProduction = process.argv.includes('--production')
const testDbUrl = process.env.DATABASE_URL_TEST?.trim()
if (!useProduction && testDbUrl) {
  process.env.DATABASE_URL = testDbUrl
  process.env.DIRECT_URL = process.env.DIRECT_URL_TEST?.trim() ?? testDbUrl
  console.log('Cél: teszt DB')
} else {
  console.log('Cél: éles DB')
}

async function main() {
  const { prisma } = await import('../src/lib/db')
  await syncConnectorTemplates(prisma, 'builtin', BUILTIN_CONNECTOR_TEMPLATES)
  await syncConnectorTemplates(prisma, 'custom', CUSTOM_CONNECTOR_TEMPLATES, CUSTOM_TEMPLATE_TENANT_SLUG_BY_KEY)
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
