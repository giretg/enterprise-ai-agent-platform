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
  // Agent-engedélyek, projektkötés és szervezeti kill-switch (#75, D5/D9/D13/D54).
  agentGranted: 'channel.agent.granted',
  agentRevoked: 'channel.agent.revoked',
  agentProjectSet: 'channel.agent.project_set',
  tenantDisabled: 'channel.tenant.disabled',
  tenantEnabled: 'channel.tenant.enabled',
} as const

/**
 * A platform-oldali felhasználói értesítés típusa az összekötésről (D12 story 3) — ha nem a
 * felhasználó kötött, azonnal lássa és megszüntethesse.
 */
export const CHANNEL_LINK_NOTIFICATION_KIND = 'channel.link.established' as const

export type ChannelAuditAction =
  (typeof CHANNEL_AUDIT_ACTIONS)[keyof typeof CHANNEL_AUDIT_ACTIONS]

/**
 * A gyűjtő projektkulcs (D9/D34). Ha a felhasználó nem állít be mást, egy agent Telegram-
 * fordulója ide esik — beállítás nélkül is működik, de a projektfolytonosság a beállítással
 * él igazán.
 */
export const CHANNEL_DEFAULT_PROJECT_KEY = '__general__' as const

/**
 * PlatformSetting kulcs a SZERVEZETI (tenant-szintű) Telegram-kill-switchhez (D54, #75).
 * Bucket: `{ [tenantId]: { killSwitch, updatedAt?, updatedById? } }` — ugyanaz a minta, mint a
 * web-search tenant-kill-switchnél. Kikapcsolva a csatorna azonnal fail-closed minden be- és
 * kimenő úton (D16: „ha nincs jogosultság, a rendszer nem válaszol").
 */
export const CHANNEL_TENANT_CONTROLS_KEY = 'channel.telegram.tenant_controls' as const

/** Egy tenant Telegram-csatorna kapcsolójának állapota. `killSwitch=true` → a csatorna zárva. */
export type ChannelTenantControls = {
  killSwitch: boolean
  updatedById: string | null
  updatedAt: string | null
}

/**
 * Igaz, ha az érték érvényes projektkulcs. A kulcs a memória-rendszer hatókör-címkéje, ezért
 * csak biztonságos, rövid azonosítót engedünk (a `__general__` gyűjtő is ilyen). Nem enged
 * whitespace-t, útvonal-szeparátort vagy tetszőleges szöveget.
 */
export function isValidProjectKey(value: string): boolean {
  return /^[A-Za-z0-9_.:-]{1,120}$/.test(value.trim())
}

/**
 * Egy csatorna-agent-engedély (grant) felületen MEGMUTATHATÓ nézete a metszet-oldali
 * elérhetőséggel (D5). Az `availability` a platform-jog ∩ Telegram-engedély metszet
 * agent-oldali eredménye:
 *  - `available`   — a platformon is elérhető ÉS Telegramra engedélyezett → választható;
 *  - `agent_removed` — Telegramra engedélyezett, de a platformon már NINCS (nyugdíjazott /
 *    felfüggesztett / törölt) → NEM választható, de érthető tájékoztatással látszik.
 */
export type ChannelAgentAvailability = 'available' | 'agent_removed'

export type ChannelAgentGrantView = {
  agentId: string
  agentName: string
  projectKey: string
  availability: ChannelAgentAvailability
}

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
