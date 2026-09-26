/**
 * AgentMail admin kliens: a tenant szervezeti kulcsával postafiókot listáz/hoz létre,
 * és postafiókonként szűk (olvasás + küldés) kulcsot generál az agent-kapcsolatnak.
 * A szervezeti kulcs a connector-titoktárban él, soha nem kerül agenthez.
 * Régió: EU (api.agentmail.eu) vagy global (api.agentmail.to) — tenantonként választható.
 */
import {
  buildConnectorSecretRef,
  ConnectorApiKeyMissingError,
  loadConnectorApiKeyByRef,
  saveConnectorApiKey,
} from '@/domain/connector/connector-secret-store'
import {
  AGENTMAIL_API_BASE,
  AGENTMAIL_EU_API_BASE,
  AGENTMAIL_EU_HOST,
  AGENTMAIL_GLOBAL_API_BASE,
  AGENTMAIL_GLOBAL_HOST,
} from '@/domain/connector-template/builtin-templates'

export type AgentMailRegion = 'eu' | 'global'

export const AGENTMAIL_REGIONS: Record<AgentMailRegion, { apiBase: string; host: string; label: string }> = {
  eu: { apiBase: AGENTMAIL_EU_API_BASE, host: AGENTMAIL_EU_HOST, label: 'EU (api.agentmail.eu)' },
  global: { apiBase: AGENTMAIL_GLOBAL_API_BASE, host: AGENTMAIL_GLOBAL_HOST, label: 'Global (api.agentmail.to)' },
}

export function parseAgentMailRegion(value: unknown): AgentMailRegion {
  return value === 'global' ? 'global' : 'eu'
}

export function agentMailApiBase(region: AgentMailRegion): string {
  return AGENTMAIL_REGIONS[region].apiBase
}

export function agentMailEgressHost(region: AgentMailRegion): string {
  return AGENTMAIL_REGIONS[region].host
}

export type AgentMailInbox = { inboxId: string; email: string; displayName: string | null }

type RawInbox = { inbox_id: string; email: string; display_name?: string | null }

export class AgentMailApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'AgentMailApiError'
  }
}

/** Spam / blokkolt / hitelesítetlen / kuka címkéjű levél így rejtve marad az agent elől. */
const AGENT_INBOX_KEY_PERMISSIONS = { inbox_read: true, message_read: true, message_send: true }

const INBOX_BASE_PREFIXES = [AGENTMAIL_EU_API_BASE, AGENTMAIL_GLOBAL_API_BASE].map(
  (base) => `${base}/inboxes/`,
)

const orgKeyRef = (tenantId: string) => buildConnectorSecretRef(`agentmail-org-${tenantId}`)
const regionRef = (tenantId: string) => buildConnectorSecretRef(`agentmail-region-${tenantId}`)

export async function loadAgentMailOrgKey(tenantId: string): Promise<string | null> {
  try {
    return await loadConnectorApiKeyByRef(orgKeyRef(tenantId))
  } catch (e) {
    if (e instanceof ConnectorApiKeyMissingError) return null
    throw e
  }
}

export function saveAgentMailOrgKey(tenantId: string, apiKey: string): Promise<void> {
  return saveConnectorApiKey(`agentmail-org-${tenantId}`, apiKey)
}

/** A tenant választott régiója; hiányában 'eu' (a korábbi EU-only viselkedés). */
export async function loadAgentMailRegion(tenantId: string): Promise<AgentMailRegion> {
  try {
    const raw = await loadConnectorApiKeyByRef(regionRef(tenantId))
    return parseAgentMailRegion(raw.trim())
  } catch (e) {
    if (e instanceof ConnectorApiKeyMissingError) return 'eu'
    throw e
  }
}

export function saveAgentMailRegion(tenantId: string, region: AgentMailRegion): Promise<void> {
  return saveConnectorApiKey(`agentmail-region-${tenantId}`, region)
}

export function agentMailInboxPathSegment(inboxId: string): string {
  return encodeURIComponent(inboxId)
}

export function inboxIdFromConnectorBaseUrl(baseUrl: unknown): string | null {
  if (typeof baseUrl !== 'string') return null
  const prefix = INBOX_BASE_PREFIXES.find((p) => baseUrl.startsWith(p))
  if (!prefix) return null
  const segment = baseUrl.slice(prefix.length).replace(/\/+$/, '')
  if (!segment || segment.includes('/')) return null
  return decodeURIComponent(segment)
}

async function call<T>(
  apiBase: string,
  apiKey: string,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${apiBase}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${apiKey}`,
      accept: 'application/json',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  })
  const data = (await res.json().catch(() => null)) as { message?: string } | null
  if (!res.ok) {
    throw new AgentMailApiError(res.status, data?.message?.trim() || `AgentMail HTTP ${res.status}`)
  }
  return data as T
}

const toInbox = (raw: RawInbox): AgentMailInbox => ({
  inboxId: raw.inbox_id,
  email: raw.email,
  displayName: raw.display_name?.trim() || null,
})

export async function listAgentMailInboxes(apiKey: string, apiBase: string = AGENTMAIL_API_BASE): Promise<AgentMailInbox[]> {
  const inboxes: AgentMailInbox[] = []
  let pageToken: string | undefined
  do {
    const query = `limit=100${pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : ''}`
    const page = await call<{ inboxes: RawInbox[]; next_page_token?: string }>(
      apiBase,
      apiKey,
      'GET',
      `/inboxes?${query}`,
    )
    inboxes.push(...page.inboxes.map(toInbox))
    pageToken = page.next_page_token || undefined
  } while (pageToken)
  return inboxes
}

export async function createAgentMailInbox(
  apiKey: string,
  input: { username?: string; domain?: string; displayName?: string },
  apiBase: string = AGENTMAIL_API_BASE,
): Promise<AgentMailInbox> {
  const raw = await call<RawInbox>(apiBase, apiKey, 'POST', '/inboxes', {
    ...(input.username ? { username: input.username } : {}),
    ...(input.domain ? { domain: input.domain } : {}),
    ...(input.displayName ? { display_name: input.displayName } : {}),
  })
  return toInbox(raw)
}

export async function createAgentInboxApiKey(
  orgKey: string,
  inboxId: string,
  name: string,
  apiBase: string = AGENTMAIL_API_BASE,
): Promise<string> {
  const res = await call<{ api_key: string }>(
    apiBase,
    orgKey,
    'POST',
    `/inboxes/${agentMailInboxPathSegment(inboxId)}/api-keys`,
    { name, permissions: AGENT_INBOX_KEY_PERMISSIONS },
  )
  return res.api_key
}

/** A kapcsolat leírása az agent promptjába kerül — így tudja, mi a saját címe. */
export function agentMailConnectorDescription(inbox: AgentMailInbox): string {
  const identity = inbox.displayName ? `${inbox.displayName} <${inbox.email}>` : inbox.email
  return `A munkatárs SAJÁT postafiókja: ${identity}. Ebből a címből, a saját nevedben levelezel (nem a felhasználó nevében). Küldés: POST /messages/send, válasz: POST /messages/{message_id}/reply — minden kimenő levél emberi jóváhagyás után megy ki. Beérkezett levelek: GET /messages, levélváltások: GET /threads.`
}
