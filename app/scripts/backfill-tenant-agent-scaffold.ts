/**
 * Backfill: minden meglévő tenant kapja meg a saját Agent Scaffold példányát (#584).
 *
 * Idempotens: meglévő published+active példányt nem hoz létre újra.
 *
 * Futtatás: npx tsx scripts/backfill-tenant-agent-scaffold.ts
 */
import { prisma } from '../src/lib/db'
import { repositories } from '../src/repositories/postgres'
import {
  ensureTenantAgentScaffold,
  findTenantAgentScaffold,
} from '../src/domain/agent-scaffold-materialization'

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
    console.error('Nincs aktív felhasználó — publish/activate jóváhagyója nem oldható fel.')
    process.exitCode = 1
    return
  }

  const deps = {
    agents: repositories.agents,
    versions: repositories.agentDefinitions,
    skills: repositories.skills,
  }

  let created = 0
  let skipped = 0
  for (const tenant of tenants) {
    const before = await findTenantAgentScaffold(deps.agents, tenant.id)
    await ensureTenantAgentScaffold(deps, { tenantId: tenant.id, publishedById: actor.id })
    const after = await findTenantAgentScaffold(deps.agents, tenant.id)
    if (before?.currentDefinitionVersionId && before.status === 'active') {
      skipped++
      console.log(`  = ${tenant.slug}: már van Agent Scaffold`)
    } else {
      created++
      console.log(`  + ${tenant.slug}: Agent Scaffold (${after?.id ?? '?'})`)
    }
  }

  console.log(`\nKész: ${created} létrehozva/frissítve, ${skipped} változatlan (${tenants.length} tenant).`)
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
