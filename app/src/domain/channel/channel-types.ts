/**
 * Csatorna-réteg közös típusok és konstansok (Telegram feature-spec #70/#71, D3/D10/D14).
 *
 * Ez a modul a csatorna-alap "szótára": a Telegram Bot API host (egress-engedélylista),
 * a titok-referencia forma, és a csatornához tartozó audit-eseménytípusok — egy helyen,
 * hogy a séma, a szolgáltatás és a kimenő átvitel ugyanarra hivatkozzon.
 */

import type { ChannelType } from '@prisma/client'

/**
 * A Telegram Bot API hostja. Minden kimenő csatorna-hívás ezen a hoston megy, és a
 * kimenő átviteli kapu (D11) deny-by-default egress-őre CSAK ezt engedi (D10 — a
 * Telegram API az engedélylistán van, különben a deny-by-default kimenő szabály tiltja).
 */
export const TELEGRAM_API_HOST = 'api.telegram.org'

/**
 * A csatorna-réteg egyetlen kimenő cél-hostjának engedélylistája. Ma egyetlen elem
 * (Telegram); a WhatsApp/Slack/SMS adapterek KÍVÜL esnek a hatókörön, de amint jönnek,
 * ide kerül a hostjuk. A kimenő átviteli kapu ezt adja az egress-őrnek.
 */
export const CHANNEL_EGRESS_ALLOWLIST_HOSTS: readonly string[] = [TELEGRAM_API_HOST]

/**
 * A csatorna-réteg audit-eseménytípusai (a #70 spec §Testing "Audit" pontja: minden
 * csatorna-hatás determinisztikus audit-bejegyzést ír). Ezeket a globális audit-katalógus
 * (`src/lib/audit/event-catalog.ts`) is regisztrálja — itt névvel hivatkozhatók a kódból.
 */
export const CHANNEL_AUDIT_ACTIONS = {
  botRegister: 'channel.bot.register',
  botUpdate: 'channel.bot.update',
  messageSent: 'channel.message.sent',
  messageBlocked: 'channel.message.blocked',
  // Összekötés és visszavonás (#72, D12).
  linkTokenIssued: 'channel.link.token_issued',
  linkEstablished: 'channel.link.established',
  linkRejected: 'channel.link.rejected',
  identityRevoked: 'channel.identity.revoked',
  unlinkedNotice: 'channel.link.unlinked_notice',
  // 1:1 agent-chat forduló-sor és feldolgozás (#73/#74, D8): sor-írás, sikeres feldolgozás,
  // újrapróbálás (elszállt futás) és végleges hiba. Az azonosítók ÁLNEVESÍTVE.
  turnEnqueued: 'channel.turn.enqueued',
  turnCompleted: 'channel.turn.completed',
  turnRetry: 'channel.turn.retry',
  turnFailed: 'channel.turn.failed',
} as const

/**
 * A platform-oldali felhasználói értesítés típusa az összekötésről (D12 story 3) — ha nem a
 * felhasználó kötött, azonnal lássa és megszüntethesse.
 */
export const CHANNEL_LINK_NOTIFICATION_KIND = 'channel.link.established' as const

export type ChannelAuditAction =
  (typeof CHANNEL_AUDIT_ACTIONS)[keyof typeof CHANNEL_AUDIT_ACTIONS]

/**
 * Egy titok-referencia elfogadott formái (megegyezik a connector `secretAlias` mintájával,
 * l. `resolveConnectorApiKey`). A NYERS titok SOHA nem kerül az adatbázisba — csak ez a
 * referencia, ami szerveroldalon, rövid élettartamra oldódik fel. A felületen sosem
 * olvasható vissza (D14/#71).
 */
const SECRET_REF_PREFIXES = ['env:', 'secret-ref:', 'secret-manager:'] as const

/** Igaz, ha az érték a támogatott titok-referencia formák egyike (nem nyers titok). */
export function isSecretRef(value: string): boolean {
  const v = value.trim()
  return SECRET_REF_PREFIXES.some((p) => v.startsWith(p)) && v.length > v.indexOf(':') + 1
}

/**
 * Egy csatorna-bot felületen MEGMUTATHATÓ nézete. A titok-referenciákat SOHA nem adja
 * vissza — csak azt, hogy be van-e állítva (`hasAccessKey` / `hasWebhookSecret`). Így a
 * kulcs a felületről nem olvasható vissza, csak felülírható.
 */
export type ChannelBotPublicView = {
  id: string
  channelType: ChannelType
  tenantId: string | null
  isPlatformLevel: boolean
  name: string
  status: 'active' | 'disabled'
  hasAccessKey: boolean
  hasWebhookSecret: boolean
  createdAt: string
  updatedAt: string
}
