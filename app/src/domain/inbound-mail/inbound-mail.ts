/**
 * #1032 bejövő levél esemény — tiszta logika (DB nélkül): a szabály ellenőrzése, a feladó-szűrő,
 * a hurok- és spam-őr, és a döntés, hogy egy új levéllel mi történjen.
 */

export type InboundMailMode = 'notify' | 'process' | 'handoff'
export type InboundMailAction = 'notify' | 'process' | 'handoff' | 'ignore'
export type InboundMailProvider = 'agentmail' | 'google' | 'microsoft'

export type InboundMailRule = {
  mode: InboundMailMode
  /** Az admin feldolgozási utasítása; a futás system promptjába kerül. */
  instructions: string
  responsibleUserId: string | null
  handoffToUserId: string | null
  handoffToAgentId: string | null
  /** Domain (`ceg.hu`) vagy cím (`anna@ceg.hu`), kisbetűvel. Üres = bárki. */
  senderAllowlist: string[]
  dailyRunLimit: number
}

export const DEFAULT_INBOUND_MAIL_RULE: InboundMailRule = {
  mode: 'notify',
  instructions: '',
  responsibleUserId: null,
  handoffToUserId: null,
  handoffToAgentId: null,
  senderAllowlist: [],
  dailyRunLimit: 20,
}

export const INSTRUCTIONS_MAX = 4000
export const ALLOWLIST_MAX = 50
export const DAILY_RUN_LIMIT_MAX = 200
/** Szálanként ennyi feldolgozás óránként — e fölött csak jelzés (két agent egymásnak válaszolgatna). */
export const THREAD_RUNS_PER_HOUR = 3

/** Egy beérkezett levél fejléc-adatai — a törzs SOSEM kerül ide. */
export type InboundMailHeaders = {
  messageId: string
  threadId: string | null
  from: string
  subject: string
  receivedAt: Date
  labels: string[]
  /** Kisbetűs fejlécnevek → érték (csak a hurok-őrhöz szükségesek). */
  headers: Record<string, string>
}

const EMAIL_RE = /[^\s<>()"',;:]+@[^\s<>()"',;:]+\.[^\s<>()"',;:]+/
const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/

/** „Kiss Anna <anna@ceg.hu>” → `anna@ceg.hu` (kisbetű); cím nélkül üres. */
export function senderAddress(from: string): string {
  const angle = /<([^>]+)>/.exec(from)?.[1]
  return (angle ? EMAIL_RE.exec(angle)?.[0] : EMAIL_RE.exec(from)?.[0])?.toLowerCase() ?? ''
}

/** Soronként vagy vesszővel elválasztott domainek/címek; `@ceg.hu` és `*.ceg.hu` is elfogadott domainként. */
export function parseSenderAllowlist(text: string): { ok: true; entries: string[] } | { ok: false; invalid: string } {
  const entries: string[] = []
  for (const raw of text.split(/[\n,;]+/)) {
    const entry = raw.trim().toLowerCase().replace(/^\*\./, '').replace(/^@/, '')
    if (!entry) continue
    const valid = entry.includes('@') ? EMAIL_RE.test(entry) && senderAddress(entry) === entry : DOMAIN_RE.test(entry)
    if (!valid) return { ok: false, invalid: raw.trim() }
    if (!entries.includes(entry)) entries.push(entry)
  }
  return { ok: true, entries }
}

/** Üres lista = bárki. Domain-bejegyzés az aldomaineket is engedi (`ceg.hu` → `hu.ceg.hu`). */
export function senderAllowed(from: string, allowlist: readonly string[]): boolean {
  if (allowlist.length === 0) return true
  const address = senderAddress(from)
  if (!address) return false
  const domain = address.slice(address.lastIndexOf('@') + 1)
  return allowlist.some((entry) =>
    entry.includes('@') ? entry === address : domain === entry || domain.endsWith(`.${entry}`),
  )
}

export type RuleInput = {
  mode: unknown
  instructions?: unknown
  responsibleUserId?: unknown
  handoffToUserId?: unknown
  handoffToAgentId?: unknown
  senderAllowlist?: unknown
  dailyRunLimit?: unknown
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function optionalUuid(value: unknown): string | null | undefined {
  if (value === null || value === undefined || value === '') return null
  return typeof value === 'string' && UUID_RE.test(value) ? value : undefined
}

/** A beállítás-űrlap ellenőrzése; a hibaüzenet az adminnak szól. */
export function validateInboundMailRule(input: RuleInput): { ok: true; rule: InboundMailRule } | { ok: false; error: string } {
  const mode = input.mode
  if (mode !== 'notify' && mode !== 'process' && mode !== 'handoff') return { ok: false, error: 'Válaszd ki, mi történjen az új levéllel.' }
  const instructions = typeof input.instructions === 'string' ? input.instructions.trim() : ''
  if (instructions.length > INSTRUCTIONS_MAX) return { ok: false, error: `A feldolgozási utasítás legfeljebb ${INSTRUCTIONS_MAX} karakter lehet.` }
  const responsibleUserId = optionalUuid(input.responsibleUserId)
  const handoffToUserId = optionalUuid(input.handoffToUserId)
  const handoffToAgentId = optionalUuid(input.handoffToAgentId)
  if (responsibleUserId === undefined || handoffToUserId === undefined || handoffToAgentId === undefined) {
    return { ok: false, error: 'Érvénytelen kiválasztás — töltsd újra az oldalt.' }
  }
  const allowlistText = Array.isArray(input.senderAllowlist)
    ? input.senderAllowlist.filter((x): x is string => typeof x === 'string').join('\n')
    : typeof input.senderAllowlist === 'string'
      ? input.senderAllowlist
      : ''
  const allowlist = parseSenderAllowlist(allowlistText)
  if (!allowlist.ok) return { ok: false, error: `„${allowlist.invalid}” nem érvényes domain vagy e-mail cím.` }
  if (allowlist.entries.length > ALLOWLIST_MAX) return { ok: false, error: `Legfeljebb ${ALLOWLIST_MAX} feladó adható meg.` }
  const limitRaw = input.dailyRunLimit === undefined || input.dailyRunLimit === '' ? DEFAULT_INBOUND_MAIL_RULE.dailyRunLimit : Number(input.dailyRunLimit)
  if (!Number.isInteger(limitRaw) || limitRaw < 1 || limitRaw > DAILY_RUN_LIMIT_MAX) {
    return { ok: false, error: `A napi feldolgozás-keret 1 és ${DAILY_RUN_LIMIT_MAX} közötti egész szám legyen.` }
  }
  if (mode === 'process') {
    if (!instructions) return { ok: false, error: 'Írd le, mit csináljon a munkatárs az új levéllel (feldolgozási utasítás).' }
    if (!responsibleUserId) return { ok: false, error: 'Válaszd ki a felelős kollégát — az ő nevében és jogaival dolgozik a munkatárs.' }
  }
  if (mode === 'handoff') {
    if (Boolean(handoffToUserId) === Boolean(handoffToAgentId)) return { ok: false, error: 'Válaszd ki, kinek adja át a levelet (egy kollégát vagy egy munkatársat).' }
    if (!responsibleUserId) return { ok: false, error: 'Válaszd ki a felelős kollégát — az átadás az ő nevében jön létre.' }
  }
  return {
    ok: true,
    rule: {
      mode,
      instructions,
      responsibleUserId,
      handoffToUserId: mode === 'handoff' ? handoffToUserId : null,
      handoffToAgentId: mode === 'handoff' ? handoffToAgentId : null,
      senderAllowlist: allowlist.entries,
      dailyRunLimit: limitRaw,
    },
  }
}

const SPAM_LABELS = new Set(['spam', 'junk', 'blocked', 'unauthenticated', 'quarantine'])

export function isSpam(mail: Pick<InboundMailHeaders, 'labels'>): boolean {
  return mail.labels.some((label) => SPAM_LABELS.has(label.toLowerCase()))
}

/** Saját küldött levél (pl. az AgentMail a küldött leveleket is listázza). */
export function isOutgoing(mail: Pick<InboundMailHeaders, 'labels'>): boolean {
  const labels = mail.labels.map((label) => label.toLowerCase())
  return labels.includes('sent') && !labels.includes('received') && !labels.includes('inbox')
}

/**
 * Automatikus levél (RFC 3834 `Auto-Submitted`, `Precedence: bulk/junk/list`, Exchange/egyéb
 * automatikus-válasz jelölők) — ilyenre sosem indul futás (házon kívül-válasz, kézbesítési hiba).
 */
export function automatedReason(mail: Pick<InboundMailHeaders, 'headers' | 'from'>): string | null {
  const h = mail.headers
  const autoSubmitted = h['auto-submitted']?.trim().toLowerCase()
  if (autoSubmitted && autoSubmitted !== 'no') return 'auto_submitted'
  const precedence = h['precedence']?.trim().toLowerCase()
  if (precedence && ['bulk', 'junk', 'list', 'auto_reply'].includes(precedence)) return 'precedence'
  if (h['x-autoreply'] || h['x-autorespond'] || h['x-auto-response-suppress']?.toLowerCase().includes('all')) return 'auto_reply'
  if (h['x-ms-exchange-generated-message-source'] || h['x-ms-exchange-inbox-rules-loop']) return 'auto_reply'
  const address = senderAddress(mail.from)
  if (/^(mailer-daemon|postmaster|no-?reply|do-?not-?reply)@/.test(address)) return 'system_sender'
  return null
}

export type DecideInput = {
  rule: InboundMailRule
  mail: InboundMailHeaders
  /** A postafiók saját címe (a saját levél kiszűréséhez). */
  ownAddress: string | null
  /** A tenant összes platform-agentjének címe (agent → agent hurok). */
  platformAddresses: ReadonlySet<string>
  processedToday: number
  threadRunsLastHour: number
}

export type Decision = { action: InboundMailAction; reason: string | null }

/**
 * Mi történjen az új levéllel. A „Dolgozza fel” / „Adja át” szabályt a védelmek visszaléptetik
 * „Csak jelezze”-re (reason-nel), a saját és a spam levelet figyelmen kívül hagyjuk.
 */
export function decideInboundAction(input: DecideInput): Decision {
  const { rule, mail } = input
  const from = senderAddress(mail.from)
  if (isOutgoing(mail) || (input.ownAddress && from === input.ownAddress.toLowerCase())) return { action: 'ignore', reason: 'own_message' }
  if (isSpam(mail)) return { action: 'ignore', reason: 'spam' }
  if (rule.mode === 'notify') return { action: 'notify', reason: null }
  if (from && input.platformAddresses.has(from)) return { action: 'notify', reason: 'platform_agent_sender' }
  const automated = automatedReason(mail)
  if (automated) return { action: 'notify', reason: automated }
  if (!senderAllowed(mail.from, rule.senderAllowlist)) return { action: 'notify', reason: 'sender_filtered' }
  if (rule.mode === 'handoff') return { action: 'handoff', reason: null }
  if (input.processedToday >= rule.dailyRunLimit) return { action: 'notify', reason: 'daily_limit' }
  if (input.threadRunsLastHour >= THREAD_RUNS_PER_HOUR) return { action: 'notify', reason: 'thread_limit' }
  return { action: 'process', reason: null }
}

/** A Postaláda nézet magyarázata: miért csak jelzés lett. */
export function inboundReasonLabel(reason: string | null | undefined): string | null {
  switch (reason) {
    case null:
    case undefined:
      return null
    case 'own_message':
      return 'A munkatárs saját levele.'
    case 'spam':
      return 'Kéretlen vagy nem hitelesített levél.'
    case 'platform_agent_sender':
      return 'Egy másik AI munkatárs küldte — hurok ellen nem dolgozzuk fel automatikusan.'
    case 'auto_submitted':
    case 'precedence':
    case 'auto_reply':
      return 'Automatikus levél (pl. házon kívül-válasz) — nem dolgozzuk fel automatikusan.'
    case 'system_sender':
      return 'Rendszerüzenet (pl. kézbesítési hiba) — nem dolgozzuk fel automatikusan.'
    case 'sender_filtered':
      return 'A feladó nincs az engedélyezett feladók között.'
    case 'daily_limit':
      return 'Elérte a napi feldolgozás-keretet — ma már csak jelez.'
    case 'thread_limit':
      return 'Ebben a levélváltásban az elmúlt órában már többször dolgozott — most csak jelez.'
    case 'run_unavailable':
      return 'A feldolgozás nem indulhatott el (a munkatárs vagy a platform-chat nem elérhető a felelős kollégának).'
    case 'no_responsible_user':
      return 'Nincs kiválasztva felelős kolléga.'
    case 'agent_unpublished':
      return 'A munkatárs nincs élesítve, ezért nem adhat át feladatot.'
    case 'handoff_failed':
      return 'Az átadás nem sikerült.'
    default:
      return reason
  }
}
