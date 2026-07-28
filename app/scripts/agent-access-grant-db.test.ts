/**
 * Agent-hozzáférési gráf — ADATBÁZIS-szintű invariánsok (#142).
 *
 * Futtatás valódi Postgres ellen: npm run test:agent-access-grant-db
 *
 * Ezeket a garanciákat FAKE NEM tudja bizonyítani, mert a DB kényszeríti ki őket:
 *  - a subject-diszkrimináns és a két FK egymást kizáró kitöltése (CHECK);
 *  - „legalább az egyik ige igaz" (CHECK) — nincs értelmetlen false/false sor;
 *  - self-edge tiltása (CHECK);
 *  - subject→target páronként pontosan egy sor (UNIQUE);
 *  - a cross-table tenant-invariáns TRANZAKCIÓS ellenőrzése (ezt CHECK nem tudja);
 *  - hogy a grant-írás és az audit-esemény ugyanabban a tranzakcióban keletkezik —
 *    tehát nincs olyan állapot, ahol a policy megváltozott, de nyoma nincs.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { prisma } from '../src/lib/db'
import { PostgresAgentAccessGrantRepository } from '../src/repositories/postgres/agent-access-grant-repository'

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

const repo = new PostgresAgentAccessGrantRepository()

/** Egy audit-esemény sablonja a tranzakciós íráshoz. */
const auditFor = (action: string, actorId: string) => () => ({
  actorType: 'human' as const,
  actorId,
  agentVersion: null,
  action,
  targetType: 'agent_access_grant',
  targetId: null,
  modelUsed: null,
  inputRef: null,
  outputRef: null,
  policyDecision: 'granted',
  metadata: {},
})

async function seed() {
  const suffix = randomUUID().slice(0, 8)
  const tenantA = await prisma.tenant.create({
    data: { slug: `t-a-${suffix}`, displayName: 'Tenant A' },
  })
  const tenantB = await prisma.tenant.create({
    data: { slug: `t-b-${suffix}`, displayName: 'Tenant B' },
  })
  const admin = await prisma.user.create({
    data: {
      externalAuthId: `ext-${suffix}`,
      email: `admin-${suffix}@example.test`,
      name: 'Admin',
      status: 'active',
      role: 'admin',
      tenantId: tenantA.id,
    },
  })
  await prisma.tenantMembership.create({
    data: { tenantId: tenantA.id, userId: admin.id, role: 'admin', status: 'active' },
  })

  const mkAgent = async (name: string, tenantId: string | null) => {
    const memory = await prisma.memory.create({ data: {} })
    return prisma.agent.create({
      data: {
        name: `${name}-${suffix}`,
        roleInstruction: 'x',
        behaviorProfile: 'y',
        modelConfig: { provider: 'stub', model: 'stub' },
        status: 'active',
        tenantId,
        memoryId: memory.id,
      },
    })
  }

  return {
    tenantA,
    tenantB,
    admin,
    agentA1: await mkAgent('A1', tenantA.id),
    agentA2: await mkAgent('A2', tenantA.id),
    agentB1: await mkAgent('B1', tenantB.id),
  }
}

async function main() {
  console.log('=== Agent-hozzáférési gráf — DB invariánsok ===')
  const s = await seed()

  await check('a grant-írás és az audit UGYANABBAN a tranzakcióban keletkezik', async () => {
    const before = await prisma.auditLog.count({ where: { action: 'agent_access.grant.create' } })
    const res = await repo.upsertEdge({
      tenantId: s.tenantA.id,
      subjectType: 'user',
      subjectUserId: s.admin.id,
      subjectAgentId: null,
      targetAgentId: s.agentA1.id,
      canView: true,
      canAddress: false,
      grantedById: s.admin.id,
      buildAudit: auditFor('agent_access.grant.create', s.admin.id),
    })
    assert.equal(res.ok, true)
    const after = await prisma.auditLog.count({ where: { action: 'agent_access.grant.create' } })
    assert.equal(after, before + 1, 'nem keletkezett audit-esemény a grant mellé')
  })

  await check('subject→target páronként PONTOSAN EGY sor (bővítés, nem második él)', async () => {
    const res = await repo.upsertEdge({
      tenantId: s.tenantA.id,
      subjectType: 'user',
      subjectUserId: s.admin.id,
      subjectAgentId: null,
      targetAgentId: s.agentA1.id,
      canView: true,
      canAddress: true,
      grantedById: s.admin.id,
      buildAudit: auditFor('agent_access.grant.create', s.admin.id),
    })
    assert.equal(res.ok, true)
    if (res.ok) assert.deepEqual(res.previous, { canView: true, canAddress: false })

    const rows = await prisma.agentAccessGrant.findMany({
      where: { tenantId: s.tenantA.id, subjectUserId: s.admin.id, targetAgentId: s.agentA1.id },
    })
    assert.equal(rows.length, 1)
    assert.equal(rows[0].canAddress, true)
  })

  await check('CHECK: mindkét ige hamis sor NEM hozható létre', async () => {
    await assert.rejects(() =>
      prisma.agentAccessGrant.create({
        data: {
          tenantId: s.tenantA.id,
          subjectType: 'user',
          subjectUserId: s.admin.id,
          targetAgentId: s.agentA2.id,
          canView: false,
          canAddress: false,
          grantedById: s.admin.id,
        },
      }),
    )
  })

  await check('CHECK: `user` alanynál agent-oszlop nem tölthető ki', async () => {
    await assert.rejects(() =>
      prisma.agentAccessGrant.create({
        data: {
          tenantId: s.tenantA.id,
          subjectType: 'user',
          subjectUserId: s.admin.id,
          subjectAgentId: s.agentA1.id,
          targetAgentId: s.agentA2.id,
          canView: true,
          canAddress: false,
          grantedById: s.admin.id,
        },
      }),
    )
  })

  await check('CHECK: `agent` alanynál user-oszlop nem tölthető ki', async () => {
    await assert.rejects(() =>
      prisma.agentAccessGrant.create({
        data: {
          tenantId: s.tenantA.id,
          subjectType: 'agent',
          subjectAgentId: s.agentA1.id,
          subjectUserId: s.admin.id,
          targetAgentId: s.agentA2.id,
          canView: true,
          canAddress: false,
          grantedById: s.admin.id,
        },
      }),
    )
  })

  await check('CHECK: self-edge nem hozható létre', async () => {
    await assert.rejects(() =>
      prisma.agentAccessGrant.create({
        data: {
          tenantId: s.tenantA.id,
          subjectType: 'agent',
          subjectAgentId: s.agentA1.id,
          targetAgentId: s.agentA1.id,
          canView: true,
          canAddress: true,
          grantedById: s.admin.id,
        },
      }),
    )
  })

  await check('tranzakciós tenant-invariáns: cross-tenant CÉL elutasítva', async () => {
    const res = await repo.upsertEdge({
      tenantId: s.tenantA.id,
      subjectType: 'agent',
      subjectUserId: null,
      subjectAgentId: s.agentA1.id,
      targetAgentId: s.agentB1.id,
      canView: true,
      canAddress: true,
      grantedById: s.admin.id,
      buildAudit: auditFor('agent_access.grant.create', s.admin.id),
    })
    assert.equal(res.ok, false)
    if (!res.ok) assert.equal(res.reason, 'target_not_in_tenant')
  })

  await check('tranzakciós tenant-invariáns: cross-tenant ALANY-agent elutasítva', async () => {
    const res = await repo.upsertEdge({
      tenantId: s.tenantA.id,
      subjectType: 'agent',
      subjectUserId: null,
      subjectAgentId: s.agentB1.id,
      targetAgentId: s.agentA1.id,
      canView: true,
      canAddress: true,
      grantedById: s.admin.id,
      buildAudit: auditFor('agent_access.grant.create', s.admin.id),
    })
    assert.equal(res.ok, false)
    if (!res.ok) assert.equal(res.reason, 'subject_not_in_tenant')
  })

  await check('tranzakciós tenant-invariáns: tagság nélküli user-alany elutasítva', async () => {
    const outsider = await prisma.user.create({
      data: {
        externalAuthId: `ext-out-${randomUUID().slice(0, 8)}`,
        email: `out-${randomUUID().slice(0, 8)}@example.test`,
        name: 'Kívülálló',
        status: 'active',
      },
    })
    const res = await repo.upsertEdge({
      tenantId: s.tenantA.id,
      subjectType: 'user',
      subjectUserId: outsider.id,
      subjectAgentId: null,
      targetAgentId: s.agentA1.id,
      canView: true,
      canAddress: true,
      grantedById: s.admin.id,
      buildAudit: auditFor('agent_access.grant.create', s.admin.id),
    })
    assert.equal(res.ok, false)
    if (!res.ok) assert.equal(res.reason, 'subject_not_in_tenant')
  })

  await check('elutasított írásnál NEM keletkezik audit-esemény (fail-closed)', async () => {
    const before = await prisma.auditLog.count({ where: { action: 'agent_access.grant.create' } })
    await repo.upsertEdge({
      tenantId: s.tenantA.id,
      subjectType: 'agent',
      subjectUserId: null,
      subjectAgentId: s.agentA1.id,
      targetAgentId: s.agentB1.id,
      canView: true,
      canAddress: true,
      grantedById: s.admin.id,
      buildAudit: auditFor('agent_access.grant.create', s.admin.id),
    })
    const after = await prisma.auditLog.count({ where: { action: 'agent_access.grant.create' } })
    assert.equal(after, before)
  })

  await check('törlés: a sor eltűnik és az audit rögzíti az ELŐZŐ értéket', async () => {
    const res = await repo.deleteEdge({
      tenantId: s.tenantA.id,
      subjectType: 'user',
      subjectUserId: s.admin.id,
      subjectAgentId: null,
      targetAgentId: s.agentA1.id,
      buildAudit: (change) => {
        assert.deepEqual(change.previous, { canView: true, canAddress: true })
        assert.deepEqual(change.next, { canView: false, canAddress: false })
        return { ...auditFor('agent_access.grant.revoke', s.admin.id)(), targetId: change.grantId }
      },
    })
    assert.equal(res.ok, true)
    const rows = await prisma.agentAccessGrant.findMany({
      where: { tenantId: s.tenantA.id, subjectUserId: s.admin.id, targetAgentId: s.agentA1.id },
    })
    assert.equal(rows.length, 0)
  })

  await check('az agent törlése kaszkádolva viszi az éleit (nincs árva policy-sor)', async () => {
    await repo.upsertEdge({
      tenantId: s.tenantA.id,
      subjectType: 'agent',
      subjectUserId: null,
      subjectAgentId: s.agentA1.id,
      targetAgentId: s.agentA2.id,
      canView: false,
      canAddress: true,
      grantedById: s.admin.id,
      buildAudit: auditFor('agent_access.grant.create', s.admin.id),
    })
    await prisma.agent.delete({ where: { id: s.agentA2.id } })
    const rows = await prisma.agentAccessGrant.findMany({
      where: { targetAgentId: s.agentA2.id },
    })
    assert.equal(rows.length, 0)
  })

  console.log(failures === 0 ? '\nMinden DB-invariáns teszt zöld.' : `\n${failures} teszt elbukott.`)
  process.exitCode = failures === 0 ? 0 : 1
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
