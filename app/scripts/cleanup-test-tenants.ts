/**
 * Egyszeri (vagy ismétlő) takarítás: DB-regressziós tesztek által bent hagyott tenantok.
 *
 * Futtatás:
 *   npm run db:cleanup-test-tenants
 *   npm run db:cleanup-test-tenants -- --dry-run
 */
import './load-env'

import { prisma } from '../src/lib/db'
import { deleteTestTenants, isKnownTestTenantSlug } from './_test-tenant-cleanup'

async function main() {
  const dryRun = process.argv.includes('--dry-run')

  const tenants = await prisma.tenant.findMany({
    select: { id: true, slug: true, displayName: true },
    orderBy: { createdAt: 'asc' },
  })

  const toDelete = tenants.filter((t) => isKnownTestTenantSlug(t.slug))

  if (toDelete.length === 0) {
    console.log('Nincs törlendő teszt tenant.')
    return
  }

  console.log(`${dryRun ? '[dry-run] ' : ''}Törlendő tenantok (${toDelete.length}):`)
  for (const t of toDelete) {
    console.log(`  - ${t.displayName} (${t.slug})`)
  }

  if (dryRun) return

  await deleteTestTenants(
    prisma,
    toDelete.map((t) => t.id),
  )
  console.log(`\nTörölve: ${toDelete.length} teszt tenant.`)
  console.log(`Maradt: ${tenants.length - toDelete.length} tenant`)
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
