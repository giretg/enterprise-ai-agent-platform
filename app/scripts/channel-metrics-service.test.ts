/**
 * Csatorna üzemeltetői metrikák (CM-*) — a #78 záró slice, story 59. Fakes-szel, DB nélkül.
 *
 * A teszt KIZÁRÓLAG külső viselkedést figyel: a metrika-szolgáltatás az audit-akció-számokat
 * és a csatorna-táblák aggregált állapotát olvassa, és egy pillanatképet ad. A teszt a
 * befecskendezett audit- és metrika-dublőrökön keresztül hajtja, és a visszaadott pillanatképet
 * nézi — nem hív külön belső számlálót.
 *
 * Futtatás: npm run test:channel-metrics
 */
import assert from 'node:assert/strict'
import type { ChannelBot } from '@prisma/client'
import { ChannelMetricsService } from '../src/domain/channel/channel-metrics-service'
import { CHANNEL_AUDIT_ACTIONS } from '../src/domain/channel/channel-types'
import { assertAuditActionRegistered } from '../src/lib/audit/event-catalog'
import type { ChannelMetricsRepository } from '../src/repositories/interfaces'

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

const NOW = new Date('2026-07-23T12:00:00Z')

function makeBot(overrides?: Partial<ChannelBot>): ChannelBot {
  return {
    id: 'bot-1',
    channelType: 'telegram',
    tenantId: null,
    name: 'Platform Bot',
    botUsername: null,
    accessKeySecretRef: 'env:X',
    webhookSecretRef: 'env:Y',
    status: 'active',
    createdById: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

function makeService(opts: {
  actionCounts?: Record<string, number>
  turns?: Record<string, number>
  sessions?: { total: number; linked: number }
  identities?: Record<string, number>
  pending?: { pending: number; oldestSentAt: Date | null }
  bot?: ChannelBot | null
  captureSince?: (since?: Date) => void
}) {
  const audit = {
    async getActionCounts(filter?: { actions?: string[]; since?: Date }) {
      opts.captureSince?.(filter?.since)
      const all = opts.actionCounts ?? {}
      if (!filter?.actions) return all
      const out: Record<string, number> = {}
      for (const a of filter.actions) if (all[a] != null) out[a] = all[a]
      return out
    },
  }
  const metrics: ChannelMetricsRepository = {
    async countTurnsByStatus() {
      return opts.turns ?? {}
    },
    async countSessions() {
      return opts.sessions ?? { total: 0, linked: 0 }
    },
    async countIdentitiesByStatus() {
      return opts.identities ?? {}
    },
    async countPendingOutbound() {
      return opts.pending ?? { pending: 0, oldestSentAt: null }
    },
  }
  const bots = {
    async findPlatformBot() {
      return opts.bot === undefined ? makeBot() : opts.bot
    },
  }
  return new ChannelMetricsService({ audit, metrics, bots, now: () => NOW })
}

async function main() {
  // CM-0: a katalógusban regisztrált audit-akciók (az összegző takarítás-eseményekhez is).
  await test('CM-0: az üzemeltetési audit-akciók regisztráltak a katalógusban', () => {
    assertAuditActionRegistered(CHANNEL_AUDIT_ACTIONS.messagePurged)
    assertAuditActionRegistered(CHANNEL_AUDIT_ACTIONS.retentionSwept)
  })

  // CM-1: a forgalmi számok az audit-akció-számokból, a megfelelő címkékre képezve.
  await test('CM-1: a forgalom az audit-akció-számokból áll össze', async () => {
    const svc = makeService({
      actionCounts: {
        [CHANNEL_AUDIT_ACTIONS.linkTokenIssued]: 5,
        [CHANNEL_AUDIT_ACTIONS.linkEstablished]: 3,
        [CHANNEL_AUDIT_ACTIONS.linkRejected]: 2,
        [CHANNEL_AUDIT_ACTIONS.unlinkedNotice]: 7,
        [CHANNEL_AUDIT_ACTIONS.messageSent]: 42,
        [CHANNEL_AUDIT_ACTIONS.messageBlocked]: 4,
        [CHANNEL_AUDIT_ACTIONS.identityRevoked]: 1,
        [CHANNEL_AUDIT_ACTIONS.messagePurged]: 9,
      },
    })
    const snap = await svc.snapshot()
    assert.equal(snap.traffic.tokensIssued, 5)
    assert.equal(snap.traffic.linksEstablished, 3)
    assert.equal(snap.traffic.linksRejected, 2)
    assert.equal(snap.traffic.unlinkedNotices, 7)
    assert.equal(snap.traffic.outboundSent, 42)
    assert.equal(snap.traffic.outboundBlocked, 4)
    assert.equal(snap.traffic.revocations, 1)
    assert.equal(snap.traffic.messagesPurged, 9)
  })

  // CM-2: a hibametrikák a fordulók bukásaiból + audit-számokból; hiányzó akció = 0.
  await test('CM-2: hibametrikák és hiányzó akció → 0 (nem hiba)', async () => {
    const svc = makeService({
      actionCounts: { [CHANNEL_AUDIT_ACTIONS.linkRejected]: 6, [CHANNEL_AUDIT_ACTIONS.messageBlocked]: 2 },
      turns: { queued: 1, running: 0, done: 10, failed: 4 },
      identities: { active: 8, revoked: 2, blocked: 3 },
    })
    const snap = await svc.snapshot()
    assert.equal(snap.errors.turnsFailed, 4)
    assert.equal(snap.errors.linksRejected, 6)
    assert.equal(snap.errors.outboundBlocked, 2)
    assert.equal(snap.errors.identitiesBlocked, 3)
    // Nem szereplő forgalmi akció 0, nem undefined.
    assert.equal(snap.traffic.outboundSent, 0)
    assert.equal(snap.traffic.tokensIssued, 0)
  })

  // CM-3: a pillanatnyi állapot a csatorna-táblák aggregátumaiból.
  await test('CM-3: pillanatnyi állapot (fordulók, munkamenetek, identitások, takarítási lemaradás)', async () => {
    const oldest = new Date('2026-06-01T00:00:00Z')
    const svc = makeService({
      turns: { queued: 2, running: 1, done: 5, failed: 0 },
      sessions: { total: 12, linked: 9 },
      identities: { active: 9, revoked: 1, blocked: 0 },
      pending: { pending: 4, oldestSentAt: oldest },
    })
    const snap = await svc.snapshot()
    assert.deepEqual(snap.health.turns, { queued: 2, running: 1, done: 5, failed: 0 })
    assert.deepEqual(snap.health.sessions, { total: 12, linked: 9 })
    assert.deepEqual(snap.health.identities, { active: 9, revoked: 1, blocked: 0 })
    assert.equal(snap.health.retention.pendingOutbound, 4)
    assert.equal(snap.health.retention.oldestPendingSentAt, oldest.toISOString())
  })

  // CM-4: az időablak a mostól visszafelé számolódik és átmegy az audithoz + a fordulókhoz.
  await test('CM-4: sinceMs → windowSince az audit-szűrőhöz továbbadva', async () => {
    let captured: Date | undefined
    const svc = makeService({ captureSince: (s) => (captured = s) })
    const snap = await svc.snapshot({ sinceMs: 7 * 24 * 60 * 60 * 1000 })
    const expected = new Date(NOW.getTime() - 7 * 24 * 60 * 60 * 1000)
    assert.equal(snap.windowSince, expected.toISOString())
    assert.equal(captured?.toISOString(), expected.toISOString())
  })

  // CM-5: teljes előzmény → nincs időablak (since undefined).
  await test('CM-5: sinceMs nélkül teljes előzmény (windowSince = null)', async () => {
    let captured: Date | undefined = new Date()
    const svc = makeService({ captureSince: (s) => (captured = s) })
    const snap = await svc.snapshot()
    assert.equal(snap.windowSince, null)
    assert.equal(captured, undefined)
  })

  // CM-6: a bot állapota a pillanatképben (regisztrált/aktív/webhook beállítva).
  await test('CM-6: bot-állapot — nincs bot / aktív+webhook / webhook hiányzik', async () => {
    const none = await makeService({ bot: null }).snapshot()
    assert.equal(none.bot.registered, false)
    assert.equal(none.bot.status, null)
    assert.equal(none.bot.hasWebhookSecret, false)

    const ok = await makeService({ bot: makeBot({ status: 'active', webhookSecretRef: 'env:Y' }) }).snapshot()
    assert.equal(ok.bot.registered, true)
    assert.equal(ok.bot.status, 'active')
    assert.equal(ok.bot.hasWebhookSecret, true)

    const noWh = await makeService({ bot: makeBot({ webhookSecretRef: '   ' }) }).snapshot()
    assert.equal(noWh.bot.hasWebhookSecret, false)
  })

  console.log(failures === 0 ? '\nAll channel-metrics tests passed.' : `\n${failures} test(s) failed.`)
  if (failures > 0) process.exit(1)
}

void main()
