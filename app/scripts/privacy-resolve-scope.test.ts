/**
 * Feloldási scope-invariáns (AI Privacy Gateway APG-08 / spec §10.5, R14).
 *
 * VALÓDI Postgres kell hozzá — a tenant/conversation/résztvevő kapu a vault
 * + conversation-hozzáférés + hash-láncolt audit együttese, mockkal nem
 * bizonyítható, hogy idegen tenant / másik beszélgetés / nem-résztvevő
 * nem old fel, és hogy a bukás `privacy.resolve.denied` auditot ír.
 *
 * Futtatás egy migrált DB ellen:
 *   npm run test:privacy-resolve-scope
 * A CI-ban a `migrations` job futtatja.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { prisma } from '../src/lib/db'
import { createPlatformSurrogateEngine } from '../src/domain/privacy/create-surrogate-engine'
import { PostgresAuditRepository } from '../src/repositories/postgres/audit-repository'
import { PostgresConversationRepository } from '../src/repositories/postgres/conversation-repository'
import { PostgresTicketRepository } from '../src/repositories/postgres/ticket-repository'

let failures = 0
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn()
    console.log(`  OK  ${name}`)
  } catch (e) {
    failures += 1
    console.log(`  FAIL ${name}: ${e instanceof Error ? e.message : String(e)}`)
  }
}

const SOURCE_ID = 'crm/company/4821'
const COMPANY_NAME = 'SPAR Magyarország Kereskedelmi Kft.'

async function seedUser(tenantId: string, label: string) {
  const suffix = randomUUID().slice(0, 8)
  return prisma.user.create({
    data: {
      externalAuthId: `ext-${label}-${suffix}`,
      email: `${label}-${suffix}@example.test`,
      name: label,
      status: 'active',
      role: 'operator',
      tenantId,
    },
  })
}

async function seedAgent(tenantId: string, name: string) {
  const memory = await prisma.memory.create({ data: {} })
  return prisma.agent.create({
    data: {
      name,
      roleInstruction: 'x',
      behaviorProfile: 'y',
      modelConfig: { provider: 'stub', model: 'stub' },
      status: 'active',
      tenantId,
      memoryId: memory.id,
    },
  })
}

type World = {
  tenantA: string
  tenantB: string
  ownerA: string
  otherA: string
  ownerB: string
  convA: string
  convB: string
  convOwnerB: string
  connectorId: string
  engine: ReturnType<typeof createPlatformSurrogateEngine>
}

async function withWorld(fn: (world: World) => Promise<void>) {
  const suffix = randomUUID().slice(0, 8)
  const tenantA = await prisma.tenant.create({
    data: { slug: `apg08-a-${suffix}`, displayName: `APG-08 A ${suffix}` },
  })
  const tenantB = await prisma.tenant.create({
    data: { slug: `apg08-b-${suffix}`, displayName: `APG-08 B ${suffix}` },
  })
  const ownerA = await seedUser(tenantA.id, 'owner-a')
  const otherA = await seedUser(tenantA.id, 'other-a')
  const ownerB = await seedUser(tenantB.id, 'owner-b')
  await prisma.tenantMembership.createMany({
    data: [
      { tenantId: tenantA.id, userId: ownerA.id, role: 'operator', status: 'active' },
      { tenantId: tenantA.id, userId: otherA.id, role: 'operator', status: 'active' },
      { tenantId: tenantB.id, userId: ownerB.id, role: 'operator', status: 'active' },
    ],
  })
  const agentA = await seedAgent(tenantA.id, `apg08-a-${suffix}`)
  const agentB = await seedAgent(tenantB.id, `apg08-b-${suffix}`)
  const convA = await prisma.conversation.create({
    data: { tenantId: tenantA.id, agentId: agentA.id, createdById: ownerA.id, title: 'A' },
  })
  const convB = await prisma.conversation.create({
    data: { tenantId: tenantA.id, agentId: agentA.id, createdById: ownerA.id, title: 'B' },
  })
  const convOwnerB = await prisma.conversation.create({
    data: { tenantId: tenantB.id, agentId: agentB.id, createdById: ownerB.id, title: 'B-own' },
  })

  const engine = createPlatformSurrogateEngine(
    new PostgresAuditRepository(),
    new PostgresConversationRepository(),
    new PostgresTicketRepository(),
  )

  try {
    await fn({
      tenantA: tenantA.id,
      tenantB: tenantB.id,
      ownerA: ownerA.id,
      otherA: otherA.id,
      ownerB: ownerB.id,
      convA: convA.id,
      convB: convB.id,
      convOwnerB: convOwnerB.id,
      connectorId: randomUUID(),
      engine,
    })
  } finally {
    await prisma.surrogateMap.deleteMany({ where: { tenantId: { in: [tenantA.id, tenantB.id] } } })
    await prisma.conversation.deleteMany({ where: { id: { in: [convA.id, convB.id, convOwnerB.id] } } })
    await prisma.agent.deleteMany({ where: { id: { in: [agentA.id, agentB.id] } } })
    await prisma.memory.deleteMany({ where: { id: { in: [agentA.memoryId, agentB.memoryId] } } })
    await prisma.tenantMembership.deleteMany({
      where: { tenantId: { in: [tenantA.id, tenantB.id] } },
    })
    await prisma.user.deleteMany({ where: { id: { in: [ownerA.id, otherA.id, ownerB.id] } } })
    await prisma.tenant.deleteMany({ where: { id: { in: [tenantA.id, tenantB.id] } } })
  }
}

async function allocateIn(world: World, tenantId: string, conversationId: string) {
  return world.engine.allocateRef({
    tenantId,
    scope: { type: 'conversation', id: conversationId },
    entityType: 'company',
    connectorId: world.connectorId,
    sourceId: SOURCE_ID,
    displayValue: COMPANY_NAME,
  })
}

async function deniedAudits(tenantId: string, since: Date) {
  return prisma.auditLog.findMany({
    where: { action: 'privacy.resolve.denied', tenantId, createdAt: { gte: since } },
    orderBy: { seq: 'asc' },
  })
}

function assertNoRawSecret(row: {
  action: string
  inputRef: string | null
  outputRef: string | null
  policyDecision: string | null
  metadata: unknown
}) {
  const text = JSON.stringify({
    action: row.action,
    inputRef: row.inputRef,
    outputRef: row.outputRef,
    policyDecision: row.policyDecision,
    metadata: row.metadata,
  })
  assert.equal(text.includes(SOURCE_ID), false, 'audit tartalmazza a nyers sourceId-t')
  assert.equal(text.includes(COMPANY_NAME), false, 'audit tartalmazza a nyers cégnevet')
  assert.equal(text.includes('SPAR'), false, 'audit tartalmazza a nyers megjelenítési értéket')
}

async function main() {
  console.log('APG-08 feloldási scope-invariáns (valós Postgres)\n')

  await check('jogosult résztvevő feloldhatja a saját beszélgetése álnevét', async () => {
    await withWorld(async (world) => {
      const surrogate = await allocateIn(world, world.tenantA, world.convA)
      const resolved = await world.engine.resolveRef({
        tenantId: world.tenantA,
        scope: { type: 'conversation', id: world.convA },
        surrogate,
        requester: { tenantId: world.tenantA, userId: world.ownerA },
      })
      assert.equal(resolved.ok, true)
      if (!resolved.ok) return
      assert.equal(resolved.record.sourceId, SOURCE_ID)
    })
  })

  await check('idegen tenant surrogate-ja nem oldható fel, privacy.resolve.denied audit', async () => {
    await withWorld(async (world) => {
      const surrogate = await allocateIn(world, world.tenantA, world.convA)
      const since = new Date(Date.now() - 1000)
      const resolved = await world.engine.resolveRef({
        tenantId: world.tenantA,
        scope: { type: 'conversation', id: world.convA },
        surrogate,
        requester: { tenantId: world.tenantB, userId: world.ownerB },
      })
      assert.equal(resolved.ok, false)
      if (resolved.ok) return
      assert.equal(resolved.reason, 'denied')
      if (resolved.reason === 'denied') assert.equal(resolved.denyReason, 'tenant')

      const events = await deniedAudits(world.tenantB, since)
      assert.equal(events.length, 1)
      assert.equal(events[0]?.action, 'privacy.resolve.denied')
      assert.equal(events[0]?.policyDecision, 'denied')
      assert.equal(events[0]?.inputRef, surrogate)
      assert.equal(events[0]?.actorId, world.ownerB)
      assertNoRawSecret(events[0])
    })
  })

  await check('azonos tenant, másik beszélgetés surrogate-ja nem oldható fel, audit', async () => {
    await withWorld(async (world) => {
      const surrogate = await allocateIn(world, world.tenantA, world.convA)
      const since = new Date(Date.now() - 1000)
      const resolved = await world.engine.resolveRef({
        tenantId: world.tenantA,
        scope: { type: 'conversation', id: world.convB },
        surrogate,
        requester: { tenantId: world.tenantA, userId: world.ownerA },
      })
      assert.equal(resolved.ok, false)
      if (resolved.ok) return
      assert.equal(resolved.reason, 'denied')
      if (resolved.reason === 'denied') assert.equal(resolved.denyReason, 'scope')

      const events = await deniedAudits(world.tenantA, since)
      assert.equal(events.length, 1)
      assert.equal(events[0]?.action, 'privacy.resolve.denied')
      assert.equal(events[0]?.inputRef, surrogate)
      assert.equal(events[0]?.outputRef, 'scope')
      assertNoRawSecret(events[0])
    })
  })

  await check('nem-résztvevő user nem oldhatja fel, privacy.resolve.denied audit', async () => {
    await withWorld(async (world) => {
      const surrogate = await allocateIn(world, world.tenantA, world.convA)
      const since = new Date(Date.now() - 1000)
      const resolved = await world.engine.resolveRef({
        tenantId: world.tenantA,
        scope: { type: 'conversation', id: world.convA },
        surrogate,
        requester: { tenantId: world.tenantA, userId: world.otherA },
      })
      assert.equal(resolved.ok, false)
      if (resolved.ok) return
      assert.equal(resolved.reason, 'denied')
      if (resolved.reason === 'denied') assert.equal(resolved.denyReason, 'participant')

      const events = await deniedAudits(world.tenantA, since)
      assert.equal(events.length, 1)
      assert.equal(events[0]?.action, 'privacy.resolve.denied')
      assert.equal(events[0]?.actorId, world.otherA)
      assert.equal(events[0]?.outputRef, 'participant')
      assertNoRawSecret(events[0])
    })
  })

  console.log(failures === 0 ? '\nMinden privacy-resolve-scope teszt zöld.' : `\n${failures} teszt elbukott.`)
  process.exitCode = failures === 0 ? 0 : 1
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
