/**
 * Perzisztált agent-forduló repository-tesztek
 * (chat-agent-turn-resilience-spec.md §4, §5, §12).
 *
 * VALÓDI Postgres kell hozzá — a teszt lényege az aktív-forduló invariáns (D7),
 * amit a `0009_agent_turn` migráció RÉSZLEGES EGYEDI INDEXE kényszerít ki. Egy
 * in-memory fake ezt nem tudná bizonyítani, csak a fake-et tesztelné.
 *
 * Futtatás egy migrált DB ellen:
 *   DATABASE_URL=postgresql://… npm run test:agent-turn
 * A CI-ban a `migrations` job futtatja, közvetlenül a `prisma migrate deploy` után.
 *
 * A teszt a saját sorait egy dedikált, véletlen tenant-azonosító alatt hozza
 * létre, és a végén cascade-del takarít — meglévő adatot nem érint.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { PostgresAgentTurnRepository } from '../src/repositories/postgres/agent-turn-repository'
import { ActiveAgentTurnExistsError } from '../src/repositories/interfaces'

let failures = 0
function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  OK ${name}`))
    .catch((e) => {
      failures++
      console.log(`  FAIL ${name}: ${e instanceof Error ? e.message : e}`)
    })
}

const prisma = new PrismaClient()
const repo = new PostgresAgentTurnRepository()

type Fixture = {
  tenantId: string
  agentId: string
  memoryId: string
  userId: string
  conversationId: string
  userMessageId: string
}

/** Minimális FK-lánc: tenant → user + agent → conversation → user-üzenet. */
async function seedFixture(): Promise<Fixture> {
  const suffix = randomUUID()
  const tenant = await prisma.tenant.create({
    data: { displayName: `agent-turn-test-${suffix}`, slug: `agent-turn-test-${suffix}` },
  })
  const user = await prisma.user.create({
    data: {
      externalAuthId: `agent-turn-test-${suffix}`,
      email: `agent-turn-test-${suffix}@example.invalid`,
      name: 'Agent turn teszt',
      tenantId: tenant.id,
    },
  })
  const memory = await prisma.memory.create({ data: {} })
  const agent = await prisma.agent.create({
    data: {
      tenantId: tenant.id,
      name: `agent-turn-test-${suffix}`,
      roleInstruction: 'teszt',
      behaviorProfile: 'teszt',
      modelConfig: { provider: 'stub', model: 'stub' },
      memoryId: memory.id,
    },
  })
  const conversation = await prisma.conversation.create({
    data: { tenantId: tenant.id, agentId: agent.id, createdById: user.id },
  })
  const message = await prisma.message.create({
    data: { conversationId: conversation.id, seq: 1, role: 'user', actingUserId: user.id },
  })
  return {
    tenantId: tenant.id,
    agentId: agent.id,
    memoryId: memory.id,
    userId: user.id,
    conversationId: conversation.id,
    userMessageId: message.id,
  }
}

async function cleanup(fixture: Fixture): Promise<void> {
  // A conversation → agent_turns / messages él cascade; a tenant nem, ezért
  // explicit sorrendben bontunk.
  await prisma.agentTurn.deleteMany({ where: { conversationId: fixture.conversationId } })
  await prisma.message.deleteMany({ where: { conversationId: fixture.conversationId } })
  await prisma.conversation.delete({ where: { id: fixture.conversationId } })
  await prisma.agent.delete({ where: { id: fixture.agentId } })
  await prisma.memory.delete({ where: { id: fixture.memoryId } })
  await prisma.user.delete({ where: { id: fixture.userId } })
  await prisma.tenant.delete({ where: { id: fixture.tenantId } })
}

function createInput(fixture: Fixture) {
  return {
    conversationId: fixture.conversationId,
    tenantId: fixture.tenantId,
    agentId: fixture.agentId,
    agentVersion: 1,
    createdById: fixture.userId,
    userMessageId: fixture.userMessageId,
  }
}

async function main() {
  console.log('=== Agent-forduló repository teszt (valódi Postgres) ===')

  await check('létrehozás: aktív forduló, lock-kal claimelve', async () => {
    const fixture = await seedFixture()
    try {
      const lockToken = randomUUID()
      const turn = await repo.create({ ...createInput(fixture), lockToken, lockedAt: new Date() })

      assert.equal(turn.status, 'running')
      assert.equal(turn.conversationId, fixture.conversationId)
      assert.equal(turn.userMessageId, fixture.userMessageId)
      assert.equal(turn.assistantMessageId, null)
      assert.equal(turn.lockToken, lockToken)
      assert.equal(turn.partialText, '')
      assert.deepEqual(turn.activities, [])
      assert.equal(turn.turnCount, 0)
      assert.equal(turn.cancelRequested, false)
      assert.equal(turn.finishedAt, null)
      assert.ok(turn.heartbeatAt instanceof Date)

      const active = await repo.findActiveByConversation(fixture.conversationId)
      assert.equal(active?.id, turn.id)
    } finally {
      await cleanup(fixture)
    }
  })

  await check('INVARIÁNS (D7): második aktív forduló ugyanarra a beszélgetésre elutasítva', async () => {
    const fixture = await seedFixture()
    try {
      await repo.create(createInput(fixture))

      await assert.rejects(
        () => repo.create(createInput(fixture)),
        (error: unknown) => {
          assert.ok(
            error instanceof ActiveAgentTurnExistsError,
            `várt ActiveAgentTurnExistsError, kapott: ${String(error)}`,
          )
          assert.equal(error.conversationId, fixture.conversationId)
          return true
        },
      )

      // A kényszer tényleg a DB-ben van: a repository megkerülésével, nyers
      // Prisma-írással is elbukik.
      await assert.rejects(() =>
        prisma.agentTurn.create({
          data: { ...createInput(fixture), status: 'streaming' },
        }),
      )

      const rows = await prisma.agentTurn.count({ where: { conversationId: fixture.conversationId } })
      assert.equal(rows, 1)
    } finally {
      await cleanup(fixture)
    }
  })

  await check('E5: PÁRHUZAMOS foglalás — pontosan egy nyer, a másik az aktív azonosítót kapja', async () => {
    const fixture = await seedFixture()
    try {
      // Az előzetes lekérdezés itt mit sem érne: mindkét hívó „szabad"-ot látna.
      // A döntést a beszúrásra csattanó részleges egyedi index hozza meg.
      const results = await Promise.allSettled([
        repo.create({ ...createInput(fixture), userMessageId: null }),
        repo.create({ ...createInput(fixture), userMessageId: null }),
      ])

      const winners = results.filter((r) => r.status === 'fulfilled')
      const losers = results.filter((r) => r.status === 'rejected')
      assert.equal(winners.length, 1, 'pontosan egy foglalás sikerül')
      assert.equal(losers.length, 1, 'a másik elutasításra kerül')
      assert.ok(
        losers[0].reason instanceof ActiveAgentTurnExistsError,
        `várt ActiveAgentTurnExistsError, kapott: ${String(losers[0].reason)}`,
      )

      // A vesztes hívó ebből az azonosítóból építi a 409-es választ.
      const active = await repo.findActiveByConversation(fixture.conversationId)
      assert.equal(active?.id, (winners[0] as PromiseFulfilledResult<{ id: string }>).value.id)

      const rows = await prisma.agentTurn.count({ where: { conversationId: fixture.conversationId } })
      assert.equal(rows, 1, 'nem keletkezik árva második sor')
    } finally {
      await cleanup(fixture)
    }
  })

  await check('foglalás user-üzenet nélkül, majd utólagos bekötés', async () => {
    const fixture = await seedFixture()
    try {
      // A forduló-hely a user-üzenet perzisztálása ELŐTT foglalódik (#61), hogy
      // az elutasított küldés ne hagyjon árva üzenetet.
      const reserved = await repo.create({ ...createInput(fixture), userMessageId: null })
      assert.equal(reserved.userMessageId, null)

      await repo.attachUserMessage(reserved.id, fixture.userMessageId)
      const attached = await repo.findById(reserved.id)
      assert.equal(attached?.userMessageId, fixture.userMessageId)
    } finally {
      await cleanup(fixture)
    }
  })

  await check('a lezárás felszabadítja az aktív helyet — új forduló indulhat', async () => {
    const fixture = await seedFixture()
    try {
      const first = await repo.create(createInput(fixture))
      const closed = await repo.finalize(first.id, {
        status: 'completed',
        assistantMessageId: null,
        partialText: 'kész válasz',
      })
      assert.equal(closed?.status, 'completed')
      assert.equal(closed?.partialText, 'kész válasz')
      assert.ok(closed?.finishedAt instanceof Date)
      assert.equal(closed?.lockToken, null)
      assert.equal(await repo.findActiveByConversation(fixture.conversationId), null)

      const second = await repo.create(createInput(fixture))
      assert.notEqual(second.id, first.id)
      assert.equal((await repo.findActiveByConversation(fixture.conversationId))?.id, second.id)
    } finally {
      await cleanup(fixture)
    }
  })

  await check('a lezárás idempotens: a második hívás nem írja felül az elsőt', async () => {
    const fixture = await seedFixture()
    try {
      const turn = await repo.create(createInput(fixture))
      const first = await repo.finalize(turn.id, { status: 'cancelled', reason: 'cancelled' })
      assert.equal(first?.status, 'cancelled')

      // Pl. watchdog vs. runner verseny: a második lezárás null-t ad.
      const second = await repo.finalize(turn.id, { status: 'failed', reason: 'watchdog' })
      assert.equal(second, null)

      const stored = await repo.findById(turn.id)
      assert.equal(stored?.status, 'cancelled')
      assert.equal(stored?.reason, 'cancelled')
    } finally {
      await cleanup(fixture)
    }
  })

  await check('lock: a birtokos üt szívet, idegen token nem; elengedés után átvehető', async () => {
    const fixture = await seedFixture()
    try {
      const owner = randomUUID()
      const turn = await repo.create({ ...createInput(fixture), lockToken: owner, lockedAt: new Date() })

      // Már claimelve → másik futó nem szerezheti meg.
      assert.equal(await repo.acquireLock(turn.id, randomUUID(), new Date()), null)

      const beat = new Date(Date.now() + 1_000)
      const beaten = await repo.heartbeat(turn.id, owner, beat)
      assert.equal(beaten?.heartbeatAt.getTime(), beat.getTime())
      // Idegen token nem üthet szívet (a stale-reclaim így nem írható vissza).
      assert.equal(await repo.heartbeat(turn.id, randomUUID(), new Date()), null)

      await repo.releaseLock(turn.id, owner)
      assert.equal((await repo.findById(turn.id))?.lockToken, null)

      const reclaimer = randomUUID()
      const reclaimed = await repo.acquireLock(turn.id, reclaimer, new Date())
      assert.equal(reclaimed?.lockToken, reclaimer)
      // A forduló státusza a lock-műveletektől nem változik.
      assert.equal(reclaimed?.status, 'running')
    } finally {
      await cleanup(fixture)
    }
  })

  await check('watchdog-lekérdezés: csak az elöregedett heartbeat-ű aktív fordulók', async () => {
    const fresh = await seedFixture()
    const stale = await seedFixture()
    const terminal = await seedFixture()
    try {
      const freshTurn = await repo.create(createInput(fresh))
      const staleTurn = await repo.create(createInput(stale))
      const terminalTurn = await repo.create(createInput(terminal))

      const old = new Date(Date.now() - 10 * 60_000)
      await prisma.agentTurn.updateMany({
        where: { id: { in: [staleTurn.id, terminalTurn.id] } },
        data: { heartbeatAt: old },
      })
      // A terminális forduló akkor sem stale, ha régi a heartbeatje.
      await repo.finalize(terminalTurn.id, { status: 'completed' })

      const cutoff = new Date(Date.now() - 2 * 60_000)
      const found = await repo.findStale(cutoff, 50)
      const ids = found.map((t) => t.id)

      assert.ok(ids.includes(staleTurn.id), 'az elöregedett fordulónak szerepelnie kell')
      assert.ok(!ids.includes(freshTurn.id), 'a friss forduló nem stale')
      assert.ok(!ids.includes(terminalTurn.id), 'a terminális forduló nem stale')
    } finally {
      await cleanup(fresh)
      await cleanup(stale)
      await cleanup(terminal)
    }
  })

  console.log(failures === 0 ? '\nMinden teszt zöld.' : `\n${failures} teszt bukott.`)
  await prisma.$disconnect()
  process.exit(failures === 0 ? 0 : 1)
}

void main()
