/**
 * Egy tenant (vagy az összes) user→agent kiinduló jogmátrixának anyagiasítása.
 * A 0022 migráció SQL-je ugyanezt teszi globálisan; ez a script újrafuttatható
 * (pl. ha közben új tag/agent jött, vagy a migráció előtt kell egy tenant).
 *
 * Futtatás: npx tsx scripts/backfill-explicit-user-agent-access.ts [tenantId]
 */
import { prisma } from '../src/lib/db'
import { materializeDefaultUserAgentGrants } from '../src/domain/agent-access/default-user-agent-grants'

async function main() {
  const onlyTenant = process.argv[2]
  const tenants = onlyTenant
    ? await prisma.tenant.findMany({ where: { id: onlyTenant }, select: { id: true, slug: true } })
    : await prisma.tenant.findMany({ select: { id: true, slug: true } })

  if (tenants.length === 0) {
    console.error(onlyTenant ? `Nincs ilyen tenant: ${onlyTenant}` : 'Nincs tenant.')
    process.exitCode = 1
    return
  }

  for (const tenant of tenants) {
    const admin = await prisma.tenantMembership.findFirst({
      where: { tenantId: tenant.id, role: 'admin', status: { in: ['active', 'pending'] } },
      select: { userId: true },
      orderBy: { createdAt: 'asc' },
    })
    if (!admin) {
      console.log(`  SKIP ${tenant.slug}: nincs admin a granted_by-hoz`)
      continue
    }
    const result = await materializeDefaultUserAgentGrants({
      tenantId: tenant.id,
      actorUserId: admin.userId,
    })
    console.log(
      `  OK  ${tenant.slug}: +${result.grantsCreated} grant, ${result.agentsRestricted} agent inbound zárva`,
    )
  }
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
