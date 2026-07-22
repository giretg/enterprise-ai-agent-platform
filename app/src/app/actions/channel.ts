'use server'

import { z } from 'zod'
import { requirePlatformRole } from '@/auth/tenant-context'
import { services } from '@/domain'
import { ensureActiveDatabaseMode } from '@/lib/db'
import { fail, ok } from '@/lib/result'

/**
 * Platform-szintű csatorna-bot regisztráció / frissítés (Telegram feature-spec #70/#71, D3).
 * CSAK platform-admin (superadmin). A hozzáférési kulcsot és a webhook titkos fejlécet a
 * hívó TITOK-REFERENCIAKÉNT adja (`env:` / `secret-ref:` / `secret-manager:`) — a nyers
 * kulcs sosem jut a szerverre ezen az úton, és a visszaadott nézet sosem tartalmazza.
 */

const secretRefSchema = z
  .string()
  .trim()
  .min(1)
  .refine(
    (v) => /^(env:|secret-ref:|secret-manager:).+/.test(v),
    'A titok CSAK referenciaként adható meg (env:… / secret-ref:… / secret-manager:…), nyersen nem.',
  )

const registerPlatformBotSchema = z.object({
  channelType: z.literal('telegram'),
  name: z.string().trim().min(1, 'A bot neve kötelező.'),
  accessKeySecretRef: secretRefSchema,
  webhookSecretRef: secretRefSchema,
})

const updatePlatformBotSchema = z.object({
  channelType: z.literal('telegram'),
  name: z.string().trim().min(1).optional(),
  status: z.enum(['active', 'disabled']).optional(),
  accessKeySecretRef: secretRefSchema.optional(),
  webhookSecretRef: secretRefSchema.optional(),
})

/** Szerviz-hibakód → hétköznapi magyar üzenet (NFR-1, D16). */
function messageFor(reason: string): string {
  switch (reason) {
    case 'invalid_name':
      return 'A bot neve kötelező.'
    case 'invalid_secret_ref':
      return 'A hozzáférési kulcs és a webhook titkos fejléc CSAK referenciaként adható meg (env:… / secret-ref:… / secret-manager:…), nyersen nem.'
    case 'already_exists':
      return 'Már van regisztrált platform-bot ehhez a csatornához — a meglévőt frissítsd.'
    case 'not_found':
      return 'Nincs regisztrált platform-bot ehhez a csatornához — előbb regisztráld.'
    default:
      return 'A csatorna-bot művelet nem sikerült.'
  }
}

export async function registerPlatformChannelBot(input: unknown) {
  try {
    await ensureActiveDatabaseMode()
    const actor = (await requirePlatformRole('superadmin')).user
    const parsed = registerPlatformBotSchema.parse(input)
    const res = await services.channelBots.registerPlatformBot(parsed, actor.id)
    if (!res.ok) return fail(messageFor(res.reason))
    return ok(res.bot)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült regisztrálni a platform-botot.')
  }
}

export async function updatePlatformChannelBot(input: unknown) {
  try {
    await ensureActiveDatabaseMode()
    const actor = (await requirePlatformRole('superadmin')).user
    const parsed = updatePlatformBotSchema.parse(input)
    const res = await services.channelBots.updatePlatformBot(parsed, actor.id)
    if (!res.ok) return fail(messageFor(res.reason))
    return ok(res.bot)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült frissíteni a platform-botot.')
  }
}

export async function getPlatformChannelBot(channelType: 'telegram' = 'telegram') {
  try {
    await requirePlatformRole('superadmin')
    const bot = await services.channelBots.getPlatformBot(channelType)
    return ok(bot)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült lekérni a platform-botot.')
  }
}
