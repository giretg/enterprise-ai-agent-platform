/**
 * Backfill: minden meglévő tenant kapja meg a SAJÁT Futás-elemző példányát (#345).
 *
 * Idempotens: meglévő példányt nem hoz létre újra, restriction-kapcsolókat nem írja
 * felül, hiányzó admin grantokat pótolja.
 *
 * Futtatás: npx tsx scripts/backfill-tenant-run-analyst.ts
 */
import { prisma } from '../src/lib/db'
import {
  ensureTenantRunAnalystAgent,
  findTenantRunAnalystAgent,
} from '../src/domain/agent-access/run-analyst-materialization'

async function main() {
  const tenants = await prisma.tenant.findMany({
    where: { status: { in: ['active', 'suspended', 'offboarding'] } },
    select: { id: true, slug: true },
    orderBy: { slug: 'asc' },
  })

  const actor =
    (await prisma.user.findFirst({
      where: { status: 'active', platformMemberships: { some: { status: 'active' } } },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    })) ??
    (await prisma.user.findFirst({
      where: { status: 'active' },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    }))

  if (!actor) {
    console.error('Nincs aktív felhasználó — a memória-verzió jóváhagyója nem oldható fel.')
    process.exitCode = 1
    return
  }

  let created = 0
  let skipped = 0
  for (const tenant of tenants) {
    const before = await findTenantRunAnalystAgent(tenant.id)
    await ensureTenantRunAnalystAgent({ tenantId: tenant.id, approvedById: actor.id })
    if (before) {
      skipped++
      console.log(`  = ${tenant.slug}: már van Futás-elemző példány`)
    } else {
      created++
      console.log(`  + ${tenant.slug}: Futás-elemző példány létrehozva (admin-only grantokkal)`)
    }
  }

  console.log(`\nKész: ${created} létrehozva, ${skipped} változatlan (${tenants.length} tenant).`)
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
