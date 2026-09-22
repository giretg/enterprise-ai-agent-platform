import type { AgentDefinition, AgentDefinitionSnapshot } from '@/domain/agent-definition'
import { findHttpApiEndpoint } from '@/domain/connector/http-api-client'
import {
  delegatedScopeDeniedReason,
  isDelegatedToolAllowedByScopes,
  parseDelegatedGrantScopes,
} from '@/domain/connector-grant/delegated-oauth-registry'
import { TOOL_REQUIREMENTS } from '@/domain/connector-grant/tool-connector-requirements'
import { asUuid } from './tool-error-messages'
import {
  HTTP_API_GET_ALL_TOOL,
  HTTP_API_GET_TOOL,
  HTTP_API_REQUEST_TOOL,
  KB_GET_DOCUMENT_TOOL,
  KB_GET_PAGE_TOOL,
  KB_LIST_INDEX_TOOL,
  KB_SEARCH_TOOL,
} from './tool-definitions'

const KB_READ_TOOLS = [KB_GET_DOCUMENT_TOOL, KB_GET_PAGE_TOOL, KB_LIST_INDEX_TOOL, KB_SEARCH_TOOL]

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

export type HttpApiConnectorChoice = {
  connectorId: string
  name?: string
  description?: string | null
}

export type AuthorizeToolCallDenied = {
  allowed: false
  reason: string
  connectorId?: string
  /** Több http_api kötés esetén, ha path alapján nem egyértelmű. */
  connectorChoices?: HttpApiConnectorChoice[]
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

type SnapshotConnector = AgentDefinitionSnapshot['connectors'][number]

function httpMethodForTool(toolName: string, args: Record<string, unknown>): string | null {
  if (toolName === HTTP_API_REQUEST_TOOL) {
    const method = args.method
    return typeof method === 'string' ? method.toUpperCase() : null
  }
  if (toolName === HTTP_API_GET_TOOL || toolName === HTTP_API_GET_ALL_TOOL) return 'GET'
  return null
}

function connectorSnapshotRow(
  definition: AgentDefinition,
  connectorId: string,
): SnapshotConnector | undefined {
  return definition.snapshot.connectors.find((row) => row.connectorId === connectorId)
}

function httpApiSnapshotHasEndpoint(row: SnapshotConnector, method: string, path: string): boolean {
  if (!row.endpoints?.length) return false
  return (
    findHttpApiEndpoint({ endpoints: row.endpoints }, method, path) !== undefined
  )
}

function normalizeConnectorName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function pickByConnectorName(
  candidates: SnapshotConnector[],
  connectorName: string,
): SnapshotConnector[] {
  const wanted = connectorName.trim().toLowerCase()
  return candidates.filter((row) => row.name?.trim().toLowerCase() === wanted)
}

function connectorChoicesFromCandidates(
  definition: AgentDefinition,
  candidates: SnapshotConnector[],
): HttpApiConnectorChoice[] {
  return candidates.map((row) => {
    const snap = connectorSnapshotRow(definition, row.connectorId)
    return {
      connectorId: row.connectorId,
      name: snap?.name ?? row.name,
      description: snap?.description ?? null,
    }
  })
}

function pickBinding(
  definition: AgentDefinition,
  connectorType: string,
  accessMode: string,
  connectorIdArg: string | undefined,
  connectorNameArg: string | undefined,
  toolName: string,
  args: Record<string, unknown>,
): { connectorId: string } | { reason: string; connectorChoices?: HttpApiConnectorChoice[] } {
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
  if (connectorNameArg) {
    const byName = pickByConnectorName(candidates, connectorNameArg)
    if (byName.length === 1) return { connectorId: byName[0].connectorId }
    if (byName.length > 1) {
      return {
        reason: 'connector_id_required',
        connectorChoices: connectorChoicesFromCandidates(definition, byName),
      }
    }
    return { reason: missingConnectorReason(connectorType, accessMode) }
  }
  if (candidates.length === 1) return { connectorId: candidates[0].connectorId }
  if (candidates.length === 0) return { reason: missingConnectorReason(connectorType, accessMode) }

  if (connectorType === 'http_api') {
    const path = typeof args.path === 'string' ? args.path : ''
    const method = httpMethodForTool(toolName, args)
    if (path && method) {
      const byEndpoint = candidates.filter((row) => {
        const snap = connectorSnapshotRow(definition, row.connectorId)
        return snap ? httpApiSnapshotHasEndpoint(snap, method, path) : false
      })
      if (byEndpoint.length === 1) return { connectorId: byEndpoint[0].connectorId }
    }
    return {
      reason: 'connector_id_required',
      connectorChoices: connectorChoicesFromCandidates(definition, candidates),
    }
  }

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

  const accepted =
    input.toolName === KB_GET_DOCUMENT_TOOL ? KB_READ_TOOLS : [input.toolName]
  const capability = input.definition.snapshot.capabilities.find(
    (row) => accepted.includes(row.toolName) && row.allowed,
  )
  if (!capability) {
    return { allowed: false, reason: 'capability_not_allowed' }
  }

  const picked = pickBinding(
    input.definition,
    requirement.connectorType,
    requirement.accessMode,
    asUuid(input.args.connectorId),
    normalizeConnectorName(input.args.connectorName),
    input.toolName,
    input.args,
  )
  if ('reason' in picked) {
    return {
      allowed: false,
      reason: picked.reason,
      ...(picked.connectorChoices ? { connectorChoices: picked.connectorChoices } : {}),
    }
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
