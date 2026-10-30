import { expireRejectedTenantMailbox, type MailboxFailureDeps } from '@/domain/connector-grant/tenant-mailbox-failure'
import { canOperateAgent, type AgentDefinition } from '@/domain/agent-definition'
import type { WriteConfirmLinkReason } from '@/domain/gateway-operation/write-confirm-branch'
import { isDispatchable } from '@/lib/agent-lifecycle'
import { PdfPageImageError } from '@/lib/kb-pdf-images'
import {
  GoogleDriveApiAuthError,
  GoogleDriveApiError,
} from '@/domain/connector-grant/google-drive-api-client'
import { GmailApiAuthError } from '@/domain/connector-grant/gmail-api-client'
import {
  GoogleWorkspaceApiAuthError,
  GoogleWorkspaceApiError,
} from '@/domain/connector-grant/google-workspace-api-client'
import { findHttpApiEndpoint, HttpApiError } from '@/domain/connector/http-api-client'
import { appendTextSignature, isAgentMailSendRequest, withAgentMailSignature } from '@/domain/agent-mailbox/agent-mailbox'
import { executeMailTool } from '@/domain/mail/providers'
import { listMailAccounts, publicMailAccount, resolveMailAccounts } from '@/domain/mail/mail'
import {
  authorizeToolCall,
  type AuthorizeToolCallDeps,
  type LiveConnectorRow,
  type ToolCallPrincipal,
} from './authorize-tool-call'
import {
  checkDefinitionPin,
  invalidArgsDetails,
  withDefinitionUpdatedNotice,
  type DefinitionPinDeps,
} from './definition-pin'
import { executeGoogleDriveTool } from './handlers/google-drive'
import { executeGmailTool } from './handlers/gmail'
import { executeHttpApiTool } from './handlers/http-api'
import { executeSandboxRun as defaultExecuteSandboxRun } from './handlers/sandbox-run'
import {
  isWikiToolCall,
  KbToolError,
  type KbToolContext,
  type WikiToolOutcome,
} from './handlers/knowledge-base'
import {
  checkMcpCallGate,
  executeMcpTool as defaultExecuteMcpTool,
  executeMcpWithRetryPolicy,
  mcpErrorCode,
  type ExecuteMcpToolInput,
  type McpGateDeps,
} from './handlers/mcp'
import type { McpCallResult } from '@/domain/connector/mcp-client'
import { mcpResultForModel, mcpToolListForModel } from '@/domain/connector/mcp-tools'
import { tenantLanguageOrDefault, type TenantLanguage } from '@/lib/tenant-language'
import { asUuid, enterpriseToolErrorPayload } from './tool-error-messages'
import {
  GOOGLE_DRIVE_UPLOAD_FILE_TOOL,
  HTTP_API_REQUEST_TOOL,
  isEnterpriseGmailTool,
  isEnterpriseHttpTool,
  isEnterpriseMailTool,
  MAIL_CREATE_DRAFT_TOOL,
  MAIL_LIST_ACCOUNTS_TOOL,
  MAIL_SEARCH_TOOL,
  MAIL_SEND_TOOL,
  isEnterpriseKbTool,
  isEnterpriseMcpTool,
  isEnterpriseReadOnlyTool,
  isEnterpriseSandboxTool,
  isEnterpriseTool,
  isEnterpriseWriteTool,
  KB_GET_DOCUMENT_TOOL,
  KB_GET_PAGE_TOOL,
  KB_INGEST_TOOL,
  KB_LIST_INDEX_TOOL,
  KB_WIKI_WRITE_TOOL,
  KB_WIKI_CHANGES_TOOL,
  KB_WIKI_REVERT_TOOL,
  MCP_CALL_TOOL,
  MCP_LIST_TOOLS_TOOL,
  mcpCallInputSchema,
  mcpListToolsInputSchema,
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
  TENANT_MAILBOX_DISCONNECTED,
  connectorUsesGrantToken,
  tenantMailboxDisconnectedMessage,
  tenantMailboxForcesApproval,
  tenantMailboxOf,
} from '@/domain/connector-grant/tenant-mailbox'
import {
  resolvePinnedSkillScript,
  resolveSandboxWorkInputs,
  sandboxWorkFilePrefix,
  splitSandboxArgs,
} from '@/domain/code-sandbox/skill-script'
import type { AuditSink } from '@/lib/audit/types'
import { writeAudit } from '@/lib/audit/types'
import { isAuthorizationLinkReason } from '@/domain/connector-grant/connector-grant-needed'
import { scopeSnapshotConnectorsToUser } from '@/lib/wiki-access'
import {
  skipsWriteApproval,
  type AgentWriteApprovalModes,
} from '@/lib/write-approval-modes'

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

export type EnterpriseToolDeps = MailboxFailureDeps & AuthorizeToolCallDeps &
  DefinitionPinDeps &
  McpGateDeps & {
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
  executeMailTool?: typeof executeMailTool
  executeHttpApiTool?: (
    toolName: EnterpriseHttpTool,
    args: Record<string, unknown>,
    connector: LiveConnectorRow,
    accessToken?: string,
    actingUser?: HttpApiActingUser,
    agent?: { id: string; version?: number },
    /** #717: a modellnek szóló http_api hintek nyelve. */
    language?: TenantLanguage,
    allowedEgressHosts?: string[],
  ) => Promise<unknown>
  /** #717: a tenant kimeneti nyelve (a modellnek szóló szövegekhez). Hiányában `hu`. */
  resolveTenantLanguage?: (tenantId: string) => Promise<TenantLanguage>
  resolveEgressAllowlist?: (tenantId: string | null) => Promise<string[]>
  resolveActingUser?: (input: { userId: string }) => Promise<{ id: string; email: string } | null>
  executeKbTool?: (
    toolName: EnterpriseKbTool,
    args: Record<string, unknown>,
    ctx: KbToolContext,
  ) => Promise<unknown>
  /** #943: wiki-beküldés, -írás, tálca (a cél-wikit a snapshotból oldja fel). */
  executeWikiTool?: (
    toolName: EnterpriseKbTool,
    args: Record<string, unknown>,
    ctx: Omit<KbToolContext, 'connectorId'> & { snapshot: NonNullable<KbToolContext['snapshot']> },
  ) => Promise<WikiToolOutcome>
  /** #943: `wikiId` / `documentId` → a tudásbázis connectorja (tenanton belül). */
  resolveKbConnector?: (input: { tenantId: string; wikiId?: string; documentId?: string }) => Promise<string | null>
  /** #943: a jóváhagyásra tett change-set gateway-művelete; `null` = nem került sorba (elutasítjuk). */
  onWikiApprovalQueued?: (input: { tenantId: string; changeSetId: string; operationId: string | null }) => Promise<void>
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
  /** Agent írási jóváhagyás-módjai (#739). Hiányában minden írás approval-köteles. */
  findAgentWriteModes?: (input: {
    agentId: string
    tenantId: string
  }) => Promise<AgentWriteApprovalModes | null>
  /** #1029: az agent saját postafiókja és aláírása — a kimenő AgentMail-levél végére kerül. */
  findAgentMailSignature?: (input: {
    agentId: string
    tenantId: string
  }) => Promise<{ connectorId: string; connectorName: string; signature: string | null } | null>
  startAuthorization?: StartDelegatedAuthorization
  /** #395: külső MCP-hívás; tesztben cserélhető. */
  executeMcpTool?: (input: ExecuteMcpToolInput) => Promise<McpCallResult>
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

const WORK_FILE_TOOL_ERROR_CODES = new Set([
  'invalid_path',
  'unknown_project',
  'invalid_project_key',
  'file_too_large',
  'quota_exceeded',
])

function workFileToolErrorCode(error: unknown): string {
  const thrown = error instanceof Error ? error.message : ''
  return WORK_FILE_TOOL_ERROR_CODES.has(thrown) ? thrown : 'tool_execution_failed'
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
  errorDetails?: Record<string, unknown>,
) {
  const payload = {
    toolName,
    reasonCode: reason,
    tenantId: principal.tenantId,
    userId: principal.userId,
    ...(definitionId ? { definitionId } : {}),
    ...(agentId ? { agentId } : {}),
    ...errorDetails,
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

/** #1028: user- vagy tenant-grant tokenje; sima service-konnektornál nincs. */
async function resolveGrantToken(
  deps: EnterpriseToolDeps,
  principal: ToolCallPrincipal,
  connector: LiveConnectorRow,
  authorized: { grantId?: string | null; tokenRef?: string | null },
): Promise<string | undefined> {
  if (!connectorUsesGrantToken(connector)) return undefined
  return resolveDelegatedToken(deps, principal, connector, authorized.grantId, authorized.tokenRef)
}

/** #1028: megszakadt tenant-postafióknál a user ne OAuth-linket kapjon, hanem „szólj az adminnak”. */
function tenantMailboxErrorExtra(
  reason: string,
  address: string | null | undefined,
): Record<string, unknown> {
  if (reason !== TENANT_MAILBOX_DISCONNECTED) return {}
  return { message: tenantMailboxDisconnectedMessage(address), ...(address ? { mailbox: address } : {}) }
}

/** #1028: audit-metaadat — a postafiók címe minden tenant-postafiók hívásnál. */
function mailboxAuditMeta(
  connector: LiveConnectorRow,
  grant: { accountLabel?: string | null } | null | undefined,
): Record<string, unknown> {
  if (!tenantMailboxOf(connector)) return {}
  return { mailbox: grant?.accountLabel ?? tenantMailboxOf(connector)?.address ?? null }
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

type DirectWriteBypass = 'agent_output_folder' | 'agent_write_mode'

/**
 * #1029: AgentMail-küldés az agent saját címéről → aláírás a levél végére. A cél
 * konnektor: connectorId / connectorName, ennek hiányában az egyetlen kötött HTTP
 * konnektor, amelynek van ilyen végpontja (ugyanígy választ a szerver is).
 */
async function withPrimaryMailboxSignature(
  deps: EnterpriseToolDeps,
  tenantId: string,
  definition: AgentDefinition,
  toolName: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if ((toolName === MAIL_SEND_TOOL || toolName === MAIL_CREATE_DRAFT_TOOL) && deps.findAgentMailSignature) {
    const mailbox = await deps.findAgentMailSignature({ agentId: definition.agentId, tenantId }).catch(() => null)
    const signature = mailbox?.signature?.trim()
    const body = typeof args.body === 'string' ? args.body : ''
    if (!signature || !body) return args
    const account = typeof args.account === 'string' ? args.account.trim().toLowerCase() : ''
    const primaryName = mailbox?.connectorName.trim().toLowerCase() ?? ''
    const fromPrimary = !account || account === 'all' || primaryName.includes(account) || account === mailbox?.connectorId
    return fromPrimary ? { ...args, body: appendTextSignature(body, signature) } : args
  }
  if (toolName !== HTTP_API_REQUEST_TOOL || !deps.findAgentMailSignature) return args
  if (!isAgentMailSendRequest(args.method, args.path)) return args
  const mailbox = await deps.findAgentMailSignature({ agentId: definition.agentId, tenantId }).catch(() => null)
  if (!mailbox?.signature) return args
  const connectorId = typeof args.connectorId === 'string' ? args.connectorId.trim() : ''
  const connectorName = typeof args.connectorName === 'string' ? args.connectorName.trim().toLowerCase() : ''
  let targetsPrimary: boolean
  if (connectorId) targetsPrimary = connectorId === mailbox.connectorId
  else if (connectorName) targetsPrimary = connectorName === mailbox.connectorName.trim().toLowerCase()
  else {
    const method = String(args.method).toUpperCase()
    const path = String(args.path)
    const candidates = definition.snapshot.connectors.filter(
      (row) => row.type === 'http_api' && row.endpoints?.length && findHttpApiEndpoint({ endpoints: row.endpoints }, method, path),
    )
    targetsPrimary = candidates.length === 1 && candidates[0].connectorId === mailbox.connectorId
  }
  return targetsPrimary ? withAgentMailSignature(args, mailbox.signature) : args
}

/**
 * Output-mappa vagy agent-szintű közvetlen írás: capability- és connector-ellenőrzéssel,
 * jóváhagyás nélkül, auditáltan fut. Egyébként null (→ enqueue).
 */
async function tryDirectWrite(
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
  const parsed = schemaForEnterpriseTool(toolName)?.safeParse(args)
  if (!parsed?.success) return null
  const parsedArgs = parsed.data as Record<string, unknown>
  const parentFolderId =
    typeof parsedArgs.parentFolderId === 'string' ? parsedArgs.parentFolderId : undefined
  const outputFolderId = deps.findAgentOutputFolder
    ? await deps.findAgentOutputFolder({
        agentId: definition.agentId,
        tenantId: principal.tenantId,
      })
    : null
  const outputFolder = isOutputFolderWrite({ toolName, parentFolderId, outputFolderId })
  const modes = deps.findAgentWriteModes
    ? await deps.findAgentWriteModes({
        agentId: definition.agentId,
        tenantId: principal.tenantId,
      })
    : null
  const bypass: DirectWriteBypass | null = outputFolder
    ? 'agent_output_folder'
    : skipsWriteApproval(toolName, modes)
      ? 'agent_write_mode'
      : null
  if (!bypass) return null
  if (outputFolder) {
    // Hiányzó parent → a fájl tényleg a mappába menjen, ne a Drive gyökerébe.
    parsedArgs.parentFolderId = outputFolderId
  }
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
      ...(authorized.accountChoices?.length ? { accounts: authorized.accountChoices } : {}),
      ...tenantMailboxErrorExtra(authorized.reason, authorized.mailboxAddress),
    })
  }
  const connector = authorized.connector
  // #1028: az admin kikényszerítette a jóváhagyást — az agent írási módja nem kerülheti meg.
  if (bypass === 'agent_write_mode' && tenantMailboxForcesApproval(connector)) return null
  const authFailedCode =
    connector.type === 'gmail'
      ? 'gmail_auth_failed'
      : connector.type === 'http_api'
        ? 'http_api_error'
        : 'google_drive_auth_failed'
  const mailboxMeta = mailboxAuditMeta(connector, authorized.grant)
  let accessToken: string | undefined
  try {
    accessToken = await resolveGrantToken(deps, principal, connector, authorized)
  } catch {
    if (tenantMailboxOf(connector)) {
      await auditDenied(deps, principal, toolName, TENANT_MAILBOX_DISCONNECTED, definitionId, definition.agentId, mailboxMeta)
      return errorResult(TENANT_MAILBOX_DISCONNECTED, tenantMailboxErrorExtra(TENANT_MAILBOX_DISCONNECTED, mailboxMeta.mailbox as string | null))
    }
    await auditDenied(deps, principal, toolName, authFailedCode, definitionId, definition.agentId)
    return errorResult(authFailedCode)
  }
  try {
    const actingUser = isEnterpriseHttpTool(toolName)
      ? await resolveHttpActingUser(deps, principal)
      : null
    const result = await dispatchTool(deps, {
      toolName,
      args: parsedArgs,
      connector,
      accessToken,
      actingUser,
      agent: { id: definition.agentId, version: definition.version },
    })
    if (await expireRejectedTenantMailbox(deps, { connector, grantId: authorized.grantId, userId: principal.userId, tenantId: principal.tenantId, outcome: result })) {
      await auditDenied(deps, principal, toolName, TENANT_MAILBOX_DISCONNECTED, definitionId, definition.agentId, mailboxMeta)
      return errorResult(TENANT_MAILBOX_DISCONNECTED, tenantMailboxErrorExtra(TENANT_MAILBOX_DISCONNECTED, mailboxMeta.mailbox as string | null))
    }
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
      ...mailboxMeta,
      approvalBypass: bypass,
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
    if (await expireRejectedTenantMailbox(deps, { connector, grantId: authorized.grantId, userId: principal.userId, tenantId: principal.tenantId, outcome: error })) {
      await auditDenied(deps, principal, toolName, TENANT_MAILBOX_DISCONNECTED, definitionId, definition.agentId, mailboxMeta)
      return errorResult(TENANT_MAILBOX_DISCONNECTED, tenantMailboxErrorExtra(TENANT_MAILBOX_DISCONNECTED, mailboxMeta.mailbox as string | null))
    }
    const mapped = mapToolError(error, connector.type)
    const extra = { ...mapped.extra, ...driveUploadLogMeta(toolName, parsedArgs) }
    const auditDetails = Object.keys(extra).length ? extra : undefined
    await auditDenied(
      deps,
      principal,
      toolName,
      mapped.code,
      definitionId,
      definition.agentId,
      auditDetails,
    )
    return errorResult(mapped.code, extra)
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
    /** Belső: egyszer már átváltottunk a régi definícióról az aktuálisra (nincs második ugrás). */
    followedStaleDefinition?: boolean
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
    if (pin.currentDefinitionId && isEnterpriseReadOnlyTool(toolName) && !input.followedStaleDefinition) {
      const result = await invokeEnterpriseTool(deps, {
        ...input,
        args: { ...args, definitionId: pin.currentDefinitionId },
        followedStaleDefinition: true,
      })
      if (!('content' in result)) return result
      return withDefinitionUpdatedNotice(result, {
        previousDefinitionId: definitionId,
        currentDefinitionId: pin.currentDefinitionId,
      })
    }
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

  if (isEnterpriseMailTool(toolName) && !isEnterpriseWriteTool(toolName)) {
    return invokeMailRead(deps, { principal, toolName, args, definitionId, definition })
  }

  if (isEnterpriseMcpTool(toolName)) {
    return invokeMcpTool(deps, { principal, toolName, args, definitionId, definition, origin, confirm })
  }

  if (isEnterpriseKbTool(toolName)) {
    return invokeKbTool(deps, {
      principal,
      toolName,
      args,
      definitionId,
      definition,
      origin,
    })
  }

  if (isEnterpriseWriteTool(toolName)) {
    if (!deps.enqueueWrite) {
      await auditDenied(deps, principal, toolName, 'tool_not_configured', definitionId, definition.agentId)
      return errorResult('tool_not_configured')
    }
    // #1029: az aláírás a jóváhagyás ELŐTT kerül a levélbe, így a jóváhagyó a végleges szöveget látja.
    const writeArgs = await withPrimaryMailboxSignature(deps, principal.tenantId, definition, toolName, args)
    const direct = await tryDirectWrite(deps, { principal, definition, definitionId, toolName, args: writeArgs })
    if (direct) return direct
    return deps.enqueueWrite({ principal, toolName, args: writeArgs, origin, confirm })
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
    const details = invalidArgsDetails(parsed.error)
    await auditDenied(deps, principal, toolName, 'invalid_args', definitionId, definition.agentId, details)
    return errorResult('invalid_args', details)
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
      ...(authorized.accountChoices?.length ? { accounts: authorized.accountChoices } : {}),
      ...tenantMailboxErrorExtra(authorized.reason, authorized.mailboxAddress),
    })
  }

  const connector = authorized.connector
  const authFailedCode =
    connector.type === 'gmail'
      ? 'gmail_auth_failed'
      : connector.type === 'http_api'
        ? 'http_api_error'
        : 'google_drive_auth_failed'

  const mailboxMeta = mailboxAuditMeta(connector, authorized.grant)
  let accessToken: string | undefined
  try {
    accessToken = await resolveGrantToken(deps, principal, connector, authorized)
  } catch {
    if (tenantMailboxOf(connector)) {
      await auditDenied(deps, principal, toolName, TENANT_MAILBOX_DISCONNECTED, definitionId, definition.agentId, mailboxMeta)
      return errorResult(TENANT_MAILBOX_DISCONNECTED, tenantMailboxErrorExtra(TENANT_MAILBOX_DISCONNECTED, mailboxMeta.mailbox as string | null))
    }
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
    if (await expireRejectedTenantMailbox(deps, { connector, grantId: authorized.grantId, userId: principal.userId, tenantId: principal.tenantId, outcome: result })) {
      await auditDenied(deps, principal, toolName, TENANT_MAILBOX_DISCONNECTED, definitionId, definition.agentId, mailboxMeta)
      return errorResult(TENANT_MAILBOX_DISCONNECTED, tenantMailboxErrorExtra(TENANT_MAILBOX_DISCONNECTED, mailboxMeta.mailbox as string | null))
    }
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
      ...mailboxMeta,
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
    if (await expireRejectedTenantMailbox(deps, { connector, grantId: authorized.grantId, userId: principal.userId, tenantId: principal.tenantId, outcome: error })) {
      await auditDenied(deps, principal, toolName, TENANT_MAILBOX_DISCONNECTED, definitionId, definition.agentId, mailboxMeta)
      return errorResult(TENANT_MAILBOX_DISCONNECTED, tenantMailboxErrorExtra(TENANT_MAILBOX_DISCONNECTED, mailboxMeta.mailbox as string | null))
    }
    const mapped = mapToolError(error, connector.type)
    const mappedExtra = {
      ...mapped.extra,
      ...driveUploadLogMeta(toolName, parsed.data as Record<string, unknown>),
    }
    const auditDetails = Object.keys(mappedExtra).length ? mappedExtra : undefined
    const payload = {
      toolName,
      tenantId: principal.tenantId,
      userId: principal.userId,
      definitionId,
      agentId: definition.agentId,
      connectorId: authorized.connectorId,
      ...mailboxMeta,
      errorCode: mapped.code,
      ...auditDetails,
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
    return errorResult(mapped.code, { ...mappedExtra, ...extra })
  }
}

async function grantsFor(
  deps: EnterpriseToolDeps,
  input: { tenantId: string; connectorId: string; userId: string },
) {
  if (deps.findActiveGrants) return deps.findActiveGrants(input)
  const one = await deps.findActiveGrant(input)
  return one ? [one] : []
}

async function invokeMailRead(
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
  const schema = schemaForEnterpriseTool(toolName)
  if (!schema) {
    await auditDenied(deps, principal, toolName, 'tool_not_configured', definitionId, definition.agentId)
    return errorResult('tool_not_configured')
  }
  const parsed = schema.safeParse(args)
  if (!parsed.success) {
    const details = invalidArgsDetails(parsed.error)
    await auditDenied(deps, principal, toolName, 'invalid_args', definitionId, definition.agentId, details)
    return errorResult('invalid_args', details)
  }
  const parsedArgs = parsed.data as Record<string, unknown>
  const authorized = await authorizeToolCall(deps, { principal, definition, toolName, args: parsedArgs })
  if (toolName === MAIL_LIST_ACCOUNTS_TOOL) {
    if (!authorized.allowed && authorized.reason === 'capability_not_allowed') {
      await auditDenied(deps, principal, toolName, authorized.reason, definitionId, definition.agentId)
      return errorResult(authorized.reason)
    }
    const accounts = await listMailAccounts({
      definition,
      primaryConnectorId: deps.findPrimaryMailboxConnectorId
        ? await deps.findPrimaryMailboxConnectorId({ agentId: definition.agentId, tenantId: principal.tenantId })
        : null,
      findConnector: deps.findConnector,
      findActiveGrants: (row) => grantsFor(deps, row),
      userId: principal.userId,
      tenantId: principal.tenantId,
    })
    const payload = { accounts: accounts.map(publicMailAccount) }
    await auditToolOutcome(deps, {
      principal,
      toolName,
      definitionId,
      agentId: definition.agentId,
      ok: true,
      metadata: { count: accounts.length },
    })
    return textResult(payload)
  }
  const all = toolName === MAIL_SEARCH_TOOL && typeof parsedArgs.account === 'string' && parsedArgs.account.trim().toLowerCase() === 'all'
  if (all) {
    if (!authorized.allowed && authorized.reason === 'capability_not_allowed') {
      await auditDenied(deps, principal, toolName, authorized.reason, definitionId, definition.agentId)
      return errorResult(authorized.reason)
    }
    const primaryConnectorId = deps.findPrimaryMailboxConnectorId
      ? await deps.findPrimaryMailboxConnectorId({ agentId: definition.agentId, tenantId: principal.tenantId })
      : null
    const listed = await listMailAccounts({
      definition,
      primaryConnectorId,
      findConnector: deps.findConnector,
      findActiveGrants: (row) => grantsFor(deps, row),
      userId: principal.userId,
      tenantId: principal.tenantId,
    })
    const resolved = resolveMailAccounts(listed, 'all', { allAllowed: true, write: false, primaryConnectorId })
    if (!resolved.ok) {
      await auditDenied(deps, principal, toolName, resolved.reason, definitionId, definition.agentId)
      return errorResult(resolved.reason, resolved.accounts.length ? { accounts: resolved.accounts } : undefined)
    }
    const messages: unknown[] = []
    for (const account of resolved.accounts) {
      const one = await authorizeToolCall(deps, {
        principal,
        definition,
        toolName,
        args: { ...parsedArgs, account: account.account },
      })
      if (!one.allowed) continue
      let accessToken: string | undefined
      try {
        accessToken = await resolveGrantToken(deps, principal, one.connector, one)
      } catch {
        continue
      }
      const execute = deps.executeMailTool ?? executeMailTool
      const result = await execute({
        toolName,
        args: parsedArgs,
        connector: one.connector,
        accessToken,
        account: account.account,
      })
      const rows = result && typeof result === 'object' && Array.isArray((result as { messages?: unknown[] }).messages)
        ? (result as { messages: unknown[] }).messages
        : []
      messages.push(...rows)
    }
    await auditToolOutcome(deps, {
      principal,
      toolName,
      definitionId,
      agentId: definition.agentId,
      ok: true,
      metadata: { account: 'all', count: messages.length },
    })
    return textResult({ messages })
  }
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
      ...(authorized.accountChoices?.length ? { accounts: authorized.accountChoices } : {}),
      ...tenantMailboxErrorExtra(authorized.reason, authorized.mailboxAddress),
    })
  }
  const connector = authorized.connector
  const mailboxMeta = mailboxAuditMeta(connector, authorized.grant)
  let accessToken: string | undefined
  try {
    accessToken = await resolveGrantToken(deps, principal, connector, authorized)
  } catch {
    if (tenantMailboxOf(connector)) {
      await auditDenied(deps, principal, toolName, TENANT_MAILBOX_DISCONNECTED, definitionId, definition.agentId, mailboxMeta)
      return errorResult(TENANT_MAILBOX_DISCONNECTED, tenantMailboxErrorExtra(TENANT_MAILBOX_DISCONNECTED, mailboxMeta.mailbox as string | null))
    }
    const extra = await authorizationLinkFields(deps.startAuthorization, {
      reason: connector.type === 'gmail' ? 'gmail_auth_failed' : 'http_api_error',
      connectorId: authorized.connectorId,
      userId: principal.userId,
      tenantId: principal.tenantId,
      role: principal.role,
      toolName,
    })
    return errorResult(connector.type === 'gmail' ? 'gmail_auth_failed' : 'http_api_error', extra)
  }
  try {
    const execute = deps.executeMailTool ?? executeMailTool
    const account =
      typeof parsedArgs.account === 'string' && parsedArgs.account.trim()
        ? parsedArgs.account.trim()
        : mailboxAuditMeta(connector, authorized.grant).mailbox as string | undefined ?? connector.name ?? connector.id
    const result = await execute({
      toolName,
      args: parsedArgs,
      connector,
      accessToken,
      account: typeof account === 'string' ? account : connector.id,
    })
    await auditToolOutcome(deps, {
      principal,
      toolName,
      definitionId,
      agentId: definition.agentId,
      ok: true,
      metadata: { connectorId: authorized.connectorId, ...mailboxMeta },
    })
    return textResult(result)
  } catch (error) {
    const mapped = mapToolError(error, connector.type)
    await auditDenied(deps, principal, toolName, mapped.code, definitionId, definition.agentId, mapped.extra)
    return errorResult(mapped.code, mapped.extra)
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
  if (isEnterpriseMailTool(input.toolName)) {
    const execute = deps.executeMailTool ?? executeMailTool
    const account = typeof input.args.account === 'string' && input.args.account.trim()
      ? input.args.account.trim()
      : input.connector.name || input.connector.id
    return execute({
      toolName: input.toolName,
      args: input.args,
      connector: input.connector,
      accessToken: input.accessToken,
      account,
    })
  }
  if (isEnterpriseGmailTool(input.toolName)) {
    const execute = deps.executeGmailTool ?? executeGmailTool
    return execute(input.toolName, input.args, input.accessToken ?? '')
  }
  if (isEnterpriseHttpTool(input.toolName)) {
    const execute = deps.executeHttpApiTool ?? executeHttpApiTool
    // #717: a hintek/hibák a tenant nyelvén — angol tenant ne kapjon magyar szöveget.
    const language = await tenantLanguageOrDefault(deps.resolveTenantLanguage, input.connector.tenantId)
    const allowedEgressHosts = deps.resolveEgressAllowlist
      ? await deps.resolveEgressAllowlist(input.connector.tenantId)
      : undefined
    return execute(
      input.toolName,
      input.args,
      input.connector,
      input.accessToken,
      input.actingUser,
      input.agent,
      language,
      allowedEgressHosts,
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

function googleDriveMappedExtra(error: {
  status: number
  code?: string
  googleStatus?: string
  googleReasonCodes?: string[]
  googleLocations?: string[]
  googleMessage?: string
}): Record<string, unknown> {
  return {
    status: error.status,
    ...(typeof error.code === 'string' ? { googleCode: error.code } : {}),
    ...(typeof error.googleStatus === 'string' ? { googleStatus: error.googleStatus } : {}),
    ...(Array.isArray(error.googleReasonCodes) ? { googleReasonCodes: error.googleReasonCodes } : {}),
    ...(Array.isArray(error.googleLocations) ? { googleLocations: error.googleLocations } : {}),
    ...(typeof error.googleMessage === 'string' ? { googleMessage: error.googleMessage } : {}),
  }
}

function driveUploadLogMeta(toolName: string, args: Record<string, unknown>): Record<string, unknown> {
  if (toolName !== GOOGLE_DRIVE_UPLOAD_FILE_TOOL) return {}
  const name = typeof args.name === 'string' ? args.name.slice(0, 120) : undefined
  const mimeType = typeof args.mimeType === 'string' ? args.mimeType.slice(0, 100) : undefined
  const parent = typeof args.parentFolderId === 'string' ? args.parentFolderId.trim() : ''
  let uploadContentLength: number | undefined
  if (typeof args.textContent === 'string') {
    uploadContentLength = Buffer.byteLength(args.textContent, 'utf8')
  } else if (typeof args.contentBase64 === 'string') {
    const padded = args.contentBase64.endsWith('==') ? 2 : args.contentBase64.endsWith('=') ? 1 : 0
    uploadContentLength = Math.floor((args.contentBase64.length * 3) / 4) - padded
  }
  return {
    ...(name ? { uploadName: name } : {}),
    ...(mimeType ? { uploadMimeType: mimeType } : {}),
    hasParentFolderId: parent.length > 0,
    ...(uploadContentLength != null ? { uploadContentLength } : {}),
  }
}

function mapToolError(
  error: unknown,
  connectorType: string,
): { code: string; extra?: Record<string, unknown> } {
  if (error instanceof GoogleDriveApiAuthError || error instanceof GoogleWorkspaceApiAuthError) {
    return {
      code: 'google_drive_auth_failed',
      extra: googleDriveMappedExtra(error),
    }
  }
  if (error instanceof GmailApiAuthError) {
    return { code: 'gmail_auth_failed', extra: { status: error.status } }
  }
  if (error instanceof GoogleDriveApiError || error instanceof GoogleWorkspaceApiError) {
    return {
      code: connectorType === 'gmail' ? 'gmail_api_error' : 'google_drive_api_error',
      extra: googleDriveMappedExtra(error),
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

async function auditToolOutcome(
  deps: EnterpriseToolDeps,
  input: {
    principal: ToolCallPrincipal
    toolName: string
    definitionId: string
    agentId: string
    ok: boolean
    errorCode?: string
    metadata: Record<string, unknown>
  },
) {
  const action = input.ok ? 'enterprise.tool.ok' : 'enterprise.tool.error'
  const payload = {
    toolName: input.toolName,
    tenantId: input.principal.tenantId,
    userId: input.principal.userId,
    definitionId: input.definitionId,
    agentId: input.agentId,
    ...(input.errorCode ? { errorCode: input.errorCode } : {}),
    ...input.metadata,
  }
  console.info(action, payload)
  await writeAudit(deps.audit, {
    actorType: 'human',
    actorId: input.principal.userId,
    agentVersion: null,
    action,
    targetType: 'agent',
    targetId: input.agentId,
    modelUsed: null,
    inputRef: input.toolName,
    outputRef: input.errorCode ?? null,
    policyDecision: input.ok ? 'allowed' : null,
    metadata: payload,
    tenantId: input.principal.tenantId,
  })
}

/**
 * #395: `mcp_list_tools` + `mcp_call`. Ugyanaz az út, mint bármely enterprise
 * eszköznél (definíció-pin és agent-hozzáférés már lefutott), plusz az MCP-kapu:
 * engedélyezett domain, aktív jóváhagyott eszközlista, admin-besorolás (§3.3).
 */
async function invokeMcpTool(
  deps: EnterpriseToolDeps,
  input: {
    principal: ToolCallPrincipal
    toolName: string
    args: Record<string, unknown>
    definitionId: string
    definition: AgentDefinition
    origin?: string
    confirm?: WriteConfirmInput
  },
): Promise<EnterpriseToolMcpResult | InputRequiredToolResult> {
  const { principal, toolName, args, definitionId, definition } = input
  const deny = async (code: string, extra?: Record<string, unknown>) => {
    const auditDetails = code === 'invalid_args' ? extra : undefined
    await auditDenied(deps, principal, toolName, code, definitionId, definition.agentId, auditDetails)
    return errorResult(code, extra)
  }
  const linkFields = (reason: string, connectorId?: string) =>
    authorizationLinkFields(deps.startAuthorization, {
      reason,
      connectorId,
      userId: principal.userId,
      tenantId: principal.tenantId,
      role: principal.role,
      toolName,
    })
  if (!deps.loadMcpActiveTools) return deny('tool_not_configured')

  if (toolName === MCP_LIST_TOOLS_TOOL) {
    const parsed = mcpListToolsInputSchema.safeParse(args)
    if (!parsed.success) return deny('invalid_args', invalidArgsDetails(parsed.error))
    const wantedName = parsed.data.connectorName?.trim().toLowerCase()
    const candidates = definition.snapshot.connectors.filter(
      (row) =>
        row.type === 'mcp' &&
        (!parsed.data.connectorId || row.connectorId === parsed.data.connectorId) &&
        (!wantedName || row.name?.trim().toLowerCase() === wantedName),
    )
    if (candidates.length === 0) return deny('missing_mcp_connector_read')
    const connectors: Array<Record<string, unknown>> = []
    let firstDenial: string | null = null
    let note: string | undefined
    for (const row of candidates) {
      const authorized = await authorizeToolCall(deps, {
        principal,
        definition,
        toolName,
        args: { ...parsed.data, connectorId: row.connectorId },
      })
      // Hiányzó saját fiók: a jóváhagyott lista a mi adatunk, megmutatható — linkkel.
      const needsGrant = !authorized.allowed && isAuthorizationLinkReason(authorized.reason)
      if (!authorized.allowed && !needsGrant) {
        firstDenial ??= authorized.reason
        continue
      }
      const active = await deps.loadMcpActiveTools({ connectorId: row.connectorId, tenantId: principal.tenantId })
      const listed = mcpToolListForModel(active?.tools ?? [], parsed.data.query)
      note = listed.note
      connectors.push({
        connectorId: row.connectorId,
        name: row.name,
        tools: listed.tools,
        ...(active ? {} : { status: 'no_approved_tool_list' }),
        ...(needsGrant ? await linkFields(authorized.reason, row.connectorId) : {}),
      })
    }
    if (connectors.length === 0) return deny(firstDenial ?? 'missing_mcp_connector_read')
    await auditToolOutcome(deps, {
      principal,
      toolName,
      definitionId,
      agentId: definition.agentId,
      ok: true,
      metadata: { connectorIds: connectors.map((row) => row.connectorId) },
    })
    return textResult({
      note,
      connectors,
      usage:
        'Call mcp_call with connectorId, tool and arguments (matching inputSchema). Tools with risk write or danger need an idempotencyKey and may wait for human approval.',
    })
  }

  const parsed = mcpCallInputSchema.safeParse(args)
  if (!parsed.success) return deny('invalid_args', invalidArgsDetails(parsed.error))
  const callArgs = parsed.data as Record<string, unknown>
  const authorized = await authorizeToolCall(deps, { principal, definition, toolName, args: callArgs })
  if (!authorized.allowed) {
    return deny(authorized.reason, {
      ...(await linkFields(authorized.reason, authorized.connectorId)),
      ...(authorized.connectorChoices?.length ? { connectors: authorized.connectorChoices } : {}),
      ...(authorized.accountChoices?.length ? { accounts: authorized.accountChoices } : {}),
    })
  }
  const connector = authorized.connector
  const gate = await checkMcpCallGate(deps, { connector, tool: parsed.data.tool })
  if (!gate.ok) return deny(gate.code, { connectorId: connector.id })

  if (gate.risk !== 'read') {
    const binding = definition.snapshot.connectors.find((row) => row.connectorId === connector.id)
    if (binding?.accessMode !== 'write') return deny('missing_mcp_connector_write')
    // `danger` mindig jóváhagyási sor, az agent írási módjától függetlenül (§3.3/4).
    const modes =
      gate.risk === 'write' && deps.findAgentWriteModes
        ? await deps.findAgentWriteModes({ agentId: definition.agentId, tenantId: principal.tenantId })
        : null
    if (!skipsWriteApproval(MCP_CALL_TOOL, modes)) {
      if (!deps.enqueueWrite) return deny('tool_not_configured')
      return deps.enqueueWrite({ principal, toolName, args: callArgs, origin: input.origin, confirm: input.confirm })
    }
  }

  let accessToken: string | undefined
  if (connectorUsesGrantToken(connector)) {
    try {
      accessToken = await resolveGrantToken(deps, principal, connector, authorized)
    } catch {
      return deny('mcp_auth_failed', await linkFields('mcp_auth_failed', connector.id))
    }
  }

  const serverRequests = new Set<string>()
  const metadata = {
    connectorId: connector.id,
    mcpTool: parsed.data.tool,
    risk: gate.risk,
    ...(gate.risk !== 'read' ? { approvalBypass: 'agent_write_mode' } : {}),
  }
  try {
    const result = await executeMcpWithRetryPolicy(
      deps.executeMcpTool ?? defaultExecuteMcpTool,
      {
        connector,
        accessToken,
        tool: parsed.data.tool,
        arguments: parsed.data.arguments ?? {},
        allowedHosts: gate.allowedHosts,
        onServerRequest: (method) => serverRequests.add(method),
      },
      gate.risk,
    )
    await auditMcpServerRequests(deps, principal, definition.agentId, connector.id, serverRequests)
    await auditToolOutcome(deps, {
      principal,
      toolName,
      definitionId,
      agentId: definition.agentId,
      ok: !result.isError,
      ...(result.isError ? { errorCode: 'mcp_tool_error' } : {}),
      metadata,
    })
    return textResult(mcpResultForModel(result), Boolean(result.isError))
  } catch (error) {
    const code = mcpErrorCode(error, gate.risk)
    await auditMcpServerRequests(deps, principal, definition.agentId, connector.id, serverRequests)
    await auditToolOutcome(deps, {
      principal,
      toolName,
      definitionId,
      agentId: definition.agentId,
      ok: false,
      errorCode: code,
      metadata,
    })
    return errorResult(code, {
      connectorId: connector.id,
      ...(code === 'mcp_auth_failed' ? await linkFields(code, connector.id) : {}),
    })
  }
}

/** D9: a szerver sampling/elicitation/roots kérését elutasítottuk — ez auditálandó. */
export async function auditMcpServerRequests(
  deps: { audit?: AuditSink },
  principal: { userId: string; tenantId: string },
  agentId: string,
  connectorId: string | null,
  methods: Set<string>,
) {
  for (const method of methods) {
    const metadata = { method, connectorId, tenantId: principal.tenantId, userId: principal.userId, agentId }
    console.info('mcp.server_request.denied', metadata)
    await writeAudit(deps.audit, {
      actorType: 'system',
      actorId: null,
      agentVersion: null,
      action: 'mcp.server_request.denied',
      targetType: 'connector',
      targetId: connectorId,
      modelUsed: null,
      inputRef: method,
      outputRef: null,
      policyDecision: 'denied',
      metadata,
      tenantId: principal.tenantId,
    })
  }
}

async function invokeKbTool(
  deps: EnterpriseToolDeps,
  input: {
    principal: ToolCallPrincipal
    toolName: EnterpriseKbTool
    args: Record<string, unknown>
    definitionId: string
    definition: AgentDefinition
    origin?: string
  },
): Promise<EnterpriseToolMcpResult | InputRequiredToolResult> {
  const { principal, toolName, args, definitionId, definition } = input
  if (!deps.executeKbTool) {
    await auditDenied(deps, principal, toolName, 'tool_not_configured', definitionId, definition.agentId)
    return errorResult('tool_not_configured')
  }
  const parsed = schemaForEnterpriseKbTool(toolName).safeParse(args)
  if (!parsed.success) {
    const details = invalidArgsDetails(parsed.error)
    await auditDenied(deps, principal, toolName, 'invalid_args', definitionId, definition.agentId, details)
    return errorResult('invalid_args', details)
  }
  const parsedArgs = { ...(parsed.data as Record<string, unknown>) }
  const deny = async (code: string, details?: Record<string, unknown>) => {
    const auditDetails = code === 'invalid_args' ? details : undefined
    await auditDenied(deps, principal, toolName, code, definitionId, definition.agentId, auditDetails)
    return errorResult(code, details)
  }

  // #943: wikiId / documentId → a tudásbázis-kötés, ha a hívó nem adta meg.
  // A feloldott kötést ugyanúgy a hívóra szűkített snapshot ellenőrzi (D13).
  if (deps.resolveKbConnector && !asUuid(parsedArgs.connectorId)) {
    const wikiId = asUuid(parsedArgs.wikiId)
    const documentId = toolName === KB_GET_DOCUMENT_TOOL ? asUuid(parsedArgs.documentId) : undefined
    if (wikiId || documentId) {
      const connectorId = await deps.resolveKbConnector({ tenantId: principal.tenantId, wikiId, documentId })
      if (!connectorId && wikiId) return deny('not_found')
      if (connectorId) parsedArgs.connectorId = connectorId
    }
  }

  const userConnectors = scopeSnapshotConnectorsToUser(definition.snapshot.connectors, principal.userId)
  const kbBindings = userConnectors.filter((row) => row.type === 'knowledge_base')
  const wikiOverview =
    toolName === KB_LIST_INDEX_TOOL &&
    parsedArgs.inbox !== true &&
    !parsedArgs.connectorId &&
    !parsedArgs.pathPrefix &&
    !parsedArgs.artifactId &&
    kbBindings.length > 1
  if (deps.executeWikiTool && (isWikiToolCall(toolName, parsedArgs) || wikiOverview)) {
    return invokeWikiTool(deps, { ...input, args: parsedArgs, userConnectors })
  }
  if (
    toolName === KB_WIKI_WRITE_TOOL ||
    toolName === KB_WIKI_CHANGES_TOOL ||
    toolName === KB_WIKI_REVERT_TOOL ||
    parsedArgs.processingMode === 'wiki' ||
    parsedArgs.inbox === true
  ) {
    return deny('tool_not_configured')
  }

  const authorized = await authorizeToolCall(deps, {
    principal,
    definition,
    toolName,
    args: parsedArgs,
  })
  if (!authorized.allowed) {
    return deny(authorized.reason)
  }
  try {
    const result = await deps.executeKbTool(toolName, parsedArgs, {
      connectorId: authorized.connectorId,
      tenantId: principal.tenantId,
      agentId: definition.agentId,
      userId: principal.userId,
      snapshot: { connectors: userConnectors },
    })
    await auditKbOk(deps, { principal, toolName, definitionId, agentId: definition.agentId, connectorId: authorized.connectorId })
    return textResult(result)
  } catch (error) {
    const known = error instanceof KbToolError
    const pdf = error instanceof PdfPageImageError
    const code = known
      ? error.code
      : pdf
        ? error.code
        : error instanceof Error && error.message === 'not_found'
          ? 'not_found'
          : error instanceof Error && error.message === 'invalid_args'
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
    return errorResult(
      code,
      known ? error.details : pdf ? { nextStep: error.message, message: error.message } : undefined,
    )
  }
}

async function auditKbOk(
  deps: EnterpriseToolDeps,
  input: {
    principal: ToolCallPrincipal
    toolName: string
    definitionId: string
    agentId: string
    connectorId: string | null
  },
) {
  const payload = {
    toolName: input.toolName,
    tenantId: input.principal.tenantId,
    userId: input.principal.userId,
    definitionId: input.definitionId,
    agentId: input.agentId,
    ...(input.connectorId ? { connectorId: input.connectorId } : {}),
  }
  console.info('enterprise.tool.ok', payload)
  await writeAudit(deps.audit, {
    actorType: 'human',
    actorId: input.principal.userId,
    agentVersion: null,
    action: 'enterprise.tool.ok',
    targetType: 'agent',
    targetId: input.agentId,
    modelUsed: null,
    inputRef: input.toolName,
    outputRef: null,
    policyDecision: 'allowed',
    metadata: payload,
    tenantId: input.principal.tenantId,
  })
}

/** `kb_wiki_write` a snapshotban: saját képessége vagy a `kb_ingest` (a wiki-jog a kötésen dől el, D2). */
const WIKI_TOOL_CAPABILITIES: Record<string, readonly string[]> = {
  [KB_WIKI_WRITE_TOOL]: [KB_WIKI_WRITE_TOOL, KB_INGEST_TOOL],
  // #978: az előzmény-eszközök a meglévő wiki-képességre épülnek (a jog a kötésen dől el).
  [KB_WIKI_REVERT_TOOL]: [KB_WIKI_REVERT_TOOL, KB_WIKI_WRITE_TOOL, KB_INGEST_TOOL],
  [KB_WIKI_CHANGES_TOOL]: [KB_WIKI_CHANGES_TOOL, KB_LIST_INDEX_TOOL, KB_GET_PAGE_TOOL],
  [KB_INGEST_TOOL]: [KB_INGEST_TOOL],
  [KB_LIST_INDEX_TOOL]: [KB_LIST_INDEX_TOOL],
}

/**
 * #943: a wiki-útvonalak (beküldés, írás, tálca, áttekintés) nem egyetlen
 * kiválasztott kötésen futnak: a cél-wikit és a jogot (`none/read/submit/write`)
 * a `WikiService` oldja fel a publikált snapshotból és a hívó felhasználóból.
 */
async function invokeWikiTool(
  deps: EnterpriseToolDeps,
  input: {
    principal: ToolCallPrincipal
    toolName: EnterpriseKbTool
    args: Record<string, unknown>
    definitionId: string
    definition: AgentDefinition
    origin?: string
    userConnectors: AgentDefinition['snapshot']['connectors']
  },
): Promise<EnterpriseToolMcpResult | InputRequiredToolResult> {
  const { principal, toolName, args, definitionId, definition } = input
  const accepted = WIKI_TOOL_CAPABILITIES[toolName] ?? [toolName]
  if (!definition.snapshot.capabilities.some((row) => row.allowed && accepted.includes(row.toolName))) {
    await auditDenied(deps, principal, toolName, 'capability_not_allowed', definitionId, definition.agentId)
    return errorResult('capability_not_allowed')
  }
  let outcome: WikiToolOutcome
  try {
    outcome = await deps.executeWikiTool!(toolName, args, {
      tenantId: principal.tenantId,
      userId: principal.userId,
      agentId: definition.agentId,
      snapshot: { connectors: input.userConnectors },
    })
  } catch (error) {
    const code =
      error instanceof Error && (error.message === 'invalid_args' || error.message === 'file_too_large')
        ? error.message
        : error instanceof Error && error.message === 'not_found'
          ? 'not_found'
          : 'tool_execution_failed'
    if (code === 'tool_execution_failed') console.error('enterprise.tool.wiki_failed', error)
    await auditDenied(deps, principal, toolName, code, definitionId, definition.agentId)
    return errorResult(code)
  }

  if (outcome.ok === false) {
    await auditDenied(deps, principal, toolName, outcome.code, definitionId, definition.agentId)
    return errorResult(outcome.code, outcome.details)
  }
  if (outcome.ok === true) {
    const connectorId = asUuid(args.connectorId) ?? null
    await auditKbOk(deps, { principal, toolName, definitionId, agentId: definition.agentId, connectorId })
    return textResult(outcome.result)
  }

  // Jóváhagyás: egy kártya a teljes change-setre a gateway-sorban (D1/D4).
  const { request } = outcome
  if (!deps.enqueueWrite) {
    await deps.onWikiApprovalQueued?.({ tenantId: principal.tenantId, changeSetId: request.changeSetId, operationId: null })
    await auditDenied(deps, principal, toolName, 'tool_not_configured', definitionId, definition.agentId)
    return errorResult('tool_not_configured')
  }
  const queued = await deps.enqueueWrite({
    principal,
    toolName: KB_WIKI_WRITE_TOOL,
    args: {
      definitionId,
      idempotencyKey: `kb-wiki-changeset:${request.changeSetId}`,
      connectorId: request.connectorId,
      wikiId: request.wikiId,
      changeSetId: request.changeSetId,
      pageCount: request.pageCount,
      ...(request.pages ? { pages: request.pages } : {}),
    },
    origin: input.origin,
  })
  const queuedPayload = 'content' in queued ? parseToolJson(queued) : null
  const operationId = queued && 'content' in queued && !queued.isError ? asUuid(queuedPayload?.operationId) ?? null : null
  await deps.onWikiApprovalQueued?.({ tenantId: principal.tenantId, changeSetId: request.changeSetId, operationId })
  if (!operationId || !queuedPayload) return queued
  return textResult({ ...queuedPayload, ...outcome.result })
}

function parseToolJson(result: EnterpriseToolMcpResult): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(result.content[0]?.text ?? '') as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
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
    const details = invalidArgsDetails(parsed.error)
    await auditDenied(deps, principal, toolName, 'invalid_args', definitionId, definition.agentId, details)
    return errorResult('invalid_args', details)
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
  const mounted: Array<{ path: string; sandboxPath: string }> = []
  for (const item of resolvedInputs.inputs) {
    let file: { path: string; content: string } | null
    try {
      file = await readWorkFile!({
        tenantId: principal.tenantId,
        projectKey: parsedArgs.projectKey,
        path: item.workPath,
      })
    } catch (error) {
      const code = workFileToolErrorCode(error)
      await auditDenied(deps, principal, toolName, code, definitionId, definition.agentId)
      return errorResult(code)
    }
    if (!file) {
      await auditDenied(deps, principal, toolName, 'file_not_found', definitionId, definition.agentId)
      return errorResult('file_not_found', { path: item.workPath })
    }
    files.push({ sandboxPath: item.sandboxPath, bytes: Buffer.from(file.content, 'utf8') })
    mounted.push({ path: file.path, sandboxPath: item.sandboxPath })
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
    const thrown = error instanceof Error ? error.message : ''
    const code =
      error instanceof CodeSandboxDeniedError
        ? error.reason.split(':')[0]!
        : thrown === 'code_sandbox_disabled' ||
            thrown === 'code_sandbox_base_url_missing' ||
            thrown === 'invalid_sandbox_command' ||
            WORK_FILE_TOOL_ERROR_CODES.has(thrown)
          ? thrown
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
