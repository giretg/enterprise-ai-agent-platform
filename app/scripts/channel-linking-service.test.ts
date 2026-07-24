/**
 * Csatorna összekötés és visszavonás (CL-*) — a csatorna-szolgáltatás VARRATA
 * (Telegram feature-spec #70/#72, D2/D11/D12/D15). Fakes-szel, DB nélkül.
 *
 * A tesztek KIZÁRÓLAG külső viselkedést figyelnek: hatás éri a szolgáltatást (web-token-kiadás,
 * bejövő frissítés, vagy visszavonás), és megnézzük, milyen KIMENŐ hívások keletkeztek — vagy
 * nem — és milyen audit-/értesítés-hatás született. A teszt SOSEM hívja külön az identitás-
 * feloldót vagy a token-ellenőrzőt.
 *
 * Futtatás: npm run test:channel-linking
 */
import assert from 'node:assert/strict'
import type {
  ChannelBot,
  ChannelIdentity,
  ChannelIdentityStatus,
  ChannelLinkToken,
  ChannelSession,
} from '@prisma/client'
import {
  ChannelLinkingService,
  type ChannelLinkedMessageSink,
  type ChannelLinkNotifier,
} from '../src/domain/channel/channel-linking-service'
import { RecordingChannelTransport } from '../src/domain/channel/channel-outbound-transport'
import { pseudonymFromLookupHash } from '../src/domain/channel/channel-identity-crypto'
import { CHANNEL_AUDIT_ACTIONS } from '../src/domain/channel/channel-types'
import { assertAuditActionRegistered } from '../src/lib/audit/event-catalog'
import type {
  ChannelBotRepository,
  ChannelIdentityRepository,
  ChannelLinkTokenRepository,
  ChannelSessionRepository,
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

type AuditRow = { action: string; targetType: string; policyDecision: string; metadata: Record<string, unknown> }

const WEBHOOK_SECRET = 'wh-secret-abc'
const TENANT_A = '11111111-1111-1111-1111-111111111111'
const TENANT_B = '22222222-2222-2222-2222-222222222222'
const USER_1 = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'

function makeHarness(opts?: { botStatus?: 'active' | 'disabled'; noBot?: boolean }) {
  let clock = new Date('2026-07-22T10:00:00Z')
  const setClock = (d: Date) => {
    clock = d
  }
  const advanceMs = (ms: number) => {
    clock = new Date(clock.getTime() + ms)
  }

  const bot: ChannelBot = {
    id: 'bot-1',
    channelType: 'telegram',
    tenantId: null,
    name: 'Platform Bot',
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
  let idSeq = 0
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
    async create(input) {
      const now = clock
      const row: ChannelIdentity = {
        id: `id-${++idSeq}`,
        channelType: input.channelType,
        externalUserIdEnc: input.externalUserIdEnc,
        lookupHash: input.lookupHash,
        tenantId: input.tenantId,
        userId: input.userId,
        status: 'active',
        linkedAt: now,
        createdAt: now,
        updatedAt: now,
      }
      identityRows.set(row.id, row)
      return row
    },
    async updateStatus(id, status: ChannelIdentityStatus) {
      const cur = identityRows.get(id)
      if (!cur) throw new Error('identity not found')
      const next = { ...cur, status, updatedAt: clock }
      identityRows.set(id, next)
      return next
    },
    async reactivate(id, input) {
      const cur = identityRows.get(id)
      if (!cur) throw new Error('identity not found')
      const next = {
        ...cur,
        status: 'active' as ChannelIdentityStatus,
        userId: input.userId,
        tenantId: input.tenantId,
        linkedAt: input.linkedAt,
        updatedAt: clock,
      }
      identityRows.set(id, next)
      return next
    },
  }

  const sessionRows = new Map<string, ChannelSession>()
  let sessSeq = 0
  const sessions: ChannelSessionRepository = {
    async findById(id) {
      return sessionRows.get(id) ?? null
    },
    async findByBotAndThread(botId, externalThreadId) {
      for (const s of sessionRows.values()) {
        if (s.botId === botId && s.externalThreadId === externalThreadId) return s
      }
      return null
    },
    async create(input) {
      const now = clock
      const row: ChannelSession = {
        id: `sess-${++sessSeq}`,
        botId: input.botId,
        externalThreadId: input.externalThreadId,
        conversationId: null,
        identityId: null,
        activeAgentId: null,
        updateWatermark: null,
        unlinkedNoticeAt: null,
        lastActivityAt: now,
        createdAt: now,
        updatedAt: now,
      }
      sessionRows.set(row.id, row)
      return row
    },
    async update(id, data) {
      const cur = sessionRows.get(id)
      if (!cur) throw new Error('session not found')
      const next: ChannelSession = {
        ...cur,
        ...(data.identityId !== undefined ? { identityId: data.identityId } : {}),
        ...(data.activeAgentId !== undefined ? { activeAgentId: data.activeAgentId } : {}),
        ...(data.conversationId !== undefined ? { conversationId: data.conversationId } : {}),
        ...(data.updateWatermark !== undefined ? { updateWatermark: data.updateWatermark } : {}),
        ...(data.unlinkedNoticeAt !== undefined ? { unlinkedNoticeAt: data.unlinkedNoticeAt } : {}),
        ...(data.lastActivityAt !== undefined ? { lastActivityAt: data.lastActivityAt } : {}),
        updatedAt: clock,
      }
      sessionRows.set(id, next)
      return next
    },
  }

  const tokenRows = new Map<string, ChannelLinkToken>()
  let tokSeq = 0
  const linkTokens: ChannelLinkTokenRepository = {
    async create(input) {
      const row: ChannelLinkToken = {
        id: `tok-${++tokSeq}`,
        channelType: input.channelType,
        jti: input.jti,
        signature: input.signature,
        userId: input.userId,
        tenantId: input.tenantId,
        expiresAt: input.expiresAt,
        consumedAt: null,
        consumedByLookupHash: null,
        createdById: input.createdById,
        createdAt: clock,
      }
      tokenRows.set(input.jti, row)
      return row
    },
    async findByJti(jti) {
      return tokenRows.get(jti) ?? null
    },
    async consume(jti, consumedByLookupHash, now) {
      const cur = tokenRows.get(jti)
      if (!cur || cur.consumedAt != null) return null // atomi egyszer-használat
      const next = { ...cur, consumedAt: now, consumedByLookupHash }
      tokenRows.set(jti, next)
      return next
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

  const notifications: Array<{ userId: string; tenantId: string | null; orgName: string | null }> = []
  const notifier: ChannelLinkNotifier = {
    async linkEstablished(input) {
      notifications.push({ userId: input.userId, tenantId: input.tenantId, orgName: input.orgName })
    },
  }

  const transport = new RecordingChannelTransport()

  // Forduló-sor sink-fake (#73/#74): a linking-varrat a `linkedMessageSink.enqueueInbound`-on
  // (a valós `ChannelTurnService.enqueueInbound`-ot helyettesítve) ír sorba és auditál — a
  // claim/reclaim/agent-futás a worker-varrat teszté. A rögzített sorokból a teszt ellenőrzi a
  // bekötött → sorba-írás utat.
  const turnRows: Array<{ id: string; sessionId: string; inboundRef: string | null }> = []
  let turnSeq = 0
  const enqueuedNotifications: string[] = []
  const linkedMessageSink: ChannelLinkedMessageSink = {
    async enqueueInbound(input) {
      const row = { id: `turn-${++turnSeq}`, sessionId: input.sessionId, inboundRef: input.message.text }
      turnRows.push(row)
      await audit.append({
        action: CHANNEL_AUDIT_ACTIONS.turnEnqueued,
        targetType: 'channel_turn',
        policyDecision: 'queued',
        metadata: {
          channelType: input.identity.channelType,
          inboundKind: input.message.kind,
          pseudonym: pseudonymFromLookupHash(input.identity.lookupHash),
          tenantId: input.identity.tenantId,
        },
      })
      return { id: row.id }
    },
  }

  const svc = new ChannelLinkingService({
    bots,
    identities,
    sessions,
    linkTokens,
    linkedMessageSink,
    onTurnEnqueued: async (turnId: string) => {
      enqueuedNotifications.push(turnId)
    },
    transport,
    audit: audit as never,
    notifier,
    resolveOrgName: async (tenantId) =>
      tenantId === TENANT_A ? 'Alfa Kft.' : tenantId === TENANT_B ? 'Beta Zrt.' : null,
    resolveWebhookSecret: async () => WEBHOOK_SECRET,
    buildDeepLink: (jti) => `https://t.me/PlatformBot?start=${jti}`,
    now: () => clock,
  })

  return {
    svc,
    transport,
    audits,
    notifications,
    identityRows,
    sessionRows,
    tokenRows,
    turnRows,
    enqueuedNotifications,
    setClock,
    advanceMs,
    clockNow: () => clock,
  }
}

/** A kiadott token jti-jét a deep-linkből vonjuk ki (a valós úton így jut a Telegramba). */
function jtiFromDeepLink(deepLink: string): string {
  return new URL(deepLink).searchParams.get('start')!
}

/** Bejövő `/start <jti>` frissítés egy adott Telegram-usertől/threadtől. */
function startUpdate(updateId: number, fromId: string, jti: string, threadId = fromId) {
  return {
    message: { updateId, externalThreadId: threadId, externalUserId: fromId, text: `/start ${jti}` },
    secretHeader: WEBHOOK_SECRET,
  }
}

function textUpdate(updateId: number, fromId: string, text: string, threadId = fromId) {
  return {
    message: { updateId, externalThreadId: threadId, externalUserId: fromId, text },
    secretHeader: WEBHOOK_SECRET,
  }
}

async function main() {
  console.log('=== Csatorna összekötés és visszavonás (varrat) ===')

  await test('CL-1 boldog út: érvényes token → kötés + org-megnevezés + értesítés + audit', async () => {
    const h = makeHarness()
    const issued = await h.svc.issueLinkToken({ userId: USER_1, tenantId: TENANT_A })
    assert.equal(issued.ok, true)
    if (!issued.ok) return
    assert.ok(issued.warning.length > 20, 'a figyelmeztetés a döntés hordozója')
    const jti = jtiFromDeepLink(issued.deepLink)

    const res = await h.svc.handleInboundUpdate(startUpdate(1, '900001', jti))
    assert.equal(res.outcome, 'link_established')

    // Kötés jött létre a TOKEN szervezetére (D2), aktív, SZEREPKÖR nélkül.
    const identity = [...h.identityRows.values()][0]
    assert.ok(identity, 'létrejött az identitás')
    assert.equal(identity.tenantId, TENANT_A)
    assert.equal(identity.status, 'active')
    assert.equal((identity as Record<string, unknown>).role, undefined, 'a kötés SZEREPKÖRT nem tárol')
    assert.ok(!('role' in identity), 'a séma sem visz role mezőt a kötésre')

    // Telegram-visszaigazolás MEGNEVEZI a szervezetet.
    assert.equal(h.transport.calls.length, 1)
    assert.equal(h.transport.lastCall!.method, 'sendMessage')
    assert.ok(String(h.transport.lastCall!.payload.text).includes('Alfa Kft.'), 'a visszaigazolás megnevezi a szervezetet')

    // A platform ÉRTESÍTI a felhasználót.
    assert.equal(h.notifications.length, 1)
    assert.equal(h.notifications[0].userId, USER_1)

    // Auditok: token-kiadás + kötés.
    assert.ok(h.audits.some((a) => a.action === 'channel.link.token_issued'))
    const est = h.audits.find((a) => a.action === 'channel.link.established')
    assert.ok(est, 'van channel.link.established audit')
    // Álnevesített azonosító, nyers külső id SOHA.
    assert.ok(typeof est!.metadata.pseudonym === 'string')
    assert.ok(!JSON.stringify(h.audits).includes('900001'), 'a nyers Telegram-id nem kerül auditba')
  })

  await test('CL-2 lejárt token → nincs kötés, érthető elutasító üzenet', async () => {
    const h = makeHarness()
    const issued = await h.svc.issueLinkToken({ userId: USER_1, tenantId: TENANT_A })
    assert.ok(issued.ok)
    const jti = issued.ok ? jtiFromDeepLink(issued.deepLink) : ''
    h.advanceMs(16 * 60 * 1000) // a 15 perces TTL után

    const res = await h.svc.handleInboundUpdate(startUpdate(1, '900002', jti))
    assert.equal(res.outcome, 'link_rejected')
    assert.equal(res.rejectReason, 'expired')
    assert.equal(h.identityRows.size, 0, 'nem jött létre kötés')
    assert.ok(String(h.transport.lastCall!.payload.text).toLowerCase().includes('lejárt'))
    assert.equal(h.notifications.length, 0)
  })

  await test('CL-3 elhasznált token (továbbküldött link, MÁS fiók) → nincs kötés', async () => {
    const h = makeHarness()
    const issued = await h.svc.issueLinkToken({ userId: USER_1, tenantId: TENANT_A })
    const jti = issued.ok ? jtiFromDeepLink(issued.deepLink) : ''
    // Az első fiók bevált (jogos).
    await h.svc.handleInboundUpdate(startUpdate(1, '900003', jti))
    assert.equal(h.identityRows.size, 1)
    // A továbbküldött linkkel egy MÁSIK fiók koppint → elutasítás, nincs második kötés.
    const res = await h.svc.handleInboundUpdate(startUpdate(1, '900999', jti))
    assert.equal(res.outcome, 'link_rejected')
    assert.equal(res.rejectReason, 'already_used')
    assert.equal(h.identityRows.size, 1, 'nem jött létre második kötés')
  })

  await test('CL-4 hamis aláírású token → nincs kötés', async () => {
    const h = makeHarness()
    const issued = await h.svc.issueLinkToken({ userId: USER_1, tenantId: TENANT_A })
    const jti = issued.ok ? jtiFromDeepLink(issued.deepLink) : ''
    // A tárolt aláírás meghamisítása (integritás-sérülés).
    const row = h.tokenRows.get(jti)!
    h.tokenRows.set(jti, { ...row, signature: 'HAMIS-ALÁÍRÁS' })

    const res = await h.svc.handleInboundUpdate(startUpdate(1, '900004', jti))
    assert.equal(res.outcome, 'link_rejected')
    assert.equal(res.rejectReason, 'bad_signature')
    assert.equal(h.identityRows.size, 0)
  })

  await test('CL-5 ismeretlen (kitalált) token → nincs kötés', async () => {
    const h = makeHarness()
    const res = await h.svc.handleInboundUpdate(startUpdate(1, '900005', 'teljesen-kitalalt-jti'))
    assert.equal(res.outcome, 'link_rejected')
    assert.equal(res.rejectReason, 'not_found')
    assert.equal(h.identityRows.size, 0)
  })

  await test('CL-6 kettős koppintás UGYANAZZAL a fiókkal → idempotens siker, nincs dupla értesítés', async () => {
    const h = makeHarness()
    const issued = await h.svc.issueLinkToken({ userId: USER_1, tenantId: TENANT_A })
    const jti = issued.ok ? jtiFromDeepLink(issued.deepLink) : ''
    const r1 = await h.svc.handleInboundUpdate(startUpdate(1, '900006', jti))
    const r2 = await h.svc.handleInboundUpdate(startUpdate(2, '900006', jti))
    assert.equal(r1.outcome, 'link_established')
    assert.equal(r2.outcome, 'link_established')
    assert.equal(h.identityRows.size, 1, 'nincs második kötés')
    assert.equal(h.notifications.length, 1, 'nincs második értesítés (nem hibaüzenet, hanem nyugta)')
    assert.equal(
      h.audits.filter((a) => a.action === 'channel.link.established').length,
      1,
      'nincs második established audit',
    )
  })

  await test('CL-7 visszavonás → azonnal fail-closed (a következő üzenet bekötetlenként kezelődik)', async () => {
    const h = makeHarness()
    const issued = await h.svc.issueLinkToken({ userId: USER_1, tenantId: TENANT_A })
    const jti = issued.ok ? jtiFromDeepLink(issued.deepLink) : ''
    await h.svc.handleInboundUpdate(startUpdate(1, '900007', jti))
    const identity = [...h.identityRows.values()][0]

    const rev = await h.svc.revokeIdentity({ identityId: identity.id, actorUserId: USER_1, scope: 'self' })
    assert.equal(rev.ok, true)
    assert.ok(h.audits.some((a) => a.action === 'channel.identity.revoked' && a.metadata.scope === 'self'))

    // A visszavont fiók következő üzenete → bekötetlen semleges válasz (fail-closed).
    const before = h.transport.calls.length
    const res = await h.svc.handleInboundUpdate(textUpdate(2, '900007', 'szia'))
    assert.equal(res.outcome, 'unlinked_notice_sent')
    assert.equal(h.transport.calls.length, before + 1)
  })

  await test('CL-8 bekötetlen küldő: EGY semleges válasz, utána CSEND ugyanabban a szálban', async () => {
    const h = makeHarness()
    const r1 = await h.svc.handleInboundUpdate(textUpdate(1, '900008', 'helló'))
    assert.equal(r1.outcome, 'unlinked_notice_sent')
    assert.equal(h.transport.calls.length, 1)
    const text = String(h.transport.lastCall!.payload.text)
    // Semleges: se szervezet-, se agent-, se felhasználónév.
    assert.ok(!text.includes('Alfa'), 'nincs szervezetnév a semleges válaszban')

    const r2 = await h.svc.handleInboundUpdate(textUpdate(2, '900008', 'van ott valaki?'))
    assert.equal(r2.outcome, 'unlinked_silenced')
    assert.equal(h.transport.calls.length, 1, 'a második üzenetre CSEND (nincs új kimenő hívás)')
  })

  await test('CL-9 hibás/hiányzó titkos fejléc → nincs feldolgozás, nincs kimenő hívás', async () => {
    const h = makeHarness()
    const bad = { ...textUpdate(1, '900009', 'szia'), secretHeader: 'rossz-fejlec' }
    const res = await h.svc.handleInboundUpdate(bad)
    assert.equal(res.outcome, 'bad_secret')
    assert.equal(h.transport.calls.length, 0)
    assert.equal(h.sessionRows.size, 0, 'nem is jött létre munkamenet')

    const missing = { ...textUpdate(1, '900009', 'szia'), secretHeader: null }
    const res2 = await h.svc.handleInboundUpdate(missing)
    assert.equal(res2.outcome, 'bad_secret')
    assert.equal(h.transport.calls.length, 0)
  })

  await test('CL-10 duplikáció: ugyanaz az update_id kétszer → egy feldolgozás, egy kimenő hívás', async () => {
    const h = makeHarness()
    const u = textUpdate(7, '900010', 'szia')
    const r1 = await h.svc.handleInboundUpdate(u)
    assert.equal(r1.outcome, 'unlinked_notice_sent')
    assert.equal(h.transport.calls.length, 1)
    // Ugyanaz az update_id újraküldve → duplikáció, nincs második kimenő hívás.
    const r2 = await h.svc.handleInboundUpdate(u)
    assert.equal(r2.outcome, 'duplicate')
    assert.equal(h.transport.calls.length, 1)
  })

  await test('CL-11 a szervezet a TOKENBŐL dől el (superadmin „szervezet felvétele" Telegramon nem érvényesül)', async () => {
    const h = makeHarness()
    // A token a TENANT_B-re szól; a bejövő üzenet nem hordozhat szervezetet.
    const issued = await h.svc.issueLinkToken({ userId: USER_1, tenantId: TENANT_B })
    const jti = issued.ok ? jtiFromDeepLink(issued.deepLink) : ''
    await h.svc.handleInboundUpdate(startUpdate(1, '900011', jti))
    const identity = [...h.identityRows.values()][0]
    assert.equal(identity.tenantId, TENANT_B, 'a kötés a token szervezetére szól, nem az üzenetből')
    assert.ok(String(h.transport.lastCall!.payload.text).includes('Beta Zrt.'))
  })

  await test('CL-12 re-link: visszavont kötés újraaktiválható ugyanabban a sorban (nincs duplikátum)', async () => {
    const h = makeHarness()
    const first = await h.svc.issueLinkToken({ userId: USER_1, tenantId: TENANT_A })
    await h.svc.handleInboundUpdate(startUpdate(1, '900012', first.ok ? jtiFromDeepLink(first.deepLink) : ''))
    const identity = [...h.identityRows.values()][0]
    await h.svc.revokeIdentity({ identityId: identity.id, actorUserId: USER_1, scope: 'self' })

    const second = await h.svc.issueLinkToken({ userId: USER_1, tenantId: TENANT_A })
    const res = await h.svc.handleInboundUpdate(startUpdate(2, '900012', second.ok ? jtiFromDeepLink(second.deepLink) : ''))
    assert.equal(res.outcome, 'link_established')
    assert.equal(h.identityRows.size, 1, 'ugyanaz a külső fiók egyetlen sorként él tovább')
    assert.equal([...h.identityRows.values()][0].status, 'active')
  })

  await test('CL-13 nincs regisztrált platform-bot → a token-kiadás és a bejövő út is elzár', async () => {
    const h = makeHarness({ noBot: true })
    const issued = await h.svc.issueLinkToken({ userId: USER_1, tenantId: TENANT_A })
    assert.equal(issued.ok, false)
    const res = await h.svc.handleInboundUpdate(textUpdate(1, '900013', 'szia'))
    assert.equal(res.outcome, 'no_bot')
    assert.equal(h.transport.calls.length, 0)
  })

  await test('CL-14 admin-visszavonás auditja a scope-ot rögzíti', async () => {
    const h = makeHarness()
    const issued = await h.svc.issueLinkToken({ userId: USER_1, tenantId: TENANT_A })
    await h.svc.handleInboundUpdate(startUpdate(1, '900014', issued.ok ? jtiFromDeepLink(issued.deepLink) : ''))
    const identity = [...h.identityRows.values()][0]
    const rev = await h.svc.revokeIdentity({ identityId: identity.id, actorUserId: 'admin-9', scope: 'admin' })
    assert.equal(rev.ok, true)
    const audit = h.audits.find((a) => a.action === 'channel.identity.revoked')!
    assert.equal(audit.metadata.scope, 'admin')
  })

  await test('CL-15 bekötött felhasználó üzenete → TARTÓS forduló-sorba kerül (nem néma, nincs kimenő hívás)', async () => {
    const h = makeHarness()
    const issued = await h.svc.issueLinkToken({ userId: USER_1, tenantId: TENANT_A })
    const jti = issued.ok ? jtiFromDeepLink(issued.deepLink) : ''
    await h.svc.handleInboundUpdate(startUpdate(1, '900015', jti))
    const outboundAfterLink = h.transport.calls.length

    // A bekötött fiók egy sima üzenete → sorba írás (a worker veszi fel), NEM azonnali kimenő hívás.
    const res = await h.svc.handleInboundUpdate(textUpdate(2, '900015', 'kérlek nézd meg a jelentést'))
    assert.equal(res.outcome, 'linked_enqueued')
    assert.ok(res.turnId, 'visszaadja a sorba írt forduló azonosítóját')
    assert.equal(h.turnRows.length, 1, 'pontosan egy forduló került a sorba')
    assert.equal(h.transport.calls.length, outboundAfterLink, 'a sorba írás nem küld azonnali kimenő hívást')

    // A worker-ébresztő NOTIFY elsült, a fordulóra hivatkozva.
    assert.deepEqual(h.enqueuedNotifications, [res.turnId])

    // Audit: a sorba kerülés determinisztikus, álnevesített nyommal — az üzenet TARTALMA nélkül.
    const enq = h.audits.find((a) => a.action === 'channel.turn.enqueued')
    assert.ok(enq, 'van channel.turn.enqueued audit')
    assert.ok(typeof enq!.metadata.pseudonym === 'string')
    assert.ok(!JSON.stringify(h.audits).includes('jelentést'), 'az üzenet tartalma nem kerül auditba')
    assert.ok(!JSON.stringify(h.audits).includes('900015'), 'a nyers Telegram-id nem kerül auditba')
  })

  await test('CL-16 duplikált frissítés a bekötött úton → egy forduló (vízjel)', async () => {
    const h = makeHarness()
    const issued = await h.svc.issueLinkToken({ userId: USER_1, tenantId: TENANT_A })
    const jti = issued.ok ? jtiFromDeepLink(issued.deepLink) : ''
    await h.svc.handleInboundUpdate(startUpdate(1, '900016', jti))

    const u = textUpdate(5, '900016', 'szia')
    const r1 = await h.svc.handleInboundUpdate(u)
    assert.equal(r1.outcome, 'linked_enqueued')
    // Ugyanaz az update_id újraküldve → duplikáció, NINCS második forduló.
    const r2 = await h.svc.handleInboundUpdate(u)
    assert.equal(r2.outcome, 'duplicate')
    assert.equal(h.turnRows.length, 1, 'a duplikált frissítés nem indít második fordulót')
  })

  if (failures > 0) {
    console.error(`\n${failures} teszt BUKOTT.`)
    process.exit(1)
  }
  console.log('\nMinden összekötés/visszavonás varrat-teszt zöld.')
}

void main()
