import { canOperateAgent, type AgentDefinition } from '@/domain/agent-definition'
import {
  GoogleDriveApiAuthError,
  GoogleDriveApiError,
} from '@/domain/connector-grant/google-drive-api-client'
import {
  authorizeToolCall,
  type AuthorizeToolCallDeps,
  type LiveConnectorRow,
  type ToolCallPrincipal,
} from './authorize-tool-call'
import { executeGoogleDriveTool } from './handlers/google-drive'
import { asUuid, enterpriseToolErrorMessage } from './tool-error-messages'
import {
  isEnterpriseDriveTool,
  isEnterpriseDriveWriteTool,
  schemaForEnterpriseDriveTool,
  type EnterpriseDriveTool,
} from './tool-definitions'
import type { AuditSink } from '@/lib/audit/types'
import { writeAudit } from '@/lib/audit/types'

export type EnterpriseToolMcpResult = {
  isError?: true
  content: Array<{ type: 'text'; text: string }>
}

export type EnterpriseToolDeps = AuthorizeToolCallDeps & {
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
  enqueueWrite?: (input: {
    principal: ToolCallPrincipal
    toolName: string
    args: Record<string, unknown>
  }) => Promise<EnterpriseToolMcpResult>
  audit?: AuditSink
}

function textResult(payload: unknown, isError = false): EnterpriseToolMcpResult {
  return {
    ...(isError ? { isError: true as const } : {}),
    content: [{ type: 'text', text: JSON.stringify(payload) }],
  }
}

function denyMessage(code: string): string {
  return enterpriseToolErrorMessage(code)
}

function errorResult(code: string, extra?: Record<string, unknown>): EnterpriseToolMcpResult {
  return textResult({ code, message: denyMessage(code), ...extra }, true)
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
    reason,
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

export async function invokeEnterpriseTool(
  deps: EnterpriseToolDeps,
  input: {
    principal: ToolCallPrincipal
    toolName: string
    args: Record<string, unknown>
  },
): Promise<EnterpriseToolMcpResult> {
  const { principal, toolName, args } = input
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

  if (isEnterpriseDriveWriteTool(toolName)) {
    if (!deps.enqueueWrite) {
      await auditDenied(deps, principal, toolName, 'tool_not_configured', definitionId, definition.agentId)
      return errorResult('tool_not_configured')
    }
    return deps.enqueueWrite({ principal, toolName, args })
  }

  if (!isEnterpriseDriveTool(toolName)) {
    await auditDenied(deps, principal, toolName, 'tool_not_configured', definitionId, definition.agentId)
    return errorResult('tool_not_configured')
  }

  const parsed = schemaForEnterpriseDriveTool(toolName).safeParse(args)
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

  const connector = authorized.connector

  let accessToken: string
  try {
    accessToken = await deps.resolveAccessToken({
      connector,
      grantId: authorized.grantId,
      tokenRef: authorized.tokenRef,
      actingUserId: principal.userId,
      tenantId: principal.tenantId,
    })
  } catch {
    const payload = {
      toolName,
      tenantId: principal.tenantId,
      userId: principal.userId,
      definitionId,
      agentId: definition.agentId,
      connectorId: authorized.connectorId,
      errorCode: 'google_drive_auth_failed',
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
      outputRef: 'google_drive_auth_failed',
      policyDecision: null,
      metadata: payload,
      tenantId: principal.tenantId,
    })
    return errorResult('google_drive_auth_failed')
  }

  const execute = deps.executeDriveTool ?? executeGoogleDriveTool
  try {
    const result = await execute(toolName, parsed.data as Record<string, unknown>, accessToken)
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
    const mapped = mapDriveError(error)
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
    return errorResult(mapped.code, mapped.extra)
  }
}

function mapDriveError(error: unknown): { code: string; extra?: Record<string, unknown> } {
  if (error instanceof GoogleDriveApiAuthError) {
    return { code: 'google_drive_auth_failed', extra: { status: error.status } }
  }
  if (error instanceof GoogleDriveApiError) {
    return {
      code: 'google_drive_api_error',
      extra: {
        status: error.status,
        ...(error.code ? { googleCode: error.code } : {}),
      },
    }
  }
  return { code: 'tool_execution_failed' }
}
