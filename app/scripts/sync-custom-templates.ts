/**
 * Globális custom connector-sablonok szinkronizálása a kódból a DB-be.
 * Futtatás: cd app && npx tsx scripts/sync-custom-templates.ts --production
 */
import { config } from 'dotenv'
import { resolve } from 'node:path'
import { GLOBAL_CUSTOM_CONNECTOR_TEMPLATES } from '../src/domain/connector-template/custom-template-seeds'
import { withTemplateIcon } from '../prisma/template-icons'

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
  for (const seed of GLOBAL_CUSTOM_CONNECTOR_TEMPLATES) {
    const existing = await prisma.connectorTemplate.findFirst({
      where: { key: seed.key, version: 1, tenantId: null, origin: 'custom' },
    })
    const descriptor = withTemplateIcon(seed, existing?.descriptor)
    if (!existing) {
      await prisma.connectorTemplate.create({
        data: {
          key: descriptor.key,
          version: 1,
          origin: 'custom',
          displayName: descriptor.displayName,
          description: descriptor.description ?? null,
          tenantId: null,
          descriptor,
          status: 'active',
        },
      })
      console.log(`Létrehozva: ${descriptor.displayName}`)
      continue
    }
    await prisma.connectorTemplate.update({
      where: { id: existing.id },
      data: {
        displayName: descriptor.displayName,
        description: descriptor.description ?? null,
        descriptor,
        status: 'active',
      },
    })
    console.log(`Frissítve: ${descriptor.displayName} (${descriptor.key})`)
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
