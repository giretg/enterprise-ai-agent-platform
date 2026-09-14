'use server'

import { z } from 'zod'
import { requirePlatformRole } from '@/auth/tenant-context'
import { services } from '@/domain'
import {
  CHANNEL_BOT_TOKEN_SECRET_ID,
  CHANNEL_WEBHOOK_SECRET_ID,
  isValidTelegramBotUsername,
} from '@/domain/channel/channel-types'
import { ensureActiveDatabaseMode } from '@/lib/db'
import { fail, ok } from '@/lib/result'

/**
 * Platform-szintű csatorna-bot regisztráció / frissítés (Telegram feature-spec #70/#71, D3).
 * CSAK platform-admin (superadmin).
 *
 * A hozzáférési kulcs és a webhook titkos fejléc NYERSEN beírható a beüzemelő UI-on: a
 * szerver a connectoroknál bevált menedzselt titok-tárba menti (Secret Manager prod,
 * lokális fájl dev), és a `channel_bots` sorba CSAK a `secret-ref:…` hivatkozás kerül.
 * A visszaadott nézet sosem tartalmaz titkot — csak azt, hogy be van-e állítva.
 * (Régi, env-alapú telepítésekhez a `…SecretRef` mezők továbbra is elfogadottak.)
 */

const secretRefSchema = z
  .string()
  .trim()
  .min(1)
  .refine(
    (v) => /^(env:|secret-ref:|secret-manager:).+/.test(v),
    'A titok CSAK referenciaként adható meg (env:… / secret-ref:… / secret-manager:…), nyersen nem.',
  )

/**
 * Nyers BotFather-token (pl. `123456:ABC-…`): legalább 20 karakter és tartalmaz kettőspontot.
 * A finom érvényesítést a Telegram `getMe` ellenőrzés végzi a 4. lépésben.
 */
const rawAccessKeySchema = z
  .string()
  .trim()
  .min(20, 'A hozzáférési kulcs túl rövid — a BotFathertől kapott teljes tokent írd be.')
  .refine((v) => v.includes(':'), 'Ez nem tűnik Telegram bot-tokennek (forma: számok:kód).')

/** Nyers webhook-titok: a Telegram 1–256 karaktert enged, mi legalább 16-ot kérünk. */
const rawWebhookSecretSchema = z
  .string()
  .trim()
  .min(16, 'A webhook titkos fejléc legalább 16 karakter legyen — válassz hosszú, véletlen szöveget.')
  .max(256, 'A webhook titkos fejléc legfeljebb 256 karakter lehet (Telegram-korlát).')
  .refine(
    (v) => !/^(env:|secret-ref:|secret-manager:)/.test(v),
    'Ide a NYERS titkos szöveget írd, nem a hivatkozását.',
  )

const botUsernameSchema = z
  .string()
  .trim()
  .transform((v) => v.replace(/^@+/, '').trim())
  .refine(
    (v) => v.length === 0 || isValidTelegramBotUsername(v),
    'A felhasználónév 5–32 karakter (betű, szám, aláhúzás), @ nélkül.',
  )

const registerPlatformBotSchema = z.object({
  channelType: z.literal('telegram'),
  name: z.string().trim().min(1, 'A bot neve kötelező.'),
  /** A bot Telegram-felhasználóneve (@ nélkül) — a t.me/… mélylink alapja, nem titok. */
  botUsername: botUsernameSchema.optional(),
  /** ÚJ út: nyers titok a UI-ról → a szerver a menedzselt titok-tárba menti. */
  accessKey: rawAccessKeySchema.optional(),
  webhookSecret: rawWebhookSecretSchema.optional(),
  /** RÉGI út (visszafelé-kompat): már hivatkozott titok (env / secret-manager). */
  accessKeySecretRef: secretRefSchema.optional(),
  webhookSecretRef: secretRefSchema.optional(),
})

const updatePlatformBotSchema = z.object({
  channelType: z.literal('telegram'),
  name: z.string().trim().min(1).optional(),
  botUsername: botUsernameSchema.optional(),
  status: z.enum(['active', 'disabled']).optional(),
  accessKey: rawAccessKeySchema.optional(),
  webhookSecret: rawWebhookSecretSchema.optional(),
  accessKeySecretRef: secretRefSchema.optional(),
  webhookSecretRef: secretRefSchema.optional(),
})

/** Szerviz-hibakód → hétköznapi magyar üzenet (NFR-1, D16). */
function messageFor(reason: string): string {
  switch (reason) {
    case 'invalid_name':
      return 'A bot neve kötelező.'
    case 'invalid_bot_username':
      return 'A bot felhasználóneve 5–32 karakter (betű, szám, aláhúzás), @ nélkül — ezt a BotFathertől kaptad.'
    case 'invalid_secret_ref':
      return 'A hozzáférési kulcs vagy a webhook titkos fejléc formája érvénytelen.'
    case 'already_exists':
      return 'Már van regisztrált platform-bot ehhez a csatornához — a meglévőt frissítsd.'
    case 'not_found':
      return 'Nincs regisztrált platform-bot ehhez a csatornához — előbb regisztráld.'
    default:
      return 'A csatorna-bot művelet nem sikerült.'
  }
}

/**
 * A nyers UI-titkokat a menedzselt titok-tárba menti, és visszaadja a DB-be írandó
 * `secret-ref:…` hivatkozásokat. Amelyikhez se nyers, se referencia nem érkezett, ahhoz
 * `undefined` tartozik (regisztrációnál ez hibát jelent, frissítésnél „marad a régi").
 */
async function storeRawSecrets(parsed: {
  accessKey?: string
  webhookSecret?: string
  accessKeySecretRef?: string
  webhookSecretRef?: string
}): Promise<{ accessKeySecretRef?: string; webhookSecretRef?: string }> {
  const { saveConnectorApiKey, buildConnectorSecretRef } = await import(
    '@/domain/connector/connector-secret-store'
  )
  const out: { accessKeySecretRef?: string; webhookSecretRef?: string } = {}
  if (parsed.accessKey?.trim()) {
    await saveConnectorApiKey(CHANNEL_BOT_TOKEN_SECRET_ID, parsed.accessKey.trim())
    out.accessKeySecretRef = buildConnectorSecretRef(CHANNEL_BOT_TOKEN_SECRET_ID)
  } else if (parsed.accessKeySecretRef) {
    out.accessKeySecretRef = parsed.accessKeySecretRef
  }
  if (parsed.webhookSecret) {
    await saveConnectorApiKey(CHANNEL_WEBHOOK_SECRET_ID, parsed.webhookSecret)
    out.webhookSecretRef = buildConnectorSecretRef(CHANNEL_WEBHOOK_SECRET_ID)
  } else if (parsed.webhookSecretRef) {
    out.webhookSecretRef = parsed.webhookSecretRef
  }
  return out
}

export async function registerPlatformChannelBot(input: unknown) {
  try {
    await ensureActiveDatabaseMode()
    const actor = (await requirePlatformRole('superadmin')).user
    const parsed = registerPlatformBotSchema.parse(input)
    // A titok-slot csatornánként EGY (fix azonosító): a létezés-ellenőrzés a mentés ELŐTT
    // kell, különben egy elutasított (already_exists) regisztráció felülírná az élő bot kulcsát.
    if (await services.channelBots.getPlatformBot(parsed.channelType)) {
      return fail(messageFor('already_exists'))
    }
    const refs = await storeRawSecrets(parsed)
    if (!refs.accessKeySecretRef || !refs.webhookSecretRef) {
      return fail('A hozzáférési kulcs és a webhook titkos fejléc is kötelező a regisztrációhoz.')
    }
    const res = await services.channelBots.registerPlatformBot(
      {
        channelType: parsed.channelType,
        name: parsed.name,
        ...(parsed.botUsername ? { botUsername: parsed.botUsername } : {}),
        accessKeySecretRef: refs.accessKeySecretRef,
        webhookSecretRef: refs.webhookSecretRef,
      },
      actor.id,
    )
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
    if (!(await services.channelBots.getPlatformBot(parsed.channelType))) {
      return fail(messageFor('not_found'))
    }
    const refs = await storeRawSecrets(parsed)
    const res = await services.channelBots.updatePlatformBot(
      {
        channelType: parsed.channelType,
        ...(parsed.name !== undefined ? { name: parsed.name } : {}),
        ...(parsed.botUsername !== undefined
          ? { botUsername: parsed.botUsername || null }
          : {}),
        ...(parsed.status !== undefined ? { status: parsed.status } : {}),
        ...(refs.accessKeySecretRef !== undefined
          ? { accessKeySecretRef: refs.accessKeySecretRef }
          : {}),
        ...(refs.webhookSecretRef !== undefined
          ? { webhookSecretRef: refs.webhookSecretRef }
          : {}),
      },
      actor.id,
    )
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

/**
 * A beüzemelő képernyő állapota: a bot-sor ÉS a három környezeti feltétel (bot-felhasználónév,
 * publikus app-cím, webhook-cím). E nélkül a beüzemelés „mindent beírtam, mégsem működik" volt.
 */
export async function getTelegramChannelSetup(channelType: 'telegram' = 'telegram') {
  try {
    await requirePlatformRole('superadmin')
    return ok(await services.channelBots.getSetupState(channelType))
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült lekérni a csatorna beállításait.')
  }
}

/** Beüzemelő hibakód → hétköznapi magyar üzenet (NFR-1, D16). */
function setupMessageFor(reason: string): string {
  switch (reason) {
    case 'not_found':
      return 'Nincs regisztrált platform-bot — előbb regisztráld a botot fentebb.'
    case 'public_url_missing':
      return 'Nincs beállítva a platform publikus webcíme (NEXT_PUBLIC_APP_URL), ezért a Telegram nem tudná, hova küldje az üzeneteket. Állítsd be, indítsd újra az alkalmazást, majd próbáld újra.'
    case 'secret_unresolvable':
      return 'A webhook titkos fejlécét nem sikerült feloldani a megadott referenciából. Ellenőrizd, hogy a hivatkozott titok tényleg létezik és nem üres.'
    case 'transport_unavailable':
      return 'A kimenő Telegram-kapcsolat nincs beállítva ebben a környezetben.'
    case 'egress_blocked':
      return 'A kimenő hívást a hálózati őr blokkolta — a Telegram API nincs engedélyezve ebben a környezetben.'
    case 'provider_error':
      return 'A Telegram elutasította a kérést. A leggyakoribb ok: hibás bot-token, vagy a webcím nem érhető el kívülről HTTPS-en.'
    case 'transport_error':
      return 'Nem sikerült elérni a Telegramot (hálózati hiba vagy időtúllépés). Próbáld újra.'
    default:
      return 'A művelet nem sikerült.'
  }
}

/**
 * A bejövő webhook bekötése a Telegramnál. Ez az a lépés, ami nélkül a bot egyetlen üzenetet
 * sem ad át nekünk — eddig csak kézi `curl`-lel volt elvégezhető, most egy gomb.
 */
export async function installTelegramWebhook(channelType: 'telegram' = 'telegram') {
  try {
    await ensureActiveDatabaseMode()
    const actor = (await requirePlatformRole('superadmin')).user
    const res = await services.channelBots.installWebhook(channelType, actor.id)
    if (!res.ok) return fail(setupMessageFor(res.reason))
    return ok(res.data)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült bekötni a webhookot.')
  }
}

/** A beüzemelés ellenőrzése (csak olvas): válaszol-e a bot, és a mi végpontunkra van-e kötve. */
export async function checkTelegramChannelConnection(channelType: 'telegram' = 'telegram') {
  try {
    await requirePlatformRole('superadmin')
    return ok(await services.channelBots.checkConnection(channelType))
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült ellenőrizni a kapcsolatot.')
  }
}
