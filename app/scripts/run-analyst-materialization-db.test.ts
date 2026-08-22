/**
 * Futás-elemző tenant materializáció — DB regresszió (#345).
 *
 * Futtatás: npm run test:run-analyst-materialization-db
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { prisma } from '../src/lib/db'
import {
  ensureTenantRunAnalystAgent,
  findTenantRunAnalystAgent,
  materializeRunAnalystAdminGrants,
} from '../src/domain/agent-access/run-analyst-materialization'
import { materializeDefaultUserAgentGrants } from '../src/domain/agent-access/default-user-agent-grants'
import { isAdminOnlyGraphNode, receivesDefaultUserAgentGrants } from '../src/lib/platform-agent-registry'

let failures = 0

async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn()
    console.log(`  OK  ${name}`)
  } catch (e) {
    failures++
    console.log(`  FAIL ${name}: ${e instanceof Error ? e.message : String(e)}`)
  }
}

async function seedTenant() {
  const suffix = randomUUID().slice(0, 8)
  const tenant = await prisma.tenant.create({
    data: { slug: `ra-${suffix}`, displayName: 'Run Analyst Tenant' },
  })
  const admin = await prisma.user.create({
    data: {
      externalAuthId: `ext-a-${suffix}`,
      email: `admin-${suffix}@example.test`,
      name: 'Admin',
      status: 'active',
      role: 'admin',
      tenantId: tenant.id,
    },
  })
  const operator = await prisma.user.create({
    data: {
      externalAuthId: `ext-o-${suffix}`,
      email: `op-${suffix}@example.test`,
      name: 'Operator',
      status: 'active',
      role: 'operator',
      tenantId: tenant.id,
    },
  })
  await prisma.tenantMembership.createMany({
    data: [
      { tenantId: tenant.id, userId: admin.id, role: 'admin', status: 'active' },
      { tenantId: tenant.id, userId: operator.id, role: 'operator', status: 'active' },
    ],
  })
  return { tenant, admin, operator, suffix }
}

async function main() {
  console.log('=== Futás-elemző materializáció — DB regresszió (#345) ===')

  await check('isAdminOnlyGraphNode és deny-by-default grant szabály', () => {
    assert.equal(isAdminOnlyGraphNode({ systemRole: 'run_analyst' }), true)
    assert.equal(receivesDefaultUserAgentGrants({ systemRole: 'run_analyst' }), false)
  })

  await check('ensureTenantRunAnalystAgent: pontosan egy példány, helyes alapértékek', async () => {
    const s = await seedTenant()
    const agent = await ensureTenantRunAnalystAgent({
      tenantId: s.tenant.id,
      approvedById: s.admin.id,
    })
    assert.equal(agent.systemRole, 'run_analyst')
    assert.equal(agent.status, 'active')
    assert.equal(agent.role, 'worker')
    assert.equal(agent.hiddenFromOperators, true)
    assert.equal(agent.inboundRestricted, true)
    assert.equal(agent.outboundRestricted, true)

    const again = await ensureTenantRunAnalystAgent({
      tenantId: s.tenant.id,
      approvedById: s.admin.id,
    })
    assert.equal(again.id, agent.id)
    const count = await prisma.agent.count({
      where: { tenantId: s.tenant.id, systemRole: 'run_analyst' },
    })
    assert.equal(count, 1)

    const memory = await prisma.memory.findUniqueOrThrow({
      where: { id: agent.memoryId! },
      include: { versions: true },
    })
    assert.equal(memory.versions.length, 1)
    assert.equal(memory.currentVersionId, memory.versions[0]!.id)
  })

  await check('admin grantok: canView + canAddress; operator nem kap', async () => {
    const s = await seedTenant()
    const agent = await ensureTenantRunAnalystAgent({
      tenantId: s.tenant.id,
      approvedById: s.admin.id,
    })
    const grants = await prisma.agentAccessGrant.findMany({
      where: { tenantId: s.tenant.id, targetAgentId: agent.id },
    })
    assert.equal(grants.length, 1)
    assert.equal(grants[0]!.subjectUserId, s.admin.id)
    assert.equal(grants[0]!.canView, true)
    assert.equal(grants[0]!.canAddress, true)
    assert.ok(!grants.some((g) => g.subjectUserId === s.operator.id))
  })

  await check('materializeDefaultUserAgentGrants: run_analyst 0 default grant, inbound érintetlen', async () => {
    const s = await seedTenant()
    const agent = await ensureTenantRunAnalystAgent({
      tenantId: s.tenant.id,
      approvedById: s.admin.id,
    })
    await prisma.agentAccessGrant.deleteMany({ where: { targetAgentId: agent.id } })
    const result = await materializeDefaultUserAgentGrants({
      tenantId: s.tenant.id,
      actorUserId: s.admin.id,
      agentId: agent.id,
    })
    assert.equal(result.grantsCreated, 0)
    assert.equal(result.agentsRestricted, 0)
    const row = await prisma.agent.findUniqueOrThrow({ where: { id: agent.id } })
    assert.equal(row.inboundRestricted, true)
    assert.equal(row.outboundRestricted, true)
  })

  await check('meglévő példán: restriction-kapcsolók nem íródnak vissza', async () => {
    const s = await seedTenant()
    const agent = await ensureTenantRunAnalystAgent({
      tenantId: s.tenant.id,
      approvedById: s.admin.id,
    })
    await prisma.agent.update({
      where: { id: agent.id },
      data: { inboundRestricted: false, outboundRestricted: false },
    })
    await ensureTenantRunAnalystAgent({ tenantId: s.tenant.id, approvedById: s.admin.id })
    const row = await prisma.agent.findUniqueOrThrow({ where: { id: agent.id } })
    assert.equal(row.inboundRestricted, false)
    assert.equal(row.outboundRestricted, false)
  })

  await check('új admin user: materializeRunAnalystAdminGrants pótolja a grantot', async () => {
    const s = await seedTenant()
    await ensureTenantRunAnalystAgent({ tenantId: s.tenant.id, approvedById: s.admin.id })
    const admin2 = await prisma.user.create({
      data: {
        externalAuthId: `ext-a2-${s.suffix}`,
        email: `admin2-${s.suffix}@example.test`,
        name: 'Admin2',
        status: 'active',
        role: 'admin',
        tenantId: s.tenant.id,
      },
    })
    await prisma.tenantMembership.create({
      data: { tenantId: s.tenant.id, userId: admin2.id, role: 'admin', status: 'active' },
    })
    const agent = await findTenantRunAnalystAgent(s.tenant.id)
    assert.ok(agent)
    const result = await materializeRunAnalystAdminGrants({
      tenantId: s.tenant.id,
      actorUserId: s.admin.id,
      userId: admin2.id,
    })
    assert.equal(result.grantsCreated, 1)
    const grant = await prisma.agentAccessGrant.findFirstOrThrow({
      where: { tenantId: s.tenant.id, subjectUserId: admin2.id, targetAgentId: agent!.id },
    })
    assert.equal(grant.canView, true)
    assert.equal(grant.canAddress, true)
  })

  console.log(failures === 0 ? '\nMinden DB-regresszió zöld.' : `\n${failures} teszt elbukott.`)
  process.exitCode = failures === 0 ? 0 : 1
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
