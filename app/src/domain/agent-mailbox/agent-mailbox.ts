/**
 * #1029 az agent saját e-mail címe. Tiszta logika (DB nélkül): melyik konnektor
 * postafiók, mit lát a modell a briefingben, és hogyan kerül az aláírás a kimenő
 * AgentMail-levél végére.
 */

export const AGENTMAIL_PROVIDER = 'agentmail'

export type MailboxKind = 'agentmail' | 'google' | 'microsoft'

export type MailboxConnectorInfo = { kind: MailboxKind; address: string | null }

type ConnectorLike = { type: string; authMode?: string | null; name?: string | null; config?: unknown }

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

const EMAIL_RE = /[^\s<>()"',;:]+@[^\s<>()"',;:]+\.[^\s<>()"',;:]+/

function emailIn(text: unknown): string | null {
  if (typeof text !== 'string') return null
  return text.match(EMAIL_RE)?.[0]?.toLowerCase() ?? null
}

/**
 * Postafiók-e a konnektor, és mi a címe. AgentMail: `http_api` + `config.provider`;
 * tenant-szintű Gmail / M365 (#1028): `service` konnektor `config.mailbox` jelöléssel.
 */
export function mailboxConnectorInfo(connector: ConnectorLike): MailboxConnectorInfo | null {
  const config = isRecord(connector.config) ? connector.config : {}
  if (connector.type === 'http_api' && config.provider === AGENTMAIL_PROVIDER) {
    // A konnektor neve „AgentMail · cim@domain” — ebből olvasható ki a cím.
    return { kind: 'agentmail', address: emailIn(connector.name) ?? emailIn(config.description) }
  }
  const mailbox = isRecord(config.mailbox) ? config.mailbox : null
  if (mailbox && (connector.authMode ?? 'service') === 'service' && (mailbox.source === 'google' || mailbox.source === 'microsoft')) {
    return { kind: mailbox.source, address: emailIn(mailbox.address) }
  }
  return null
}

export function mailboxKindLabel(kind: MailboxKind): string {
  if (kind === 'agentmail') return 'AgentMail'
  return kind === 'google' ? 'Gmail' : 'Microsoft 365'
}

export function effectiveMailDisplayName(agent: { name: string; mailDisplayName?: string | null }): string {
  return agent.mailDisplayName?.trim() || agent.name.trim()
}

const ACCENTS: Record<string, string> = { á: 'a', é: 'e', í: 'i', ó: 'o', ö: 'o', ő: 'o', ú: 'u', ü: 'u', ű: 'u' }

/** Az agent nevéből képzett postafiók-felhasználónév (pl. „Számlázási asszisztens” → `szamlazasi-asszisztens`). */
export function suggestMailboxUsername(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[áéíóöőúüű]/g, (ch) => ACCENTS[ch] ?? ch)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '')
  return slug || 'asszisztens'
}

export type AgentMailIdentity = {
  primary: {
    connectorId: string
    connectorName: string
    kind: MailboxKind
    address: string | null
    displayName: string
    signature: string | null
  } | null
  /** A korábbi saját cím megszűnt (a konnektort törölték / leválasztották). */
  lostPrimaryAddress: string | null
  /** A többi hozzáférhető postafiók (nem saját cím). */
  others: Array<{ connectorId: string; connectorName: string; kind: MailboxKind; address: string | null; accessMode: 'read' | 'write' }>
  /** Az agenthez a felhasználó saját Gmailje is be van kötve (gmail_* eszközök). */
  userGmail: boolean
}

export const EMPTY_MAIL_IDENTITY: AgentMailIdentity = { primary: null, lostPrimaryAddress: null, others: [], userGmail: false }

export function hasMailIdentity(identity: AgentMailIdentity | null | undefined): identity is AgentMailIdentity {
  return Boolean(identity && (identity.primary || identity.others.length > 0))
}

function mailboxLabel(row: { connectorName: string; kind: MailboxKind; address: string | null }): string {
  return row.address ? `\`${row.address}\` (${mailboxKindLabel(row.kind)})` : `${row.connectorName} (${mailboxKindLabel(row.kind)})`
}

function sendHint(row: { connectorName: string; connectorId: string; kind: MailboxKind }): string {
  if (row.kind === 'agentmail') {
    return `send with http_api_request POST /messages/send (reply: POST /messages/{message_id}/reply), connectorName "${row.connectorName}"`
  }
  if (row.kind === 'microsoft') return `send with http_api_request POST /v1.0/me/sendMail, connectorId ${row.connectorId}`
  return `send with gmail_send, connectorId ${row.connectorId}`
}

/** A briefing „Your e-mail identity” blokkja; null, ha az agentnek nincs postafiókja. */
export function renderMailIdentityBriefingLines(identity: AgentMailIdentity | null | undefined): string[] | null {
  if (!hasMailIdentity(identity)) return null
  const lines = ['## Your e-mail identity', '']
  const { primary } = identity
  if (primary) {
    lines.push(
      `- Your own e-mail address: ${mailboxLabel(primary)}, display name: ${primary.displayName}. Unless the user says otherwise, send from this address — ${sendHint(primary)}.`,
      primary.signature
        ? '- Your signature is added to the end of every message you send from this address automatically — do not type it yourself.'
        : '- Sign messages from this address with your display name.',
      '- A message sent to this address is addressed to you; a message in another mailbox is addressed to its owner.',
    )
  } else {
    lines.push('- You have no own e-mail address. Do not send from a shared mailbox unless the user asks you to.')
  }
  if (identity.others.length > 0 || identity.userGmail) {
    const others = identity.others.map((row) => `${mailboxLabel(row)}${row.accessMode === 'read' ? ' (read only)' : ''}`)
    if (identity.userGmail) others.unshift("the user's own Gmail (gmail_* tools; accounts: platform.whoami → linkedAccounts)")
    lines.push(
      `- You can also access: ${others.join('; ')}. These are not your address: use them only when the user explicitly asks (e.g. "send it from my own account").`,
    )
  }
  return lines
}

/** A `get_definition` válaszának gépi blokkja (a briefing mellé). */
export function mailIdentityDefinitionBlock(identity: AgentMailIdentity | null | undefined) {
  if (!hasMailIdentity(identity)) return {}
  return {
    mailIdentity: {
      primary: identity.primary
        ? {
            connectorId: identity.primary.connectorId,
            connectorName: identity.primary.connectorName,
            provider: identity.primary.kind,
            address: identity.primary.address,
            displayName: identity.primary.displayName,
            hasSignature: Boolean(identity.primary.signature),
          }
        : null,
      others: identity.others.map((row) => ({
        connectorId: row.connectorId,
        connectorName: row.connectorName,
        provider: row.kind,
        address: row.address,
        accessMode: row.accessMode,
      })),
      userGmail: identity.userGmail,
    },
  }
}

// ── Kimenő levél: aláírás ────────────────────────────────────────────────────

const AGENTMAIL_SEND_PATH = /^\/?messages\/(send|[^/]+\/(reply|reply-all|forward))\/?$/

export function isAgentMailSendRequest(method: unknown, path: unknown): boolean {
  return typeof method === 'string' && method.toUpperCase() === 'POST' && typeof path === 'string' && AGENTMAIL_SEND_PATH.test(path.trim())
}

const squash = (text: string) => text.replace(/\s+/g, ' ').trim().toLowerCase()

/** A szöveg már tartalmazza-e az aláírást (szóköz- és kisbetű-függetlenül). */
export function containsSignature(text: string, signature: string): boolean {
  const sig = squash(signature)
  return sig.length > 0 && squash(text).includes(sig)
}

export function appendTextSignature(text: string, signature: string): string {
  const sig = signature.trim()
  if (!sig || containsSignature(text, sig)) return text
  return `${text.replace(/\s+$/, '')}\n\n${sig}`
}

const escapeHtml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export function appendHtmlSignature(html: string, signature: string): string {
  const sig = signature.trim()
  const plain = html.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ')
  if (!sig || containsSignature(plain, sig)) return html
  const block = `<p>${escapeHtml(sig).replace(/\r?\n/g, '<br>')}</p>`
  return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${block}</body>`) : `${html}${block}`
}

/**
 * http_api_request AgentMail-küldés body-jába teszi az aláírást (text és html is).
 * Nem JSON body / nem küldés / üres aláírás → változatlan args.
 */
export function withAgentMailSignature(args: Record<string, unknown>, signature: string | null | undefined): Record<string, unknown> {
  const sig = signature?.trim()
  if (!sig || !isAgentMailSendRequest(args.method, args.path) || typeof args.body !== 'string') return args
  let body: unknown
  try {
    body = JSON.parse(args.body)
  } catch {
    return args
  }
  if (!isRecord(body)) return args
  const next = { ...body }
  if (typeof next.text === 'string') next.text = appendTextSignature(next.text, sig)
  if (typeof next.html === 'string') next.html = appendHtmlSignature(next.html, sig)
  if (next.text === body.text && next.html === body.html) return args
  return { ...args, body: JSON.stringify(next) }
}
