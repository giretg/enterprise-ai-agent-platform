/**
 * A bot saját kimenő üzeneteinek megőrzési takarítása (CR-*) — a #78 záró slice, D4. DB nélkül.
 *
 * A teszt a csatorna VARRATÁN figyel: a takarítás hatása éri a szolgáltatást (egy futás), és
 * megnézzük, milyen KIMENŐ hívások keletkeztek (a rögzítő transport-dublőrön: `deleteMessage`
 * a helyes chat/message párral), mely sorok jelölődtek takarítottnak, és milyen ÁLNEVESÍTETT
 * audit-bejegyzések születtek (nyers külső azonosító / tartalom SEHOL).
 *
 * Futtatás: npm run test:channel-retention
 */
import assert from 'node:assert/strict'
import type { ChannelOutboundMessage } from '@prisma/client'
import { ChannelRetentionService } from '../src/domain/channel/channel-retention-service'
import {
  RecordingChannelTransport,
  type ChannelOutboundResult,
} from '../src/domain/channel/channel-outbound-transport'
import { CHANNEL_AUDIT_ACTIONS } from '../src/domain/channel/channel-types'
import type {
  ChannelOutboundMessageRepository,
  RecordChannelOutboundInput,
} from '../src/repositories/interfaces'

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

type AuditRow = {
  action: string
  targetType: string
  policyDecision: string
  metadata: Record<string, unknown>
}

const NOW = new Date('2026-07-23T12:00:00Z')
const DAY_MS = 24 * 60 * 60 * 1000

/** In-memory kimenő-üzenet tár, ami a `listExpired`/`markPurged` szerződést tükrözi. */
class FakeOutboundRepo implements ChannelOutboundMessageRepository {
  rows: ChannelOutboundMessage[] = []
  private seq = 0

  seed(input: { threadId: string; providerMessageId: string; sentAt: Date; kind?: string }) {
    const row: ChannelOutboundMessage = {
      id: `om-${++this.seq}`,
      sessionId: `sess-${this.seq}`,
      channelType: 'telegram',
      externalThreadId: input.threadId,
      providerMessageId: input.providerMessageId,
      kind: input.kind ?? 'link_established',
      sentAt: input.sentAt,
      purgedAt: null,
    }
    this.rows.push(row)
    return row
  }

  async record(input: RecordChannelOutboundInput): Promise<ChannelOutboundMessage> {
    return this.seed({
      threadId: input.externalThreadId,
      providerMessageId: input.providerMessageId,
      sentAt: input.sentAt ?? NOW,
      kind: input.kind ?? undefined,
    })
  }

  async listExpired(cutoff: Date, limit: number): Promise<ChannelOutboundMessage[]> {
    return this.rows
      .filter((r) => r.purgedAt == null && r.sentAt.getTime() < cutoff.getTime())
      .sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime())
      .slice(0, limit)
  }

  async markPurged(id: string, purgedAt: Date): Promise<void> {
    const row = this.rows.find((r) => r.id === id)
    if (row) row.purgedAt = purgedAt
  }
}

function makeHarness(defaultResult?: ChannelOutboundResult) {
  const outbound = new FakeOutboundRepo()
  const transport = new RecordingChannelTransport(defaultResult)
  const audits: AuditRow[] = []
  const audit = {
    async append(data: AuditRow) {
      audits.push({
        action: data.action,
        targetType: data.targetType,
        policyDecision: data.policyDecision,
        metadata: data.metadata,
      })
      return {} as never
    },
  }
  const service = new ChannelRetentionService({
    outbound,
    transport,
    audit: audit as never,
    now: () => NOW,
  })
  return { outbound, transport, audits, service }
}

async function main() {
  // CR-1: a horizonton túli üzenet törlődik — deleteMessage a helyes chat/message párral,
  // a sor takarítottnak jelölődik, és ÁLNEVESÍTETT audit születik (nyers chat id nélkül).
  await test('CR-1: horizonton túli üzenet → deleteMessage + purged + álnevesített audit', async () => {
    const { outbound, transport, audits, service } = makeHarness()
    const old = outbound.seed({
      threadId: '99887766',
      providerMessageId: '4242',
      sentAt: new Date(NOW.getTime() - 40 * DAY_MS),
    })

    const res = await service.purgeExpiredOutbound({ retentionDays: 30 })

    assert.equal(res.scanned, 1)
    assert.equal(res.deleted, 1)
    assert.equal(res.alreadyGone, 0)
    assert.equal(res.failed, 0)

    // A kimenő hívás: deleteMessage a helyes chat/message párral.
    const del = transport.calls.find((c) => c.method === 'deleteMessage')
    assert.ok(del, 'deleteMessage hívásnak lennie kell')
    assert.equal(del?.payload.chat_id, '99887766')
    assert.equal(del?.payload.message_id, 4242)

    // A sor takarítottnak jelölődött.
    assert.equal(outbound.rows.find((r) => r.id === old.id)?.purgedAt?.toISOString(), NOW.toISOString())

    // Álnevesített audit: nincs nyers chat id, van szál-álnév.
    const purged = audits.find((a) => a.action === CHANNEL_AUDIT_ACTIONS.messagePurged)
    assert.ok(purged, 'message.purged audit')
    assert.equal(purged?.policyDecision, 'deleted')
    const meta = purged?.metadata ?? {}
    assert.ok(typeof meta.threadPseudonym === 'string' && meta.threadPseudonym.length > 0)
    assert.ok(!JSON.stringify(meta).includes('99887766'), 'a nyers chat id NEM kerülhet auditba')
  })

  // CR-2: a horizonton BELÜLI üzenet érintetlen — nincs deleteMessage, nincs purge.
  await test('CR-2: friss (horizonton belüli) üzenet érintetlen', async () => {
    const { outbound, transport, service } = makeHarness()
    outbound.seed({
      threadId: '111',
      providerMessageId: '1',
      sentAt: new Date(NOW.getTime() - 5 * DAY_MS),
    })
    const res = await service.purgeExpiredOutbound({ retentionDays: 30 })
    assert.equal(res.scanned, 0)
    assert.equal(transport.calls.filter((c) => c.method === 'deleteMessage').length, 0)
    assert.equal(outbound.rows[0].purgedAt, null)
  })

  // CR-3: idempotens — a provider szerint már nincs meg az üzenet (provider_error) → takarítottnak
  // jelölve, „already_gone", nem próbálkozik újra és nem hiba.
  await test('CR-3: provider szerint már nincs meg → already_gone, purged, nincs végtelen újrapróba', async () => {
    const { outbound, transport, audits, service } = makeHarness()
    outbound.seed({
      threadId: '222',
      providerMessageId: '7',
      sentAt: new Date(NOW.getTime() - 60 * DAY_MS),
    })
    // A provider szerint az üzenet már nincs meg → provider_error.
    transport.queueResults({ ok: false, reason: 'provider_error', detail: 'status_400' })

    const res = await service.purgeExpiredOutbound({ retentionDays: 30 })
    assert.equal(res.deleted, 0)
    assert.equal(res.alreadyGone, 1)
    assert.equal(res.failed, 0)
    assert.equal(outbound.rows[0].purgedAt?.toISOString(), NOW.toISOString())
    const purged = audits.find((a) => a.action === CHANNEL_AUDIT_ACTIONS.messagePurged)
    assert.equal(purged?.policyDecision, 'already_gone')
  })

  // CR-4: átmeneti hiba (egress/transport/bot letiltva) → NEM jelöli purgednek, a következő futás
  // újrapróbálja; nincs message.purged audit erre a sorra.
  await test('CR-4: átmeneti hiba → nincs purge, újrapróbálható', async () => {
    const { outbound, transport, audits, service } = makeHarness()
    outbound.seed({
      threadId: '333',
      providerMessageId: '8',
      sentAt: new Date(NOW.getTime() - 60 * DAY_MS),
    })
    transport.queueResults({ ok: false, reason: 'transport_error', detail: 'AbortError' })

    const res = await service.purgeExpiredOutbound({ retentionDays: 30 })
    assert.equal(res.failed, 1)
    assert.equal(res.deleted, 0)
    assert.equal(res.alreadyGone, 0)
    assert.equal(outbound.rows[0].purgedAt, null)
    assert.equal(audits.filter((a) => a.action === CHANNEL_AUDIT_ACTIONS.messagePurged).length, 0)
  })

  // CR-5: minden futás összegző audit-ot ír (a takarítás determinisztikus nyoma az üzemeltetésnek).
  await test('CR-5: a futás összegző retention.swept auditot ír', async () => {
    const { outbound, audits, service } = makeHarness()
    outbound.seed({ threadId: '444', providerMessageId: '9', sentAt: new Date(NOW.getTime() - 90 * DAY_MS) })
    await service.purgeExpiredOutbound({ retentionDays: 30 })
    const swept = audits.find((a) => a.action === CHANNEL_AUDIT_ACTIONS.retentionSwept)
    assert.ok(swept, 'retention.swept audit')
    assert.equal(swept?.metadata.scanned, 1)
    assert.equal(swept?.metadata.deleted, 1)
    assert.equal(swept?.metadata.retentionDays, 30)
  })

  // CR-6: üres futás (nincs horizonton túli üzenet) → nincs kimenő hívás, de van összegző audit.
  await test('CR-6: üres futás — nincs deleteMessage, van összegző audit', async () => {
    const { transport, audits, service } = makeHarness()
    const res = await service.purgeExpiredOutbound({ retentionDays: 30 })
    assert.equal(res.scanned, 0)
    assert.equal(transport.calls.length, 0)
    assert.ok(audits.some((a) => a.action === CHANNEL_AUDIT_ACTIONS.retentionSwept))
  })

  // CR-7: a limit korlátozza egy futás munkáját (nagy hátralék biztonságos darabolása).
  await test('CR-7: a sweep-limit korlátozza a futásonként feldolgozott sorokat', async () => {
    const { outbound, service } = makeHarness()
    for (let i = 0; i < 5; i++) {
      outbound.seed({ threadId: `t${i}`, providerMessageId: String(i), sentAt: new Date(NOW.getTime() - 50 * DAY_MS) })
    }
    const res = await service.purgeExpiredOutbound({ retentionDays: 30, limit: 2 })
    assert.equal(res.scanned, 2)
    assert.equal(outbound.rows.filter((r) => r.purgedAt != null).length, 2)
  })

  console.log(failures === 0 ? '\nAll channel-retention tests passed.' : `\n${failures} test(s) failed.`)
  if (failures > 0) process.exit(1)
}

void main()
