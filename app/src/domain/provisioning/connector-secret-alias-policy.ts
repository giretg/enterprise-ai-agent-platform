/**
 * A külső secret-aliasok platform-konfigurációból, tenant szerint engedélyezhetők.
 *
 * Egy connector-admin a saját connectorát tetszőleges egress-hostra kötheti. Emiatt
 * egy szabadon megadható `env:` vagy `secret-manager:` alias a futó szolgáltatás
 * bármely titkának exfiltrációs útja lenne. A connector saját, `secret-ref:<id>`
 * titka kivétel: azt kizárólag a platform írja a Secret Store-ba a connectorhoz.
 */
export const PLATFORM_SECRET_ALIAS_SCOPE = '__platform__'

export type TrustedConnectorSecretAliasPolicy = Readonly<Record<string, readonly string[]>>

/**
 * `CONNECTOR_TRUSTED_SECRET_ALIASES` alakja:
 * `{ "tenant-uuid": ["env:CUSTOMER_CRM_KEY"], "__platform__": ["secret-manager:projects/.../secrets/shared-key"] }`
 *
 * Hibás vagy hiányzó beállításnál az eredmény üres, vagyis fail-closed.
 */
export function parseTrustedConnectorSecretAliasPolicy(
  raw: string | undefined,
): TrustedConnectorSecretAliasPolicy {
  if (!raw?.trim()) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed)) return {}
    const policy: Record<string, readonly string[]> = {}
    for (const [scope, aliases] of Object.entries(parsed)) {
      if (!Array.isArray(aliases)) continue
      const normalized = aliases.filter(
        (alias): alias is string => typeof alias === 'string' && alias.trim().length > 0,
      )
      if (normalized.length > 0) policy[scope] = normalized.map((alias) => alias.trim())
    }
    return policy
  } catch {
    return {}
  }
}

export function isTrustedExternalConnectorSecretAlias(
  alias: string,
  tenantId: string | null,
  policy: TrustedConnectorSecretAliasPolicy,
): boolean {
  const scope = tenantId ?? PLATFORM_SECRET_ALIAS_SCOPE
  return policy[scope]?.includes(alias.trim()) === true
}

/** A managed Secret Store-ban egy connector csak a SAJÁT referenciáját használhatja. */
export function isConnectorOwnedSecretRef(alias: string, connectorId: string): boolean {
  return alias.trim() === `secret-ref:${connectorId}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
