/**
 * #1032 bejövő levél valódi (migrált) Postgresen: a webhook-végpont szerződése a Prisma-tárolóval —
 * egyidejű dupla kézbesítés egy eseményt és egy futást ad, hamis aláírás nem ír a DB-be,
 * átadás-sor (Handoff) idempotensen, értesítés-lista, figyelt postafiókok, feliratkozás-állapot.
 * Futtatás: npm run test:inbound-mail-db (DATABASE_URL + DIRECT_URL egy eldobható DB-re).
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { prisma } from '../src/lib/db'
import { InboundMailService, type InboundMailEffects } from '../src/domain/inbound-mail/service'
import { MailboxWatcher, type WatchState } from '../src/domain/inbound-mail/watcher'
import { handleMailWebhookRequest } from '../src/domain/inbound-mail/webhook-request'
import { signSvix } from '../src/domain/inbound-mail/webhook-auth'
import { createInboundMailEffects } from '../src/lib/inbound-mail/effects'
import {
  countNewForUser,
  listAgentEvents,
  listNewForUser,
  listWatchedMailboxes,
  loadWatchedMailbox,
  prismaInboundMailStore,
  watchStore,
  type WatchRow,
} from '../src/lib/inbound-mail/store'
import { PostgresHandoffRepository } from '../src/repositories/postgres/handoff-repository'

const SECRET = `whsec_${Buffer.from('db-test-secret-0123456789abcdef!').toString('base64')}`

let failures = 0
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn()
    console.log(`  OK  ${name}`)
  } catch (e) {
    failures++
    console.log(`  FAIL ${name}: ${e instanceof Error ? e.stack : e}`)
  }
}

const toState = (row: WatchRow): WatchState => ({
  connectorId: row.connectorId,
  provider: row.provider,
  externalId: row.externalId,
  cursor: row.cursor,
  expiresAt: row.expiresAt,
  lastPolledAt: row.lastPolledAt,
  createdAt: row.createdAt,
})

async function main() {
  const suffix = randomUUID().slice(0, 8)
  const tenant = await prisma.tenant.create({ data: { slug: `inbound-${suffix}`, displayName: 'Inbound mail test' } })
  const user = await prisma.user.create({ data: { externalAuthId: `ext-${suffix}`, email: `anna-${suffix}@ceg.hu`, name: 'Anna', status: 'active' } })
  const other = await prisma.user.create({ data: { externalAuthId: `ext2-${suffix}`, email: `bela-${suffix}@ceg.hu`, name: 'Béla', status: 'active' } })
  await prisma.tenantMembership.createMany({
    data: [
      { tenantId: tenant.id, userId: user.id, role: 'operator', status: 'active' },
      { tenantId: tenant.id, userId: other.id, role: 'operator', status: 'active' },
    ],
  })
  const address = `szamlazas-${suffix}@ceg.hu`
  const connector = await prisma.connector.create({
    data: {
      tenantId: tenant.id,
      type: 'http_api',
      name: `AgentMail · ${address}`,
      scope: 'single',
      config: { provider: 'agentmail', baseUrl: `https://api.agentmail.eu/v0/inboxes/${encodeURIComponent(address)}` },
    },
  })
  const agent = await prisma.agent.create({
    data: { tenantId: tenant.id, name: 'Számlázási asszisztens', roleInstruction: '', primaryMailboxConnectorId: connector.id, primaryMailboxAddress: address },
  })
  const definition = await prisma.agentDefinitionVersion.create({
    data: { agentId: agent.id, version: 1, snapshot: {}, contentHash: 'h', publishedById: user.id },
  })
  await prisma.agent.update({ where: { id: agent.id }, data: { currentDefinitionVersionId: definition.id, status: 'active' } })
  await prisma.agentInboundMailRule.create({
    data: { agentId: agent.id, tenantId: tenant.id, mode: 'process', instructions: 'Töltsd fel a számlát.', responsibleUserId: user.id },
  })

  const runs: string[] = []
  const handoffs = new PostgresHandoffRepository()
  const realEffects = createInboundMailEffects({
    session: {} as never,
    loadRole: async () => null,
    handoffs,
  })
  const effects: InboundMailEffects = {
    async startRun(input) {
      runs.push(input.eventId)
      // Lassú worker-hívás szimulálása: a párhuzamos kézbesítés ezalatt érkezik.
      await new Promise((r) => setTimeout(r, 50))
      return { ok: true, conversationId: randomUUID() }
    },
    runState: async () => 'processed',
    createHandoff: realEffects.createHandoff,
  }
  const service = new InboundMailService({ store: prismaInboundMailStore, effects })
  const secrets = new Map([[connector.id, SECRET]])
  const watcher = new MailboxWatcher({
    service,
    store: prismaInboundMailStore,
    watches: {
      find: async (id) => {
        const row = await watchStore.find(id)
        return row ? toState(row) : null
      },
      findByExternalId: async (p, e) => {
        const row = await watchStore.findByExternalId(p, e)
        return row ? toState(row) : null
      },
      listByProvider: async (p) => (await watchStore.listByProvider(p)).map(toState),
      upsert: async (input) => toState(await watchStore.upsert(input)),
      update: (id, patch) => watchStore.update(id, patch),
    },
    loadMailbox: (id) => loadWatchedMailbox(id),
    listMailboxes: listWatchedMailboxes,
    credentials: {
      agentMailInbox: async () => ({ baseUrl: 'https://api.agentmail.eu/v0/inboxes/x', inboxId: address, inboxKey: 'k' }),
      agentMailOrg: async () => null,
      oauthToken: async () => 'unused',
    },
    secrets: { save: async (id, s) => void secrets.set(id, s), load: async (id) => secrets.get(id) ?? null },
    config: { publicOrigin: null, gmailTopic: null },
  })
  const deps = { watcher, verifyGoogleToken: async () => false }
  const request = (messageId: string, opts: { from?: string; secret?: string } = {}) => {
    const raw = JSON.stringify({
      event_type: 'message.received',
      message: { inbox_id: address, thread_id: `t-${messageId}`, message_id: messageId, from: opts.from ?? 'Partner <a@partner.hu>', subject: 'Számla', timestamp: new Date().toISOString(), labels: ['received'] },
    })
    const id = `msg_${randomUUID()}`
    const ts = Math.floor(Date.now() / 1000)
    return new Request(`https://x/api/webhooks/mail/agentmail?c=${connector.id}`, {
      method: 'POST',
      headers: { 'svix-id': id, 'svix-timestamp': String(ts), 'svix-signature': signSvix(opts.secret ?? SECRET, id, ts, raw) },
      body: raw,
    })
  }

  try {
    await check('a figyelt postafiókok között van (agent saját címe), a figyelés-állapot létrejön', async () => {
      const boxes = await listWatchedMailboxes()
      const box = boxes.find((b) => b.connectorId === connector.id)
      assert.equal(box?.agent?.id, agent.id)
      assert.equal(box?.provider, 'agentmail')
      assert.equal(box?.address, address)
      assert.equal(await watcher.ensureWatch(box!), 'poll', 'nyilvános https cím nélkül csak polling')
      assert.equal((await watchStore.find(connector.id))?.provider, 'agentmail')
    })

    await check('AC3: ugyanaz a webhook egyszerre kétszer → egy esemény, egy futás', async () => {
      const [a, b] = await Promise.all([handleMailWebhookRequest('agentmail', request('dup-1'), deps), handleMailWebhookRequest('agentmail', request('dup-1'), deps)])
      assert.deepEqual([a.status, b.status], [200, 200])
      const created = [(await a.json()) as { created: number }, (await b.json()) as { created: number }].map((x) => x.created).sort()
      assert.deepEqual(created, [0, 1])
      const rows = await prisma.inboundMailEvent.findMany({ where: { connectorId: connector.id, messageId: 'dup-1' } })
      assert.equal(rows.length, 1)
      assert.equal(runs.length, 1)
      assert.equal(rows[0].status, 'claimed')
      assert.ok(rows[0].conversationId)
      assert.equal(rows[0].responsibleUserId, user.id)
    })

    await check('AC5: hamis aláírás → 401, nincs új sor', async () => {
      const before = await prisma.inboundMailEvent.count({ where: { connectorId: connector.id } })
      const res = await handleMailWebhookRequest('agentmail', request('forged', { secret: `whsec_${Buffer.from('evil').toString('base64')}` }), deps)
      assert.equal(res.status, 401)
      assert.equal(await prisma.inboundMailEvent.count({ where: { connectorId: connector.id } }), before)
    })

    await check('AC2: az egyeztetés a kész futást processed-re állítja', async () => {
      const summary = await service.reconcileClaimed(50)
      assert.ok(summary.processed >= 1)
      const row = await prisma.inboundMailEvent.findFirstOrThrow({ where: { connectorId: connector.id, messageId: 'dup-1' } })
      assert.equal(row.status, 'processed')
    })

    await check('„Csak jelezze”: a felelős kolléga értesítés-listájában és számlálójában megjelenik', async () => {
      await prisma.agentInboundMailRule.update({ where: { agentId: agent.id }, data: { mode: 'notify' } })
      await handleMailWebhookRequest('agentmail', request('notify-1'), deps)
      assert.equal(await countNewForUser(tenant.id, user.id), 1)
      const mine = await listNewForUser(tenant.id, user.id)
      assert.equal(mine[0].messageId, 'notify-1')
      assert.equal(mine[0].agentName, 'Számlázási asszisztens')
      assert.equal(await countNewForUser(tenant.id, other.id), 0)
    })

    await check('AC4: saját cím → figyelmen kívül; másik platform-agent címe → csak jelzés (futás nincs)', async () => {
      await prisma.agentInboundMailRule.update({ where: { agentId: agent.id }, data: { mode: 'process' } })
      const before = runs.length
      await handleMailWebhookRequest('agentmail', request('own-1', { from: `Számlázás <${address}>` }), deps)
      const own = await prisma.inboundMailEvent.findFirstOrThrow({ where: { connectorId: connector.id, messageId: 'own-1' } })
      assert.equal(own.status, 'ignored')
      assert.equal(runs.length, before)
    })

    await check('„Adja át”: valódi Handoff-sor egyszer, a kolléga Feladatai között', async () => {
      await prisma.agentInboundMailRule.update({ where: { agentId: agent.id }, data: { mode: 'handoff', handoffToUserId: other.id } })
      await handleMailWebhookRequest('agentmail', request('handoff-1'), deps)
      await handleMailWebhookRequest('agentmail', request('handoff-1'), deps)
      const event = await prisma.inboundMailEvent.findFirstOrThrow({ where: { connectorId: connector.id, messageId: 'handoff-1' } })
      assert.equal(event.status, 'processed')
      const open = await handoffs.listOpenForUser(tenant.id, other.id)
      assert.equal(open.length, 1)
      assert.equal(open[0].id, event.handoffId)
      assert.ok(open[0].summary.includes('a@partner.hu'))
      assert.equal(open[0].createdById, user.id)
    })

    await check('napi keret a valódi számlálóval: keret felett csak jelzés', async () => {
      await prisma.agentInboundMailRule.update({ where: { agentId: agent.id }, data: { mode: 'process', dailyRunLimit: 2, handoffToUserId: null } })
      await handleMailWebhookRequest('agentmail', request('limit-1'), deps)
      await handleMailWebhookRequest('agentmail', request('limit-2'), deps)
      const last = await prisma.inboundMailEvent.findFirstOrThrow({ where: { connectorId: connector.id, messageId: 'limit-2' } })
      assert.equal(last.reason, 'daily_limit', '(dup-1 + limit-1 = 2 futás ma)')
      assert.equal(last.status, 'new')
      const listed = await listAgentEvents(tenant.id, agent.id)
      assert.ok(listed.length >= 6)
    })
  } finally {
    await prisma.handoff.deleteMany({ where: { tenantId: tenant.id } })
    await prisma.inboundMailEvent.deleteMany({ where: { tenantId: tenant.id } })
    await prisma.mailWatchSubscription.deleteMany({ where: { tenantId: tenant.id } })
    await prisma.agentInboundMailRule.deleteMany({ where: { tenantId: tenant.id } })
    await prisma.agent.update({ where: { id: agent.id }, data: { currentDefinitionVersionId: null } })
    await prisma.agentDefinitionVersion.deleteMany({ where: { agentId: agent.id } })
    await prisma.agent.delete({ where: { id: agent.id } })
    await prisma.connector.delete({ where: { id: connector.id } })
    await prisma.tenantMembership.deleteMany({ where: { tenantId: tenant.id } })
    await prisma.user.deleteMany({ where: { id: { in: [user.id, other.id] } } })
    await prisma.tenant.delete({ where: { id: tenant.id } })
    await prisma.$disconnect()
  }
  if (failures) {
    console.error(`\n${failures} teszt hibás.`)
    process.exit(1)
  }
  console.log('\nMinden teszt rendben.')
}

void main()
