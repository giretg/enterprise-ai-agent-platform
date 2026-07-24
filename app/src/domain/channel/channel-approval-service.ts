/**
 * Eseményvezérelt jóváhagyás Telegram-gombokkal — a csatorna-szolgáltatás NEGYEDIK bejárata
 * (Telegram feature-spec #70/#76, D5/D6/D11/D14).
 *
 * A csatornának eddig három bejárata volt: (1) bejövő üzenet, (2) proaktív Monitor-értesítés,
 * (3) összekötés/visszavonás. Ez a modul a NEGYEDIK: a ticket-állapotgép `awaiting_human`
 * ESEMÉNYE (a state-machine NEM hív közvetlenül Telegramot — csak eseményt jelez, l.
 * `AwaitingHumanEventSink`), amire a felelős / jóváhagyói kör AZONNAL jogosultság-tudatos
 * gombokat kap. A gomb koppintása a NEGYEDIK bejárat másik fele: a webhook `callback_query`-je.
 *
 * A varrat elve változatlan (#70): minden KIMENŐ hívás az EGYETLEN befecskendezett
 * `ChannelOutboundTransport`-on megy (D11 — a state-machine sem hívhatja közvetlenül a
 * Telegramot), és minden hatás determinisztikus, ÁLNEVESÍTETT azonosítójú audit-bejegyzést ír
 * (§64). A tesztek a bejáratot a rögzített kimenő hívásokon és auditokon mérik — a
 * jogosultság-forrás, a ticket-olvasó, a token-port és a tárak BEFECSKENDEZETT dublőrök.
 *
 * A védelmi rend (a #76 acceptance kapui), amit a kód KÜLÖN-KÜLÖN kikényszerít:
 *  - Jogosultság-tudatos gombok: CSAK az a döntés jelenik meg, amire a címzett jogosult; a
 *    kezdeményező NEM kap „Jóváhagyás" gombot (saját kérés jóváhagyása tiltott); a `needs_info`
 *    nem egy-koppintásos, ezért SOHA nincs gombja.
 *  - Aláírt, a konkrét jóváhagyáshoz + címzetthez kötött, EGYSZER-használatos gomb-payload; a
 *    visszajátszás (ismeretlen/hamis payload) és a más fiók koppintása elutasítva.
 *  - Koppintáskor ÉLŐ jogosultság-ellenőrzés: visszavont jog / inaktív kötés → érthető elutasítás.
 *  - Kettős koppintás: a második (ugyanaz a fiók, ugyanaz a döntés) NYUGTÁZÁS (nem ijesztő hiba),
 *    nincs kettős hatás; más fiók / más döntés a döntés után → „már eldöntötte valaki" tájékoztatás.
 *  - Boldog út: a döntés a KÖZÖS ticket-állapotgépet lépteti (befecskendezett `ApprovalTransitioner`);
 *    utána a gombok eltűnnek, a döntés látszik, és a kezdeményező értesül.
 *
 * A négyórás elakadás-figyelő biztonsági hálóként FÜGGETLENÜL megmarad — ez a bejárat csak
 * felgyorsítja a jóváhagyást, nem váltja ki a hálót.
 */
import type { ChannelIdentity, ChannelType } from '@prisma/client'
import { safeSecretEquals } from '@/lib/crypto/timing-safe'
import type {
  AuditRepository,
  ChannelApprovalPromptRepository,
  ChannelBotRepository,
  ChannelIdentityRepository,
} from '@/repositories/interfaces'
import type { ChannelBot } from '@prisma/client'
import type { ChannelOutboundTransport } from './channel-outbound-transport'
import { CHANNEL_AUDIT_ACTIONS } from './channel-types'
import {
  deriveChannelLookupHash,
  decryptExternalId,
  pseudonymFromLookupHash,
} from './channel-identity-crypto'
import {
  defaultChannelApprovalTokenPort,
  type ApprovalAction,
  type ChannelApprovalTokenPort,
} from './channel-approval-token'

const TELEGRAM: ChannelType = 'telegram'

// ── Felhasználó felé látszó szövegek (D16 / NFR-1: hétköznapi magyar, önmagát magyarázó) ──

/** A gombüzenet fejléce a döntéshez — a részletek a webes felületen (a Telegram nem hiteles tár). */
export function approvalPromptText(title: string, detailUrl: string | null): string {
  const lines = [`🔔 Jóváhagyásra vár: ${title}`, 'Koppints a döntésedre — a részleteket a webes felületen látod.']
  if (detailUrl) lines.push(`Részletek: ${detailUrl}`)
  return lines.join('\n')
}

/** A gombok felirata. */
export const APPROVE_BUTTON_LABEL = '✅ Jóváhagyom'
export const REJECT_BUTTON_LABEL = '🚫 Elutasítom'

/** Visszajátszás / ismeretlen vagy hamis payload — nem szivárgó, érthető üzenet. */
export const REPLAY_TEXT =
  'Ez a jóváhagyó gomb már nem érvényes. Nyisd meg a legfrissebb értesítést, vagy dönts a webes felületen.'

/** A gomb nem ehhez a fiókhoz szól (továbbküldött üzenet) / nincs kötés. */
export const NOT_RECIPIENT_TEXT =
  'Ez a jóváhagyás nem hozzád szól. Ha úgy gondolod, hogy neked kellene döntened, szólj a rendszergazdádnak.'

/** Inaktív / visszavont kötés vagy visszavont jogosultság — érthető elutasítás. */
export const REVOKED_TEXT =
  'Már nincs jogosultságod ehhez a jóváhagyáshoz. Ha ez tévedés, szólj a rendszergazdádnak.'

/** Saját kérés jóváhagyása tiltott. */
export const SELF_REQUEST_TEXT =
  'A saját kérésedet nem hagyhatod jóvá. Kérj meg egy másik jogosult kollégát a döntésre.'

/** Már eldöntötte valaki (más fiók / a weben / superseded). */
export const ALREADY_DECIDED_TEXT =
  'Ezt a kérést időközben eldöntötték. Nincs teendőd.'

/** Kettős koppintás ugyanazzal a fiókkal, ugyanarra a döntésre — NYUGTÁZÁS, nem hiba. */
export const ACKNOWLEDGED_TEXT =
  'Ezt már rögzítettem tőled — nincs kettős hatás, minden rendben.'

/** A közös állapotgép elutasította a döntést (verseny / policy) — fail-closed, a webre irányít. */
export const TRANSITION_DENIED_TEXT =
  'A döntést most nem tudtam rögzíteni. Nézd meg a kérést a webes felületen, ott véglegesítheted.'

/** A döntés visszaigazolása a koppintás után. */
export function decisionConfirmedText(action: ApprovalAction): string {
  return action === 'approve' ? 'Köszönöm, rögzítettem: Jóváhagyva.' : 'Köszönöm, rögzítettem: Elutasítva.'
}

/** A gombüzenet ÚJ szövege a döntés után (a gombok eltűnnek, a döntés látszik). */
export function decidedMessageText(title: string, action: ApprovalAction, deciderNote: string): string {
  const verb = action === 'approve' ? '✅ Jóváhagyva' : '🚫 Elutasítva'
  return `${verb} — ${title}\n${deciderNote}`
}

// ── Portok / típusok ─────────────────────────────────────────────────────────

/**
 * A ticket-olvasó a jóváhagyó-kontextushoz. A csatorna nem ismeri a Playbook-runtime részleteit —
 * csak azt kérdezi meg, mi a ticket állapota, melyik kapu zárja, milyen szerepkör kell hozzá, ki a
 * kezdeményező / felelős, és MELY döntések választhatók (a `needs_info` SOHA nem gomb).
 */
export interface ApprovalTicketReader {
  load(input: { ticketId: string; tenantId: string | null }): Promise<ApprovalTicketView | null>
}

export type ApprovalTicketView = {
  ticketId: string
  tenantId: string | null
  /** A ticket állapota — csak `awaiting_human`-ra megy ki gomb, más állapot már eldöntött. */
  state: string
  gateId: string | null
  stepId: string | null
  /** A kapu kért jóváhagyói szerepköre (ha van) — a jogosultság-tudatos gombokhoz. */
  requiredActorRole: string | null
  /** A kezdeményező — a „saját kérés jóváhagyása tiltott" ellenőrzéshez. */
  initiatorUserId: string | null
  /** A felelős (ticket-hozzárendelt ember, ha van) — ő kap elsőként értesítést. */
  assigneeUserId: string | null
  title: string
  /** A webes részletek linkje (opcionális) — a gombüzenetben megy ki. */
  detailUrl: string | null
  /** A választható egy-koppintásos döntések (az `approve`/`reject` részhalmaza; `needs_info` KIZÁRVA). */
  allowedActions: ApprovalAction[]
}

/** A jóváhagyói kör és az ÉLŐ jogosultság forrása (a platform IAM-je mögé injektálva). */
export interface ApprovalRecipientDirectory {
  /** A jóváhagyói kör: a szervezetben az adott szerepkörrel bíró felhasználók. */
  listApprovers(input: {
    tenantId: string | null
    requiredActorRole: string | null
  }): Promise<ApprovalRecipient[]>
  /** Egy felhasználó ÉLŐ szerepkörei a szervezetben (a koppintáskori újraellenőrzéshez). */
  rolesForUser(input: { userId: string; tenantId: string | null }): Promise<string[]>
}

export type ApprovalRecipient = { userId: string; roles: string[] }

/** A KÖZÖS ticket-állapotgép léptetője (befecskendezve — a `TicketStateMachine` köré). */
export interface ApprovalTransitioner {
  decide(input: {
    ticketId: string
    tenantId: string | null
    toState: 'approved' | 'rejected'
    actorUserId: string
    roles: string[]
    gateId: string | null
  }): Promise<ApprovalTransitionResult>
}

export type ApprovalTransitionResult = { ok: true } | { ok: false; reason: string }

/** A kezdeményező értesítése a döntésről (best-effort — a döntést az audit már rögzítette). */
export interface ApprovalInitiatorNotifier {
  decisionMade(input: {
    initiatorUserId: string
    tenantId: string | null
    ticketId: string
    decision: ApprovalAction
    title: string
    deciderPseudonym: string
  }): Promise<void>
}

/** Az injektálható kripto — a lookup-hash származtatás és a kimenő chat_id feloldás (teszt felülírja). */
export type ChannelApprovalCryptoPort = {
  deriveLookupHash: (channelType: string, rawExternalId: string) => string
  decryptExternalId: (enc: string) => string
}

const defaultCrypto: ChannelApprovalCryptoPort = {
  deriveLookupHash: deriveChannelLookupHash,
  decryptExternalId,
}

export type ChannelApprovalDeps = {
  bots: Pick<ChannelBotRepository, 'findPlatformBot'>
  identities: Pick<ChannelIdentityRepository, 'findByLookupHash' | 'findById' | 'listByUser' | 'updateStatus'>
  prompts: ChannelApprovalPromptRepository
  tickets: ApprovalTicketReader
  recipients: ApprovalRecipientDirectory
  transitioner: ApprovalTransitioner
  transport: ChannelOutboundTransport
  audit: Pick<AuditRepository, 'append'>
  /** A webhook titkos fejlécének feloldása (referenciából) — konstans idejű vetéshez. */
  resolveWebhookSecret: (bot: ChannelBot) => Promise<string>
  /** Best-effort értesítő a kezdeményezőnek. Opcionális. */
  initiatorNotifier?: ApprovalInitiatorNotifier
  token?: ChannelApprovalTokenPort
  crypto?: ChannelApprovalCryptoPort
  now?: () => Date
}

export type NotifyAwaitingHumanInput = {
  ticketId: string
  tenantId: string | null
  channelType?: ChannelType
}

export type NotifyAwaitingHumanOutcome =
  | 'notified'
  | 'skipped_not_awaiting'
  | 'no_recipients'
  | 'no_bot'
  | 'channel_disabled'

export type NotifyAwaitingHumanResult = {
  outcome: NotifyAwaitingHumanOutcome
  /** Hány címzettnek ment ki (jogosultság-tudatos) gombüzenet. */
  notified: number
}

export type HandleApprovalCallbackInput = {
  channelType?: ChannelType
  secretHeader: string | null
  externalUserId: string
  externalThreadId: string
  callbackQueryId: string
  callbackData: string | null
  /** A gombot hordozó üzenet provider-azonosítója (a döntés utáni szerkesztéshez). */
  messageId: string | number | null
}

export type ApprovalCallbackOutcome =
  | 'no_bot'
  | 'channel_disabled'
  | 'bad_secret'
  | 'ignored'
  | 'replay'
  | 'unauthorized'
  | 'already_decided'
  | 'acknowledged'
  | 'transition_denied'
  | 'approved'
  | 'rejected'

export type HandleApprovalCallbackResult = { outcome: ApprovalCallbackOutcome }

export class ChannelApprovalService {
  private readonly token: ChannelApprovalTokenPort
  private readonly crypto: ChannelApprovalCryptoPort
  private readonly now: () => Date

  constructor(private readonly deps: ChannelApprovalDeps) {
    this.token = deps.token ?? defaultChannelApprovalTokenPort
    this.crypto = deps.crypto ?? defaultCrypto
    this.now = deps.now ?? (() => new Date())
  }

  // ── Bejárat A: esemény → azonnali, jogosultság-tudatos gombok ────────────────

  /**
   * A ticket-állapotgép `awaiting_human` eseményére: azonnali gombüzenet a felelősnek (ha van),
   * különben a jóváhagyói körnek. CSAK az a döntés jelenik meg gombként, amire a címzett
   * ténylegesen jogosult; a `needs_info` sosem gomb, és a kezdeményező nem kap „Jóváhagyom"-ot.
   * Sosem dob — a hívó (state-machine) egyetlen ágon sem bukhat el emiatt.
   */
  async notifyAwaitingHuman(input: NotifyAwaitingHumanInput): Promise<NotifyAwaitingHumanResult> {
    const channelType = input.channelType ?? TELEGRAM

    const bot = await this.deps.bots.findPlatformBot(channelType)
    if (!bot) return { outcome: 'no_bot', notified: 0 }
    if (bot.status === 'disabled') return { outcome: 'channel_disabled', notified: 0 }

    const ticket = await this.deps.tickets.load({ ticketId: input.ticketId, tenantId: input.tenantId })
    // Csak AKTUÁLISAN emberi jóváhagyásra váró ticketre megy ki gomb — a köztes eldöntött állapot
    // (pl. a weben már döntöttek) nem termel új gombot.
    if (!ticket || ticket.state !== 'awaiting_human') {
      return { outcome: 'skipped_not_awaiting', notified: 0 }
    }
    // A `needs_info` szerkezetileg kizárt: csak az `approve`/`reject` az egy-koppintásos döntés.
    const decisionActions = ticket.allowedActions.filter((a) => a === 'approve' || a === 'reject')
    if (decisionActions.length === 0) return { outcome: 'no_recipients', notified: 0 }

    const recipients = await this.resolveRecipients(ticket)
    let notified = 0
    for (const recipient of recipients) {
      const identity = await this.findActiveIdentity(recipient.userId, ticket.tenantId, channelType)
      if (!identity) continue // nem elérhető ezen a csatornán → nincs küldés (fail-closed)

      // Jogosultság-tudatos gombok: csak amire a címzett jogosult.
      const offered = decisionActions.filter((action) =>
        this.mayOffer(action, recipient.roles, ticket.requiredActorRole, recipient.userId, ticket.initiatorUserId),
      )
      if (offered.length === 0) continue // nincs jogosult döntése → nem küldünk gombot

      const sent = await this.sendPrompt({ ticket, identity, channelType, offered })
      if (sent) notified++
    }

    return { outcome: notified > 0 ? 'notified' : 'no_recipients', notified }
  }

  /** A címzettek: a felelős (ha van, ő az egyetlen), különben a jóváhagyói kör. */
  private async resolveRecipients(ticket: ApprovalTicketView): Promise<ApprovalRecipient[]> {
    if (ticket.assigneeUserId) {
      const roles = await this.deps.recipients.rolesForUser({
        userId: ticket.assigneeUserId,
        tenantId: ticket.tenantId,
      })
      return [{ userId: ticket.assigneeUserId, roles }]
    }
    return this.deps.recipients.listApprovers({
      tenantId: ticket.tenantId,
      requiredActorRole: ticket.requiredActorRole,
    })
  }

  /** Egy döntés MEGJELENÍTHETŐ-e a címzettnek: szerepkör-egyezés + „saját kérés jóváhagyása tiltott". */
  private mayOffer(
    action: ApprovalAction,
    roles: string[],
    requiredActorRole: string | null,
    recipientUserId: string,
    initiatorUserId: string | null,
  ): boolean {
    if (requiredActorRole && !roles.includes(requiredActorRole)) return false
    if (action === 'approve' && initiatorUserId && recipientUserId === initiatorUserId) return false
    return true
  }

  private async findActiveIdentity(
    userId: string,
    tenantId: string | null,
    channelType: ChannelType,
  ): Promise<ChannelIdentity | null> {
    const identities = await this.deps.identities.listByUser(userId)
    return (
      identities.find(
        (i) => i.channelType === channelType && i.status === 'active' && i.tenantId === tenantId,
      ) ?? null
    )
  }

  /** Egy címzettnek kiküldi a jogosultság-tudatos gombüzenetet + rögzíti a kötést és auditál. */
  private async sendPrompt(input: {
    ticket: ApprovalTicketView
    identity: ChannelIdentity
    channelType: ChannelType
    offered: ApprovalAction[]
  }): Promise<boolean> {
    const { ticket, identity, channelType, offered } = input
    const promptId = this.token.newPromptId()

    const prompt = await this.deps.prompts.create({
      promptId,
      channelType,
      ticketId: ticket.ticketId,
      tenantId: ticket.tenantId,
      gateId: ticket.gateId,
      stepId: ticket.stepId,
      requiredActorRole: ticket.requiredActorRole,
      recipientIdentityId: identity.id,
      recipientUserId: identity.userId,
      initiatorUserId: ticket.initiatorUserId,
      allowedActions: offered,
      externalThreadId: this.chatId(identity),
    })

    const inlineKeyboard = offered.map((action) => [
      {
        text: action === 'approve' ? APPROVE_BUTTON_LABEL : REJECT_BUTTON_LABEL,
        callback_data: this.token.buildCallbackData({
          promptId,
          action,
          ticketId: ticket.ticketId,
          gateId: ticket.gateId,
          recipientIdentityId: identity.id,
        }),
      },
    ])

    const result = await this.deps.transport.send({
      channelType,
      method: 'sendMessage',
      payload: {
        chat_id: this.chatId(identity),
        text: approvalPromptText(ticket.title, ticket.detailUrl),
        reply_markup: { inline_keyboard: inlineKeyboard },
      },
    })

    if (!result.ok) {
      // Bot-letiltás → a kötés jelölődik (D15); más hiba best-effort (a state-machine nem bukik el).
      if (result.reason === 'blocked_by_user') {
        await this.deps.identities.updateStatus(identity.id, 'blocked')
      }
      await this.auditApproval(CHANNEL_AUDIT_ACTIONS.approvalNotified, 'not_sent', ticket, identity, {
        reason: result.reason,
        actions: offered,
      })
      return false
    }

    if (result.providerMessageId) {
      // A provider-azonosító a prompt soron marad — a döntéskor ebből (vagy a callback message_id-ből)
      // tüntetjük el a gombokat. (A megőrzési takarítás munkamenet-alapú, ezért ide nem írunk.)
      await this.deps.prompts.setProviderMessageId(prompt.id, result.providerMessageId)
    }

    await this.auditApproval(CHANNEL_AUDIT_ACTIONS.approvalNotified, 'sent', ticket, identity, {
      actions: offered,
      providerMessageId: result.providerMessageId ?? null,
    })
    return true
  }

  // ── Bejárat B: gomb-koppintás (callback_query) ──────────────────────────────

  /**
   * A gomb koppintásának feldolgozása: aláírás- és kötés-ellenőrzés, ÉLŐ jogosultság, saját-kérés
   * kapu, kettős-koppintás nyugtázás, majd a KÖZÖS állapotgép léptetése. Sosem dob — a webhook
   * mindig gyorsan nyugtáz.
   */
  async handleApprovalCallback(input: HandleApprovalCallbackInput): Promise<HandleApprovalCallbackResult> {
    const channelType = input.channelType ?? TELEGRAM

    const bot = await this.deps.bots.findPlatformBot(channelType)
    if (!bot || bot.status === 'disabled') {
      return { outcome: !bot ? 'no_bot' : 'channel_disabled' }
    }
    // Titkos fejléc — konstans idejű vetés (D15). Eltérés → csendes elutasítás, nincs kimenő hívás.
    const expectedSecret = await this.deps.resolveWebhookSecret(bot)
    if (!safeSecretEquals(input.secretHeader, expectedSecret)) {
      return { outcome: 'bad_secret' }
    }

    const parsed = this.token.parseCallbackData(input.callbackData)
    if (!parsed) {
      await this.answerCallback(channelType, input.callbackQueryId, REPLAY_TEXT)
      return { outcome: 'ignored' }
    }

    const prompt = await this.deps.prompts.findByPromptId(parsed.promptId)
    if (!prompt) {
      // Ismeretlen payload → visszajátszás / lejárt gomb. Nincs mit szerkeszteni.
      await this.answerCallback(channelType, input.callbackQueryId, REPLAY_TEXT)
      await this.auditReject(channelType, 'not_found', null, null, { promptId: parsed.promptId })
      return { outcome: 'replay' }
    }

    // Aláírás a sorból ismert KÖTÖTT mezők felett (hamisítás-detektálás, konstans idejű vetés).
    const signatureValid = this.token.verify(
      {
        promptId: prompt.promptId,
        action: parsed.action,
        ticketId: prompt.ticketId,
        gateId: prompt.gateId,
        recipientIdentityId: prompt.recipientIdentityId,
      },
      parsed.signature,
    )
    if (!signatureValid) {
      await this.answerCallback(channelType, input.callbackQueryId, REPLAY_TEXT)
      await this.auditReject(channelType, 'bad_signature', prompt.ticketId, null, { promptId: prompt.promptId })
      return { outcome: 'replay' }
    }

    // A koppintó ÉLŐ kötése — a gomb a KONKRÉT címzetthez van kötve (más fiók nem váltja be).
    const lookupHash = this.crypto.deriveLookupHash(channelType, input.externalUserId)
    const tapper = await this.deps.identities.findByLookupHash(channelType, lookupHash)
    if (!tapper || tapper.id !== prompt.recipientIdentityId) {
      await this.answerCallback(channelType, input.callbackQueryId, NOT_RECIPIENT_TEXT)
      await this.auditReject(channelType, 'not_recipient', prompt.ticketId, lookupHash, {})
      return { outcome: 'unauthorized' }
    }
    if (tapper.status !== 'active' || tapper.tenantId !== prompt.tenantId) {
      await this.answerCallback(channelType, input.callbackQueryId, REVOKED_TEXT)
      await this.auditReject(channelType, 'identity_inactive', prompt.ticketId, lookupHash, {})
      return { outcome: 'unauthorized' }
    }

    // A döntésnek a KIAJÁNLOTT halmazban kell lennie (a `needs_info` sosem jut ide).
    if (!prompt.allowedActions.includes(parsed.action)) {
      await this.answerCallback(channelType, input.callbackQueryId, NOT_RECIPIENT_TEXT)
      await this.auditReject(channelType, 'action_not_allowed', prompt.ticketId, lookupHash, {})
      return { outcome: 'unauthorized' }
    }

    // ÉLŐ jogosultság-ellenőrzés (D6): visszavont jog → érthető elutasítás.
    const roles = await this.deps.recipients.rolesForUser({
      userId: tapper.userId,
      tenantId: prompt.tenantId,
    })
    if (prompt.requiredActorRole && !roles.includes(prompt.requiredActorRole)) {
      await this.answerCallback(channelType, input.callbackQueryId, REVOKED_TEXT)
      await this.auditReject(channelType, 'role_revoked', prompt.ticketId, lookupHash, {})
      return { outcome: 'unauthorized' }
    }

    // Saját kérés jóváhagyása tiltott (élő újraellenőrzés a gomb-szűrésen túl is).
    if (parsed.action === 'approve' && prompt.initiatorUserId && tapper.userId === prompt.initiatorUserId) {
      await this.answerCallback(channelType, input.callbackQueryId, SELF_REQUEST_TEXT)
      await this.auditReject(channelType, 'self_request', prompt.ticketId, lookupHash, {})
      return { outcome: 'unauthorized' }
    }

    // Már eldöntött? (Más úton — pl. a weben — vagy egy korábbi koppintás.)
    const alreadyDecided = await this.handleAlreadyDecided(input, channelType, prompt, parsed.action, lookupHash)
    if (alreadyDecided) return alreadyDecided

    // Atomi EGYSZER-használat: csak a NYERTES billent `pending`→`decided`.
    const consumed = await this.deps.prompts.consume(parsed.promptId, parsed.action, lookupHash, this.now())
    if (!consumed) {
      // Verseny: valaki (talán ugyanez a fiók) épp elhasználta a check és a consume között.
      const after = await this.deps.prompts.findByPromptId(parsed.promptId)
      return (
        (await this.doubleTapOrAlreadyDecided(input, channelType, after, parsed.action, lookupHash)) ?? {
          outcome: 'already_decided',
        }
      )
    }

    // A KÖZÖS ticket-állapotgép léptetése (a boldog út magja).
    const toState = parsed.action === 'approve' ? 'approved' : 'rejected'
    const transition = await this.deps.transitioner.decide({
      ticketId: prompt.ticketId,
      tenantId: prompt.tenantId,
      toState,
      actorUserId: tapper.userId,
      roles,
      gateId: prompt.gateId,
    })

    if (!transition.ok) {
      // A közös gép elutasította (verseny / policy) — fail-closed. A gombokat eltüntetjük, a
      // döntést az audit rögzíti, a felhasználót a webre irányítjuk.
      await this.editToDecided(channelType, input, prompt.externalThreadId, ticketTitleFallback(), parsed.action, TRANSITION_DENIED_TEXT)
      await this.answerCallback(channelType, input.callbackQueryId, TRANSITION_DENIED_TEXT)
      await this.auditReject(channelType, 'transition_denied', prompt.ticketId, lookupHash, {
        detail: transition.reason,
      })
      return { outcome: 'transition_denied' }
    }

    // Siker: a többi címzett gombja érvénytelenné válik; a gombok eltűnnek, a döntés látszik.
    await this.deps.prompts.supersedeOthers(prompt.ticketId, prompt.promptId)
    const ticket = await this.deps.tickets.load({ ticketId: prompt.ticketId, tenantId: prompt.tenantId })
    const title = ticket?.title ?? ticketTitleFallback()
    await this.editToDecided(
      channelType,
      input,
      prompt.externalThreadId,
      title,
      parsed.action,
      decisionConfirmedText(parsed.action),
    )
    await this.answerCallback(channelType, input.callbackQueryId, decisionConfirmedText(parsed.action))

    // A kezdeményező értesül a döntésről (best-effort).
    if (this.deps.initiatorNotifier && prompt.initiatorUserId) {
      try {
        await this.deps.initiatorNotifier.decisionMade({
          initiatorUserId: prompt.initiatorUserId,
          tenantId: prompt.tenantId,
          ticketId: prompt.ticketId,
          decision: parsed.action,
          title,
          deciderPseudonym: pseudonymFromLookupHash(lookupHash),
        })
      } catch {
        // best-effort: a döntést az audit már rögzítette.
      }
    }

    await this.auditApprovalDecided(channelType, prompt, parsed.action, lookupHash)
    return { outcome: parsed.action === 'approve' ? 'approved' : 'rejected' }
  }

  /**
   * A már-eldöntött / kettős-koppintás ág a consume ELŐTT (a `status` alapján). Visszaad egy
   * eredményt, ha a kérés már nem `pending`; különben `null` (mehet tovább a consume).
   */
  private async handleAlreadyDecided(
    input: HandleApprovalCallbackInput,
    channelType: ChannelType,
    prompt: { status: string; decidedByLookupHash: string | null; decidedAction: string | null; ticketId: string; externalThreadId: string; tenantId: string | null },
    action: ApprovalAction,
    lookupHash: string,
  ): Promise<HandleApprovalCallbackResult | null> {
    if (prompt.status === 'pending') return null
    return this.doubleTapOrAlreadyDecided(input, channelType, prompt, action, lookupHash)
  }

  /**
   * Egy már nem `pending` prompt koppintására: ha UGYANAZ a fiók UGYANARRA a döntésre koppintott,
   * az NYUGTÁZÁS (nem hiba, nincs kettős hatás); egyébként „már eldöntötte valaki" tájékoztatás.
   */
  private async doubleTapOrAlreadyDecided(
    input: HandleApprovalCallbackInput,
    channelType: ChannelType,
    prompt:
      | { status: string; decidedByLookupHash: string | null; decidedAction: string | null; ticketId: string }
      | null,
    action: ApprovalAction,
    lookupHash: string,
  ): Promise<HandleApprovalCallbackResult | null> {
    if (!prompt) return null
    const sameTapper = prompt.decidedByLookupHash === lookupHash
    const sameAction = prompt.decidedAction === action
    if (prompt.status === 'decided' && sameTapper && sameAction) {
      await this.answerCallback(channelType, input.callbackQueryId, ACKNOWLEDGED_TEXT)
      await this.audit(CHANNEL_AUDIT_ACTIONS.approvalAcknowledged, 'acknowledged', channelType, prompt.ticketId, lookupHash, {})
      return { outcome: 'acknowledged' }
    }
    await this.answerCallback(channelType, input.callbackQueryId, ALREADY_DECIDED_TEXT)
    await this.auditReject(channelType, 'already_decided', prompt.ticketId, lookupHash, {})
    return { outcome: 'already_decided' }
  }

  // ── Kimenő segédek (mind az EGYETLEN befecskendezett transporton, D11) ────────

  private chatId(identity: ChannelIdentity): string {
    return this.crypto.decryptExternalId(identity.externalUserIdEnc)
  }

  private async answerCallback(channelType: ChannelType, callbackQueryId: string, text: string): Promise<void> {
    await this.deps.transport.send({
      channelType,
      method: 'answerCallbackQuery',
      payload: { callback_query_id: callbackQueryId, text, show_alert: false },
    })
  }

  /** A gombüzenet átírása a döntés utáni állapotra: a gombok eltűnnek, a döntés látszik. */
  private async editToDecided(
    channelType: ChannelType,
    input: HandleApprovalCallbackInput,
    chatId: string,
    title: string,
    action: ApprovalAction,
    note: string,
  ): Promise<void> {
    if (input.messageId == null) return
    await this.deps.transport.send({
      channelType,
      method: 'editMessageText',
      payload: {
        chat_id: chatId,
        message_id: input.messageId,
        text: decidedMessageText(title, action, note),
        reply_markup: { inline_keyboard: [] },
      },
    })
  }

  // ── Audit (minden azonosító ÁLNEVESÍTVE, nyers külső id sosem, §64) ──────────

  private async auditApproval(
    action: string,
    policyDecision: string,
    ticket: ApprovalTicketView,
    identity: ChannelIdentity,
    extra: Record<string, unknown>,
  ): Promise<void> {
    await this.deps.audit.append({
      actorType: 'system',
      actorId: null,
      agentVersion: null,
      action,
      targetType: 'ticket',
      targetId: ticket.ticketId,
      modelUsed: null,
      inputRef: null,
      outputRef: null,
      policyDecision,
      metadata: {
        channelType: identity.channelType,
        tenantId: ticket.tenantId,
        gateId: ticket.gateId,
        pseudonym: pseudonymFromLookupHash(identity.lookupHash),
        ...extra,
      },
      tenantId: ticket.tenantId,
    })
  }

  private async auditApprovalDecided(
    channelType: ChannelType,
    prompt: { ticketId: string; tenantId: string | null; gateId: string | null },
    action: ApprovalAction,
    lookupHash: string,
  ): Promise<void> {
    await this.deps.audit.append({
      actorType: 'human',
      actorId: null,
      agentVersion: null,
      action: CHANNEL_AUDIT_ACTIONS.approvalDecided,
      targetType: 'ticket',
      targetId: prompt.ticketId,
      modelUsed: null,
      inputRef: null,
      outputRef: null,
      policyDecision: action === 'approve' ? 'approved' : 'rejected',
      metadata: {
        channelType,
        tenantId: prompt.tenantId,
        gateId: prompt.gateId,
        decision: action,
        pseudonym: pseudonymFromLookupHash(lookupHash),
      },
      tenantId: prompt.tenantId,
    })
  }

  private async auditReject(
    channelType: ChannelType,
    reason: string,
    ticketId: string | null,
    lookupHash: string | null,
    extra: Record<string, unknown>,
  ): Promise<void> {
    await this.audit(CHANNEL_AUDIT_ACTIONS.approvalRejected, reason, channelType, ticketId, lookupHash, extra)
  }

  private async audit(
    action: string,
    policyDecision: string,
    channelType: ChannelType,
    ticketId: string | null,
    lookupHash: string | null,
    extra: Record<string, unknown>,
  ): Promise<void> {
    await this.deps.audit.append({
      actorType: 'system',
      actorId: null,
      agentVersion: null,
      action,
      targetType: 'ticket',
      targetId: ticketId ?? 'unknown',
      modelUsed: null,
      inputRef: null,
      outputRef: null,
      policyDecision,
      metadata: {
        channelType,
        ...(lookupHash ? { pseudonym: pseudonymFromLookupHash(lookupHash) } : {}),
        ...extra,
      },
    })
  }
}

/** A gombüzenet átírásához használt cím, ha a ticket időközben nem olvasható (best-effort UX). */
function ticketTitleFallback(): string {
  return 'jóváhagyási kérés'
}
