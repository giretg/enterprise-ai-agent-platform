/**
 * Default user→agent grant — DB regresszió (#344).
 *
 * Futtatás valódi Postgres ellen: npm run test:default-user-agent-grants-db
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { prisma } from '../src/lib/db'
import { materializeDefaultUserAgentGrants } from '../src/domain/agent-access/default-user-agent-grants'

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

async function seed() {
  const suffix = randomUUID().slice(0, 8)
  const tenant = await prisma.tenant.create({
    data: { slug: `duag-${suffix}`, displayName: 'Default Grant Tenant' },
  })
  const admin = await prisma.user.create({
    data: {
      externalAuthId: `ext-${suffix}`,
      email: `admin-${suffix}@example.test`,
      name: 'Admin',
      status: 'active',
      role: 'admin',
      tenantId: tenant.id,
    },
  })
  const member = await prisma.user.create({
    data: {
      externalAuthId: `ext-m-${suffix}`,
      email: `member-${suffix}@example.test`,
      name: 'Member',
      status: 'active',
      role: 'operator',
      tenantId: tenant.id,
    },
  })
  await prisma.tenantMembership.createMany({
    data: [
      { tenantId: tenant.id, userId: admin.id, role: 'admin', status: 'active' },
      { tenantId: tenant.id, userId: member.id, role: 'operator', status: 'active' },
    ],
  })

  const mkAgent = async (name: string, opts?: { systemRole?: 'web_egress'; inboundRestricted?: boolean }) => {
    const memory = await prisma.memory.create({ data: {} })
    return prisma.agent.create({
      data: {
        name: `${name}-${suffix}`,
        roleInstruction: 'x',
        behaviorProfile: 'y',
        modelConfig: { provider: 'stub', model: 'stub' },
        status: 'active',
        tenantId: tenant.id,
        memoryId: memory.id,
        systemRole: opts?.systemRole ?? null,
        inboundRestricted: opts?.inboundRestricted ?? false,
      },
    })
  }

  return { tenant, admin, member, mkAgent, suffix }
}

async function main() {
  console.log('=== Default user→agent grant — DB regresszió (#344) ===')
  const s = await seed()

  await check('web_egress: materializeDefaultUserAgentGrants 0 grantot hoz létre és nem zár inboundot', async () => {
    const webEgress = await s.mkAgent('Web-Egress', {
      systemRole: 'web_egress',
      inboundRestricted: true,
    })
    const before = await prisma.agentAccessGrant.count({
      where: { tenantId: s.tenant.id, targetAgentId: webEgress.id },
    })
    const result = await materializeDefaultUserAgentGrants({
      tenantId: s.tenant.id,
      actorUserId: s.admin.id,
      agentId: webEgress.id,
    })
    const after = await prisma.agentAccessGrant.count({
      where: { tenantId: s.tenant.id, targetAgentId: webEgress.id },
    })
    assert.equal(before, 0)
    assert.equal(after, 0)
    assert.equal(result.grantsCreated, 0)
    assert.equal(result.agentsRestricted, 0)
    const row = await prisma.agent.findUniqueOrThrow({ where: { id: webEgress.id } })
    assert.equal(row.inboundRestricted, true)
  })

  await check('normál agent: kiinduló grantok létrejönnek minden tagra', async () => {
    const normal = await s.mkAgent('Normal')
    const result = await materializeDefaultUserAgentGrants({
      tenantId: s.tenant.id,
      actorUserId: s.admin.id,
      agentId: normal.id,
    })
    assert.equal(result.grantsCreated, 2)
    assert.equal(result.agentsRestricted, 1)
    const grants = await prisma.agentAccessGrant.findMany({
      where: { tenantId: s.tenant.id, targetAgentId: normal.id },
    })
    assert.equal(grants.length, 2)
    assert.ok(grants.every((g) => g.canView && g.canAddress))
    const row = await prisma.agent.findUniqueOrThrow({ where: { id: normal.id } })
    assert.equal(row.inboundRestricted, true)
  })

  await check('admin szűkített él nem íródik felül', async () => {
    const normal = await s.mkAgent('Restricted')
    await prisma.agentAccessGrant.create({
      data: {
        id: randomUUID(),
        tenantId: s.tenant.id,
        subjectType: 'user',
        subjectUserId: s.member.id,
        subjectAgentId: null,
        targetAgentId: normal.id,
        canView: true,
        canAddress: false,
        grantedById: s.admin.id,
      },
    })
    await materializeDefaultUserAgentGrants({
      tenantId: s.tenant.id,
      actorUserId: s.admin.id,
      agentId: normal.id,
    })
    const grant = await prisma.agentAccessGrant.findFirstOrThrow({
      where: {
        tenantId: s.tenant.id,
        subjectUserId: s.member.id,
        targetAgentId: normal.id,
      },
    })
    assert.equal(grant.canView, true)
    assert.equal(grant.canAddress, false)
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
