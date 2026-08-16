/**
 * Delegált connector (Gmail-first) hozzáférés-hiány a chat/ticket futás közben.
 *
 * Ha az agentnek VAN gmail/user_delegated eszköze, de a user még nem adott
 * OAuth-grantet (vagy a scope nem elég), a loop NEM fejezi be „kész”-ként a
 * feladatot: kártyát mutat, OAuth-ot indít, siker után folytat.
 */
import { GMAIL_SCOPES } from './gmail-scopes'

export const CONNECTOR_GRANT_NEEDED_REASONS = [
  'connector_grant_missing',
  'gmail_scope_not_granted',
] as const

export type ConnectorGrantNeededReason = (typeof CONNECTOR_GRANT_NEEDED_REASONS)[number]

export const CONNECTOR_GRANT_NEEDED_VISIBILITY_MS = 24 * 60 * 60 * 1000

export type OAuthReturnTo = {
  kind: 'conversation' | 'ticket'
  id: string
  agentId?: string
}

export type ConnectorGrantNeededCard = {
  connectorId: string
  connectorType: string
  connectorName: string
  toolName: string
  reason: ConnectorGrantNeededReason
  scopes: string[]
}

export type ToolLoopConnectorGrantNeededEvent = {
  connectorId: string
  toolName: string
  reason: ConnectorGrantNeededReason
}

export function isConnectorGrantNeededReason(reason: string | null | undefined): reason is ConnectorGrantNeededReason {
  return reason === 'connector_grant_missing' || reason === 'gmail_scope_not_granted'
}

export function isGmailFamilyTool(toolName: string): boolean {
  return toolName.startsWith('gmail_') || toolName === 'mailbox_count'
}

/** A toolhoz kért minimális Gmail-scope-ok — OAuth-nál a connector configgal uniózva. */
export function scopesSuggestedForGrantNeeded(toolName: string): string[] {
  if (toolName === 'gmail_send') return [GMAIL_SCOPES.modify, GMAIL_SCOPES.send]
  if (toolName === 'gmail_create_draft') return [GMAIL_SCOPES.modify, GMAIL_SCOPES.compose]
  if (isGmailFamilyTool(toolName)) return [GMAIL_SCOPES.readonly]
  return []
}

export function mergeOauthScopes(...groups: Array<string[] | undefined>): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const group of groups) {
    if (!group) continue
    for (const scope of group) {
      const trimmed = scope.trim()
      if (!trimmed || seen.has(trimmed)) continue
      seen.add(trimmed)
      out.push(trimmed)
    }
  }
  return out
}

/**
 * OAuth utáni visszatérési útvonal. A kliens NEM küldhet nyers URL-t —
 * csak kind + uuid, a path itt áll össze (open redirect ellen).
 */
export function oauthReturnPath(returnTo: OAuthReturnTo): string {
  if (returnTo.kind === 'ticket') {
    return `/control-plane/tickets/${returnTo.id}?granted=1`
  }
  if (returnTo.agentId) {
    return `/control-plane/agents/${returnTo.agentId}?conversation=${returnTo.id}&granted=1`
  }
  return `/control-plane/connectors?connected=1`
}

export function isSafeOAuthReturnTo(value: unknown): value is OAuthReturnTo {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const rec = value as Record<string, unknown>
  if (rec.kind !== 'conversation' && rec.kind !== 'ticket') return false
  if (typeof rec.id !== 'string' || !isUuid(rec.id)) return false
  if (rec.agentId !== undefined && (typeof rec.agentId !== 'string' || !isUuid(rec.agentId))) {
    return false
  }
  return true
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  )
}

export const CONNECTOR_GRANT_NEEDED_CHAT_PROMPT =
  'A felhasználó megadta a kért connector-hozzáférést (OAuth). ' +
  'A korábban elutasított Gmail/delegált eszközök most már futtathatók. ' +
  'Folytasd a feladatot: hívd újra a szükséges eszközt, és fejezd be amit elkezdtél. ' +
  'Ne kérj újra hozzáférést, ne mondd hogy a fiók nincs összekötve.'

export const CONNECTOR_GRANT_NEEDED_TICKET_NOTE =
  'Hozzáférés megadva — folytasd a feladatot a korábban elutasított Gmail/connector lépéssel; ne kezdd elölről.'

export function readConnectorGrantNeedsFromPayload(payload: unknown): ConnectorGrantNeededCard[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return []
  const raw = (payload as { connectorGrantNeeds?: unknown }).connectorGrantNeeds
  if (!Array.isArray(raw)) return []
  const cards: ConnectorGrantNeededCard[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const rec = item as Record<string, unknown>
    if (typeof rec.connectorId !== 'string' || typeof rec.toolName !== 'string') continue
    if (!isConnectorGrantNeededReason(typeof rec.reason === 'string' ? rec.reason : '')) continue
    cards.push({
      connectorId: rec.connectorId,
      connectorType: typeof rec.connectorType === 'string' ? rec.connectorType : 'gmail',
      connectorName: typeof rec.connectorName === 'string' ? rec.connectorName : 'Gmail',
      toolName: rec.toolName,
      reason: rec.reason as ConnectorGrantNeededReason,
      scopes: Array.isArray(rec.scopes)
        ? rec.scopes.filter((scope): scope is string => typeof scope === 'string')
        : [],
    })
  }
  return cards
}
