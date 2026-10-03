import { canOperateAgent, type AgentDefinition } from '@/domain/agent-definition'
import type { WriteConfirmLinkReason } from '@/domain/gateway-operation/write-confirm-branch'
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
import { executeSandboxRun as defaultExecuteSandboxRun } from './handlers/sandbox-run'
import { asUuid, enterpriseToolErrorPayload } from './tool-error-messages'
import {
  GOOGLE_DRIVE_UPLOAD_FILE_TOOL,
  isEnterpriseGmailTool,
  isEnterpriseHttpTool,
  isEnterpriseKbTool,
  isEnterpriseSandboxTool,
  isEnterpriseTool,
  isEnterpriseWriteTool,
  schemaForEnterpriseKbTool,
  schemaForEnterpriseSandboxTool,
  schemaForEnterpriseTool,
  type EnterpriseDriveTool,
  type EnterpriseGmailTool,
  type EnterpriseHttpTool,
  type EnterpriseKbTool,
} from './tool-definitions'
import type { SandboxRunResult } from '@/domain/code-sandbox/code-sandbox-service'
import { CodeSandboxDeniedError } from '@/domain/code-sandbox/code-sandbox-service'
import {
  resolvePinnedSkillScript,
  resolveSandboxWorkInputs,
  sandboxWorkFilePrefix,
  splitSandboxArgs,
  type ResolvedSandboxWorkInput,
} from '@/domain/code-sandbox/skill-script'
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
  /** Set when `mint` is null — why the client gets the approval link (#618 audit). */
  linkReason?: WriteConfirmLinkReason
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
    agent?: { id: string; version?: number },
  ) => Promise<unknown>
  resolveActingUser?: (input: { userId: string }) => Promise<{ id: string; email: string } | null>
  executeKbTool?: (
    toolName: EnterpriseKbTool,
    args: Record<string, unknown>,
    ctx: { connectorId: string; tenantId: string; agentId: string; userId: string },
  ) => Promise<unknown>
  loadSkillVersion?: (skillVersionId: string) => Promise<{
    attachments: unknown
    status: string
    tenantId: string | null
  } | null>
  executeSandboxRun?: (
    input: {
      tenantId: string
      scopeKey: string
      command: string[]
      files: Array<{ sandboxPath: string; bytes: Uint8Array }>
    },
    connector: LiveConnectorRow,
  ) => Promise<SandboxRunResult>
  readWorkFile?: (input: {
    tenantId: string
    projectKey?: string
    path: string
  }) => Promise<{ path: string; content: string } | null>
  writeWorkFile?: (input: {
    tenantId: string
    userId: string
    projectKey?: string
    path: string
    contentBase64: string
  }) => Promise<{ path: string }>
  enqueueWrite?: (input: {
    principal: ToolCallPrincipal
    toolName: string
    args: Record<string, unknown>
    origin?: string
    confirm?: WriteConfirmInput
  }) => Promise<EnterpriseToolMcpResult | InputRequiredToolResult>
  /** Agent saját Drive output-mappája (#661). Hiányában minden Drive-írás jóváhagyást kér. */
  findAgentOutputFolder?: (input: { agentId: string; tenantId: string }) => Promise<string | null>
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

/** `ProjectWorkService.readFile` codes that are safe to surface as-is; anything else is a bug, not a user error. */
const WORK_FILE_READ_ERROR_CODES = new Set(['invalid_path', 'unknown_project', 'invalid_project_key'])

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

/**
 * Tiszta write-gate döntés (#661): az agent saját output-mappájába töltve nincs
 * jóváhagyás, minden más Drive-írás approval-köteles. Hiányzó/üres
 * parentFolderId = a beállított output-mappa (az agent nem kapja meg az id-t
 * máshonnan). Egységtesztelt.
 */
export function isOutputFolderWrite(input: {
  toolName: string
  parentFolderId?: string
  outputFolderId: string | null | undefined
}): boolean {
  if (input.toolName !== GOOGLE_DRIVE_UPLOAD_FILE_TOOL || !input.outputFolderId) return false
  const parent = input.parentFolderId?.trim()
  return !parent || parent === input.outputFolderId
}

/**
 * Output-mappán belüli Drive-feltöltés: capability- és connector-ellenőrzéssel,
 * de jóváhagyás nélkül, auditáltan fut. Minden más esetben null (→ enqueue).
 */
async function tryDirectOutputFolderWrite(
  deps: EnterpriseToolDeps,
  input: {
    principal: ToolCallPrincipal
    definition: AgentDefinition
    definitionId: string
    toolName: string
    args: Record<string, unknown>
  },
): Promise<EnterpriseToolMcpResult | null> {
  const { principal, definition, definitionId, toolName, args } = input
  if (toolName !== GOOGLE_DRIVE_UPLOAD_FILE_TOOL || !deps.findAgentOutputFolder) return null
  const parsed = schemaForEnterpriseTool(toolName)?.safeParse(args)
  if (!parsed?.success) return null
  const parsedArgs = parsed.data as Record<string, unknown>
  const parentFolderId =
    typeof parsedArgs.parentFolderId === 'string' ? parsedArgs.parentFolderId : undefined
  const outputFolderId = await deps.findAgentOutputFolder({
    agentId: definition.agentId,
    tenantId: principal.tenantId,
  })
  if (!isOutputFolderWrite({ toolName, parentFolderId, outputFolderId })) return null
  // Hiányzó parent → a fájl tényleg a mappába menjen, ne a Drive gyökerébe.
  parsedArgs.parentFolderId = outputFolderId
  const authorized = await authorizeToolCall(deps, { principal, definition, toolName, args: parsedArgs })
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
      ...(authorized.connectorChoices?.length ? { connectors: authorized.connectorChoices } : {}),
    })
  }
  const connector = authorized.connector
  let accessToken: string | undefined
  try {
    if (connector.authMode === 'user_delegated') {
      accessToken = await resolveDelegatedToken(deps, principal, connector, authorized.grantId, authorized.tokenRef)
    }
  } catch {
    await auditDenied(deps, principal, toolName, 'google_drive_auth_failed', definitionId, definition.agentId)
    return errorResult('google_drive_auth_failed')
  }
  try {
    const result = await dispatchTool(deps, {
      toolName,
      args: parsedArgs,
      connector,
      accessToken,
      actingUser: null,
    })
    const payload = {
      toolName,
      tenantId: principal.tenantId,
      userId: principal.userId,
      definitionId,
      agentId: definition.agentId,
      connectorId: authorized.connectorId,
      approvalBypass: 'agent_output_folder',
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
    await auditDenied(deps, principal, toolName, mapped.code, definitionId, definition.agentId)
    return errorResult(mapped.code, mapped.extra)
  }
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
    const direct = await tryDirectOutputFolderWrite(deps, { principal, definition, definitionId, toolName, args })
    if (direct) return direct
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

  if (isEnterpriseSandboxTool(toolName)) {
    return invokeSandboxTool(deps, {
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
      agent: { id: definition.agentId, version: definition.version },
    })
    const upstreamFailure =
      isEnterpriseHttpTool(toolName) &&
      result !== null &&
      typeof result === 'object' &&
      'ok' in result &&
      result.ok === false
    const payload = {
      toolName,
      tenantId: principal.tenantId,
      userId: principal.userId,
      definitionId,
      agentId: definition.agentId,
      connectorId: authorized.connectorId,
    }
    console.info(upstreamFailure ? 'enterprise.tool.error' : 'enterprise.tool.ok', payload)
    await writeAudit(deps.audit, {
      actorType: 'human',
      actorId: principal.userId,
      agentVersion: null,
      action: upstreamFailure ? 'enterprise.tool.error' : 'enterprise.tool.ok',
      targetType: 'agent',
      targetId: definition.agentId,
      modelUsed: null,
      inputRef: toolName,
      outputRef: null,
      policyDecision: 'allowed',
      metadata: payload,
      tenantId: principal.tenantId,
    })
    return textResult(result, upstreamFailure)
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
    agent?: { id: string; version?: number }
  },
): Promise<unknown> {
  if (isEnterpriseGmailTool(input.toolName)) {
    const execute = deps.executeGmailTool ?? executeGmailTool
    return execute(input.toolName, input.args, input.accessToken ?? '')
  }
  if (isEnterpriseHttpTool(input.toolName)) {
    const execute = deps.executeHttpApiTool ?? executeHttpApiTool
    return execute(
      input.toolName,
      input.args,
      input.connector,
      input.accessToken,
      input.actingUser,
      input.agent,
    )
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

async function invokeSandboxTool(
  deps: EnterpriseToolDeps,
  input: {
    principal: ToolCallPrincipal
    toolName: string
    args: Record<string, unknown>
    definitionId: string
    definition: AgentDefinition
  },
): Promise<EnterpriseToolMcpResult> {
  const { principal, toolName, args, definitionId, definition } = input
  const parsed = schemaForEnterpriseSandboxTool('sandbox_run').safeParse(args)
  if (!parsed.success) {
    await auditDenied(deps, principal, toolName, 'invalid_args', definitionId, definition.agentId)
    return errorResult('invalid_args')
  }
  const parsedArgs = parsed.data
  const authorized = await authorizeToolCall(deps, {
    principal,
    definition,
    toolName,
    args: parsedArgs as Record<string, unknown>,
  })
  if (!authorized.allowed) {
    await auditDenied(deps, principal, toolName, authorized.reason, definitionId, definition.agentId)
    return errorResult(authorized.reason)
  }
  const writeWorkFile = deps.writeWorkFile
  if (!deps.loadSkillVersion || !writeWorkFile) {
    await auditDenied(deps, principal, toolName, 'tool_not_configured', definitionId, definition.agentId)
    return errorResult('tool_not_configured')
  }
  const version = await deps.loadSkillVersion(parsedArgs.skillVersionId)
  if (!version) {
    await auditDenied(deps, principal, toolName, 'skill_not_found', definitionId, definition.agentId)
    return errorResult('skill_not_found')
  }
  if (version.tenantId && version.tenantId !== principal.tenantId) {
    await auditDenied(deps, principal, toolName, 'skill_not_pinned', definitionId, definition.agentId)
    return errorResult('skill_not_pinned')
  }
  if (version.status !== 'active') {
    await auditDenied(deps, principal, toolName, 'skill_not_active', definitionId, definition.agentId)
    return errorResult('skill_not_active')
  }
  const resolved = resolvePinnedSkillScript({
    definition,
    skillVersionId: parsedArgs.skillVersionId,
    entry: parsedArgs.entry,
    attachments: version.attachments,
  })
  if (!resolved.ok) {
    await auditDenied(deps, principal, toolName, resolved.reason, definitionId, definition.agentId)
    return errorResult(resolved.reason)
  }

  const files = [
    { sandboxPath: `/work/in/skill/${resolved.script.entry.path}`, bytes: Buffer.from(resolved.script.entry.text, 'utf8') },
    { sandboxPath: '/work/run.py', bytes: Buffer.from(resolved.script.entry.text, 'utf8') },
    ...resolved.script.helpers.map((helper) => ({
      sandboxPath: `/work/in/skill/${helper.path}`,
      bytes: Buffer.from(helper.text, 'utf8'),
    })),
  ]
  const resolvedInputs = resolveSandboxWorkInputs(parsedArgs.inputs)
  if (!resolvedInputs.ok) {
    await auditDenied(deps, principal, toolName, resolvedInputs.reason, definitionId, definition.agentId)
    return errorResult(resolvedInputs.reason)
  }
  const readWorkFile = deps.readWorkFile
  if (resolvedInputs.inputs.length > 0 && !readWorkFile) {
    await auditDenied(deps, principal, toolName, 'tool_not_configured', definitionId, definition.agentId)
    return errorResult('tool_not_configured')
  }
  const mounted: ResolvedSandboxWorkInput[] = []
  for (const item of resolvedInputs.inputs) {
    let file: { path: string; content: string } | null
    try {
      file = await readWorkFile!({
        tenantId: principal.tenantId,
        projectKey: parsedArgs.projectKey,
        path: item.workPath,
      })
    } catch (error) {
      const thrown = error instanceof Error ? error.message : ''
      const code = WORK_FILE_READ_ERROR_CODES.has(thrown) ? thrown : 'tool_execution_failed'
      await auditDenied(deps, principal, toolName, code, definitionId, definition.agentId)
      return errorResult(code)
    }
    if (!file) {
      await auditDenied(deps, principal, toolName, 'file_not_found', definitionId, definition.agentId)
      return errorResult('file_not_found', { path: item.workPath })
    }
    files.push({ sandboxPath: item.sandboxPath, bytes: Buffer.from(file.content, 'utf8') })
    mounted.push({ workPath: file.path, sandboxPath: item.sandboxPath })
  }
  const execute = deps.executeSandboxRun ?? defaultExecuteSandboxRun
  try {
    const ran = await execute(
      {
        tenantId: principal.tenantId,
        scopeKey: definitionId,
        command: ['python3', `/work/in/skill/${resolved.script.entry.path}`, ...splitSandboxArgs(parsedArgs.args)],
        files,
      },
      authorized.connector,
    )
    const prefix = sandboxWorkFilePrefix(resolved.script.skillName)
    const outputs: string[] = []
    for (const file of ran.outputFiles) {
      const written = await writeWorkFile({
        tenantId: principal.tenantId,
        userId: principal.userId,
        projectKey: parsedArgs.projectKey,
        path: `${prefix}/${file.path}`,
        contentBase64: Buffer.from(file.bytes).toString('base64'),
      })
      outputs.push(written.path)
    }
    const payload = {
      toolName,
      tenantId: principal.tenantId,
      userId: principal.userId,
      definitionId,
      agentId: definition.agentId,
      connectorId: authorized.connectorId,
      skillVersionId: parsedArgs.skillVersionId,
      scriptPath: resolved.script.entry.path,
      scriptSha256: resolved.script.entry.sha256,
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
      outputRef: resolved.script.entry.sha256,
      policyDecision: 'allowed',
      metadata: payload,
      tenantId: principal.tenantId,
    })
    return textResult({
      exitCode: ran.exitCode,
      stdout: ran.stdout,
      stderr: ran.stderr,
      stdoutTruncated: ran.stdoutTruncated,
      stderrTruncated: ran.stderrTruncated,
      outputs,
      inputs: mounted,
      skillVersionId: parsedArgs.skillVersionId,
      scriptPath: resolved.script.entry.path,
      scriptSha256: resolved.script.entry.sha256,
    })
  } catch (error) {
    const code =
      error instanceof CodeSandboxDeniedError
        ? error.reason.split(':')[0]!
        : error instanceof Error &&
            (error.message === 'code_sandbox_disabled' ||
              error.message === 'code_sandbox_base_url_missing' ||
              error.message === 'invalid_sandbox_command' ||
              error.message === 'quota_exceeded' ||
              error.message === 'file_too_large' ||
              error.message === 'invalid_path')
          ? error.message
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
