import type { Connector, ConnectorGrant } from '@prisma/client'
import type { ConnectorAccessMode } from '@prisma/client'

export type AgentDelegatedConnectorRow = {
  connector: Pick<Connector, 'id' | 'name' | 'type' | 'authMode' | 'lifecycleState' | 'config'>
  accessMode: ConnectorAccessMode
  grant: Pick<ConnectorGrant, 'accountLabel' | 'status'> | null
}

export function connectorFriendlyLabel(type: string, name: string): string {
  if (type === 'gmail') return 'Gmail'
  return name
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

export function extractGmailScopesFromConfig(config: unknown): string[] {
  const cfg = config as { oauth?: { scopes?: unknown } } | null
  const scopes = cfg?.oauth?.scopes
  if (!Array.isArray(scopes)) return ['https://www.googleapis.com/auth/gmail.modify']
  return scopes.filter((s): s is string => typeof s === 'string')
}
