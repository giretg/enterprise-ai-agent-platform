/**
 * Write confirmation in the MCP client (#618, MRTR / protocol 2026-07-28).
 *
 * Round 1: enqueue as today, then ask the user with a one-field form instead of
 * sending them to the approval link. Round 2: the client retries the same call
 * with the answer and the HMAC-sealed `requestState`; the answer goes through
 * the same approve/reject path as the control plane link (D5).
 */
import {
  enterpriseToolErrorPayload,
  GMAIL_CREATE_DRAFT_TOOL,
  GMAIL_MODIFY_LABELS_TOOL,
  GMAIL_SEND_TOOL,
  GMAIL_TRASH_TOOL,
  GOOGLE_DRIVE_CREATE_FOLDER_TOOL,
  GOOGLE_DRIVE_UPLOAD_FILE_TOOL,
  GOOGLE_SHEETS_WRITE_RANGE_TOOL,
  HTTP_API_REQUEST_TOOL,
  type EnterpriseToolMcpResult,
  type InputRequiredToolResult,
  type ToolCallPrincipal,
  type WriteConfirmInput,
  type WriteConfirmState,
} from '@/domain/enterprise-tools'
import { writeAudit } from '@/lib/audit/types'
import { formatToolUiName } from '@/lib/tool-ui-labels'
import {
  approveGatewayOperation,
  enqueueGatewayOperation,
  enqueueResultToMcp,
  getGatewayOperation,
  rejectGatewayOperation,
  stableJsonFingerprint,
  type GatewayOperationResult,
  type GatewayOperationServiceDeps,
} from './gateway-operation-service'
import type { GatewayOperationView } from './types'

export const WRITE_CONFIRM_KEY = 'confirm_write'
export const WRITE_CONFIRM_TTL_MS = 15 * 60_000
const MESSAGE_CONTENT_LIMIT = 2000

type ToolResult = EnterpriseToolMcpResult | InputRequiredToolResult

type WriteInput = {
  principal: ToolCallPrincipal
  toolName: string
  args: Record<string, unknown>
  origin?: string
  confirm?: WriteConfirmInput
}

const CONFIRM_SCHEMA = {
  type: 'object',
  properties: {
    decision: {
      type: 'string',
      title: 'Mehet az írás?',
      oneOf: [
        { const: 'approve', title: 'Jóváhagyom' },
        { const: 'reject', title: 'Elutasítom' },
      ],
    },
  },
  required: ['decision'],
} as const

function textResult(payload: unknown, isError = false): EnterpriseToolMcpResult {
  return {
    ...(isError ? { isError: true as const } : {}),
    content: [{ type: 'text', text: JSON.stringify(payload) }],
  }
}

function approvalUrl(origin: string | undefined, operationId: string): string | undefined {
  return origin ? `${origin.replace(/\/+$/, '')}/control-plane/operations#${operationId}` : undefined
}

function asState(value: unknown): WriteConfirmState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const state = value as Partial<WriteConfirmState>
  if (state.v !== 1) return null
  for (const key of ['operationId', 'tenantId', 'userId', 'tool', 'argsHash'] as const) {
    if (typeof state[key] !== 'string') return null
  }
  if (typeof state.exp !== 'number') return null
  return state as WriteConfirmState
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function gmailComposeTarget(args: Record<string, unknown>): string {
  if (str(args.draftId)) return `Gmail piszkozat elküldése: ${str(args.draftId)}`
  const parts = [
    str(args.replyToMessageId)
      ? `Gmail válasz a(z) ${str(args.replyToMessageId)} levélre${args.replyAll === true ? ' (mindenkinek)' : ''}`
      : 'Gmail új levél',
    str(args.to) ? `címzett: ${str(args.to)}` : str(args.replyToMessageId) ? 'címzett: az eredeti feladó' : '',
    str(args.cc) ? `másolat: ${str(args.cc)}` : '',
    str(args.bcc) ? `titkos másolat: ${str(args.bcc)}` : '',
    str(args.subject) ? `tárgy: ${str(args.subject)}` : '',
  ]
  return parts.filter(Boolean).join(', ')
}

function gmailItemTarget(args: Record<string, unknown>): string {
  return str(args.threadId) ? `Gmail levélváltás ${str(args.threadId)}` : `Gmail levél ${str(args.messageId)}`
}

async function confirmMessage(
  deps: GatewayOperationServiceDeps,
  tenantId: string,
  view: GatewayOperationView,
  args: Record<string, unknown>,
  origin?: string,
): Promise<string> {
  const definition = await deps.loadDefinition({ tenantId, definitionId: view.definitionId })
  const agentName = definition?.snapshot.name ?? 'A munkatárs'
  const connectorName =
    str(args.connectorName) ||
    definition?.snapshot.connectors.find((c) => c.connectorId === view.connectorId)?.name ||
    'HTTP API'

  let target = ''
  let content = ''
  if (view.toolName === HTTP_API_REQUEST_TOOL) {
    target = `${connectorName}: ${str(args.method)} ${str(args.path)}`
    content = str(args.body)
  } else if (view.toolName === GOOGLE_DRIVE_CREATE_FOLDER_TOOL) {
    target = `Google Drive mappa: ${str(args.name)}`
  } else if (view.toolName === GOOGLE_DRIVE_UPLOAD_FILE_TOOL) {
    target = `Google Drive fájl: ${str(args.name)}`
    content = str(args.textContent)
  } else if (view.toolName === GMAIL_SEND_TOOL || view.toolName === GMAIL_CREATE_DRAFT_TOOL) {
    target = gmailComposeTarget(args)
    content = str(args.body)
  } else if (view.toolName === GMAIL_MODIFY_LABELS_TOOL) {
    target = [
      gmailItemTarget(args),
      str(args.addLabelIds) ? `hozzáad: ${str(args.addLabelIds)}` : '',
      str(args.removeLabelIds) ? `levesz: ${str(args.removeLabelIds)}` : '',
    ]
      .filter(Boolean)
      .join(', ')
  } else if (view.toolName === GMAIL_TRASH_TOOL) {
    target = `${gmailItemTarget(args)} → kuka`
  } else if (view.toolName === GOOGLE_SHEETS_WRITE_RANGE_TOOL) {
    target = `Táblázat: ${str(args.fileId)}, tartomány: ${str(args.range)}`
    content = str(args.values)
  }

  const lines = [`${agentName} írni szeretne: ${formatToolUiName(view.toolName)}.`]
  if (target) lines.push(`Cél: ${target}`)
  if (content) {
    const url = approvalUrl(origin, view.operationId)
    const cut = content.length > MESSAGE_CONTENT_LIMIT
    lines.push(
      `Tartalom:\n${content.slice(0, MESSAGE_CONTENT_LIMIT)}${
        cut ? `\n…a teljes tartalom a linken${url ? `: ${url}` : '.'}` : ''
      }`,
    )
  }
  lines.push('Jóváhagyás után a rendszer egyszer elküldi. Elutasításnál nem történik írás.')
  return lines.join('\n')
}

/** Final answer once the operation has left `awaiting_approval`. */
function decidedResultToMcp(view: GatewayOperationView, origin?: string): EnterpriseToolMcpResult {
  if (view.status === 'succeeded') {
    return textResult({
      operationId: view.operationId,
      status: view.status,
      toolName: view.toolName,
      result: view.result,
    })
  }
  if (view.status === 'failed') {
    const code = view.errorCode ?? 'tool_execution_failed'
    return textResult(enterpriseToolErrorPayload(code, { operationId: view.operationId }), true)
  }
  if (view.status === 'rejected') {
    return textResult({
      operationId: view.operationId,
      status: view.status,
      toolName: view.toolName,
      message: 'Elutasítva, nem történt írás.',
    })
  }
  return enqueueResultToMcp({ ok: true, view }, origin)
}

async function mismatch(
  deps: GatewayOperationServiceDeps,
  principal: ToolCallPrincipal,
  toolName: string,
  reason: string,
): Promise<EnterpriseToolMcpResult> {
  await writeAudit(deps.audit, {
    actorType: 'human',
    actorId: principal.userId,
    agentVersion: null,
    action: 'gateway.operation.confirm_mismatch',
    targetType: 'gateway_operation',
    targetId: null,
    modelUsed: null,
    inputRef: toolName,
    outputRef: 'request_state_mismatch',
    policyDecision: 'denied',
    metadata: { toolName, reason, tenantId: principal.tenantId, userId: principal.userId },
    tenantId: principal.tenantId,
  })
  return textResult(
    enterpriseToolErrorPayload(
      'request_state_mismatch',
      undefined,
      'The confirmation does not belong to this call; nothing was executed',
    ),
    true,
  )
}

function decisionOf(
  response: NonNullable<WriteConfirmInput['retry']>['response'],
): 'approve' | 'reject' | null {
  if (!response) return null
  if (response.action === 'decline') return 'reject'
  if (response.action !== 'accept') return null
  const decision = response.content?.decision
  return decision === 'approve' || decision === 'reject' ? decision : null
}

async function decide(
  deps: GatewayOperationServiceDeps,
  input: WriteInput,
  view: GatewayOperationView,
  decision: 'approve' | 'reject',
): Promise<ToolResult> {
  const decideInput = {
    tenantId: input.principal.tenantId,
    operationId: view.operationId,
    actor: input.principal,
    channel: 'mcp_form' as const,
  }
  const result: GatewayOperationResult =
    decision === 'approve'
      ? await approveGatewayOperation(deps, decideInput)
      : await rejectGatewayOperation(deps, decideInput)
  if (result.ok) return decidedResultToMcp(result.view, input.origin)
  // Decided meanwhile (link, earlier retry): report the current state, never execute twice.
  if (result.code === 'approval_already_decided' || result.code === 'operation_not_awaiting_approval') {
    const current = await getGatewayOperation(deps, {
      principal: input.principal,
      operationId: view.operationId,
    })
    if (current.ok) return decidedResultToMcp(current.view, input.origin)
  }
  return enqueueResultToMcp(result, input.origin)
}

async function retryRound(
  deps: GatewayOperationServiceDeps,
  input: WriteInput,
  retry: NonNullable<WriteConfirmInput['retry']>,
): Promise<ToolResult> {
  const { principal, toolName, args, origin } = input
  const state = asState(retry.state)
  // No verified state (missing, or no key configured): fall back to the link.
  if (!state) return enqueueResultToMcp(await enqueueGatewayOperation(deps, input), origin)
  if (state.tenantId !== principal.tenantId || state.userId !== principal.userId) {
    return mismatch(deps, principal, toolName, 'principal')
  }
  if (state.tool !== toolName || state.argsHash !== stableJsonFingerprint(args)) {
    return mismatch(deps, principal, toolName, 'args')
  }

  const enqueued = await enqueueGatewayOperation(deps, input)
  if (!enqueued.ok) return enqueueResultToMcp(enqueued, origin)
  if (enqueued.view.operationId !== state.operationId) {
    return mismatch(deps, principal, toolName, 'operation')
  }
  if (enqueued.view.status !== 'awaiting_approval') return decidedResultToMcp(enqueued.view, origin)
  if (state.exp < Date.now()) return enqueueResultToMcp(enqueued, origin)

  const decision = decisionOf(retry.response)
  if (!decision) return enqueueResultToMcp(enqueued, origin)
  return decide(deps, input, enqueued.view, decision)
}

/**
 * `enqueueWrite` for the MCP gateway. Without `confirm.mint` (and no retry) this
 * is exactly the #617 link answer.
 */
export async function enqueueWriteForMcp(
  deps: GatewayOperationServiceDeps,
  input: WriteInput,
): Promise<ToolResult> {
  const retry = input.confirm?.retry
  if (retry) return retryRound(deps, input, retry)

  const enqueued = await enqueueGatewayOperation(deps, input)
  const mint = input.confirm?.mint
  if (!enqueued.ok || !mint || enqueued.view.status !== 'awaiting_approval') {
    return enqueueResultToMcp(enqueued, input.origin)
  }
  const now = Date.now()
  const requestState = await mint({
    v: 1,
    operationId: enqueued.view.operationId,
    tenantId: input.principal.tenantId,
    userId: input.principal.userId,
    tool: input.toolName,
    argsHash: stableJsonFingerprint(input.args),
    iat: now,
    exp: now + WRITE_CONFIRM_TTL_MS,
  })
  return {
    resultType: 'input_required',
    inputRequests: {
      [WRITE_CONFIRM_KEY]: {
        method: 'elicitation/create',
        params: {
          mode: 'form',
          message: await confirmMessage(deps, input.principal.tenantId, enqueued.view, input.args, input.origin),
          requestedSchema: CONFIRM_SCHEMA,
        },
      },
    },
    requestState,
  }
}
