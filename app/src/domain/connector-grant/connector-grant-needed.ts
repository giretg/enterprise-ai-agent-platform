/**
 * Delegált connector (per-user OAuth) hozzáférés-hiány a chat/ticket futás közben.
 *
 * Ha az agentnek VAN `user_delegated` eszköze, de a user még nem adott
 * OAuth-grantet (vagy a scope nem elég), a loop NEM fejezi be „kész"-ként a
 * feladatot: kártyát mutat, OAuth-ot indít, siker után folytat.
 *
 * A modul provider-független — a Gmail csak egy bejegyzés a
 * {@link ./delegated-oauth-registry} regiszterben. Egy új delegált OAuth
 * connector kód nélkül megkapja ugyanezt a kaput.
 */
import {
  delegatedConnectorLabel,
  delegatedConnectorTypeForTool,
  delegatedScopeDeniedReason,
  GENERIC_SCOPE_DENIED_REASON,
  registeredDelegatedProviderTypes,
} from './delegated-oauth-registry'

/**
 * A grant-kapu okai. A `connector_scope_not_granted` a kanonikus scope-hiány;
 * a `gmail_scope_not_granted` a Gmail providertől jövő, auditban rögzített
 * történeti alak — a régi `tool_calls` sorok miatt is fel kell ismernünk.
 */
export const CONNECTOR_GRANT_NEEDED_REASONS = [
  'connector_grant_missing',
  GENERIC_SCOPE_DENIED_REASON,
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
  /** A regiszterből számolt típus — a kártya és a prompt címkéjéhez. */
  connectorType?: string
}

/** Minden scope-hiány ok — provider-specifikus alakokkal együtt. */
const SCOPE_NOT_GRANTED_REASONS = new Set<string>([
  GENERIC_SCOPE_DENIED_REASON,
  ...registeredDelegatedProviderTypes().map((type) => delegatedScopeDeniedReason(type)),
])

export function isConnectorGrantNeededReason(
  reason: string | null | undefined,
): reason is ConnectorGrantNeededReason {
  if (!reason) return false
  return reason === 'connector_grant_missing' || SCOPE_NOT_GRANTED_REASONS.has(reason)
}

export function isScopeNotGrantedReason(reason: string | null | undefined): boolean {
  return Boolean(reason) && SCOPE_NOT_GRANTED_REASONS.has(reason as string)
}

/** Az eszközhöz tartozó delegált connector-típus, ha ismert providerhez tartozik. */
export function connectorTypeForGrantTool(toolName: string): string | null {
  return delegatedConnectorTypeForTool(toolName)
}

/** Emberi címke a kártyán / a modellnek szánt szövegben. */
export function connectorGrantLabel(card: {
  connectorType?: string | null
  connectorName?: string | null
}): string {
  return delegatedConnectorLabel(card.connectorType, card.connectorName)
}

/**
 * Élő stream-kártya a loop eseményéből. A típus/címke a regiszterből jön —
 * Gmail-hardcode nélkül, különben egy Drive/Slack/saját API gombja is
 * „Gmail”-t írna, amíg a lap újra nem tölt.
 *
 * A chat-stream JSON-ja laza (`reason: string`); itt szűkítjük a kártya okát.
 */
export function connectorGrantCardFromLoopEvent(event: {
  connectorId: string
  toolName: string
  reason: string
  connectorType?: string
}): ConnectorGrantNeededCard {
  const reason: ConnectorGrantNeededReason = isConnectorGrantNeededReason(event.reason)
    ? event.reason
    : 'connector_grant_missing'
  const connectorType =
    event.connectorType ?? connectorTypeForGrantTool(event.toolName) ?? 'http_api'
  return {
    connectorId: event.connectorId,
    connectorType,
    connectorName: delegatedConnectorLabel(connectorType),
    toolName: event.toolName,
    reason,
    scopes: [],
  }
}

/** Az érintett fiókok felsorolása („Gmail, Google Drive") — prompt/komment szöveghez. */
export function describeConnectorGrantTargets(
  cards: Array<{ connectorType?: string | null; connectorName?: string | null }>,
): string {
  const labels = [...new Set(cards.map((card) => connectorGrantLabel(card)))]
  if (labels.length === 0) return 'a szükséges külső fiók'
  return labels.join(', ')
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
  'A felhasználó megadta a kért fiók-hozzáférést (OAuth). ' +
  'A korábban elutasított delegált eszközök most már futtathatók. ' +
  'Folytasd a feladatot: hívd újra a szükséges eszközt, és fejezd be amit elkezdtél. ' +
  'Ne kérj újra hozzáférést, ne mondd hogy a fiók nincs összekötve.'

export const CONNECTOR_GRANT_NEEDED_TICKET_NOTE =
  'Hozzáférés megadva — folytasd a feladatot a korábban elutasított külső fiókos lépéssel; ne kezdd elölről.'

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
    const connectorType =
      typeof rec.connectorType === 'string' && rec.connectorType
        ? rec.connectorType
        : (connectorTypeForGrantTool(rec.toolName) ?? 'http_api')
    cards.push({
      connectorId: rec.connectorId,
      connectorType,
      connectorName:
        typeof rec.connectorName === 'string' && rec.connectorName
          ? rec.connectorName
          : delegatedConnectorLabel(connectorType),
      toolName: rec.toolName,
      reason: rec.reason as ConnectorGrantNeededReason,
      scopes: Array.isArray(rec.scopes)
        ? rec.scopes.filter((scope): scope is string => typeof scope === 'string')
        : [],
    })
  }
  return cards
}
