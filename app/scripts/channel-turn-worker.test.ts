/**
 * Bejövő forduló-sor + worker MÁSODIK munkatípus (CT-*) — a worker-varrat (Telegram
 * feature-spec #70/#73, D8/D14). Fakes-szel, DB nélkül.
 *
 * A tesztek KIZÁRÓLAG külső viselkedést figyelnek: egy adag `queued` fordulót lezavarunk, és
 * megnézzük, milyen KIMENŐ hívások keletkeztek — vagy nem —, milyen audit-hatás született, és
 * milyen ÁLLAPOTBA került a forduló (done / vissza queued / failed). A védelmi rend kapui:
 * fail-closed (visszavont/ismeretlen kötés → agent-futásidő NEM hívódik) és az agent-engedély
 * nélküli érthető útmutatás. A fejléc- és duplikáció-varratot a linking-teszt fedi (CL-9/10/16).
 *
 * Futtatás: npm run test:channel-turn
 */
import assert from 'node:assert/strict'
import type { ChannelIdentity, ChannelSession, ChannelTurn } from '@prisma/client'
import {
  ChannelTurnService,
  NO_AGENT_GRANT_TEXT,
} from '../src/domain/channel/channel-turn-service'
import { RecordingChannelTransport } from '../src/domain/channel/channel-outbound-transport'
import { assertAuditActionRegistered } from '../src/lib/audit/event-catalog'

let failures = 0
async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn()
    console.log(`  OK  ${name}`)
  } catch (e) {
    failures++
    console.error(`FAIL  ${name}\n      ${e instanceof Error ? (e.stack ?? e.message) : e}`)
  }
}

type AuditRow = { action: string; targetType: string; policyDecision: string; metadata: Record<string, unknown> }

const TENANT_A = '11111111-1111-1111-1111-111111111111'
const USER_1 = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const LOOKUP = 'lookup-hash-abc'

function makeHarness() {
  let clock = new Date('2026-07-23T10:00:00Z')
  const setClock = (d: Date) => {
    clock = d
  }
  const advanceMs = (ms: number) => {
    clock = new Date(clock.getTime() + ms)
  }

  // ── Forduló-sor fake (a valós Postgres claim/requeue/reclaim szemantikáját utánozza) ──
  const turnRows = new Map<string, ChannelTurn>()
  let turnSeq = 0
  const turns = {
    async enqueue(input: { sessionId: string; inboundRef: string | null }) {
      const row: ChannelTurn = {
        id: `turn-${++turnSeq}`,
        sessionId: input.sessionId,
        inboundRef: input.inboundRef,
        status: 'queued',
        attempts: 0,
        lastError: null,
        createdAt: clock,
        updatedAt: clock,
      }
      turnRows.set(row.id, row)
      return row
    },
    async claimNextQueued(now: Date) {
      // A legrégebbi `queued` → `running`, attempts++.
      const queued = [...turnRows.values()]
        .filter((t) => t.status === 'queued')
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      const next = queued[0]
      if (!next) return null
      const claimed = { ...next, status: 'running' as const, attempts: next.attempts + 1, updatedAt: now }
      turnRows.set(claimed.id, claimed)
      return claimed
    },
    async markDone(id: string, now: Date) {
      const cur = turnRows.get(id)
      if (cur) turnRows.set(id, { ...cur, status: 'done', updatedAt: now })
    },
    async failOrRequeue(id: string, input: { error: string; maxAttempts: number; now: Date }) {
      const cur = turnRows.get(id)!
      const failed = cur.attempts >= input.maxAttempts
      turnRows.set(id, {
        ...cur,
        status: failed ? 'failed' : 'queued',
        lastError: input.error,
        updatedAt: input.now,
      })
      return failed ? ('failed' as const) : ('requeued' as const)
    },
    async reclaimStaleRunning(staleBefore: Date, now: Date) {
      let n = 0
      for (const t of turnRows.values()) {
        if (t.status === 'running' && t.updatedAt.getTime() < staleBefore.getTime()) {
          turnRows.set(t.id, { ...t, status: 'queued', updatedAt: now })
          n++
        }
      }
      return n
    },
  }

  // ── Munkamenet + identitás fakes ──
  const sessionRows = new Map<string, ChannelSession>()
  let sessSeq = 0
  function addSession(identityId: string | null, externalThreadId = '900001'): ChannelSession {
    const row: ChannelSession = {
      id: `sess-${++sessSeq}`,
      botId: 'bot-1',
      externalThreadId,
      conversationId: null,
      identityId,
      activeAgentId: null,
      updateWatermark: null,
      unlinkedNoticeAt: null,
      lastActivityAt: clock,
      createdAt: clock,
      updatedAt: clock,
    }
    sessionRows.set(row.id, row)
    return row
  }
  const sessions = {
    async findById(id: string) {
      return sessionRows.get(id) ?? null
    },
  }

  const identityRows = new Map<string, ChannelIdentity>()
  let idSeq = 0
  function addIdentity(status: ChannelIdentity['status']): ChannelIdentity {
    const row: ChannelIdentity = {
      id: `id-${++idSeq}`,
      channelType: 'telegram',
      externalUserIdEnc: 'enc',
      lookupHash: LOOKUP,
      tenantId: TENANT_A,
      userId: USER_1,
      status,
      linkedAt: clock,
      createdAt: clock,
      updatedAt: clock,
    }
    identityRows.set(row.id, row)
    return row
  }
  const identities = {
    async findById(id: string) {
      return identityRows.get(id) ?? null
    },
  }

  // ── Agent-engedély fake ──
  const grantsByIdentity = new Map<string, number>()
  const grants = {
    async listByIdentity(identityId: string) {
      const n = grantsByIdentity.get(identityId) ?? 0
      return Array.from({ length: n }, (_, i) => ({ id: `grant-${identityId}-${i}` })) as never
    },
    async hasAnyGrant(identityId: string) {
      return (grantsByIdentity.get(identityId) ?? 0) > 0
    },
  }
  const grantAgent = (identityId: string) =>
    grantsByIdentity.set(identityId, (grantsByIdentity.get(identityId) ?? 0) + 1)

  const audits: AuditRow[] = []
  const audit = {
    append: async (data: { action: string; targetType: string; policyDecision: string; metadata?: unknown }) => {
      assertAuditActionRegistered(data.action)
      audits.push({
        action: data.action,
        targetType: data.targetType,
        policyDecision: data.policyDecision,
        metadata: (data.metadata ?? {}) as Record<string, unknown>,
      })
      return data as never
    },
  }

  const transport = new RecordingChannelTransport()

  const svc = new ChannelTurnService({
    turns,
    sessions,
    identities,
    grants,
    transport,
    audit: audit as never,
    maxAttempts: 3,
    now: () => clock,
  })

  return {
    svc,
    turns,
    transport,
    audits,
    turnRows,
    addSession,
    addIdentity,
    grantAgent,
    setClock,
    advanceMs,
    clockNow: () => clock,
  }
}

async function main() {
  console.log('=== Bejövő forduló-sor + worker második munkatípus (varrat) ===')

  await test('CT-1 bekötött + van engedélyezett agent → forduló lezárul, agent-futás későbbi szelet (nincs kimenő hívás)', async () => {
    const h = makeHarness()
    const identity = h.addIdentity('active')
    const session = h.addSession(identity.id)
    h.grantAgent(identity.id)
    await h.turns.enqueue({ sessionId: session.id, inboundRef: 'szia agent' })

    const res = await h.svc.processQueuedBatch(10)
    assert.equal(res.claimed, 1)
    assert.equal(res.results[0].outcome, 'linked_no_runtime')
    assert.equal([...h.turnRows.values()][0].status, 'done', 'a forduló lezárult')
    assert.equal(h.transport.calls.length, 0, 'agent-futás nélkül nincs kimenő hívás (ez #74)')
  })

  await test('CT-2 bekötött, de agent-engedély NÉLKÜL → érthető „szólj az adminodnak" válasz + audit', async () => {
    const h = makeHarness()
    const identity = h.addIdentity('active')
    const session = h.addSession(identity.id)
    // Nincs grantAgent → nincs engedélyezett agent.
    await h.turns.enqueue({ sessionId: session.id, inboundRef: 'kérlek segíts' })

    const res = await h.svc.processQueuedBatch(10)
    assert.equal(res.results[0].outcome, 'no_agent_notice')
    assert.equal(h.transport.calls.length, 1, 'pontosan egy útmutató válasz megy ki')
    const text = String(h.transport.lastCall!.payload.text)
    assert.equal(text, NO_AGENT_GRANT_TEXT)
    assert.ok(text.includes('rendszergazd'), 'érthetően az adminhoz irányít (nem néma, nem rejtélyes)')
    assert.ok(!text.includes('Alfa') && !text.includes(TENANT_A), 'nincs szervezet-/agent-név a válaszban')
    assert.equal([...h.turnRows.values()][0].status, 'done')

    const na = h.audits.find((a) => a.action === 'channel.turn.no_agent')
    assert.ok(na, 'van channel.turn.no_agent audit')
    assert.ok(typeof na!.metadata.pseudonym === 'string', 'álnevesített azonosító')
  })

  await test('CT-3 fail-closed: VISSZAVONT kötés → agent-futásidő NEM hívódik, nincs kimenő hívás', async () => {
    const h = makeHarness()
    const identity = h.addIdentity('revoked')
    const session = h.addSession(identity.id)
    h.grantAgent(identity.id) // még ha lenne is engedély, a visszavont kötés zár
    await h.turns.enqueue({ sessionId: session.id, inboundRef: 'engedj be' })

    const res = await h.svc.processQueuedBatch(10)
    assert.equal(res.results[0].outcome, 'fail_closed')
    assert.equal(h.transport.calls.length, 0, 'fail-closed: semmilyen kimenő hívás')
    assert.equal([...h.turnRows.values()][0].status, 'done', 'a forduló lezárul (nem ragad be)')
    assert.equal(h.audits.length, 0, 'nincs no_agent audit egy visszavont kötésnél')
  })

  await test('CT-4 fail-closed: ISMERETLEN küldő (munkamenethez nincs kötés) → agent-futásidő NEM hívódik', async () => {
    const h = makeHarness()
    const session = h.addSession(null) // nincs identityId
    await h.turns.enqueue({ sessionId: session.id, inboundRef: 'ki vagyok?' })

    const res = await h.svc.processQueuedBatch(10)
    assert.equal(res.results[0].outcome, 'fail_closed')
    assert.equal(h.transport.calls.length, 0)
    assert.equal([...h.turnRows.values()][0].status, 'done')
  })

  await test('CT-5 újrapróbálhatóság: átmeneti kimenő hiba → vissza a sorba, kimerülésnél dead-letter', async () => {
    const h = makeHarness()
    const identity = h.addIdentity('active')
    const session = h.addSession(identity.id)
    // Nincs agent → a no-agent válasz megy ki; a transport azonban átmeneti hibát ad.
    await h.turns.enqueue({ sessionId: session.id, inboundRef: 'próba' })

    // maxAttempts=3. Két átmeneti hiba → kétszer visszakerül; a harmadik kivétel → dead-letter.
    h.transport.queueResults(
      { ok: false, reason: 'transport_error', detail: 'ETIMEDOUT' },
      { ok: false, reason: 'provider_error', detail: 'status_500' },
      { ok: false, reason: 'transport_error', detail: 'ECONNRESET' },
    )

    const r1 = await h.svc.processQueuedBatch(1)
    assert.equal(r1.results[0].outcome, 'retry_scheduled')
    assert.equal([...h.turnRows.values()][0].status, 'queued', 'átmeneti hiba → vissza a sorba')

    const r2 = await h.svc.processQueuedBatch(1)
    assert.equal(r2.results[0].outcome, 'retry_scheduled')

    const r3 = await h.svc.processQueuedBatch(1)
    assert.equal(r3.results[0].outcome, 'dead_letter')
    const turn = [...h.turnRows.values()][0]
    assert.equal(turn.status, 'failed', 'kimerült újrapróbák → dead-letter')
    assert.ok(turn.lastError && turn.lastError.includes('transport_error'), 'a lastError diagnosztizálható')
  })

  await test('CT-6 worker-tartósság: crash-elakadt `running` forduló visszakerül a sorba (watchdog)', async () => {
    const h = makeHarness()
    const identity = h.addIdentity('active')
    const session = h.addSession(identity.id)
    h.grantAgent(identity.id)
    const turn = await h.turns.enqueue({ sessionId: session.id, inboundRef: 'x' })
    // Szimuláljuk: egy worker kivette (running), majd elszállt — a forduló beragadt.
    await h.turns.claimNextQueued(h.clockNow())
    assert.equal(h.turnRows.get(turn.id)!.status, 'running')

    // Idő telik; a stale-küszöb fölött a watchdog visszateszi queued-ba.
    h.advanceMs(5 * 60 * 1000)
    const reclaimed = await h.svc.reclaimStale(2 * 60 * 1000)
    assert.equal(reclaimed, 1)
    assert.equal(h.turnRows.get(turn.id)!.status, 'queued', 'a beragadt forduló újra feldolgozható')

    // És most tényleg le is fut.
    const res = await h.svc.processQueuedBatch(10)
    assert.equal(res.results[0].outcome, 'linked_no_runtime')
    assert.equal(h.turnRows.get(turn.id)!.status, 'done')
  })

  await test('CT-7 adag: több queued forduló egy körben, üres sornál megáll', async () => {
    const h = makeHarness()
    const identity = h.addIdentity('active')
    h.grantAgent(identity.id)
    const s1 = h.addSession(identity.id, '900001')
    const s2 = h.addSession(identity.id, '900002')
    await h.turns.enqueue({ sessionId: s1.id, inboundRef: 'egy' })
    await h.turns.enqueue({ sessionId: s2.id, inboundRef: 'kettő' })

    const res = await h.svc.processQueuedBatch(10)
    assert.equal(res.claimed, 2, 'mindkét fordulót felvette')
    assert.ok([...h.turnRows.values()].every((t) => t.status === 'done'))

    const empty = await h.svc.processQueuedBatch(10)
    assert.equal(empty.claimed, 0, 'üres sornál nem csinál semmit')
  })

  if (failures > 0) {
    console.error(`\n${failures} teszt BUKOTT.`)
    process.exit(1)
  }
  console.log('\nMinden forduló-sor / worker varrat-teszt zöld.')
}

void main()
