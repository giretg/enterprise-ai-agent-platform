/**
 * #1016 nyilvános chat valódi (migrált) Postgresen: slug → tenant feloldás, munkamenet, forduló-mentés,
 * napi keret, jelzés, látogatói törlés, betöltés-állapot, 30 napos sweep — a stub-modellel végigfutó végponton át.
 * Futtatás: npm run test:public-chat-db (DATABASE_URL + DIRECT_URL egy eldobható DB-re).
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { prisma } from '../src/lib/db'
import { publicChatStore } from '../src/repositories/postgres/public-chat-store'
import { defaultPublicAssistantConfig } from '../src/domain/public-chat/config'
import { handlePublicChat, type PublicChatDeps } from '../src/domain/public-chat/service'
import { FLAG_TOOL } from '../src/domain/public-chat/runtime'
import { runPublicChatMaintenance } from '../src/domain/public-chat/maintenance'

const VISITOR = 'x'.repeat(40)

async function main() {
  const suffix = randomUUID().slice(0, 8)
  const tenant = await prisma.tenant.create({ data: { slug: `public-chat-${suffix}`, displayName: 'Public chat test' } })
  const agent = await prisma.agent.create({ data: { tenantId: tenant.id, name: 'Bolt', roleInstruction: '', kind: 'public' } })
  const slug = `bolt-${suffix}`
  const config = { ...defaultPublicAssistantConfig('Bolt'), dailyBudgetUsd: 1 }
  await prisma.publicAssistant.create({ data: { agentId: agent.id, tenantId: tenant.id, slug, draft: config, published: config } })
  let round = 0
  const deps: PublicChatDeps = {
    store: publicChatStore,
    verifyTurnstile: null,
    secret: 's'.repeat(40),
    rateLimit: () => true,
    turnDeps: ({ tenantId, agentId, sessionId }) => ({
      async callModel() {
        round++
        return round % 2 === 1
          ? { content: null, toolCalls: [{ id: 't', type: 'function', function: { name: FLAG_TOOL, arguments: '{"question":"Van parkoló?"}' } }], costUsd: 0.25 }
          : { content: 'Ezt most nem tudom biztosan.', toolCalls: [], costUsd: 0.25 }
      },
      searchKb: async () => [],
      forward: async () => 'callback_requested',
      flag: ({ source, question }) => publicChatStore.addSignal({ tenantId, agentId, sessionId, source, question }),
    }),
  }
  const send = (body: Record<string, unknown>) =>
    handlePublicChat(deps, { slug, body: { op: 'send', visitorId: VISITOR, message: 'Van parkoló?', ...body }, ip: '10.0.0.1', origin: null })
  try {
    const first = await send({ context: { page: 'kapcsolat' } })
    assert.equal(first.status, 200, JSON.stringify(first.body))
    const sessionId = String(first.body.sessionId)
    const row = await prisma.publicChatSession.findUniqueOrThrow({ where: { id: sessionId } })
    assert.equal(row.tenantId, tenant.id)
    assert.equal(row.messageCount, 2)
    assert.deepEqual(row.context, { page: 'kapcsolat' })
    assert.ok(row.ipHash && row.ipHash !== '10.0.0.1', 'az IP csak hash-elve tárolódik')
    assert.equal(await prisma.publicChatSignal.count({ where: { sessionId, source: 'uncertain' } }), 1)
    console.log('  OK  slug → tenant; munkamenet, forduló, kontextus, IP-hash és jelzés mentve')

    const second = await send({ sessionId })
    assert.equal(second.status, 200)
    const usage = await prisma.publicChatDailyUsage.findFirstOrThrow({ where: { tenantId: tenant.id } })
    assert.equal(Number(usage.costUsd), 1)
    assert.equal(usage.calls, 2)
    const exhausted = await send({ sessionId })
    assert.equal(exhausted.status, 503)
    console.log('  OK  napi keret könyvelve (upsert), kimerülés után 503')

    await handlePublicChat(deps, { slug, body: { op: 'ping', embedOrigin: 'https://www.bolt.hu/' }, ip: null, origin: null })
    const assistant = await prisma.publicAssistant.findUniqueOrThrow({ where: { agentId: agent.id } })
    assert.equal(assistant.lastLoadedDomain, 'www.bolt.hu')
    console.log('  OK  betöltés-állapot mentve')

    const del = await handlePublicChat(deps, { slug, body: { op: 'delete', visitorId: VISITOR }, ip: null, origin: null })
    assert.equal(del.body.deleted, 1)
    assert.equal(await prisma.publicChatSignal.count({ where: { sessionId } }), 0, 'a jelzések a beszélgetéssel törlődnek')
    console.log('  OK  látogatói törlés a jelzésekkel együtt')

    const old = await publicChatStore.createSession({ tenantId: tenant.id, agentId: agent.id, visitorId: VISITOR, isTest: false, context: null, ipHash: null, now: new Date(Date.now() - 31 * 86_400_000) })
    const out = await runPublicChatMaintenance({
      deleteSessionsInactiveSince: async (cutoff) => (await prisma.publicChatSession.deleteMany({ where: { tenantId: tenant.id, lastActivityAt: { lt: cutoff } } })).count,
      listUngrouped: async () => [],
      setGroupLabel: async () => {},
      callModelFor: () => async () => ({ content: null, toolCalls: [], costUsd: 0 }),
    })
    assert.equal(out.deleted, 1)
    assert.equal(await prisma.publicChatSession.findUnique({ where: { id: old.id } }), null)
    console.log('  OK  30 napnál régebbi beszélgetés törölve')
  } finally {
    await prisma.publicChatSession.deleteMany({ where: { tenantId: tenant.id } })
    await prisma.publicChatDailyUsage.deleteMany({ where: { tenantId: tenant.id } })
    await prisma.publicAssistant.deleteMany({ where: { tenantId: tenant.id } })
    await prisma.agent.deleteMany({ where: { tenantId: tenant.id } })
    await prisma.tenant.delete({ where: { id: tenant.id } })
    await prisma.$disconnect()
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
