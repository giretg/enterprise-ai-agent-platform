import type { Connector, ConnectorGrant } from '@prisma/client'
import type { ConnectorAccessMode } from '@prisma/client'
import {
  delegatedConnectorLabel,
  scopesFromConnectorConfig,
} from '@/domain/connector-grant/delegated-oauth-registry'

export type AgentDelegatedConnectorRow = {
  connector: Pick<Connector, 'id' | 'name' | 'type' | 'authMode' | 'lifecycleState' | 'config'>
  accessMode: ConnectorAccessMode
  grant: Pick<ConnectorGrant, 'accountLabel' | 'status'> | null
}

/** Emberi címke: a provider-regiszterből, különben a connector saját neve. */
export function connectorFriendlyLabel(type: string, name: string): string {
  return delegatedConnectorLabel(type, name)
}

export function connectorWithArticle(label: string): string {
  const lower = label.toLocaleLowerCase('hu')
  if (lower.startsWith('gmail')) return 'a Gmail-lel'
  if (lower.includes('drive')) return 'a Google Drive-dal'
  return `a ${label}-dal`
}

export function connectorPossessive(label: string): string {
  const lower = label.toLocaleLowerCase('hu')
  if (lower.startsWith('gmail')) return 'Gmail fiókodhoz'
  if (lower.includes('drive')) return 'Google Drive fiókodhoz'
  return `${label} fiókodhoz`
}

/**
 * A connector configjában konfigurált OAuth-scope-ok — provider-független.
 * (A korábbi Gmail-specifikus olvasás helyén; a Gmail-default a regiszterben él.)
 */
export function connectorOAuthScopesFromConfig(config: unknown, connectorType?: string): string[] {
  return scopesFromConnectorConfig(config, connectorType)
}
