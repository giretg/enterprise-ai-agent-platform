/**
 * A stateless dispatch-ciklus HTTP-szerződése (#114) — DB és hálózat nélkül.
 *
 * Miért létezik ez a teszt: a ciklust mostantól két folyamat szolgálhatja ki ugyanazon a
 * címen — a control-plane UI Next.js route-ja és a dedikált Cloud Run worker. A Scheduler
 * targetje (és a rollback) e két URL között vált. Ha az auth vagy a válasz-alak a két
 * belépőn szétcsúszik, az üzemeltető ugyanarra a hívásra más eredményt kap attól függően,
 * hol fut éppen a ciklus — a biztonsági háló csendben kiesik, és csak beragadt ticketeken
 * (elmaradt monitor-riasztás, torlódó csatorna-üzenetek) látszik.
 *
 * Amit rögzítünk (külső viselkedés, nem belső lépések):
 *  - érvényes tokennel lefut a ciklus, és a `DispatchCycleSummary` burokban jön vissza,
 *  - hiányzó / hibás / eltérő hosszú token → 401, és a ciklus EL SEM INDUL,
 *  - a törzset csak sikeres auth után olvassuk (hitelesítetlen hívó ne foglaltasson memóriát),
 *  - `{"ticketId":"…"}` átmegy a ciklus magjának (célzott dispatch), üres törzs is érvényes,
 *  - értelmezhetetlen JSON → 400, a ciklus hibája → 500 (nem szivárog ki 200-ként).
 *
 * Futtatás: npm run test:dispatch-cycle-endpoint
 */
import assert from 'node:assert/strict'

import {
  handleDispatchCycleRequest,
  type DispatchCycleRunner,
} from '../src/domain/dispatcher/dispatch-cycle-request'
import type { DispatchCycleSummary } from '../src/domain/dispatcher/run-dispatch-cycle'

const TOKEN = 'dispatch-token-abc123'

const SUMMARY: DispatchCycleSummary = {
  skipped: false,
  reclaimedDispatches: 1,
  reclaimedScheduledTasks: 0,
  reclaimedAgentTurns: 0,
  channelTurns: { reclaimed: 0, processed: 2 },
  conversationRetention: { sweptConversations: 0, deletedMessages: 0 },
  surrogateVaultGc: { deletedMappings: 0, conversationIds: [] },
  materializedScheduledTasks: 3,
  monitorSweep: { ran: true, escalated: 0, openedTickets: 0 },
  workspacePurge: { purgedTickets: 0, deletedObjects: 0 },
  dispatch: { scanned: 4, started: 1, budgetBlocked: 0, skipped: 3, paused: false, skipReasons: {} },
}

type RunnerCall = { ticketId?: string; triggeredBy?: string }

/** Ciklus-mag helyettesítő: rögzíti a hívásokat, nem nyúl DB-hez. */
function stubRunner(): { runner: DispatchCycleRunner; calls: RunnerCall[] } {
  const calls: RunnerCall[] = []
  const runner: DispatchCycleRunner = async (input) => {
    calls.push({ ticketId: input.ticketId, triggeredBy: input.triggeredBy })
    return SUMMARY
  }
  return { runner, calls }
}

let passed = 0
let failed = 0
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    console.log(`  OK  ${name}`)
    passed += 1
  } catch (e) {
    console.log(`  FAIL  ${name} — ${e instanceof Error ? e.message : String(e)}`)
    failed += 1
  }
}

async function run() {
  await check('érvényes tokennel lefut a ciklus és a summary a burokban jön vissza', async () => {
    const { runner, calls } = stubRunner()
    const result = await handleDispatchCycleRequest(
      { providedToken: TOKEN, readRawBody: () => '{}', expectedToken: TOKEN },
      runner,
    )
    assert.equal(result.status, 200)
    assert.deepEqual(result.body, { success: true, data: SUMMARY })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].ticketId, undefined)
  })

  await check('üres törzs is érvényes hívás (a Scheduler törzs nélkül is hívhat)', async () => {
    const { runner, calls } = stubRunner()
    const result = await handleDispatchCycleRequest(
      { providedToken: TOKEN, readRawBody: () => '', expectedToken: TOKEN },
      runner,
    )
    assert.equal(result.status, 200)
    assert.equal(calls.length, 1)
  })

  await check('a ticketId átmegy a ciklus magjának (célzott dispatch)', async () => {
    const { runner, calls } = stubRunner()
    const result = await handleDispatchCycleRequest(
      {
        providedToken: TOKEN,
        readRawBody: () => '{"ticketId":"  ticket-42  "}',
        expectedToken: TOKEN,
      },
      runner,
    )
    assert.equal(result.status, 200)
    assert.equal(calls[0].ticketId, 'ticket-42', 'a ticketId trimmelve, változatlanul jut át')
  })

  await check('alapból `scheduler` a forrás, de a belépő felülírhatja', async () => {
    const { runner, calls } = stubRunner()
    await handleDispatchCycleRequest(
      { providedToken: TOKEN, readRawBody: () => '{}', expectedToken: TOKEN },
      runner,
    )
    assert.equal(calls[0].triggeredBy, 'scheduler')

    await handleDispatchCycleRequest(
      { providedToken: TOKEN, readRawBody: () => '{}', expectedToken: TOKEN, triggeredBy: 'manual' },
      runner,
    )
    assert.equal(calls[1].triggeredBy, 'manual')
  })

  await check('hiányzó token → 401, és a ciklus el sem indul', async () => {
    const { runner, calls } = stubRunner()
    const result = await handleDispatchCycleRequest(
      { providedToken: null, readRawBody: () => '{}', expectedToken: TOKEN },
      runner,
    )
    assert.equal(result.status, 401)
    assert.deepEqual(result.body, { success: false, error: 'invalid or missing x-dispatcher-token' })
    assert.equal(calls.length, 0, 'hitelesítetlen hívásra NEM futhat ciklus')
  })

  await check('hibás token → 401 (azonos és eltérő hosszúságú tipp is)', async () => {
    const { runner, calls } = stubRunner()
    const sameLength = await handleDispatchCycleRequest(
      { providedToken: 'dispatch-token-abc124', readRawBody: () => '{}', expectedToken: TOKEN },
      runner,
    )
    const shorter = await handleDispatchCycleRequest(
      { providedToken: 'dispatch', readRawBody: () => '{}', expectedToken: TOKEN },
      runner,
    )
    assert.equal(sameLength.status, 401)
    assert.equal(shorter.status, 401)
    assert.equal(calls.length, 0)
  })

  await check('a szolgáltatáson hiányzó titok fail-closed (nem enged be üres tokent)', async () => {
    const { runner, calls } = stubRunner()
    const result = await handleDispatchCycleRequest(
      { providedToken: '', readRawBody: () => '{}', expectedToken: '' },
      runner,
    )
    assert.equal(result.status, 401)
    assert.equal(calls.length, 0)
  })

  await check('a törzset csak sikeres auth UTÁN olvassuk be', async () => {
    const { runner } = stubRunner()
    let reads = 0
    const result = await handleDispatchCycleRequest(
      {
        providedToken: 'rossz-token',
        readRawBody: () => {
          reads += 1
          return '{}'
        },
        expectedToken: TOKEN,
      },
      runner,
    )
    assert.equal(result.status, 401)
    assert.equal(reads, 0, 'hitelesítetlen hívónál nem pufferoljuk a törzset')
  })

  await check('értelmezhetetlen JSON → 400 (a ciklus nem indul el)', async () => {
    const { runner, calls } = stubRunner()
    const result = await handleDispatchCycleRequest(
      { providedToken: TOKEN, readRawBody: () => '{nem json', expectedToken: TOKEN },
      runner,
    )
    assert.equal(result.status, 400)
    assert.deepEqual(result.body, { success: false, error: 'Invalid JSON body' })
    assert.equal(calls.length, 0)
  })

  await check('a törzs beolvasási hibája is 400 (megszakadt / túl nagy kérés)', async () => {
    const { runner, calls } = stubRunner()
    const result = await handleDispatchCycleRequest(
      {
        providedToken: TOKEN,
        readRawBody: () => Promise.reject(new Error('request body too large')),
        expectedToken: TOKEN,
      },
      runner,
    )
    assert.equal(result.status, 400)
    assert.equal(calls.length, 0)
  })

  await check('a ciklus hibája 500-ként jelenik meg, nem sikeres futásként', async () => {
    const failing: DispatchCycleRunner = async () => {
      throw new Error('monitor sweep exploded')
    }
    const result = await handleDispatchCycleRequest(
      { providedToken: TOKEN, readRawBody: () => '{}', expectedToken: TOKEN },
      failing,
    )
    assert.equal(result.status, 500)
    assert.deepEqual(result.body, { success: false, error: 'monitor sweep exploded' })
  })

  await check('explicit token hiányában a DISPATCHER_CONTROL_TOKEN env dönt', async () => {
    const previous = process.env.DISPATCHER_CONTROL_TOKEN
    process.env.DISPATCHER_CONTROL_TOKEN = `  ${TOKEN}  `
    try {
      const { runner } = stubRunner()
      const ok = await handleDispatchCycleRequest(
        { providedToken: TOKEN, readRawBody: () => '{}' },
        runner,
      )
      assert.equal(ok.status, 200, 'a körülvágott env-titok illeszkedik a fejléc értékére')

      const bad = await handleDispatchCycleRequest(
        { providedToken: 'másik', readRawBody: () => '{}' },
        runner,
      )
      assert.equal(bad.status, 401)
    } finally {
      if (previous === undefined) delete process.env.DISPATCHER_CONTROL_TOKEN
      else process.env.DISPATCHER_CONTROL_TOKEN = previous
    }
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

void run()
