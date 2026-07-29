/**
 * Csatorna összekötés és visszavonás — a csatorna-szolgáltatás VARRATA (Telegram feature-spec
 * #70/#72, D2/D11/D12/D15).
 *
 * Ez a modul a #72 szelet magja: a webes „Telegram összekötése" gomb tokenjének kiadása, a
 * bejövő webhook ÖSSZEKÖTŐ ága (deep-link `/start <jti>`), a bekötetlen küldő EGYSZERI semleges
 * válasza (utána csend), és a visszavonás (saját + admin) azonnali fail-closeddal.
 *
 * A varrat egyetlen helyen dublőrizhető: minden KIMENŐ hívás a befecskendezett
 * `ChannelOutboundTransport`-on megy (D11 — a bejövő út sem hívja közvetlenül a Telegramot),
 * és minden hatás determinisztikus, ÁLNEVESÍTETT azonosítójú audit-bejegyzést ír (§64).
 * A tesztek három bejáraton hajthatják (itt: bejövő frissítés + web-token-kiadás + visszavonás),
 * és CSAK a rögzített kimenő hívásokat és auditokat nézik.
 *
 * Fontos szerkezeti döntések, amiket a kód kikényszerít:
 *  - A szervezet a TOKENBŐL (kötéskor rögzített), SOSEM az üzenet tartalmából dől el (D2) — így
 *    a superadmin „szervezet felvétele" képesség Telegramon nem érvényesülhet.
 *  - A kötés SZEREPKÖRT nem tárol (a séma sem enged) — a szerepkör minden üzenetnél élőben dől el.
 *  - A webhook titkos fejléc ellenőrzése ITT, a szolgáltatásban van (a fejlécet paraméterként
 *    kapja), konstans idővel — a HTTP-réteg vékony, logikátlan adapter (#70 Testing Decisions).
 */
import type { ChannelBot, ChannelIdentity, ChannelType } from '@prisma/client'
import { safeSecretEquals } from '@/lib/crypto/timing-safe'
import type {
  AuditRepository,
  ChannelBotRepository,
  ChannelIdentityRepository,
  ChannelLinkTokenRepository,
  ChannelOutboundMessageRepository,
  ChannelSessionRepository,
} from '@/repositories/interfaces'
import type { ChannelOutboundTransport } from './channel-outbound-transport'
import {
  CHANNEL_AUDIT_ACTIONS,
  CHANNEL_LINK_NOTIFICATION_KIND,
} from './channel-types'
import {
  defaultChannelLinkTokenPort,
  isValidStartParam,
  type ChannelLinkTokenPort,
} from './channel-link-token'
import {
  defaultChannelIdentityCryptoPort,
  pseudonymFromLookupHash,
  type ChannelIdentityCryptoPort,
} from './channel-identity-crypto'

// ── Felhasználó felé látszó szövegek (D16 / NFR-1: hétköznapi magyar, önmagát magyarázó) ──

/** A webes gomb figyelmeztetése — a döntés hordozója (D12): a beszélgetés a Telegramhoz kerül. */
export const LINK_WARNING_TEXT =
  'Ha összekötöd a Telegram-fiókodat, az itteni beszélgetés tartalma a Telegramhoz kerül és ott is marad. ' +
  'A Telegram külső szolgáltatás, ezt a szöveget nem tudjuk onnan visszavonni. Csak akkor kösd össze, ha ezt vállalod.'

/** A bekötetlen küldő EGYETLEN semleges válasza — szervezet-/agent-/felhasználónév nélkül (D12). */
export const UNLINKED_NEUTRAL_TEXT =
  'Szia! Ez egy belső platform-bot. A használatához előbb össze kell kötnöd a fiókodat a webes felületen. ' +
  'Ha nem tudod, hogyan, kérdezd meg a rendszergazdádat.'

/** Lejárt / elhasznált / hamis aláírású token — érthető, nem szivárgó üzenet (D12). */
export const LINK_REJECTED_TEXT =
  'Ez az összekötő link már lejárt vagy fel lett használva. Kérj egy újat a webes felületen, és nyisd meg frissen.'

function linkEstablishedText(orgName: string | null): string {
  const org = orgName?.trim() ? `„${orgName.trim()}"` : 'a szervezeted'
  return (
    `Sikeres összekötés. Mostantól ${org} nevében írhatsz itt az agenteknek. ` +
    'Az elérhető agenteket a szervezeted rendszergazdája engedélyezi — ha még egyet sem látsz, szólj neki. ' +
    'Emlékeztető: az itteni beszélgetés a Telegramon marad.'
  )
}

// ── Portok / típusok ─────────────────────────────────────────────────────────

/** Platform-oldali értesítő port — az összekötés tényéről (D12 story 3). Perzisztál. */
export interface ChannelLinkNotifier {
  linkEstablished(input: {
    userId: string
    tenantId: string | null
    channelType: ChannelType
    orgName: string | null
    linkedAt: Date
    pseudonym: string
  }): Promise<void>
}

/** A bejövő frissítés provider-független, minimál alakja (Telegram `message`-ből kivonva). */
export type ChannelInboundMessage = {
  updateId: number
  externalThreadId: string
  externalUserId: string
  text: string | null
  /**
   * A tartalom fajtája: `text` = feldolgozható szöveg; `unsupported` = fájl/kép/hang (a bot
   * érthetően megmondja, hogy ezt még nem tudja kezelni, §27). Hiányában a `text` megléte dönt.
   */
  kind?: 'text' | 'unsupported'
}

/**
 * Egy összekötött felhasználó privát üzenetének átadása a chat-futásidőnek (D8). A linking-
 * szolgáltatás a bekötött, nem-`/start` üzenetet ennek a portnak adja át; a valós wiring a
 * `ChannelTurnService.enqueueInbound`-hoz köti (tartós forduló-sor, a worker veszi fel). Ha
 * nincs beállítva (pl. a #72 slice tesztjeiben), a bekötött üzenet `linked_no_runtime` marad.
 */
export interface ChannelLinkedMessageSink {
  enqueueInbound(input: {
    sessionId: string
    identity: ChannelIdentity
    message: {
      updateId: number
      externalThreadId: string
      externalUserId: string
      text: string | null
      kind: 'text' | 'unsupported'
    }
  }): Promise<{ id: string }>
}

export type ChannelLinkingDeps = {
  bots: ChannelBotRepository
  identities: ChannelIdentityRepository
  sessions: ChannelSessionRepository
  linkTokens: ChannelLinkTokenRepository
  /**
   * A sorba írás után hívott, hibatűrő értesítő (Postgres NOTIFY) — a worker azonnal ébred a
   * cron-háló bevárása helyett. Alapból nincs (a cron-söprés így is felveszi a fordulót).
   */
  onTurnEnqueued?: (turnId: string) => Promise<void>
  transport: ChannelOutboundTransport
  audit: Pick<AuditRepository, 'append'>
  notifier: ChannelLinkNotifier
  /**
   * A bot SAJÁT kimenő üzeneteinek nyilvántartása a megőrzési takarításhoz (D4/#78).
   * OPCIONÁLIS: ha meg van adva, minden sikeresen kiment bot-üzenet `providerMessageId`-ja
   * rögzül, hogy a takarító a horizonton törölhesse. Ha nincs megadva, a küldés változatlan.
   */
  outboundLog?: Pick<ChannelOutboundMessageRepository, 'record'>
  /** A kötéskor rögzített szervezet megnevezése a Telegram-visszaigazoláshoz (D2). */
  resolveOrgName: (tenantId: string | null) => Promise<string | null>
  /** A bot webhook titkos fejlécének feloldása (referenciából) — konstans idejű vetéshez. */
  resolveWebhookSecret: (bot: ChannelBot) => Promise<string>
  /** A `jti`-ből deep-link (t.me/<bot>?start=<jti>). */
  buildDeepLink: (jti: string) => string
  /** Bekötött, nem-`/start` üzenet átadása a chat-futásidőnek (D8). Opcionális (#72 back-compat). */
  linkedMessageSink?: ChannelLinkedMessageSink
  /** Szervezeti Telegram-kill-switch. A bekötés és a sorba írás is csak élő csatornán engedett. */
  isChannelEnabled: (tenantId: string | null) => Promise<boolean>
  token?: ChannelLinkTokenPort
  crypto?: ChannelIdentityCryptoPort
  now?: () => Date
}

export type IssueLinkTokenResult =
  | { ok: true; deepLink: string; expiresAt: Date; warning: string }
  | { ok: false; reason: 'no_bot' | 'channel_disabled' }

export type RevokeScope = 'self' | 'admin'
export type RevokeResult =
  | { ok: true; identity: ChannelIdentity }
  | { ok: false; reason: 'not_found' }

/** A bejövő feldolgozás kimenete — a tesztek ezt és a rögzített kimenő hívásokat nézik. */
export type InboundOutcome =
  | 'no_bot'
  | 'bad_secret'
  | 'unsupported_update'
  | 'duplicate'
  | 'channel_disabled'
  | 'linked_no_runtime'
  | 'linked_enqueued'
  | 'unlinked_notice_sent'
  | 'unlinked_silenced'
  | 'link_established'
  | 'link_rejected'

export type HandleInboundResult = {
  handled: boolean
  outcome: InboundOutcome
  /** Az összekötés eredménye — csak `link_established`-nél. */
  identityId?: string
  /** A sorba írt forduló azonosítója — csak `linked_enqueued`-nál (a worker ezt veszi fel). */
  turnId?: string
  /** Az elutasítás oka — csak `link_rejected`-nél (diagnosztika, nem megy ki Telegramra). */
  rejectReason?: 'not_found' | 'bad_signature' | 'expired' | 'already_used'
}

const TELEGRAM: ChannelType = 'telegram'

export class ChannelLinkingService {
  private readonly token: ChannelLinkTokenPort
  private readonly crypto: ChannelIdentityCryptoPort
  private readonly now: () => Date

  constructor(private readonly deps: ChannelLinkingDeps) {
    this.token = deps.token ?? defaultChannelLinkTokenPort
    this.crypto = deps.crypto ?? defaultChannelIdentityCryptoPort
    this.now = deps.now ?? (() => new Date())
  }

  // ── 1. bejárat: web — összekötő token kiadása ───────────────────────────────

  /**
   * A webes „Telegram összekötése" gomb server-action magja. Aláírt, rövid élettartamú,
   * egyszer felhasználható tokent állít elő, amibe bele van kötve a SZERVEZET, a FELHASZNÁLÓ
   * és a LEJÁRAT; visszaadja a deep-linket és a figyelmeztetést (a döntés hordozóját).
   */
  async issueLinkToken(input: {
    userId: string
    tenantId: string | null
    channelType?: ChannelType
  }): Promise<IssueLinkTokenResult> {
    const channelType = input.channelType ?? TELEGRAM
    const bot = await this.deps.bots.findPlatformBot(channelType)
    if (!bot) return { ok: false, reason: 'no_bot' }
    if (bot.status === 'disabled') return { ok: false, reason: 'channel_disabled' }
    if (!(await this.deps.isChannelEnabled(input.tenantId))) {
      return { ok: false, reason: 'channel_disabled' }
    }

    const now = this.now()
    const jti = this.token.newJti()
    const claims = { jti, channelType, userId: input.userId, tenantId: input.tenantId }
    const signature = this.token.sign(claims)
    const expiresAt = new Date(now.getTime() + this.token.ttlMs)

    const row = await this.deps.linkTokens.create({
      channelType,
      jti,
      signature,
      userId: input.userId,
      tenantId: input.tenantId,
      expiresAt,
      createdById: input.userId,
    })

    await this.deps.audit.append({
      actorType: 'human',
      actorId: input.userId,
      agentVersion: null,
      action: CHANNEL_AUDIT_ACTIONS.linkTokenIssued,
      targetType: 'channel_link_token',
      targetId: row.id,
      modelUsed: null,
      inputRef: null,
      outputRef: null,
      policyDecision: 'issued',
      // A `jti` a mélylink capability-titka — SOSEM auditáljuk; csak a lejáratot és a szervezetet.
      metadata: { channelType, tenantId: input.tenantId, expiresAt: expiresAt.toISOString() },
      tenantId: input.tenantId,
    })

    return {
      ok: true,
      deepLink: this.deps.buildDeepLink(jti),
      expiresAt,
      warning: LINK_WARNING_TEXT,
    }
  }

  // ── 2. bejárat: bejövő webhook ──────────────────────────────────────────────

  /**
   * A bejövő frissítés feldolgozása. Az EGYETLEN szinkron kapu a nyugtázás előtt a titkos
   * fejléc konstans idejű ellenőrzése (D15). Duplikáció-védelem munkamenetenkénti vízjellel.
   * Az összekötő ágat, a bekötetlen semleges választ ÉS a bekötött felhasználó üzenetének
   * TARTÓS forduló-sorba írását (#73, D8) kezeli — ez utóbbi a webhook-kérésen túl él, és a
   * worker második munkatípusként veszi fel. Az agent-futás maga későbbi szelet (#74): itt
   * a sorba írás a szállított érték (megbízható, újrapróbálható bejövő út).
   */
  async handleInboundUpdate(input: {
    message: ChannelInboundMessage
    secretHeader: string | null
    channelType?: ChannelType
  }): Promise<HandleInboundResult> {
    const channelType = input.channelType ?? TELEGRAM
    const bot = await this.deps.bots.findPlatformBot(channelType)
    // Nincs bot (vagy kikapcsolt) → nincs mihez ellenőrizni a fejlécet; csendes elutasítás.
    if (!bot || bot.status === 'disabled') {
      return { handled: false, outcome: 'no_bot' }
    }

    // Titkos fejléc — konstans idejű vetés (D15). Eltérés → nincs feldolgozás, nincs kimenő hívás.
    const expectedSecret = await this.deps.resolveWebhookSecret(bot)
    if (!safeSecretEquals(input.secretHeader, expectedSecret)) {
      return { handled: false, outcome: 'bad_secret' }
    }

    const msg = input.message
    if (!msg.externalThreadId || !msg.externalUserId) {
      return { handled: false, outcome: 'unsupported_update' }
    }

    const session =
      (await this.deps.sessions.findByBotAndThread(bot.id, msg.externalThreadId)) ??
      (await this.deps.sessions.create({ botId: bot.id, externalThreadId: msg.externalThreadId }))

    // Duplikáció-védelem: a Telegram monoton növekvő update_id-jához vízjel. A már látott (vagy
    // korábbi) frissítés nem indít második feldolgozást (D15) — nincs kimenő hívás.
    if (session.updateWatermark != null && BigInt(msg.updateId) <= session.updateWatermark) {
      return { handled: false, outcome: 'duplicate' }
    }
    const now = this.now()
    await this.deps.sessions.update(session.id, {
      updateWatermark: BigInt(msg.updateId),
      lastActivityAt: now,
    })

    const lookupHash = this.crypto.deriveLookupHash(channelType, msg.externalUserId)
    const startParam = parseStartParam(msg.text)

    if (startParam) {
      return this.runLinkFlow({
        bot,
        channelType,
        sessionId: session.id,
        lookupHash,
        rawExternalId: msg.externalUserId,
        startParam,
        now,
      })
    }

    // Nincs `/start <token>`: bekötött → chat-futásidő (D8, forduló-sor); bekötetlen → semleges egyszer.
    const identity = await this.deps.identities.findByLookupHash(channelType, lookupHash)
    if (identity && identity.status === 'active') {
      // A kill-switch a sorba írás előtt zár: ne maradjon a leállított szervezet üzenetéből
      // olyan tartós forduló, amit egy későbbi újraengedélyezés véletlenül feldolgozhat.
      if (!(await this.deps.isChannelEnabled(identity.tenantId))) {
        return { handled: true, outcome: 'channel_disabled' }
      }
      if (session.identityId !== identity.id) {
        await this.deps.sessions.update(session.id, { identityId: identity.id })
      }
      if (this.deps.linkedMessageSink) {
        const kind: 'text' | 'unsupported' =
          msg.kind ?? (typeof msg.text === 'string' && msg.text.length > 0 ? 'text' : 'unsupported')
        return this.enqueueLinkedTurn({
          sessionId: session.id,
          identity,
          message: {
            updateId: msg.updateId,
            externalThreadId: msg.externalThreadId,
            externalUserId: msg.externalUserId,
            text: msg.text,
            kind,
          },
        })
      }
      return { handled: true, outcome: 'linked_no_runtime' }
    }

    return this.handleUnlinked({ bot, channelType, sessionId: session.id, lookupHash, now })
  }

  /**
   * A bekötött felhasználó üzenetét a chat-futásidő sink-jén (`ChannelTurnService.enqueueInbound`)
   * TARTÓS forduló-sorba írja (#73/#74, D8). A sor túléli a webhook-kérést; a worker második
   * munkatípusként veszi fel. A `NOTIFY` (ha van) csak gyorsítás — hibája nem buktathatja a
   * sorba írást (a cron-háló akkor is felveszi). Az audit-bejegyzést maga a sink
   * (`ChannelTurnService.enqueueInbound`) írja, hogy egyetlen helyen szülessen.
   */
  private async enqueueLinkedTurn(input: {
    sessionId: string
    identity: ChannelIdentity
    message: {
      updateId: number
      externalThreadId: string
      externalUserId: string
      text: string | null
      kind: 'text' | 'unsupported'
    }
  }): Promise<HandleInboundResult> {
    const turn = await this.deps.linkedMessageSink!.enqueueInbound({
      sessionId: input.sessionId,
      identity: input.identity,
      message: input.message,
    })

    if (this.deps.onTurnEnqueued) {
      // A NOTIFY tisztán gyorsítás — a hibája NEM buktathatja a (már perzisztált) fordulót.
      await this.deps.onTurnEnqueued(turn.id).catch(() => {})
    }

    return { handled: true, outcome: 'linked_enqueued', turnId: turn.id }
  }

  private async handleUnlinked(input: {
    bot: ChannelBot
    channelType: ChannelType
    sessionId: string
    lookupHash: string
    now: Date
  }): Promise<HandleInboundResult> {
    // A semleges választ csak akkor küldjük, ha ebben a szálban még nem ment ki (D12 — egyszer,
    // aztán csend; a spamelő ne kapjon folyamatos „élek" visszajelzést).
    const fresh = await this.deps.sessions.findById(input.sessionId)
    if (fresh?.unlinkedNoticeAt != null) {
      return { handled: true, outcome: 'unlinked_silenced' }
    }

    await this.sendToThread(input.bot, input.channelType, input.sessionId, UNLINKED_NEUTRAL_TEXT, 'unlinked_notice')
    await this.deps.sessions.update(input.sessionId, { unlinkedNoticeAt: input.now })

    await this.deps.audit.append({
      actorType: 'system',
      actorId: null,
      agentVersion: null,
      action: CHANNEL_AUDIT_ACTIONS.unlinkedNotice,
      targetType: 'channel_session',
      targetId: input.sessionId,
      modelUsed: null,
      inputRef: null,
      outputRef: null,
      policyDecision: 'unlinked',
      metadata: { channelType: input.channelType, pseudonym: pseudonymFromLookupHash(input.lookupHash) },
    })
    return { handled: true, outcome: 'unlinked_notice_sent' }
  }

  private async runLinkFlow(input: {
    bot: ChannelBot
    channelType: ChannelType
    sessionId: string
    lookupHash: string
    rawExternalId: string
    startParam: string
    now: Date
  }): Promise<HandleInboundResult> {
    const reject = async (
      reason: NonNullable<HandleInboundResult['rejectReason']>,
    ): Promise<HandleInboundResult> => {
      await this.sendToThread(input.bot, input.channelType, input.sessionId, LINK_REJECTED_TEXT, 'link_rejected')
      await this.deps.audit.append({
        actorType: 'system',
        actorId: null,
        agentVersion: null,
        action: CHANNEL_AUDIT_ACTIONS.linkRejected,
        targetType: 'channel_session',
        targetId: input.sessionId,
        modelUsed: null,
        inputRef: null,
        outputRef: null,
        policyDecision: reason,
        metadata: { channelType: input.channelType, pseudonym: pseudonymFromLookupHash(input.lookupHash) },
      })
      return { handled: true, outcome: 'link_rejected', rejectReason: reason }
    }

    const row = await this.deps.linkTokens.findByJti(input.startParam)
    if (!row || row.channelType !== input.channelType) return reject('not_found')

    const claims = {
      jti: row.jti,
      channelType: row.channelType,
      userId: row.userId,
      tenantId: row.tenantId,
    }
    if (!this.token.verify(claims, row.signature)) return reject('bad_signature')
    if (row.expiresAt.getTime() <= input.now.getTime()) return reject('expired')
    if (!(await this.deps.isChannelEnabled(row.tenantId))) {
      return { handled: true, outcome: 'channel_disabled' }
    }

    if (row.consumedAt != null) {
      // Kettős koppintás UGYANAZZAL a fiókkal → idempotens siker (nem hibaüzenet). Más fiók
      // (továbbküldött link) → elutasítás.
      if (row.consumedByLookupHash === input.lookupHash) {
        return this.finishEstablished(input, row.userId, row.tenantId, { idempotent: true })
      }
      return reject('already_used')
    }

    const consumed = await this.deps.linkTokens.consume(input.startParam, input.lookupHash, input.now)
    if (!consumed) {
      // Verseny: valaki más épp elhasználta. Ha UGYANAZ a fiók nyert, idempotens siker; különben tilt.
      const after = await this.deps.linkTokens.findByJti(input.startParam)
      if (after?.consumedByLookupHash === input.lookupHash) {
        return this.finishEstablished(input, row.userId, row.tenantId, { idempotent: true })
      }
      return reject('already_used')
    }

    return this.finishEstablished(input, row.userId, row.tenantId, { idempotent: false })
  }

  private async finishEstablished(
    input: {
      bot: ChannelBot
      channelType: ChannelType
      sessionId: string
      lookupHash: string
      rawExternalId: string
      now: Date
    },
    userId: string,
    tenantId: string | null,
    opts: { idempotent: boolean },
  ): Promise<HandleInboundResult> {
    // A kötés a TOKEN szervezetére szól (D2) — az üzenet tartalma nem befolyásolja. SZEREPKÖRT
    // nem tárolunk (a séma sem enged).
    const existing = await this.deps.identities.findByLookupHash(input.channelType, input.lookupHash)
    let identity: ChannelIdentity
    if (existing) {
      identity =
        existing.status === 'active' && existing.userId === userId && existing.tenantId === tenantId
          ? existing
          : await this.deps.identities.reactivate(existing.id, { userId, tenantId, linkedAt: input.now })
    } else {
      identity = await this.deps.identities.create({
        channelType: input.channelType,
        externalUserIdEnc: this.crypto.encryptExternalId(input.rawExternalId),
        lookupHash: input.lookupHash,
        tenantId,
        userId,
      })
    }

    await this.deps.sessions.update(input.sessionId, {
      identityId: identity.id,
      unlinkedNoticeAt: null,
    })

    const orgName = await this.deps.resolveOrgName(tenantId)
    await this.sendToThread(input.bot, input.channelType, input.sessionId, linkEstablishedText(orgName), 'link_established')

    // A kettős-koppintás idempotens ága NEM ír új értesítést és NEM ismétli az audit-established-et
    // — a kötés már megvolt, csak a visszaigazolást küldjük újra.
    if (!opts.idempotent) {
      await this.deps.notifier.linkEstablished({
        userId,
        tenantId,
        channelType: input.channelType,
        orgName,
        linkedAt: input.now,
        pseudonym: pseudonymFromLookupHash(input.lookupHash),
      })
      await this.deps.audit.append({
        actorType: 'human',
        actorId: userId,
        agentVersion: null,
        action: CHANNEL_AUDIT_ACTIONS.linkEstablished,
        targetType: 'channel_identity',
        targetId: identity.id,
        modelUsed: null,
        inputRef: null,
        outputRef: null,
        policyDecision: 'active',
        metadata: {
          channelType: input.channelType,
          tenantId,
          orgName,
          pseudonym: pseudonymFromLookupHash(input.lookupHash),
          notificationKind: CHANNEL_LINK_NOTIFICATION_KIND,
        },
        tenantId,
      })
    }

    return { handled: true, outcome: 'link_established', identityId: identity.id }
  }

  private async sendToThread(
    bot: ChannelBot,
    channelType: ChannelType,
    sessionId: string,
    text: string,
    kind: string,
  ): Promise<void> {
    const session = await this.deps.sessions.findById(sessionId)
    if (!session) return
    const result = await this.deps.transport.send({
      channelType,
      method: 'sendMessage',
      payload: { chat_id: session.externalThreadId, text },
    })
    // A bot SAJÁT kimenő üzenetének rögzítése a megőrzési takarításhoz (D4/#78). Csak sikeres,
    // provider-azonosítóval bíró küldést tartunk nyilván — azt lehet később törölni.
    if (result.ok && result.providerMessageId && this.deps.outboundLog) {
      await this.deps.outboundLog.record({
        sessionId: session.id,
        channelType,
        externalThreadId: session.externalThreadId,
        providerMessageId: result.providerMessageId,
        kind,
        sentAt: this.now(),
      })
    }
  }

  // ── 3. bejárat: visszavonás (saját + admin) ─────────────────────────────────

  /**
   * A kötés visszavonása — azonnal fail-closed (a következő bejövő üzenet már bekötetlenként
   * kezelődik, mert a kötés státusza `revoked`). Az AUTORIZÁCIÓ a hívó (server action) dolga;
   * a szolgáltatás a `scope`-ot és az aktort auditálja.
   */
  async revokeIdentity(input: {
    identityId: string
    actorUserId: string
    scope: RevokeScope
  }): Promise<RevokeResult> {
    const identity = await this.deps.identities.findById(input.identityId)
    if (!identity) return { ok: false, reason: 'not_found' }

    const revoked = await this.deps.identities.updateStatus(identity.id, 'revoked')

    await this.deps.audit.append({
      actorType: 'human',
      actorId: input.actorUserId,
      agentVersion: null,
      action: CHANNEL_AUDIT_ACTIONS.identityRevoked,
      targetType: 'channel_identity',
      targetId: identity.id,
      modelUsed: null,
      inputRef: null,
      outputRef: null,
      policyDecision: 'revoked',
      metadata: {
        channelType: identity.channelType,
        scope: input.scope,
        tenantId: identity.tenantId,
        pseudonym: pseudonymFromLookupHash(identity.lookupHash),
      },
      tenantId: identity.tenantId,
    })
    return { ok: true, identity: revoked }
  }

  /** Profil-nézet: egy felhasználó csatorna-kötései (a nyers külső id SOHA nem szerepel). */
  async listUserIdentities(userId: string): Promise<ChannelIdentity[]> {
    return this.deps.identities.listByUser(userId)
  }
}

/** `/start <param>` kivonat a szövegből — csak érvényes formátumú (D15) start-paramot enged. */
function parseStartParam(text: string | null): string | null {
  if (!text) return null
  const trimmed = text.trim()
  if (!trimmed.startsWith('/start')) return null
  const rest = trimmed.slice('/start'.length).trim()
  if (!rest) return null
  // A `/start@botname param` alak első tokenje a parancs maradéka lehet; a start-param az utolsó
  // whitespace-tagolt token.
  const param = rest.split(/\s+/).pop() ?? ''
  return isValidStartParam(param) ? param : null
}
