import { canOperateAgent, type AgentDefinition } from '@/domain/agent-definition'
import { isDispatchable } from '@/lib/agent-lifecycle'
import {
  GoogleDriveApiAuthError,
  GoogleDriveApiError,
} from '@/domain/connector-grant/google-drive-api-client'
import { GmailApiAuthError } from '@/domain/connector-grant/gmail-api-client'
import {
  GoogleWorkspaceApiAuthError,
  GoogleWorkspaceApiError,
} from '@/domain/connector-grant/google-workspace-api-client'
import { HttpApiError } from '@/domain/connector/http-api-client'
import {
  authorizeToolCall,
  type AuthorizeToolCallDeps,
  type LiveConnectorRow,
  type ToolCallPrincipal,
} from './authorize-tool-call'
import { checkDefinitionPin, type DefinitionPinDeps } from './definition-pin'
import { executeGoogleDriveTool } from './handlers/google-drive'
import { executeGmailTool } from './handlers/gmail'
import { executeHttpApiTool } from './handlers/http-api'
import { asUuid, enterpriseToolErrorPayload } from './tool-error-messages'
import {
  isEnterpriseGmailTool,
  isEnterpriseHttpTool,
  isEnterpriseKbTool,
  isEnterpriseTool,
  isEnterpriseWriteTool,
  schemaForEnterpriseKbTool,
  schemaForEnterpriseTool,
  type EnterpriseDriveTool,
  type EnterpriseGmailTool,
  type EnterpriseHttpTool,
  type EnterpriseKbTool,
} from './tool-definitions'
import type { AuditSink } from '@/lib/audit/types'
import { writeAudit } from '@/lib/audit/types'
import { isAuthorizationLinkReason } from '@/domain/connector-grant/connector-grant-needed'

export type StartDelegatedAuthorization = (input: {
  connectorId: string
  userId: string
  tenantId: string
  role: string
  toolName: string
}) => Promise<{ url: string } | null>

export type EnterpriseToolMcpResult = {
  isError?: true
  content: Array<{ type: 'text'; text: string }>
}

/** MCP 2026-07-28 multi-round-trip result: the client asks the user, then retries the call (#618). */
export type InputRequiredToolResult = {
  resultType: 'input_required'
  inputRequests: Record<string, unknown>
  requestState: string
}

/** `requestState` payload of a write confirmation, HMAC-sealed by the MCP layer (#618 D6). */
export type WriteConfirmState = {
  v: 1
  operationId: string
  tenantId: string
  userId: string
  tool: string
  argsHash: string
  iat: number
  exp: number
}

/**
 * Write confirmation inputs the MCP layer read off the request (#618).
 * `mint` is null when the form branch is off: 2025 request, no form capability,
 * or no `MCP_REQUEST_STATE_KEY`. `retry` is set when the client retried with
 * `inputResponses` / `requestState`; `state` is the verified payload or the raw
 * wire string when no verifier is configured (never trusted then).
 */
export type WriteConfirmInput = {
  mint: ((state: WriteConfirmState) => Promise<string>) | null
  retry?: {
    state: unknown
    response: { action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> } | null
  }
}

export type HttpApiActingUser = { id: string; email: string; tenantId: string | null } | null

export type EnterpriseToolDeps = AuthorizeToolCallDeps &
  DefinitionPinDeps & {
  loadDefinition: (input: {
    tenantId: string
    definitionId: string
  }) => Promise<AgentDefinition | null>
  findAgentGrant: (input: {
    tenantId: string
    userId: string
    agentId: string
  }) => Promise<{ accessLevel: string } | null>
  resolveAccessToken: (input: {
    connector: LiveConnectorRow
    grantId: string
    tokenRef: string
    actingUserId: string
    tenantId: string
  }) => Promise<string>
  executeDriveTool?: (
    toolName: EnterpriseDriveTool,
    args: Record<string, unknown>,
    accessToken: string,
  ) => Promise<unknown>
  executeGmailTool?: (
    toolName: EnterpriseGmailTool,
    args: Record<string, unknown>,
    accessToken: string,
  ) => Promise<unknown>
  executeHttpApiTool?: (
    toolName: EnterpriseHttpTool,
    args: Record<string, unknown>,
    connector: LiveConnectorRow,
    accessToken?: string,
    actingUser?: HttpApiActingUser,
    allowedEgressHosts?: string[],
  ) => Promise<unknown>
  resolveEgressAllowlist?: (tenantId: string | null) => Promise<string[]>
  resolveActingUser?: (input: { userId: string }) => Promise<{ id: string; email: string } | null>
  executeKbTool?: (
    toolName: EnterpriseKbTool,
    args: Record<string, unknown>,
    ctx: { connectorId: string; tenantId: string; agentId: string; userId: string },
  ) => Promise<unknown>
  enqueueWrite?: (input: {
    principal: ToolCallPrincipal
    toolName: string
    args: Record<string, unknown>
    origin?: string
    confirm?: WriteConfirmInput
  }) => Promise<EnterpriseToolMcpResult | InputRequiredToolResult>
  startAuthorization?: StartDelegatedAuthorization
  audit?: AuditSink
}

function textResult(payload: unknown, isError = false): EnterpriseToolMcpResult {
  return {
    ...(isError ? { isError: true as const } : {}),
    content: [{ type: 'text', text: JSON.stringify(payload) }],
  }
}

function errorResult(code: string, extra?: Record<string, unknown>): EnterpriseToolMcpResult {
  return textResult(enterpriseToolErrorPayload(code, extra), true)
}

export async function authorizationLinkFields(
  startAuthorization: StartDelegatedAuthorization | undefined,
  input: {
    reason: string
    connectorId?: string
    userId: string
    tenantId: string
    role: string
    toolName: string
  },
): Promise<{ authorizationUrl?: string }> {
  if (!startAuthorization || !input.connectorId) return {}
  if (!isAuthorizationLinkReason(input.reason)) return {}
  try {
    const started = await startAuthorization({
      connectorId: input.connectorId,
      userId: input.userId,
      tenantId: input.tenantId,
      role: input.role,
      toolName: input.toolName,
    })
    return started?.url ? { authorizationUrl: started.url } : {}
  } catch {
    return {}
  }
}

async function auditDenied(
  deps: EnterpriseToolDeps,
  principal: ToolCallPrincipal,
  toolName: string,
  reason: string,
  definitionId?: string,
  agentId?: string,
) {
  const payload = {
    toolName,
    reasonCode: reason,
    tenantId: principal.tenantId,
    userId: principal.userId,
    ...(definitionId ? { definitionId } : {}),
    ...(agentId ? { agentId } : {}),
  }
  console.info('enterprise.tool.denied', payload)
  await writeAudit(deps.audit, {
    actorType: 'human',
    actorId: principal.userId,
    agentVersion: null,
    action: 'enterprise.tool.denied',
    targetType: 'agent',
    targetId: agentId ?? null,
    modelUsed: null,
    inputRef: toolName,
    outputRef: reason,
    policyDecision: 'denied',
    metadata: payload,
    tenantId: principal.tenantId,
  })
}

async function resolveDelegatedToken(
  deps: EnterpriseToolDeps,
  principal: ToolCallPrincipal,
  connector: LiveConnectorRow,
  grantId: string | null | undefined,
  tokenRef: string | null | undefined,
): Promise<string> {
  if (!grantId || !tokenRef) throw new Error('connector_grant_missing')
  return deps.resolveAccessToken({
    connector,
    grantId,
    tokenRef,
    actingUserId: principal.userId,
    tenantId: principal.tenantId,
  })
}

export async function invokeEnterpriseTool(
  deps: EnterpriseToolDeps,
  input: {
    principal: ToolCallPrincipal
    toolName: string
    args: Record<string, unknown>
    origin?: string
    confirm?: WriteConfirmInput
  },
): Promise<EnterpriseToolMcpResult | InputRequiredToolResult> {
  const { principal, toolName, args, origin, confirm } = input
  const definitionId = asUuid(args.definitionId)
  if (!definitionId) {
    await auditDenied(deps, principal, toolName, 'definition_not_found')
    return errorResult('definition_not_found')
  }

  const definition = await deps.loadDefinition({
    tenantId: principal.tenantId,
    definitionId,
  })
  if (!definition) {
    await auditDenied(deps, principal, toolName, 'definition_not_found', definitionId)
    return errorResult('definition_not_found')
  }

  if (!isDispatchable(definition.status)) {
    await auditDenied(deps, principal, toolName, 'agent_inactive', definitionId, definition.agentId)
    return errorResult('agent_inactive')
  }

  const pin = await checkDefinitionPin(deps, {
    tenantId: principal.tenantId,
    definition,
  })
  if (!pin.current) {
    await auditDenied(deps, principal, toolName, 'agent_stale', definitionId, definition.agentId)
    return errorResult('agent_stale', {
      agentId: definition.agentId,
      definitionId,
      currentDefinitionId: pin.currentDefinitionId,
    })
  }

  if (args.agentId !== undefined) {
    const agentIdArg = asUuid(args.agentId)
    if (!agentIdArg || agentIdArg !== definition.agentId) {
      await auditDenied(deps, principal, toolName, 'definition_mismatch', definitionId, definition.agentId)
      return errorResult('definition_mismatch')
    }
  }

  const grant = await deps.findAgentGrant({
    tenantId: principal.tenantId,
    userId: principal.userId,
    agentId: definition.agentId,
  })
  if (!canOperateAgent({ role: principal.role, grant, assumed: principal.assumed })) {
    await auditDenied(deps, principal, toolName, 'agent_access_denied', definitionId, definition.agentId)
    return errorResult('agent_access_denied')
  }

  if (isEnterpriseWriteTool(toolName)) {
    if (!deps.enqueueWrite) {
      await auditDenied(deps, principal, toolName, 'tool_not_configured', definitionId, definition.agentId)
      return errorResult('tool_not_configured')
    }
    return deps.enqueueWrite({ principal, toolName, args, origin, confirm })
  }

  if (isEnterpriseKbTool(toolName)) {
    return invokeKbTool(deps, {
      principal,
      toolName,
      args,
      definitionId,
      definition,
    })
  }

  if (!isEnterpriseTool(toolName)) {
    await auditDenied(deps, principal, toolName, 'tool_not_configured', definitionId, definition.agentId)
    return errorResult('tool_not_configured')
  }

  const schema = schemaForEnterpriseTool(toolName)
  if (!schema) {
    await auditDenied(deps, principal, toolName, 'tool_not_configured', definitionId, definition.agentId)
    return errorResult('tool_not_configured')
  }
  const parsed = schema.safeParse(args)
  if (!parsed.success) {
    await auditDenied(deps, principal, toolName, 'invalid_args', definitionId, definition.agentId)
    return errorResult('invalid_args')
  }

  const authorized = await authorizeToolCall(deps, {
    principal,
    definition,
    toolName,
    args: parsed.data as Record<string, unknown>,
  })
  if (!authorized.allowed) {
    await auditDenied(deps, principal, toolName, authorized.reason, definitionId, definition.agentId)
    const extra = await authorizationLinkFields(deps.startAuthorization, {
      reason: authorized.reason,
      connectorId: authorized.connectorId,
      userId: principal.userId,
      tenantId: principal.tenantId,
      role: principal.role,
      toolName,
    })
    return errorResult(authorized.reason, {
      ...extra,
      ...(authorized.connectorChoices?.length
        ? { connectors: authorized.connectorChoices }
        : {}),
    })
  }

  const connector = authorized.connector
  const authFailedCode =
    connector.type === 'gmail'
      ? 'gmail_auth_failed'
      : connector.type === 'http_api'
        ? 'http_api_error'
        : 'google_drive_auth_failed'

  let accessToken: string | undefined
  try {
    if (connector.authMode === 'user_delegated') {
      accessToken = await resolveDelegatedToken(
        deps,
        principal,
        connector,
        authorized.grantId,
        authorized.tokenRef,
      )
    }
  } catch {
    const extra = await authorizationLinkFields(deps.startAuthorization, {
      reason: authFailedCode,
      connectorId: authorized.connectorId,
      userId: principal.userId,
      tenantId: principal.tenantId,
      role: principal.role,
      toolName,
    })
    const payload = {
      toolName,
      tenantId: principal.tenantId,
      userId: principal.userId,
      definitionId,
      agentId: definition.agentId,
      connectorId: authorized.connectorId,
      errorCode: authFailedCode,
    }
    console.info('enterprise.tool.error', payload)
    await writeAudit(deps.audit, {
      actorType: 'human',
      actorId: principal.userId,
      agentVersion: null,
      action: 'enterprise.tool.error',
      targetType: 'agent',
      targetId: definition.agentId,
      modelUsed: null,
      inputRef: toolName,
      outputRef: authFailedCode,
      policyDecision: null,
      metadata: payload,
      tenantId: principal.tenantId,
    })
    return errorResult(authFailedCode, extra)
  }

  try {
    const actingUser = isEnterpriseHttpTool(toolName)
      ? await resolveHttpActingUser(deps, principal)
      : null
    const result = await dispatchTool(deps, {
      toolName,
      args: parsed.data as Record<string, unknown>,
      connector,
      accessToken,
      actingUser,
    })
    const payload = {
      toolName,
      tenantId: principal.tenantId,
      userId: principal.userId,
      definitionId,
      agentId: definition.agentId,
      connectorId: authorized.connectorId,
    }
    console.info('enterprise.tool.ok', payload)
    await writeAudit(deps.audit, {
      actorType: 'human',
      actorId: principal.userId,
      agentVersion: null,
      action: 'enterprise.tool.ok',
      targetType: 'agent',
      targetId: definition.agentId,
      modelUsed: null,
      inputRef: toolName,
      outputRef: null,
      policyDecision: 'allowed',
      metadata: payload,
      tenantId: principal.tenantId,
    })
    return textResult(result)
  } catch (error) {
    const mapped = mapToolError(error, connector.type)
    const payload = {
      toolName,
      tenantId: principal.tenantId,
      userId: principal.userId,
      definitionId,
      agentId: definition.agentId,
      connectorId: authorized.connectorId,
      errorCode: mapped.code,
    }
    console.info('enterprise.tool.error', payload)
    await writeAudit(deps.audit, {
      actorType: 'human',
      actorId: principal.userId,
      agentVersion: null,
      action: 'enterprise.tool.error',
      targetType: 'agent',
      targetId: definition.agentId,
      modelUsed: null,
      inputRef: toolName,
      outputRef: mapped.code,
      policyDecision: null,
      metadata: payload,
      tenantId: principal.tenantId,
    })
    const extra = await authorizationLinkFields(deps.startAuthorization, {
      reason: mapped.code,
      connectorId: authorized.connectorId,
      userId: principal.userId,
      tenantId: principal.tenantId,
      role: principal.role,
      toolName,
    })
    return errorResult(mapped.code, { ...mapped.extra, ...extra })
  }
}

async function dispatchTool(
  deps: EnterpriseToolDeps,
  input: {
    toolName: string
    args: Record<string, unknown>
    connector: LiveConnectorRow
    accessToken?: string
    actingUser?: HttpApiActingUser
  },
): Promise<unknown> {
  if (isEnterpriseGmailTool(input.toolName)) {
    const execute = deps.executeGmailTool ?? executeGmailTool
    return execute(input.toolName, input.args, input.accessToken ?? '')
  }
  if (isEnterpriseHttpTool(input.toolName)) {
    const execute = deps.executeHttpApiTool ?? executeHttpApiTool
    const allowedEgressHosts = deps.resolveEgressAllowlist
      ? await deps.resolveEgressAllowlist(input.connector.tenantId)
      : undefined
    return execute(input.toolName, input.args, input.connector, input.accessToken, input.actingUser, allowedEgressHosts)
  }
  const execute = deps.executeDriveTool ?? executeGoogleDriveTool
  return execute(input.toolName as EnterpriseDriveTool, input.args, input.accessToken ?? '')
}

/** Resolves the real caller's email for X-Acting-User audit templates; null for background/scheduled runs with no resolver. */
async function resolveHttpActingUser(
  deps: EnterpriseToolDeps,
  principal: ToolCallPrincipal,
): Promise<HttpApiActingUser> {
  if (!deps.resolveActingUser) return null
  const resolved = await deps.resolveActingUser({ userId: principal.userId })
  return resolved ? { id: resolved.id, email: resolved.email, tenantId: principal.tenantId } : null
}

function mapToolError(
  error: unknown,
  connectorType: string,
): { code: string; extra?: Record<string, unknown> } {
  if (error instanceof GoogleDriveApiAuthError || error instanceof GoogleWorkspaceApiAuthError) {
    return { code: 'google_drive_auth_failed', extra: { status: error.status } }
  }
  if (error instanceof GmailApiAuthError) {
    return { code: 'gmail_auth_failed', extra: { status: error.status } }
  }
  if (error instanceof GoogleDriveApiError || error instanceof GoogleWorkspaceApiError) {
    return {
      code: connectorType === 'gmail' ? 'gmail_api_error' : 'google_drive_api_error',
      extra: {
        status: error.status,
        ...('code' in error && typeof error.code === 'string' ? { googleCode: error.code } : {}),
      },
    }
  }
  if (error instanceof HttpApiError) {
    return {
      code: error.code === 'missing_api_key' ? 'missing_api_key' : 'http_api_error',
      extra: {
        httpCode: error.code,
        ...(error.reason ? { reason: error.reason } : {}),
        ...(error.allowedEndpoints?.length ? { allowedEndpoints: error.allowedEndpoints } : {}),
      },
    }
  }
  return { code: 'tool_execution_failed' }
}

async function invokeKbTool(
  deps: EnterpriseToolDeps,
  input: {
    principal: ToolCallPrincipal
    toolName: EnterpriseKbTool
    args: Record<string, unknown>
    definitionId: string
    definition: AgentDefinition
  },
): Promise<EnterpriseToolMcpResult> {
  const { principal, toolName, args, definitionId, definition } = input
  if (!deps.executeKbTool) {
    await auditDenied(deps, principal, toolName, 'tool_not_configured', definitionId, definition.agentId)
    return errorResult('tool_not_configured')
  }
  const parsed = schemaForEnterpriseKbTool(toolName).safeParse(args)
  if (!parsed.success) {
    await auditDenied(deps, principal, toolName, 'invalid_args', definitionId, definition.agentId)
    return errorResult('invalid_args')
  }
  const authorized = await authorizeToolCall(deps, {
    principal,
    definition,
    toolName,
    args: parsed.data as Record<string, unknown>,
  })
  if (!authorized.allowed) {
    await auditDenied(deps, principal, toolName, authorized.reason, definitionId, definition.agentId)
    return errorResult(authorized.reason)
  }
  try {
    const result = await deps.executeKbTool(toolName, parsed.data as Record<string, unknown>, {
      connectorId: authorized.connectorId,
      tenantId: principal.tenantId,
      agentId: definition.agentId,
      userId: principal.userId,
    })
    const payload = {
      toolName,
      tenantId: principal.tenantId,
      userId: principal.userId,
      definitionId,
      agentId: definition.agentId,
      connectorId: authorized.connectorId,
    }
    console.info('enterprise.tool.ok', payload)
    await writeAudit(deps.audit, {
      actorType: 'human',
      actorId: principal.userId,
      agentVersion: null,
      action: 'enterprise.tool.ok',
      targetType: 'agent',
      targetId: definition.agentId,
      modelUsed: null,
      inputRef: toolName,
      outputRef: null,
      policyDecision: 'allowed',
      metadata: payload,
      tenantId: principal.tenantId,
    })
    return textResult(result)
  } catch (error) {
    const code =
      error instanceof Error && error.message === 'invalid_args'
        ? 'invalid_args'
        : error instanceof Error && error.message === 'file_too_large'
          ? 'file_too_large'
          : 'tool_execution_failed'
    const payload = {
      toolName,
      tenantId: principal.tenantId,
      userId: principal.userId,
      definitionId,
      agentId: definition.agentId,
      connectorId: authorized.connectorId,
      errorCode: code,
    }
    console.info('enterprise.tool.error', payload)
    await writeAudit(deps.audit, {
      actorType: 'human',
      actorId: principal.userId,
      agentVersion: null,
      action: 'enterprise.tool.error',
      targetType: 'agent',
      targetId: definition.agentId,
      modelUsed: null,
      inputRef: toolName,
      outputRef: code,
      policyDecision: null,
      metadata: payload,
      tenantId: principal.tenantId,
    })
    return errorResult(code)
  }
}
