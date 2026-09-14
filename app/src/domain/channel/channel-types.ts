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
  // A bejövő webhook bekötése a providernél (`setWebhook`) — ez ÁLLAPOTVÁLTOZÁS a Telegram
  // oldalán (innentől jönnek hozzánk az üzenetek), ezért auditálandó. A `getMe`/`getWebhookInfo`
  // ellenőrzés CSAK olvas, azt nem auditáljuk.
  botWebhookInstalled: 'channel.bot.webhook_installed',
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
  // Bejövő forduló-sor + worker második munkatípus (#73, D8) korábbi szeletének maradék
  // eseménye (agent-engedély nélküli útmutató válasz) — a #74 óta `turnCompleted` alá esik,
  // de a konstans megmarad visszafelé-kompatibilitásért / esetleges régi audit-sorokért.
  turnNoAgent: 'channel.turn.no_agent',
  // Proaktív értesítés (#77, D7/D11/D15) — a Monitor-riasztás a csatorna harmadik bejáratán.
  // A `sent` a kiment értesítés, a `skipped` a nincs-küldés (nem összekötött címzett / nincs
  // bot), a `failed` a best-effort küldési hiba (a Monitor-futás NEM bukik el), a
  // `identity.blocked` pedig a bot-letiltás jelölése (a kötés `blocked`, a küldés abbamarad).
  notificationSent: 'channel.notification.sent',
  notificationSkipped: 'channel.notification.skipped',
  notificationFailed: 'channel.notification.failed',
  identityBlocked: 'channel.identity.blocked',
  // Üzemeltetés (#78, D4): a bot saját kimenő üzeneteinek megőrzési takarítása.
  messagePurged: 'channel.message.purged',
  retentionSwept: 'channel.retention.swept',
  // Agent-engedélyek, projektkötés és szervezeti kill-switch (#75, D5/D9/D13/D54).
  agentGranted: 'channel.agent.granted',
  agentRevoked: 'channel.agent.revoked',
  agentProjectSet: 'channel.agent.project_set',
  tenantDisabled: 'channel.tenant.disabled',
  tenantEnabled: 'channel.tenant.enabled',
  // Eseményvezérelt jóváhagyás Telegram-gombokkal (#76, D5/D6/D14). A `notified` a kiment
  // (jogosultság-tudatos) gombüzenet, a `decided` a koppintással meghozott döntés (a közös
  // állapotgépet lépteti), a `rejected` a KAPUKON elakadt koppintás (nem-jogosult / visszavont
  // jog / visszajátszás / hamis aláírás / saját kérés / már eldöntött), az `acknowledged` a
  // kettős koppintás idempotens nyugtázása. Az azonosítók ÁLNEVESÍTVE, nyers külső id sosem.
  approvalNotified: 'channel.approval.notified',
  approvalDecided: 'channel.approval.decided',
  approvalRejected: 'channel.approval.rejected',
  approvalAcknowledged: 'channel.approval.acknowledged',
} as const

/**
 * A bot SAJÁT kimenő üzeneteinek megőrzési horizontja napokban (D4/#78). A hiteles példány a
 * miénk; a Telegram csak kézbesítési csatorna, ezért a bot a horizonton túl törli a saját
 * kimenő üzeneteit. Alapérték; a takarító hívása felül tudja írni (pl. szervezeti policy).
 * (A privát chat korlátja: a bot CSAK a magáét tudja törölni — a felhasználóét nem, ez
 * tudatosan félmegoldás.)
 */
export const CHANNEL_OUTBOUND_RETENTION_DAYS = 30

/** Egy megőrzési-takarító futás felső korlátja (egy körben ennyi üzenetet dolgoz fel). */
export const CHANNEL_RETENTION_SWEEP_LIMIT = 500

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
 * A Telegram platform-bot két titkának menedzselt tároló-azonosítója. A beüzemelő UI-ról
 * beírt NYERS titok a connectoroknál bevált secret-store mögé kerül (Secret Manager prod,
 * lokális fájl dev), a `channel_bots` sorban csak a `secret-ref:<id>` hivatkozás áll —
 * ugyanaz a minta, mint az API-kulcsoknál. A feloldás a meglévő `resolveConnectorApiKey`
 * úton megy (a `secret-ref:` prefixet az már ma is érti), ezért nincs új tároló-kód.
 */
export const CHANNEL_BOT_TOKEN_SECRET_ID = 'channel-telegram-bot-token' as const
export const CHANNEL_WEBHOOK_SECRET_ID = 'channel-telegram-webhook-secret' as const

/**
 * Telegram bot-felhasználónév szabály (BotFather-konvenció: 5–32 karakter, betű/szám/
 * aláhúzás, @ nélkül — a vezető @-ot a hívó már levágta). Nem titok, de a rossz mélylink
 * csendes üzemzavara miatt fail-fast validáljuk.
 */
export function isValidTelegramBotUsername(value: string): boolean {
  return /^[A-Za-z0-9_]{5,32}$/.test(value.trim())
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
  /** A bot Telegram-felhasználóneve (@ nélkül) — nem titok, a mélylinkhez kell. */
  botUsername: string | null
  status: 'active' | 'disabled'
  hasAccessKey: boolean
  hasWebhookSecret: boolean
  createdAt: string
  updatedAt: string
}
