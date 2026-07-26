/**
 * Csatorna-bot szolgáltatás (Telegram feature-spec #70/#71, D3/D14).
 *
 * A platform-admin egyetlen, platform-szintű botot regisztrálhat / frissíthet csatorna-
 * típusonként (D3 — egyetlen platform-bot; a szervezeti botot a séma viszi, az MVP nem
 * építi). A hozzáférési kulcs és a webhook titkos fejléc CSAK titok-referenciaként
 * tárolódik (`env:` / `secret-ref:` / `secret-manager:`), sosem nyersen, és a felületre
 * visszaadott nézet SOHA nem tartalmazza őket — csak azt, hogy be vannak-e állítva.
 *
 * Minden regisztráció/frissítés auditált (`channel.bot.register` / `channel.bot.update`);
 * a titok-referencia bekerül a metaadatba (mert az MAGA a referencia, nem a titok), a
 * nyers kulcs sosem.
 */

import type { ChannelBot, ChannelType } from '@prisma/client'
import type { AuditRepository, ChannelBotRepository } from '@/repositories/interfaces'
import type { ChannelOutboundTransport } from './channel-outbound-transport'
import {
  CHANNEL_AUDIT_ACTIONS,
  isSecretRef,
  type ChannelBotPublicView,
} from './channel-types'

export type RegisterPlatformBotInput = {
  channelType: ChannelType
  name: string
  /** Titok-referencia (nem nyers token). Pl. `secret-manager:projects/.../secrets/telegram-bot`. */
  accessKeySecretRef: string
  /** A webhook titkos fejléc referenciája (nem nyers érték). */
  webhookSecretRef: string
}

export type UpdatePlatformBotInput = {
  channelType: ChannelType
  name?: string
  status?: 'active' | 'disabled'
  /** Ha megadva, felülírja a hozzáférési kulcs referenciáját (a nyers kulcs cseréjéhez). */
  accessKeySecretRef?: string
  /** Ha megadva, felülírja a webhook titkos fejléc referenciáját. */
  webhookSecretRef?: string
}

export type ChannelBotServiceError =
  | 'invalid_name'
  | 'invalid_secret_ref'
  | 'already_exists'
  | 'not_found'

export type ChannelBotServiceResult =
  | { ok: true; bot: ChannelBotPublicView }
  | { ok: false; reason: ChannelBotServiceError }

/**
 * A beüzemelés ÁLLAPOTA a platform-admin képernyőjének (#70 story 53/55/56 + NFR-1). Nem csak a
 * bot-sort mutatja, hanem azt a HÁROM külső feltételt is, ami nélkül a csatorna némán halott:
 * a bot Telegram-felhasználóneve (ebből épül a mélylink), a publikus app-cím (ide jönnek a
 * Telegram üzenetei), és maga a webhook-bekötés. Ezek mindegyike ma env/kézi lépés volt — a
 * képernyő ezért mondja ki, melyik hiányzik.
 */
export type ChannelSetupState = {
  bot: ChannelBotPublicView | null
  /** A `TELEGRAM_BOT_USERNAME` env értéke — ebből épül a `t.me/<username>?start=…` mélylink. */
  botUsername: string
  /** `false`, ha az env nincs kitöltve és a kód a helykitöltő névre esik vissza (rossz mélylink). */
  botUsernameConfigured: boolean
  /** A bejövő webhook teljes, publikus URL-je — ezt kell a Telegramnál beállítani. */
  webhookUrl: string
  /** `false`, ha nincs publikus app-cím beállítva (a webhook URL localhost lenne). */
  webhookUrlConfigured: boolean
}

/** A `getMe` + `getWebhookInfo` együttes eredménye — „tényleg működik-e" a beüzemelés. */
export type ChannelConnectionCheck = {
  reachable: boolean
  /** A Telegram által VISSZAADOTT bot-felhasználónév (a valóság, nem az env). */
  botUsername: string | null
  /** A Telegramnál JELENLEG beállított webhook URL (üres string = nincs bekötve). */
  webhookUrl: string | null
  /** A Telegramnál beállított URL egyezik-e azzal, amit mi várunk. */
  webhookMatches: boolean
  /** Az env-ben megadott felhasználónév egyezik-e a valódival (a mélylink helyessége). */
  usernameMatches: boolean
  /** Feldolgozatlan, a Telegramnál torlódó frissítések száma (0 a normális). */
  pendingUpdateCount: number | null
  /** A Telegram utolsó kézbesítési hibája, ha volt (pl. rossz cert, 404, timeout). */
  lastErrorMessage: string | null
  /** Gépi hibaok, ha a lekérdezés maga nem sikerült. */
  failureReason: string | null
}

export type ChannelSetupActionResult<T> = { ok: true; data: T } | { ok: false; reason: string }

export class ChannelBotService {
  constructor(
    private readonly deps: {
      bots: ChannelBotRepository
      audit: Pick<AuditRepository, 'append'>
      /**
       * A közös, egress-őrzött kimenő kapu — a beüzemelő hívások (`getMe`, `setWebhook`,
       * `getWebhookInfo`) is EZEN mennek ki, hogy ne legyen második, dublőrözhetetlen kijárat
       * a Telegram felé (D11). Opcionális: a szolgáltatás enélkül is regisztrál/frissít.
       */
      transport?: ChannelOutboundTransport
      /** A webhook titkos fejléc feloldása a bot referenciájából (a `setWebhook` `secret_token`-je). */
      resolveWebhookSecret?: (bot: ChannelBot) => Promise<string>
      /** A bejövő webhook publikus URL-je (a publikus app-címből épül). */
      resolveWebhookUrl?: (channelType: ChannelType) => string
      /** A `TELEGRAM_BOT_USERNAME` env és annak kitöltöttsége (a mélylink alapja). */
      resolveBotUsername?: () => { username: string; configured: boolean }
      /** A publikus app-cím be van-e állítva (különben a webhook URL localhost lenne). */
      isPublicAppUrlConfigured?: () => boolean
    },
  ) {}

  /**
   * A platform-bot regisztrációja (create). Ha már van platform-bot erre a csatorna-típusra,
   * `already_exists` — a frissítéshez az `updatePlatformBot`-ot kell hívni (D3 — egyetlen bot).
   */
  async registerPlatformBot(
    input: RegisterPlatformBotInput,
    actorId: string,
  ): Promise<ChannelBotServiceResult> {
    const name = input.name.trim()
    if (!name) return { ok: false, reason: 'invalid_name' }
    if (!isSecretRef(input.accessKeySecretRef) || !isSecretRef(input.webhookSecretRef)) {
      return { ok: false, reason: 'invalid_secret_ref' }
    }

    const existing = await this.deps.bots.findPlatformBot(input.channelType)
    if (existing) return { ok: false, reason: 'already_exists' }

    const bot = await this.deps.bots.create({
      channelType: input.channelType,
      tenantId: null, // platform-szintű
      name,
      accessKeySecretRef: input.accessKeySecretRef.trim(),
      webhookSecretRef: input.webhookSecretRef.trim(),
      status: 'active',
      createdById: actorId,
    })

    await this.audit(CHANNEL_AUDIT_ACTIONS.botRegister, bot, actorId)
    return { ok: true, bot: toPublicView(bot) }
  }

  /**
   * A meglévő platform-bot frissítése. A titok-referenciák CSAK akkor íródnak felül, ha a
   * hívó megadja őket — így a név/státusz módosítható a kulcs újbóli beírása nélkül.
   */
  async updatePlatformBot(
    input: UpdatePlatformBotInput,
    actorId: string,
  ): Promise<ChannelBotServiceResult> {
    const existing = await this.deps.bots.findPlatformBot(input.channelType)
    if (!existing) return { ok: false, reason: 'not_found' }

    if (input.name !== undefined && input.name.trim() === '') {
      return { ok: false, reason: 'invalid_name' }
    }
    if (input.accessKeySecretRef !== undefined && !isSecretRef(input.accessKeySecretRef)) {
      return { ok: false, reason: 'invalid_secret_ref' }
    }
    if (input.webhookSecretRef !== undefined && !isSecretRef(input.webhookSecretRef)) {
      return { ok: false, reason: 'invalid_secret_ref' }
    }

    const bot = await this.deps.bots.update(existing.id, {
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.accessKeySecretRef !== undefined
        ? { accessKeySecretRef: input.accessKeySecretRef.trim() }
        : {}),
      ...(input.webhookSecretRef !== undefined
        ? { webhookSecretRef: input.webhookSecretRef.trim() }
        : {}),
    })

    await this.audit(CHANNEL_AUDIT_ACTIONS.botUpdate, bot, actorId, {
      accessKeyRotated: input.accessKeySecretRef !== undefined,
      webhookSecretRotated: input.webhookSecretRef !== undefined,
    })
    return { ok: true, bot: toPublicView(bot) }
  }

  /** A platform-bot felületre biztonságos nézete (titok nélkül), vagy `null`. */
  async getPlatformBot(channelType: ChannelType): Promise<ChannelBotPublicView | null> {
    const bot = await this.deps.bots.findPlatformBot(channelType)
    return bot ? toPublicView(bot) : null
  }

  /**
   * A beüzemelés teljes állapota EGY lekérdezésben (a platform-admin képernyőjének).
   * A bot-soron TÚL azt is megmondja, mi hiányzik a környezetből — e nélkül a csatorna
   * beüzemelése „mindent beírtam, mégsem működik" élmény volt.
   */
  async getSetupState(channelType: ChannelType): Promise<ChannelSetupState> {
    const bot = await this.deps.bots.findPlatformBot(channelType)
    const username = this.deps.resolveBotUsername?.() ?? { username: '', configured: false }
    return {
      bot: bot ? toPublicView(bot) : null,
      botUsername: username.username,
      botUsernameConfigured: username.configured,
      webhookUrl: this.deps.resolveWebhookUrl?.(channelType) ?? '',
      webhookUrlConfigured: this.deps.isPublicAppUrlConfigured?.() ?? false,
    }
  }

  /**
   * A bejövő webhook BEKÖTÉSE a providernél (`setWebhook`). Ez az a lépés, ami nélkül a bot
   * soha egyetlen üzenetet sem ad át nekünk — eddig csak kézzel, `curl`-lel volt elvégezhető.
   *
   * A titkos fejléc a bot referenciájából oldódik fel, és NYERSEN csak a hívás pillanatában
   * létezik: sem a válaszban, sem az auditban nem jelenik meg. Az `allowed_updates` szűken a
   * két általunk feldolgozott típusra szorít (üzenet + gombkoppintás), a `drop_pending_updates`
   * pedig eldobja a bekötés előtt torlódott, kontextus nélküli régi üzeneteket.
   */
  async installWebhook(
    channelType: ChannelType,
    actorId: string,
  ): Promise<ChannelSetupActionResult<{ webhookUrl: string }>> {
    const bot = await this.deps.bots.findPlatformBot(channelType)
    if (!bot) return { ok: false, reason: 'not_found' }
    if (!this.deps.transport || !this.deps.resolveWebhookSecret || !this.deps.resolveWebhookUrl) {
      return { ok: false, reason: 'transport_unavailable' }
    }
    if (!(this.deps.isPublicAppUrlConfigured?.() ?? false)) {
      return { ok: false, reason: 'public_url_missing' }
    }

    const webhookUrl = this.deps.resolveWebhookUrl(channelType)
    let secret: string
    try {
      secret = await this.deps.resolveWebhookSecret(bot)
    } catch {
      return { ok: false, reason: 'secret_unresolvable' }
    }
    if (!secret.trim()) return { ok: false, reason: 'secret_unresolvable' }

    const res = await this.deps.transport.send({
      channelType,
      method: 'setWebhook',
      payload: {
        url: webhookUrl,
        secret_token: secret,
        allowed_updates: ['message', 'callback_query'],
        drop_pending_updates: true,
      },
    })
    if (!res.ok) return { ok: false, reason: res.reason }

    await this.deps.audit.append({
      actorType: 'human',
      actorId,
      agentVersion: null,
      action: CHANNEL_AUDIT_ACTIONS.botWebhookInstalled,
      targetType: 'channel_bot',
      targetId: bot.id,
      modelUsed: null,
      inputRef: null,
      outputRef: null,
      policyDecision: 'installed',
      // A cél-URL auditálható (a mi publikus végpontunk); a titkos fejléc NEM — csak az, hogy volt.
      metadata: { channelType, webhookUrl, secretHeaderSet: true },
    })
    return { ok: true, data: { webhookUrl } }
  }

  /**
   * A beüzemelés ELLENŐRZÉSE (csak olvas): válaszol-e a bot (`getMe`), és tényleg a MI
   * végpontunkra van-e bekötve (`getWebhookInfo`). Ez adja a képernyőnek azt a mondatot, hogy
   * „működik" vagy „ezt kell még megcsinálnod" — találgatás helyett.
   */
  async checkConnection(channelType: ChannelType): Promise<ChannelConnectionCheck> {
    const base: ChannelConnectionCheck = {
      reachable: false,
      botUsername: null,
      webhookUrl: null,
      webhookMatches: false,
      usernameMatches: false,
      pendingUpdateCount: null,
      lastErrorMessage: null,
      failureReason: null,
    }
    const bot = await this.deps.bots.findPlatformBot(channelType)
    if (!bot) return { ...base, failureReason: 'not_found' }
    if (!this.deps.transport) return { ...base, failureReason: 'transport_unavailable' }

    const me = await this.deps.transport.send({ channelType, method: 'getMe', payload: {} })
    if (!me.ok) return { ...base, failureReason: me.reason }

    const botUsername = readString(me.result, 'username')
    const expected = this.deps.resolveBotUsername?.()
    const info = await this.deps.transport.send({
      channelType,
      method: 'getWebhookInfo',
      payload: {},
    })
    const expectedUrl = this.deps.resolveWebhookUrl?.(channelType) ?? ''
    const currentUrl = info.ok ? readString(info.result, 'url') : null

    return {
      reachable: true,
      botUsername,
      webhookUrl: currentUrl,
      webhookMatches: Boolean(expectedUrl) && currentUrl === expectedUrl,
      usernameMatches:
        Boolean(expected?.configured) &&
        Boolean(botUsername) &&
        expected!.username.toLowerCase() === botUsername!.toLowerCase(),
      pendingUpdateCount: info.ok ? readNumber(info.result, 'pending_update_count') : null,
      lastErrorMessage: info.ok ? readString(info.result, 'last_error_message') : null,
      failureReason: info.ok ? null : info.reason,
    }
  }

  private async audit(
    action: string,
    bot: ChannelBot,
    actorId: string,
    extra?: Record<string, unknown>,
  ): Promise<void> {
    await this.deps.audit.append({
      actorType: 'human',
      actorId,
      agentVersion: null,
      action,
      targetType: 'channel_bot',
      targetId: bot.id,
      modelUsed: null,
      inputRef: null,
      outputRef: null,
      policyDecision: bot.status === 'active' ? 'active' : 'disabled',
      metadata: {
        channelType: bot.channelType,
        platformLevel: bot.tenantId === null,
        name: bot.name,
        // A referenciák (NEM a nyers titok) auditálhatók — ez maga a mutató, nem a kulcs.
        accessKeySecretRef: bot.accessKeySecretRef,
        webhookSecretRef: bot.webhookSecretRef,
        ...(extra ?? {}),
      },
    })
  }
}

/** Óvatos mezőolvasás a provider `result` objektumából (az alakja metódusonként más). */
function readString(result: unknown, key: string): string | null {
  if (typeof result !== 'object' || result === null) return null
  const value = (result as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : null
}

function readNumber(result: unknown, key: string): number | null {
  if (typeof result !== 'object' || result === null) return null
  const value = (result as Record<string, unknown>)[key]
  return typeof value === 'number' ? value : null
}

function toPublicView(bot: ChannelBot): ChannelBotPublicView {
  return {
    id: bot.id,
    channelType: bot.channelType,
    tenantId: bot.tenantId,
    isPlatformLevel: bot.tenantId === null,
    name: bot.name,
    status: bot.status,
    hasAccessKey: bot.accessKeySecretRef.trim().length > 0,
    hasWebhookSecret: bot.webhookSecretRef.trim().length > 0,
    createdAt: bot.createdAt.toISOString(),
    updatedAt: bot.updatedAt.toISOString(),
  }
}
