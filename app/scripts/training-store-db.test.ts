/**
 * MemoryTraining v1.1 — valódi PostgreSQL repository-regressziók.
 *
 * A teszt a két konkurencia-invariánst bizonyítja, amelyet in-memory fake nem
 * tud hitelesen lefedni:
 *   1. instruction aktiváláskor a current pointer CAS-a pontosan egy írót enged;
 *   2. agentenként legfeljebb egy nyitott instruction-training ticket lehet.
 *
 * A CI `migrations` jobja futtatja egy frissen migrált, ideiglenes adatbázison.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Prisma, PrismaClient } from '@prisma/client'
import { prisma as appPrisma } from '../src/lib/db'
import { PostgresTrainingStore } from '../src/repositories/postgres/training-store'

// Az elvárt P2002-t ne írja ijesztő hibaként a sikeres CI-logba.
const db = new PrismaClient({ log: [] })

type Fixture = {
  tenantId: string
  userId: string
  memoryId: string
  agentId: string
}

async function seedFixture(): Promise<Fixture> {
  const suffix = randomUUID()
  const tenant = await db.tenant.create({
    data: {
      slug: `training-store-test-${suffix}`,
      displayName: `training-store-test-${suffix}`,
    },
  })
  const user = await db.user.create({
    data: {
      externalAuthId: `training-store-test-${suffix}`,
      email: `training-store-test-${suffix}@example.invalid`,
      name: 'Training store teszt',
      role: 'admin',
      status: 'active',
      tenantId: tenant.id,
    },
  })
  const memory = await db.memory.create({ data: {} })
  const agent = await db.agent.create({
    data: {
      tenantId: tenant.id,
      name: `training-store-test-${suffix}`,
      roleInstruction: 'teszt',
      behaviorProfile: 'teszt',
      modelConfig: { provider: 'stub', model: 'stub' },
      status: 'active',
      memoryId: memory.id,
    },
  })
  return { tenantId: tenant.id, userId: user.id, memoryId: memory.id, agentId: agent.id }
}

async function cleanup(fixture: Fixture): Promise<void> {
  await db.ticket.deleteMany({ where: { agentId: fixture.agentId } })
  await db.agent.delete({ where: { id: fixture.agentId } })
  await db.memory.delete({ where: { id: fixture.memoryId } })
  await db.user.delete({ where: { id: fixture.userId } })
  await db.tenant.delete({ where: { id: fixture.tenantId } })
}

async function testInstructionActivationCas(fixture: Fixture): Promise<void> {
  const store = new PostgresTrainingStore()
  const shared = {
    memoryId: fixture.memoryId,
    content: '- párhuzamos szabály',
    diffFromPrevious: {},
    source: 'training',
    approvedById: fixture.userId,
    parentVersion: null,
    expectedCurrentVersionId: null,
  }

  // Eltérő verziószámot használunk, így nem a version UNIQUE kényszere, hanem
  // kizárólag a current pointer CAS-a dönti el a versenyt.
  const [first, second] = await Promise.all([
    store.activateInstructionVersion({ ...shared, version: 1 }),
    store.activateInstructionVersion({ ...shared, version: 2 }),
  ])
  const winners = [first, second].filter((row) => row !== null)
  assert.equal(winners.length, 1, 'pontosan egy CAS-író nyerhet')

  const versions = await db.memoryVersion.findMany({
    where: { memoryId: fixture.memoryId, kind: 'instruction' },
  })
  const memory = await db.memory.findUniqueOrThrow({ where: { id: fixture.memoryId } })
  assert.equal(versions.length, 1, 'a vesztes tranzakció nem hagyhat árva verziót')
  assert.equal(memory.currentVersionId, winners[0]?.id)

  const staleRestore = await store.restoreInstructionVersion({
    memoryId: fixture.memoryId,
    targetId: winners[0]!.id,
    expectedCurrentVersionId: null,
  })
  assert.equal(staleRestore, false, 'elavult rollback-CAS nem írhatja felül a pointert')
}

async function testOneOpenInstructionTicket(fixture: Fixture): Promise<void> {
  const createInstructionTicket = (title: string) =>
    db.ticket.create({
      data: {
        tenantId: fixture.tenantId,
        type: 'training',
        title,
        state: 'backlog',
        agentId: fixture.agentId,
        payload: {},
        createdById: fixture.userId,
      },
    })

  const results = await Promise.allSettled([
    createInstructionTicket('Első párhuzamos javaslat'),
    createInstructionTicket('Második párhuzamos javaslat'),
  ])
  const winners = results.filter((result) => result.status === 'fulfilled')
  const losers = results.filter((result) => result.status === 'rejected')
  assert.equal(winners.length, 1, 'pontosan egy nyitott instruction-ticket jöhet létre')
  assert.equal(losers.length, 1)
  assert.ok(
    losers[0].reason instanceof Prisma.PrismaClientKnownRequestError &&
      losers[0].reason.code === 'P2002',
    'a DB részleges egyedi indexének kell elutasítania a vesztest',
  )

  // A projektmemória külön folyamat; ugyanarra az agentre ettől még nyitható.
  await db.ticket.create({
    data: {
      tenantId: fixture.tenantId,
      type: 'training',
      title: 'Projektmemória-javaslat',
      state: 'backlog',
      agentId: fixture.agentId,
      payload: { kind: 'memory_candidate' },
      createdById: fixture.userId,
    },
  })
}

async function main() {
  console.log('=== Training store DB-invariánsok (valódi PostgreSQL) ===')
  const fixture = await seedFixture()
  try {
    await testInstructionActivationCas(fixture)
    console.log('  OK instruction aktiválás és rollback atomikus CAS')

    await testOneOpenInstructionTicket(fixture)
    console.log('  OK agentenként egy nyitott instruction-training ticket')
  } finally {
    await cleanup(fixture)
    await Promise.all([db.$disconnect(), appPrisma.$disconnect()])
  }
  console.log('\nMinden training store DB-teszt zöld.')
}

void main().catch(async (error) => {
  console.error(error)
  await Promise.all([db.$disconnect(), appPrisma.$disconnect()])
  process.exit(1)
})
