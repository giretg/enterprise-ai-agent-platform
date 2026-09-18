import type { AgentDefinition } from '@/domain/agent-definition'
import {
  isDelegatedToolAllowedByScopes,
  parseDelegatedGrantScopes,
} from '@/domain/connector-grant/delegated-oauth-registry'
import { TOOL_REQUIREMENTS } from '@/domain/connector-grant/tool-connector-requirements'
import type { EnterpriseDriveTool } from './tool-definitions'

export type ToolCallPrincipal = {
  userId: string
  tenantId: string
  role: string
  assumed: boolean
}

export type AuthorizeToolCallInput = {
  principal: ToolCallPrincipal
  definition: AgentDefinition
  toolName: EnterpriseDriveTool | string
  args: Record<string, unknown>
}

export type AuthorizeToolCallDenied = { allowed: false; reason: string }

export type AuthorizeToolCallAllowed = {
  allowed: true
  connectorId: string
  grantId: string
  tokenRef: string
}

export type AuthorizeToolCallResult = AuthorizeToolCallAllowed | AuthorizeToolCallDenied

export type LiveConnectorRow = {
  id: string
  tenantId: string
  type: string
  authMode: string
  lifecycleState: string
}

export type LiveGrantRow = {
  id: string
  tokenRef: string
  scopes: unknown
  status: string
}

export type AuthorizeToolCallDeps = {
  findConnector: (id: string) => Promise<LiveConnectorRow | null>
  findActiveGrant: (input: {
    tenantId: string
    connectorId: string
    userId: string
  }) => Promise<LiveGrantRow | null>
}

export async function authorizeToolCall(
  deps: AuthorizeToolCallDeps,
  input: AuthorizeToolCallInput,
): Promise<AuthorizeToolCallResult> {
  const requirement = TOOL_REQUIREMENTS[input.toolName]
  if (!requirement || requirement.connectorType !== 'google_drive' || requirement.accessMode !== 'read') {
    return { allowed: false, reason: 'tool_not_configured' }
  }

  const capability = input.definition.snapshot.capabilities.find(
    (row) => row.toolName === input.toolName && row.allowed,
  )
  if (!capability) {
    return { allowed: false, reason: 'capability_not_allowed' }
  }

  const binding = input.definition.snapshot.connectors.find(
    (row) => row.type === 'google_drive' && row.accessMode === 'read',
  )
  if (!binding) {
    return { allowed: false, reason: 'missing_google_drive_connector_read' }
  }

  const connector = await deps.findConnector(binding.connectorId)
  if (!connector) {
    return { allowed: false, reason: 'connector_not_active' }
  }
  if (connector.tenantId !== input.principal.tenantId) {
    return { allowed: false, reason: 'tenant_isolation' }
  }
  if (connector.lifecycleState !== 'active') {
    return { allowed: false, reason: 'connector_not_active' }
  }
  if (connector.authMode !== 'user_delegated') {
    return { allowed: false, reason: 'acting_user_required' }
  }

  const grant = await deps.findActiveGrant({
    tenantId: input.principal.tenantId,
    connectorId: connector.id,
    userId: input.principal.userId,
  })
  if (!grant) {
    return { allowed: false, reason: 'connector_grant_missing' }
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
    return { allowed: false, reason: 'google_drive_scope_not_granted' }
  }

  return {
    allowed: true,
    connectorId: connector.id,
    grantId: grant.id,
    tokenRef: grant.tokenRef,
  }
}
