/**
 * Backfill: minden meglévő tenant kapja meg a SAJÁT Web-Egress példányát (#142).
 *
 * ÜZEMELTETÉSI HATÁS: a `web_research_request` mostantól a tenant SAJÁT Web-Egress
 * agentjét oldja fel. Amíg egy tenantnak nincs példánya, a webes kutatás
 * `web_egress_agent_missing` hibával áll meg — ezért a deploy után EZT a scriptet le
 * kell futtatni. Idempotens: meglévő példányt nem hoz létre újra, és a restriction-
 * kapcsolóit nem írja felül (ha az admin tudatosan lazított rajtuk, az megmarad).
 *
 * A létrejövő példány ALAPBÓL ZÁRT (`inboundRestricted` és `outboundRestricted` is
 * true), tehát a backfill önmagában SEMMIT nem tesz elérhetővé: a webes kimenetet a
 * tenant admin agentenként, explicit agent→Web-Egress `address` granttal engedélyezi.
 *
 * Futtatás: npx tsx scripts/backfill-tenant-web-egress.ts
 */
import { prisma } from '../src/lib/db'
import {
  ensureTenantWebEgressAgent,
  findTenantWebEgressAgent,
} from '../src/domain/agent-access/web-egress-materialization'

async function main() {
  const tenants = await prisma.tenant.findMany({
    where: { status: { in: ['active', 'suspended', 'offboarding'] } },
    select: { id: true, slug: true },
    orderBy: { slug: 'asc' },
  })

  // Audit-attribúció: a legrégebbi aktív platform-admin, különben az első aktív user.
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
    const before = await findTenantWebEgressAgent(tenant.id)
    await ensureTenantWebEgressAgent({ tenantId: tenant.id, approvedById: actor.id })
    if (before) {
      skipped++
      console.log(`  = ${tenant.slug}: már van Web-Egress példány`)
    } else {
      created++
      console.log(`  + ${tenant.slug}: Web-Egress példány létrehozva (mindkét irányban zárt)`)
    }
  }

  console.log(`\nKész: ${created} létrehozva, ${skipped} változatlan (${tenants.length} tenant).`)
  console.log(
    'A webes kutatás csak explicit agent→Web-Egress `address` granttal indul el — az org-ábrán állítható be.',
  )
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
