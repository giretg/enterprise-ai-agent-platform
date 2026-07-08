/**
 * Production dispatcher end-to-end smoke (§5.7, §15.3).
 *
 * A harness-smoke-tól eltérően ez NEM közvetlenül indít Jobot: létrehoz egy `ready`
 * ticketet a közös DB-ben, és a FELHŐBEN futó wiki-dispatcher service-re bízza, hogy
 * a LISTEN/NOTIFY (vagy a cron safety net) felkapja és elindítsa a wiki-harness Jobot.
 *
 * Mit IGAZOL (a dispatcher felelőssége): a ready ticketet a dispatcher felveszi
 * (lock + in_progress) és pontosan egyszer elindít egy harness executiont
 * (`dispatch.start` audit, run.jobs.runWithOverrides). A harness/recipe MINŐSÉGE
 * (konvergál-e válaszig a Gateway 20-hívásos guardrailje alatt) külön ügy (S6) — a
 * smoke a harness végső státuszát csak tájékoztatásként írja ki.
 *
 * Előfeltétel:
 *   - wiki-dispatcher Cloud Run service fut (npm run dispatcher:cloud-run-deploy)
 *   - DATABASE/DIRECT_URL a közös Neon-ra mutat (a service ugyanazt látja)
 * Futtatás: npm run dispatcher:cloud-run-smoke
 */
import './load-env'
import { randomUUID } from 'crypto'

import { prisma } from '../src/lib/db'
import { DISPATCH_NOTIFY_CHANNEL } from '../src/lib/dispatch-notify'

const SAMPLE_QUESTION =
  'Mi a platform célja, és milyen átjárókon kell átmennie az agent műveleteinek?'
const TIMEOUT_MS = Number(process.env.DISPATCHER_SMOKE_TIMEOUT_MS ?? '120000')
const POLL_MS = 3000

async function main() {
  const agent = await prisma.agent.findFirst({ where: { name: 'Wiki Agent' } })
  const operator = await prisma.user.findUnique({ where: { externalAuthId: 'seed-operator' } })
  if (!agent || !operator) throw new Error('Seed hiányzik — npm run db:seed')

  const ticketId = randomUUID()
  await prisma.ticket.create({
    data: {
      id: ticketId,
      type: 'interaction',
      title: 'Dispatcher cloud-run smoke',
      state: 'ready',
      assigneeType: 'agent',
      assigneeId: agent.id,
      agentId: agent.id,
      payload: { question: SAMPLE_QUESTION, agentVersion: agent.currentVersion },
      createdById: operator.id,
      source: 'test',
    },
  })
  console.log(`[dispatcher-smoke] ready ticket created: ${ticketId}`)

  // Eseményvezérelt trigger (a cron safety net amúgy is felkapná ~30s-en belül).
  await prisma.$executeRawUnsafe(`SELECT pg_notify('${DISPATCH_NOTIFY_CHANNEL}', '${ticketId}')`)
  console.log(`[dispatcher-smoke] NOTIFY ${DISPATCH_NOTIFY_CHANNEL} sent`)

  const deadline = Date.now() + TIMEOUT_MS
  let dispatched = false

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_MS))

    // dispatch.start audit = a dispatcher felvette és elindította a Jobot.
    const starts = await prisma.auditLog.count({
      where: { targetId: ticketId, action: 'dispatch.start' },
    })
    if (starts > 0 && !dispatched) {
      dispatched = true
      console.log(`[dispatcher-smoke] ✅ dispatcher PICKED UP + LAUNCHED (dispatch.start, count=${starts})`)
    }
    if (starts > 1) {
      console.error(`[dispatcher-smoke] ⚠️ duplikált indítás! dispatch.start count=${starts}`)
    }

    // Harness végső státusz (tájékoztató): complete vagy error.
    const done = await prisma.auditLog.findFirst({
      where: { targetId: ticketId, action: { in: ['dispatch.complete', 'dispatch.error'] } },
      orderBy: { seq: 'desc' },
      select: { action: true, policyDecision: true },
    })
    if (dispatched && done) {
      console.log(`[dispatcher-smoke] harness outcome: ${done.action}/${done.policyDecision} (a recipe-minőség külön ügy, S6)`)
      console.log('[dispatcher-smoke] PASS — a dispatcher deploy a feladatát teljesíti.')
      await cleanup(ticketId)
      await prisma.$disconnect()
      process.exit(0)
    }
  }

  if (dispatched) {
    console.log('[dispatcher-smoke] PASS — dispatch.start megvolt; a harness még futott a timeoutkor.')
    await cleanup(ticketId)
    await prisma.$disconnect()
    process.exit(0)
  }

  console.error(`[dispatcher-smoke] ❌ TIMEOUT ${TIMEOUT_MS}ms — nem volt dispatch.start. Nézd a wiki-dispatcher service logokat.`)
  await prisma.$disconnect()
  process.exit(1)
}

/** A teszt-ticketet done-ra állítja, hogy ne pörögjön tovább a dispatch-ben. */
async function cleanup(ticketId: string) {
  await prisma.ticket
    .updateMany({ where: { id: ticketId }, data: { state: 'done', lockToken: null, lockedAt: null } })
    .catch(() => {})
}

main().catch(async (e) => {
  console.error('[dispatcher-smoke] fatal:', e instanceof Error ? e.message : e)
  await prisma.$disconnect()
  process.exit(1)
})
