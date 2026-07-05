/**
 * Egyszeri (vagy ismétlő) takarítás: teszt ticketek törlése a boardról.
 * Futtatás: npm run db:cleanup-test-tickets
 */
import './load-env'

import { prisma } from '../src/lib/db'
import { isLegacyTestTicketTitle } from '../src/lib/ticket-source'

async function main() {
  const all = await prisma.ticket.findMany({
    select: { id: true, title: true, source: true },
  })

  const legacyIds = all.filter((t) => isLegacyTestTicketTitle(t.title)).map((t) => t.id)
  const testSourceIds = all.filter((t) => t.source === 'test').map((t) => t.id)
  const toDelete = [...new Set([...legacyIds, ...testSourceIds])]

  if (toDelete.length === 0) {
    console.log('Nincs törlendő teszt ticket.')
    return
  }

  const { count } = await prisma.ticket.deleteMany({ where: { id: { in: toDelete } } })
  console.log(`Törölve: ${count} teszt ticket (${legacyIds.length} legacy cím, ${testSourceIds.length} source=test)`)
  console.log(`Maradt: ${all.length - count} ticket`)
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
