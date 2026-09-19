import type { AgentDefinition } from '@/domain/agent-definition'
import {
  delegatedScopeDeniedReason,
  isDelegatedToolAllowedByScopes,
  parseDelegatedGrantScopes,
} from '@/domain/connector-grant/delegated-oauth-registry'
import { TOOL_REQUIREMENTS } from '@/domain/connector-grant/tool-connector-requirements'
import { asUuid } from './tool-error-messages'

export type ToolCallPrincipal = {
  userId: string
  tenantId: string
  role: string
  assumed: boolean
}

export type AuthorizeToolCallInput = {
  principal: ToolCallPrincipal
  definition: AgentDefinition
  toolName: string
  args: Record<string, unknown>
}

export type LiveConnectorRow = {
  id: string
  tenantId: string
  type: string
  authMode: string
  lifecycleState: string
  name?: string
  secretAlias?: string | null
  config?: unknown
}

export type AuthorizeToolCallDenied = {
  allowed: false
  reason: string
  connectorId?: string
}

export type AuthorizeToolCallAllowed = {
  allowed: true
  connectorId: string
  connector: LiveConnectorRow
  grantId?: string | null
  tokenRef?: string | null
}

export type AuthorizeToolCallResult = AuthorizeToolCallAllowed | AuthorizeToolCallDenied

export type LiveGrantRow = {
  id: string
  tokenRef: string
  scopes: unknown
  status: string
  metadata?: unknown
}

export type AuthorizeToolCallDeps = {
  findConnector: (id: string) => Promise<LiveConnectorRow | null>
  findActiveGrant: (input: {
    tenantId: string
    connectorId: string
    userId: string
  }) => Promise<LiveGrantRow | null>
}

function missingConnectorReason(connectorType: string, accessMode: string): string {
  return `missing_${connectorType}_connector_${accessMode}`
}

function pickBinding(
  definition: AgentDefinition,
  connectorType: string,
  accessMode: string,
  connectorIdArg: string | undefined,
): { connectorId: string } | { reason: string } {
  const candidates = definition.snapshot.connectors.filter(
    (row) =>
      row.type === connectorType &&
      (accessMode === 'read' ? row.accessMode === 'read' || row.accessMode === 'write' : row.accessMode === 'write'),
  )
  if (connectorIdArg) {
    const hit = candidates.find((row) => row.connectorId === connectorIdArg)
    if (!hit) return { reason: missingConnectorReason(connectorType, accessMode) }
    return { connectorId: hit.connectorId }
  }
  if (candidates.length === 1) return { connectorId: candidates[0].connectorId }
  if (candidates.length === 0) return { reason: missingConnectorReason(connectorType, accessMode) }
  return { reason: 'connector_id_required' }
}

export async function authorizeToolCall(
  deps: AuthorizeToolCallDeps,
  input: AuthorizeToolCallInput,
): Promise<AuthorizeToolCallResult> {
  const requirement = TOOL_REQUIREMENTS[input.toolName]
  if (!requirement) {
    return { allowed: false, reason: 'tool_not_configured' }
  }

  const capability = input.definition.snapshot.capabilities.find(
    (row) => row.toolName === input.toolName && row.allowed,
  )
  if (!capability) {
    return { allowed: false, reason: 'capability_not_allowed' }
  }

  const picked = pickBinding(
    input.definition,
    requirement.connectorType,
    requirement.accessMode,
    asUuid(input.args.connectorId),
  )
  if ('reason' in picked) {
    return { allowed: false, reason: picked.reason }
  }

  const connector = await deps.findConnector(picked.connectorId)
  if (!connector) {
    return { allowed: false, reason: 'connector_not_active' }
  }
  if (connector.tenantId !== input.principal.tenantId) {
    return { allowed: false, reason: 'tenant_isolation' }
  }
  if (connector.lifecycleState !== 'active') {
    return { allowed: false, reason: 'connector_not_active' }
  }
  if (connector.type !== requirement.connectorType) {
    return { allowed: false, reason: 'connector_not_active' }
  }

  if (requirement.connectorType === 'knowledge_base') {
    return {
      allowed: true,
      connectorId: connector.id,
      connector,
      grantId: null,
      tokenRef: null,
    }
  }

  const delegated = connector.authMode === 'user_delegated'
  if (!delegated && requirement.connectorType !== 'http_api') {
    return { allowed: false, reason: 'acting_user_required' }
  }

  if (!delegated) {
    return {
      allowed: true,
      connectorId: connector.id,
      connector,
    }
  }

  const grant = await deps.findActiveGrant({
    tenantId: input.principal.tenantId,
    connectorId: connector.id,
    userId: input.principal.userId,
  })
  if (!grant) {
    return { allowed: false, reason: 'connector_grant_missing', connectorId: connector.id }
  }

  const scopes = parseDelegatedGrantScopes(grant.scopes)
  if (
    !isDelegatedToolAllowedByScopes({
      connectorType: connector.type,
      toolName: input.toolName,
      args: input.args,
      scopes,
    })
  ) {
    return {
      allowed: false,
      reason: delegatedScopeDeniedReason(connector.type),
      connectorId: connector.id,
    }
  }

  return {
    allowed: true,
    connectorId: connector.id,
    connector,
    grantId: grant.id,
    tokenRef: grant.tokenRef,
  }
}
