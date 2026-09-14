/**
 * Proaktív csatorna-értesítés (CN-*) — a csatorna-szolgáltatás HARMADIK bejárata
 * (Telegram feature-spec #70/#77, D7/D11/D15). Fakes-szel, DB nélkül.
 *
 * A tesztek KIZÁRÓLAG külső viselkedést figyelnek: hatás éri a szolgáltatást (Monitor-riasztás
 * bejárat), és megnézzük, milyen KIMENŐ hívások keletkeztek — vagy nem —, és milyen audit-hatás
 * született. A teszt SOSEM hívja külön az identitás-feloldót vagy a kripto-réteget.
 *
 * Varrat-esetek (#77 acceptance): boldog út (linkkel), nem regisztrált címzett (nincs küldés),
 * küldési hiba best-effort (a Monitor-futás nem bukik el), bot letiltva (kötés jelölődik, küldés
 * abbamarad). Plusz: nincs bot / kikapcsolt csatorna, szervezeti határ.
 *
 * Futtatás: npm run test:channel-notification
 */
import assert from 'node:assert/strict'
import type { ChannelBot, ChannelIdentity, ChannelIdentityStatus } from '@prisma/client'
import {
  ChannelNotificationService,
  type ChannelNotifyInput,
} from '../src/domain/channel/channel-notification-service'
import { RecordingChannelTransport } from '../src/domain/channel/channel-outbound-transport'
import { assertAuditActionRegistered } from '../src/lib/audit/event-catalog'
import type { ChannelBotRepository, ChannelIdentityRepository } from '../src/repositories/interfaces'

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
const TENANT_B = '22222222-2222-2222-2222-222222222222'
const USER_1 = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const RAW_CHAT_ID = '900042'

/** A fake kripto: `enc:<chatId>` ↔ `<chatId>` — determinisztikus, DB és titok nélkül. */
const fakeCrypto = { decryptExternalId: (enc: string) => enc.replace(/^enc:/, '') }

function makeHarness(opts?: {
  botStatus?: 'active' | 'disabled'
  noBot?: boolean
  identity?: { status?: ChannelIdentityStatus; tenantId?: string | null; userId?: string } | null
}) {
  const clock = new Date('2026-07-23T10:00:00Z')

  const bot: ChannelBot = {
    id: 'bot-1',
    channelType: 'telegram',
    tenantId: null,
    name: 'Platform Bot',
    botUsername: null,
    accessKeySecretRef: 'env:X',
    webhookSecretRef: 'env:Y',
    status: opts?.botStatus ?? 'active',
    createdById: null,
    createdAt: clock,
    updatedAt: clock,
  }

  const bots: ChannelBotRepository = {
    async findPlatformBot() {
      return opts?.noBot ? null : bot
    },
    async findById() {
      return opts?.noBot ? null : bot
    },
    async create() {
      throw new Error('unused')
    },
    async update() {
      throw new Error('unused')
    },
  }

  const identityRows = new Map<string, ChannelIdentity>()
  // Alap: egy AKTÍV kötés a USER_1-hez a TENANT_A-ban (hacsak a teszt mást nem kér).
  if (opts?.identity !== null) {
    const row: ChannelIdentity = {
      id: 'id-1',
      channelType: 'telegram',
      externalUserIdEnc: `enc:${RAW_CHAT_ID}`,
      lookupHash: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
      tenantId: opts?.identity?.tenantId !== undefined ? opts.identity.tenantId : TENANT_A,
      userId: opts?.identity?.userId ?? USER_1,
      status: opts?.identity?.status ?? 'active',
      linkedAt: clock,
      createdAt: clock,
      updatedAt: clock,
    }
    identityRows.set(row.id, row)
  }

  const identities: ChannelIdentityRepository = {
    async findByLookupHash(channelType, lookupHash) {
      for (const i of identityRows.values()) {
        if (i.channelType === channelType && i.lookupHash === lookupHash) return i
      }
      return null
    },
    async findById(id) {
      return identityRows.get(id) ?? null
    },
    async listByUser(userId) {
      return [...identityRows.values()].filter((i) => i.userId === userId)
    },
    async listByTenantWithUsers() {
      return []
    },
    async create() {
      throw new Error('unused')
    },
    async updateStatus(id, status: ChannelIdentityStatus) {
      const cur = identityRows.get(id)
      if (!cur) throw new Error('identity not found')
      const next = { ...cur, status, updatedAt: clock }
      identityRows.set(id, next)
      return next
    },
    async reactivate() {
      throw new Error('unused')
    },
  }

  const audits: AuditRow[] = []
  const audit = {
    append: async (data: {
      action: string
      targetType: string
      policyDecision: string
      metadata?: unknown
    }) => {
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

  const svc = new ChannelNotificationService({
    bots,
    identities,
    transport,
    audit: audit as never,
    crypto: fakeCrypto,
  })

  return { svc, transport, audits, identityRows }
}

function monitorInput(over?: Partial<ChannelNotifyInput>): ChannelNotifyInput {
  return {
    recipientUserId: USER_1,
    tenantId: TENANT_A,
    title: 'Monitor: Board hátralék',
    body: 'Jel: 3 nyitott ticket — súlyosság 2',
    detailUrl: 'https://app.example.com/control-plane/board?ticket=t-1',
    sourceType: 'monitor',
    sourceId: 'monitor-1',
    correlationId: 'run-1',
    ...over,
  }
}

async function main() {
  console.log('=== Proaktív csatorna-értesítés (varrat) ===')

  await test('CN-1 boldog út: összekötött címzett → kimenő üzenet a részletek-linkkel + audit', async () => {
    const h = makeHarness()
    const res = await h.svc.notifyUser(monitorInput())
    assert.equal(res.outcome, 'sent')

    // EGY kimenő hívás a helyes chat_id-re (a kötésből feloldva, nem tetszőleges cím).
    assert.equal(h.transport.calls.length, 1)
    assert.equal(h.transport.lastCall!.method, 'sendMessage')
    assert.equal(h.transport.lastCall!.payload.chat_id, RAW_CHAT_ID)
    const text = String(h.transport.lastCall!.payload.text)
    assert.ok(text.includes('Board hátralék'), 'a fejléc benne van')
    assert.ok(
      text.includes('https://app.example.com/control-plane/board?ticket=t-1'),
      'az értesítés tartalmazza a linket a részletekre',
    )

    // Audit: kiment; álnevesített azonosító, nyers chat_id SOHA.
    const sent = h.audits.find((a) => a.action === 'channel.notification.sent')
    assert.ok(sent, 'van channel.notification.sent audit')
    assert.equal(sent!.targetType, 'monitor')
    assert.ok(typeof sent!.metadata.pseudonym === 'string')
    assert.ok(!JSON.stringify(h.audits).includes(RAW_CHAT_ID), 'a nyers chat_id nem kerül auditba')
  })

  await test('CN-2 nem összekötött címzett → NINCS küldés, nincs kimenő hívás', async () => {
    const h = makeHarness({ identity: null })
    const res = await h.svc.notifyUser(monitorInput())
    assert.equal(res.outcome, 'not_registered')
    assert.equal(h.transport.calls.length, 0, 'nem regisztrált címzettnek nem megy semmi')
    assert.ok(h.audits.some((a) => a.action === 'channel.notification.skipped'))
  })

  await test('CN-3 visszavont (nem aktív) kötés → fail-closed, nincs küldés', async () => {
    const h = makeHarness({ identity: { status: 'revoked' } })
    const res = await h.svc.notifyUser(monitorInput())
    assert.equal(res.outcome, 'not_registered')
    assert.equal(h.transport.calls.length, 0)
  })

  await test('CN-4 szervezeti határ: más szervezethez kötött címzett → nincs küldés (§63)', async () => {
    // A kötés a TENANT_B-hez tartozik, a Monitor a TENANT_A-ból értesítene.
    const h = makeHarness({ identity: { tenantId: TENANT_B } })
    const res = await h.svc.notifyUser(monitorInput({ tenantId: TENANT_A }))
    assert.equal(res.outcome, 'not_registered')
    assert.equal(h.transport.calls.length, 0, 'szervezetek közti átjárás tiltott')
  })

  await test('CN-5 küldési hiba best-effort: NEM dob, csak audit; a hívó futása nem bukik el', async () => {
    const h = makeHarness()
    h.transport.queueResults({ ok: false, reason: 'provider_error', detail: 'status_500' })
    const res = await h.svc.notifyUser(monitorInput())
    assert.equal(res.outcome, 'send_failed')
    // Volt kimenő PRÓBÁLKOZÁS, de a hiba nem propagált kivételként.
    assert.equal(h.transport.calls.length, 1)
    const failed = h.audits.find((a) => a.action === 'channel.notification.failed')
    assert.ok(failed, 'van channel.notification.failed audit')
    assert.equal(failed!.metadata.reason, 'provider_error')
  })

  await test('CN-6 transport-hiba (időtúllépés/hálózat) sem dob — best-effort', async () => {
    const h = makeHarness()
    h.transport.queueResults({ ok: false, reason: 'transport_error', detail: 'AbortError' })
    const res = await h.svc.notifyUser(monitorInput())
    assert.equal(res.outcome, 'send_failed')
    assert.ok(h.audits.some((a) => a.action === 'channel.notification.failed'))
  })

  await test('CN-7 bot letiltva: a kötés `blocked`-ra jelölődik, és a következő küldés abbamarad', async () => {
    const h = makeHarness()
    h.transport.queueResults({ ok: false, reason: 'blocked_by_user', detail: 'status_403' })
    const res = await h.svc.notifyUser(monitorInput())
    assert.equal(res.outcome, 'recipient_blocked')

    // A kötés jelölődött.
    assert.equal([...h.identityRows.values()][0].status, 'blocked')
    assert.ok(h.audits.some((a) => a.action === 'channel.identity.blocked'))

    // A KÖVETKEZŐ értesítés már nem aktív kötést talál → nincs újabb kimenő hívás (abbamarad).
    const before = h.transport.calls.length
    const res2 = await h.svc.notifyUser(monitorInput())
    assert.equal(res2.outcome, 'not_registered')
    assert.equal(h.transport.calls.length, before, 'a letiltás után a küldés abbamarad')
  })

  await test('CN-8 nincs regisztrált platform-bot → nincs küldés', async () => {
    const h = makeHarness({ noBot: true })
    const res = await h.svc.notifyUser(monitorInput())
    assert.equal(res.outcome, 'no_bot')
    assert.equal(h.transport.calls.length, 0)
    assert.ok(h.audits.some((a) => a.action === 'channel.notification.skipped'))
  })

  await test('CN-9 kikapcsolt csatorna (incidens-kikapcsoló) → nincs küldés', async () => {
    const h = makeHarness({ botStatus: 'disabled' })
    const res = await h.svc.notifyUser(monitorInput())
    assert.equal(res.outcome, 'channel_disabled')
    assert.equal(h.transport.calls.length, 0)
  })

  await test('CN-10 link nélkül is érvényes üzenet megy (a link opcionális degradálódik)', async () => {
    const h = makeHarness()
    const res = await h.svc.notifyUser(monitorInput({ detailUrl: null }))
    assert.equal(res.outcome, 'sent')
    const text = String(h.transport.lastCall!.payload.text)
    assert.ok(!text.includes('Részletek:'), 'link hiányában nincs üres „Részletek:" sor')
    assert.ok(text.includes('Board hátralék'))
  })

  if (failures > 0) {
    console.error(`\n${failures} teszt BUKOTT.`)
    process.exit(1)
  }
  console.log('\nMinden proaktív értesítés varrat-teszt zöld.')
}

void main()
