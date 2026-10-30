/**
 * #1028 tenant-szintű postafiók: az admin egyszer köti be (OAuth), a token a tenanté,
 * és bármelyik agenthez rendelhető. A konnektor `authMode: 'service'`, a configjában
 * `mailbox` jelöli; a token a konnektor egyetlen `ownerType: 'tenant'` grantjéből jön.
 */

export type TenantMailboxSource = 'google' | 'microsoft'

export type TenantMailboxConfig = {
  source: TenantMailboxSource
  /** Csak olvasási scope-pal kötötték be — `write` hozzárendelés nem engedett. */
  readOnly: boolean
  /** Az admin kikényszerítette a jóváhagyást: az agent írási módja nem kerülheti meg. */
  requireApproval: boolean
  /** A bekötött cím (a grant `accountLabel`-je); bekötés előtt üres. */
  address?: string
}

export const TENANT_MAILBOX_DISCONNECTED = 'tenant_mailbox_disconnected'
export const TENANT_MAILBOX_READ_ONLY = 'tenant_mailbox_read_only'

export const TENANT_MAILBOX_ASSIGN_WARNING =
  'Az agent minden használója olvashatja ennek a postafióknak a leveleit, és az agent a postafiók nevében küldhet. A jóváhagyás szükségességét a postafiók és az agent beállításai határozzák meg.'

const MICROSOFT_READ_SCOPES = ['offline_access', 'User.Read', 'Mail.Read']
const MICROSOFT_SEND_SCOPE = 'Mail.Send'

export const MICROSOFT_SEND_MAIL_ENDPOINT = {
  name: 'send_mail',
  method: 'POST',
  path: '/v1.0/me/sendMail',
  access: 'write',
  description: 'Send mail from the connected mailbox.',
} as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function parseTenantMailboxConfig(value: unknown): TenantMailboxConfig | null {
  if (!isRecord(value)) return null
  if (value.source !== 'google' && value.source !== 'microsoft') return null
  return {
    source: value.source,
    readOnly: value.readOnly === true,
    requireApproval: value.requireApproval !== false,
    ...(typeof value.address === 'string' && value.address.trim() ? { address: value.address.trim() } : {}),
  }
}

/** Tenant-postafiók-e a konnektor; csak `service` módban érvényes a jelölés. */
export function tenantMailboxOf(connector: { authMode: string; config?: unknown }): TenantMailboxConfig | null {
  if (connector.authMode !== 'service') return null
  const config = isRecord(connector.config) ? connector.config : null
  return parseTenantMailboxConfig(config?.mailbox)
}

/** A token grantből jön-e: user-delegált konnektornál a hívóé, tenant-postafióknál a tenanté. */
export function connectorUsesGrantToken(connector: { authMode: string; config?: unknown }): boolean {
  return connector.authMode === 'user_delegated' || tenantMailboxOf(connector) !== null
}

export function tenantMailboxScopes(source: TenantMailboxSource, readOnly: boolean): string[] {
  if (source === 'google') return [readOnly ? 'gmail.readonly' : 'gmail.modify']
  return readOnly ? [...MICROSOFT_READ_SCOPES] : [...MICROSOFT_READ_SCOPES, MICROSOFT_SEND_SCOPE]
}

export function assertTenantMailboxAccessMode(
  mailbox: TenantMailboxConfig | null,
  accessMode: 'read' | 'write',
): void {
  if (mailbox?.readOnly && accessMode === 'write') throw new Error(TENANT_MAILBOX_READ_ONLY)
}

/** Az írási mód megkerülheti-e a jóváhagyást ezen a konnektoron. */
export function tenantMailboxForcesApproval(connector: { authMode: string; config?: unknown }): boolean {
  return tenantMailboxOf(connector)?.requireApproval === true
}

/** A usernek szóló hiba: nem OAuth-link, mert a postafiókot csak az admin kötheti újra. */
export function tenantMailboxDisconnectedMessage(address: string | null | undefined): string {
  const label = address?.trim() || 'közös'
  return `A(z) ${label} postafiók kapcsolata megszakadt — szólj az adminnak.`
}

/**
 * Microsoft 365 klón-config: a scope-ok a bekötés módjához igazodnak, írható postafióknál
 * a küldés végpontja is bekerül (a sablon alapból csak olvas).
 */
export function microsoftMailboxConfig(
  baseConfig: Record<string, unknown>,
  mailbox: TenantMailboxConfig,
): Record<string, unknown> {
  const scopes = tenantMailboxScopes('microsoft', mailbox.readOnly)
  const next: Record<string, unknown> = { ...baseConfig, mailbox }
  if (isRecord(baseConfig.oauth) && Array.isArray(baseConfig.oauth.scopes)) {
    next.oauth = { ...baseConfig.oauth, scopes }
  } else if (isRecord(baseConfig.auth)) {
    next.auth = { ...baseConfig.auth, scope: scopes.join(' ') }
  }
  if (!mailbox.readOnly) {
    for (const key of ['endpoints', 'proposedTools'] as const) {
      const list = baseConfig[key]
      if (!Array.isArray(list)) continue
      const has = list.some((row) => isRecord(row) && row.path === MICROSOFT_SEND_MAIL_ENDPOINT.path)
      next[key] = has ? list : [...list, { ...MICROSOFT_SEND_MAIL_ENDPOINT }]
    }
  }
  return next
}

export function isMicrosoft365Connector(connector: { type: string; config?: unknown }): boolean {
  if (connector.type !== 'http_api' || !isRecord(connector.config)) return false
  const provenance = connector.config.provenance
  return isRecord(provenance) && provenance.templateKey === 'microsoft-365'
}
