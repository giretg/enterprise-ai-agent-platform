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

  await check('updateProgress: a lock birtokosa írhat részszöveget és aktivitást', async () => {
    const fixture = await seedFixture()
    try {
      const owner = randomUUID()
      const turn = await repo.create({ ...createInput(fixture), lockToken: owner, lockedAt: new Date() })

      const activities = [{ id: 't1', kind: 'tool', title: 'Olvasás', status: 'running' }]
      const updated = await repo.updateProgress(turn.id, owner, {
        partialText: 'részleges válasz…',
        activities,
      })
      assert.equal(updated?.partialText, 'részleges válasz…')
      assert.deepEqual(updated?.activities, activities)

      // Idegen token nem írhat.
      assert.equal(
        await repo.updateProgress(turn.id, randomUUID(), { partialText: 'hack' }),
        null,
      )
      assert.equal((await repo.findById(turn.id))?.partialText, 'részleges válasz…')

      // Terminális után sem.
      await repo.finalize(turn.id, { status: 'completed', partialText: 'kész' })
      assert.equal(
        await repo.updateProgress(turn.id, owner, { partialText: 'késő' }),
        null,
      )
      assert.equal((await repo.findById(turn.id))?.partialText, 'kész')
    } finally {
      await cleanup(fixture)
    }
  })

  // ── #516: atomi claim + tulajdonoshoz kötött írás ────────────────────────

  await check('#516: PÁRHUZAMOS claim ugyanarra a queued fordulóra — pontosan egy nyer', async () => {
    const fixture = await seedFixture()
    try {
      const launchId = randomUUID()
      const queued = await repo.create({
        ...createInput(fixture),
        status: 'queued',
        launchId,
        input: { v: 1, content: 'Szia', attachmentDocumentIds: [] },
      })
      assert.equal(queued.status, 'queued')
      assert.equal(queued.lockToken, null)

      const ownerA = randomUUID()
      const ownerB = randomUUID()
      const [a, b] = await Promise.all([
        repo.claim(queued.id, ownerA, new Date(), launchId),
        repo.claim(queued.id, ownerB, new Date(), launchId),
      ])
      const winners = [a, b].filter((r) => r !== null)
      assert.equal(winners.length, 1, 'két azonos indításból pontosan egy szerez futtatási jogot')
      const stored = await repo.findById(queued.id)
      assert.equal(stored?.status, 'running')
      assert.ok(stored?.lockToken === ownerA || stored?.lockToken === ownerB)
      assert.equal(stored?.lockToken, winners[0]!.lockToken)

      // A mentett bemenet a rekordon marad — másik processz is olvashatja.
      assert.deepEqual(stored?.input, { v: 1, content: 'Szia', attachmentDocumentIds: [] })
    } finally {
      await cleanup(fixture)
    }
  })

  await check('#516: már running / terminális forduló nem claimelhető', async () => {
    const fixture = await seedFixture()
    try {
      const launchId = randomUUID()
      const turn = await repo.create({ ...createInput(fixture), status: 'queued', launchId })
      assert.ok(await repo.claim(turn.id, randomUUID(), new Date(), launchId))
      assert.equal(
        await repo.claim(turn.id, randomUUID(), new Date(), launchId),
        null,
        'running → nincs claim',
      )
      await repo.finalize(turn.id, { status: 'cancelled', reason: 'cancelled' })
      assert.equal(
        await repo.claim(turn.id, randomUUID(), new Date(), launchId),
        null,
        'terminális → nincs claim',
      )
      // Visszavont (Stop) queued forduló sem indulhat el késve.
      const lateLaunch = randomUUID()
      const late = await repo.create({ ...createInput(fixture), status: 'queued', launchId: lateLaunch })
      await repo.finalize(late.id, { status: 'cancelled', reason: 'cancelled' })
      assert.equal(await repo.claim(late.id, randomUUID(), new Date(), lateLaunch), null)
    } finally {
      await cleanup(fixture)
    }
  })

  await check('#516: RÉGI TULAJDONOS a watchdog-reclaim után nem ír életjelet, progresst, végállapotot', async () => {
    const fixture = await seedFixture()
    try {
      const turn = await repo.create({ ...createInput(fixture), status: 'queued', launchId: randomUUID() })
      const oldOwner = randomUUID()
      assert.ok(await repo.claim(turn.id, oldOwner, new Date(), turn.launchId!))
      assert.ok(await repo.heartbeat(turn.id, oldOwner, new Date()), 'amíg övé, üthet szívet')

      // Watchdog: token nélküli reclaim-lezárás (a régi futó közben még él).
      const reclaimed = await repo.finalize(turn.id, {
        status: 'failed',
        reason: 'watchdog',
        error: 'reclaimed',
      })
      assert.equal(reclaimed?.status, 'failed')

      assert.equal(await repo.heartbeat(turn.id, oldOwner, new Date()), null)
      assert.equal(await repo.updateProgress(turn.id, oldOwner, { partialText: 'késő' }), null)
      assert.equal(
        await repo.finalize(turn.id, { status: 'completed', partialText: 'kész' }, oldOwner),
        null,
        'a régi tulajdonos tokenes lezárása nem írja felül a watchdog végállapotát',
      )
      const stored = await repo.findById(turn.id)
      assert.equal(stored?.status, 'failed')
      assert.equal(stored?.reason, 'watchdog')
      assert.equal(stored?.partialText, '')
    } finally {
      await cleanup(fixture)
    }
  })

  await check('#516: tokenes finalize csak a tulajdonosnak — idegen token aktív fordulón sem zár', async () => {
    const fixture = await seedFixture()
    try {
      const turn = await repo.create({ ...createInput(fixture), status: 'queued', launchId: randomUUID() })
      const owner = randomUUID()
      assert.ok(await repo.claim(turn.id, owner, new Date(), turn.launchId!))
      assert.equal(await repo.finalize(turn.id, { status: 'completed' }, randomUUID()), null)
      assert.equal((await repo.findById(turn.id))?.status, 'running')
      const closed = await repo.finalize(turn.id, { status: 'completed' }, owner)
      assert.equal(closed?.status, 'completed')
      assert.equal(closed?.lockToken, null)
    } finally {
      await cleanup(fixture)
    }
  })

  await check('#517: idegen/lejárt launchId nem claimel — a késői worker kilép', async () => {
    const fixture = await seedFixture()
    try {
      const launchId = randomUUID()
      const queued = await repo.create({
        ...createInput(fixture),
        status: 'queued',
        launchId,
        input: { v: 1, content: 'Szia', attachmentDocumentIds: [] },
      })
      assert.equal(await repo.claim(queued.id, randomUUID(), new Date(), randomUUID()), null)
      assert.equal((await repo.findById(queued.id))?.status, 'queued')
      assert.ok(await repo.claim(queued.id, randomUUID(), new Date(), launchId))
    } finally {
      await cleanup(fixture)
    }
  })

  await check('#517: findQueuedForLaunch csak érett queued sort ad, findStale a queued-et kihagyja', async () => {
    const dueFix = await seedFixture()
    const laterFix = await seedFixture()
    const runningFix = await seedFixture()
    try {
      const due = await repo.create({
        ...createInput(dueFix),
        status: 'queued',
        input: { v: 1, content: 'Szia', attachmentDocumentIds: [] },
      })
      const later = await repo.create({
        ...createInput(laterFix),
        status: 'queued',
        input: { v: 1, content: 'Később', attachmentDocumentIds: [] },
      })
      const running = await repo.create({ ...createInput(runningFix), status: 'running' })
      const old = new Date(Date.now() - 10 * 60_000)
      await prisma.agentTurn.update({
        where: { id: later.id },
        data: { launchNextRetryAt: new Date(Date.now() + 60_000) },
      })
      await prisma.agentTurn.updateMany({
        where: { id: { in: [due.id, running.id] } },
        data: { heartbeatAt: old },
      })

      const ready = await repo.findQueuedForLaunch(new Date(), 50)
      const readyIds = ready.map((t) => t.id)
      assert.ok(readyIds.includes(due.id), 'a retry-re érett queued sorra van')
      assert.ok(!readyIds.includes(later.id), 'a jövőbeli retry nem due')
      assert.ok(!readyIds.includes(running.id), 'running nem queued launch')

      const stale = await repo.findStale(new Date(Date.now() - 2 * 60_000), 50)
      const staleIds = stale.map((t) => t.id)
      assert.ok(staleIds.includes(running.id), 'running elöregedett heartbeat stale')
      assert.ok(!staleIds.includes(due.id), 'queued nem stale running — a watchdog nem lövi')
    } finally {
      await cleanup(dueFix)
      await cleanup(laterFix)
      await cleanup(runningFix)
    }
  })

  console.log(failures === 0 ? '\nMinden teszt zöld.' : `\n${failures} teszt bukott.`)
  await prisma.$disconnect()
  process.exit(failures === 0 ? 0 : 1)
}

void main()
