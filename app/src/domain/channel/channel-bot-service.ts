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

export class ChannelBotService {
  constructor(
    private readonly deps: {
      bots: ChannelBotRepository
      audit: Pick<AuditRepository, 'append'>
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
