import { canOperateAgent, isPrivilegedAgentReader, type AgentDefinition } from '@/domain/agent-definition'
import {
  GoogleDriveApiAuthError,
  GoogleDriveApiError,
} from '@/domain/connector-grant/google-drive-api-client'
import {
  assertGoogleDriveWriteAccess,
  createdDriveFilesFromResult,
  GoogleDriveWriteAccessError,
  grantUsesSelectedWriteProfile,
} from '@/domain/connector-grant/google-drive-write-access'
import { executeGoogleDriveTool } from '@/domain/enterprise-tools/handlers/google-drive'
import {
  authorizeToolCall,
  asUuid,
  ENTERPRISE_TOOL_ERROR_MESSAGES,
  type AuthorizeToolCallDeps,
  type EnterpriseToolMcpResult,
  type LiveConnectorRow,
  type ToolCallPrincipal,
} from '@/domain/enterprise-tools'
import {
  isEnterpriseDriveWriteTool,
  schemaForEnterpriseDriveTool,
} from '@/domain/enterprise-tools/tool-definitions'
import type {
  GatewayOperationRecord,
  GatewayOperationStatus,
  GatewayOperationStore,
  GatewayOperationView,
} from './types'
import { computeDiffHash } from '@/lib/crypto/hash-chain'
import type { AuditSink } from '@/lib/audit/types'
import { writeAudit } from '@/lib/audit/types'

export type GatewayActor = ToolCallPrincipal

export type GatewayOperationOk = { ok: true; view: GatewayOperationView; created?: boolean }
export type GatewayOperationErr = { ok: false; code: string }
export type GatewayOperationResult = GatewayOperationOk | GatewayOperationErr

export type GatewayOperationServiceDeps = AuthorizeToolCallDeps & {
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
  operations: GatewayOperationStore
  resolveRequester: (input: {
    tenantId: string
    userId: string
  }) => Promise<{ role: string; assumed: boolean } | null>
  executeDriveTool?: (
    toolName: string,
    args: Record<string, unknown>,
    accessToken: string,
  ) => Promise<unknown>
  recordCreatedDriveFiles?: (input: {
    grantId: string
    files: Array<{ fileId: string; name: string; mimeType: string }>
  }) => Promise<void>
  audit?: AuditSink
}

const MESSAGES: Record<string, string> = {
  ...ENTERPRISE_TOOL_ERROR_MESSAGES,
  operation_not_found: 'Gateway operation not found',
  operation_not_awaiting_approval: 'Gateway operation is not awaiting approval',
  approval_already_decided: 'Gateway operation has already been decided',
  approver_not_authorized: 'Approver is not authorized',
  drive_write_not_allowed: 'Google Drive write is not allowed for the selected files',
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/** Stable JSON for idempotency payload equality (key order independent). */
function stableJsonFingerprint(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJsonFingerprint(entry)).join(',')}]`
  }
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableJsonFingerprint(obj[key])}`)
    .join(',')}}`
}

/**
 * Tenant-unique idempotency keys must only replay the same call.
 * Otherwise enqueue returns another user's succeeded result (bypassing get
 * visibility) or silently drops a write with different args.
 */
function idempotencyReplayConflict(
  existing: GatewayOperationRecord,
  principal: GatewayActor,
  toolName: string,
  args: Record<string, unknown>,
): GatewayOperationErr | null {
  if (existing.principalUserId !== principal.userId) return err('idempotency_key_conflict')
  if (existing.toolName !== toolName) return err('idempotency_key_conflict')
  if (stableJsonFingerprint(asRecord(existing.argsJson)) !== stableJsonFingerprint(args)) {
    return err('idempotency_key_conflict')
  }
  return null
}

export function canApproveGatewayOperation(actor: GatewayActor): boolean {
  if (actor.assumed) return true
  return isPrivilegedAgentReader(actor.role)
}

export function canSeeGatewayOperation(
  actor: GatewayActor,
  operation: { principalUserId: string },
): boolean {
  if (actor.userId === operation.principalUserId) return true
  return canApproveGatewayOperation(actor)
}

export function toGatewayOperationView(row: GatewayOperationRecord): GatewayOperationView {
  return {
    operationId: row.id,
    status: row.status,
    toolName: row.toolName,
    idempotencyKey: row.idempotencyKey,
    definitionId: row.agentDefinitionVersionId,
    agentId: row.agentId,
    principalUserId: row.principalUserId,
    connectorId: row.connectorId,
    errorCode: row.errorCode,
    result: row.status === 'succeeded' ? row.resultJson : null,
    approval: row.approval
      ? {
          decision: row.approval.decision,
          decidedByUserId: row.approval.decidedByUserId,
          decidedAt: row.approval.decidedAt ? row.approval.decidedAt.toISOString() : null,
          reason: row.approval.reason,
        }
      : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

function textResult(payload: unknown, isError = false): EnterpriseToolMcpResult {
  return {
    ...(isError ? { isError: true as const } : {}),
    content: [{ type: 'text', text: JSON.stringify(payload) }],
  }
}

function errorMcp(code: string): EnterpriseToolMcpResult {
  return textResult({ code, message: MESSAGES[code] ?? 'Gateway operation failed' }, true)
}

export function enqueueResultToMcp(result: GatewayOperationResult): EnterpriseToolMcpResult {
  if (!result.ok) return errorMcp(result.code)
  return textResult({
    operationId: result.view.operationId,
    status: result.view.status,
    idempotencyKey: result.view.idempotencyKey,
    toolName: result.view.toolName,
  })
}

export function getResultToMcp(result: GatewayOperationResult): EnterpriseToolMcpResult {
  if (!result.ok) return errorMcp(result.code)
  return textResult(result.view)
}

function err(code: string): GatewayOperationErr {
  return { ok: false, code }
}

async function recordGatewayAudit(
  deps: GatewayOperationServiceDeps,
  input: {
    action: string
    actorType: 'human' | 'system'
    actorId: string | null
    tenantId: string
    operationId?: string | null
    policyDecision?: string | null
    metadata: Record<string, unknown>
  },
) {
  console.info(input.action, input.metadata)
  await writeAudit(deps.audit, {
    actorType: input.actorType,
    actorId: input.actorId,
    agentVersion: null,
    action: input.action,
    targetType: 'gateway_operation',
    targetId: input.operationId ?? null,
    modelUsed: null,
    inputRef: typeof input.metadata.toolName === 'string' ? input.metadata.toolName : null,
    outputRef: typeof input.metadata.errorCode === 'string' ? input.metadata.errorCode : null,
    policyDecision: input.policyDecision ?? null,
    metadata: input.metadata,
    tenantId: input.tenantId,
  })
}

function ok(view: GatewayOperationView, created?: boolean): GatewayOperationOk {
  return created === undefined ? { ok: true, view } : { ok: true, view, created }
}

type WriteAuthFail = { ok: false; code: string; definitionId?: string; agentId?: string }

async function loadAuthorizedWrite(
  deps: GatewayOperationServiceDeps,
  principal: GatewayActor,
  toolName: string,
  args: Record<string, unknown>,
): Promise<
  | WriteAuthFail
  | {
      ok: true
      definition: AgentDefinition
      connectorId: string
      parsedArgs: Record<string, unknown>
    }
> {
  const fail = (code: string, ids?: { definitionId?: string; agentId?: string }): WriteAuthFail => ({
    ok: false,
    code,
    ...ids,
  })
  if (!isEnterpriseDriveWriteTool(toolName)) return fail('tool_not_configured')

  const definitionId = asUuid(args.definitionId)
  if (!definitionId) return fail('definition_not_found')

  const definition = await deps.loadDefinition({
    tenantId: principal.tenantId,
    definitionId,
  })
  if (!definition) return fail('definition_not_found', { definitionId })
  const ids = { definitionId, agentId: definition.agentId }

  if (args.agentId !== undefined) {
    const agentIdArg = asUuid(args.agentId)
    if (!agentIdArg || agentIdArg !== definition.agentId) return fail('definition_mismatch', ids)
  }

  const grant = await deps.findAgentGrant({
    tenantId: principal.tenantId,
    userId: principal.userId,
    agentId: definition.agentId,
  })
  if (!canOperateAgent({ role: principal.role, grant, assumed: principal.assumed })) {
    return fail('agent_access_denied', ids)
  }

  const idempotencyKey = args.idempotencyKey
  if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0) {
    return fail('idempotency_key_required', ids)
  }

  const parsed = schemaForEnterpriseDriveTool(toolName).safeParse(args)
  if (!parsed.success) return fail('invalid_args', ids)

  const authorized = await authorizeToolCall(deps, {
    principal,
    definition,
    toolName,
    args: parsed.data as Record<string, unknown>,
  })
  if (!authorized.allowed) return fail(authorized.reason, ids)

  return {
    ok: true,
    definition,
    connectorId: authorized.connectorId,
    parsedArgs: parsed.data as Record<string, unknown>,
  }
}

export async function enqueueGatewayOperation(
  deps: GatewayOperationServiceDeps,
  input: { principal: GatewayActor; toolName: string; args: Record<string, unknown> },
): Promise<GatewayOperationResult> {
  const { principal, toolName, args } = input
  const authorized = await loadAuthorizedWrite(deps, principal, toolName, args)
  if (!authorized.ok) {
    await recordGatewayAudit(deps, {
      action: 'enterprise.tool.denied',
      actorType: 'human',
      actorId: principal.userId,
      tenantId: principal.tenantId,
      policyDecision: 'denied',
      metadata: {
        toolName,
        reasonCode: authorized.code,
        tenantId: principal.tenantId,
        userId: principal.userId,
        ...(authorized.definitionId ? { definitionId: authorized.definitionId } : {}),
        ...(authorized.agentId ? { agentId: authorized.agentId } : {}),
      },
    })
    return err(authorized.code)
  }

  const idempotencyKey = String(authorized.parsedArgs.idempotencyKey)
  const existing = await deps.operations.findByTenantAndIdempotencyKey(
    principal.tenantId,
    idempotencyKey,
  )
  if (existing) {
    const conflict = idempotencyReplayConflict(
      existing,
      principal,
      toolName,
      authorized.parsedArgs,
    )
    if (conflict) return conflict
    return ok(toGatewayOperationView(existing), false)
  }

  const inserted = await deps.operations.createAwaitingApproval({
    tenantId: principal.tenantId,
    agentDefinitionVersionId: authorized.definition.definitionId,
    agentId: authorized.definition.agentId,
    principalUserId: principal.userId,
    toolName,
    argsJson: authorized.parsedArgs,
    idempotencyKey,
    connectorId: authorized.connectorId,
  })
  if (!inserted.created) {
    const conflict = idempotencyReplayConflict(
      inserted.record,
      principal,
      toolName,
      authorized.parsedArgs,
    )
    if (conflict) return conflict
    return ok(toGatewayOperationView(inserted.record), false)
  }
  await recordGatewayAudit(deps, {
    action: 'gateway.operation.enqueued',
    actorType: 'human',
    actorId: principal.userId,
    tenantId: principal.tenantId,
    operationId: inserted.record.id,
    metadata: {
      operationId: inserted.record.id,
      toolName,
      tenantId: principal.tenantId,
      userId: principal.userId,
      definitionId: authorized.definition.definitionId,
      agentId: authorized.definition.agentId,
      idempotencyKey,
    },
  })
  return ok(toGatewayOperationView(inserted.record), inserted.created)
}

export async function getGatewayOperation(
  deps: GatewayOperationServiceDeps,
  input: { principal: GatewayActor; operationId: string },
): Promise<GatewayOperationResult> {
  const operationId = asUuid(input.operationId)
  if (!operationId) return err('operation_not_found')
  const row = await deps.operations.findById(operationId)
  if (!row || row.tenantId !== input.principal.tenantId) return err('operation_not_found')
  if (!canSeeGatewayOperation(input.principal, row)) return err('operation_not_found')
  return ok(toGatewayOperationView(row))
}

export type GatewayPendingOperation = GatewayOperationView & {
  args: Record<string, unknown>
}

export type GatewayPendingOperationRow = GatewayPendingOperation & {
  requesterName: string
  agentName: string
  definitionLabel: string
}

export async function listPendingGatewayOperations(
  deps: GatewayOperationServiceDeps,
  input: { tenantId: string },
): Promise<GatewayPendingOperation[]> {
  const rows = await deps.operations.listAwaitingApproval(input.tenantId)
  return rows.map((row) => ({
    ...toGatewayOperationView(row),
    args: asRecord(row.argsJson),
  }))
}

function pendingDecisionError(
  row: GatewayOperationRecord,
  tenantId: string,
): GatewayOperationErr | null {
  if (row.tenantId !== tenantId) return err('operation_not_found')
  if (row.status !== 'awaiting_approval') return err('operation_not_awaiting_approval')
  if (row.approval && row.approval.decision !== 'pending') return err('approval_already_decided')
  return null
}

export async function rejectGatewayOperation(
  deps: GatewayOperationServiceDeps,
  input: { tenantId: string; operationId: string; actor: GatewayActor; reason?: string },
): Promise<GatewayOperationResult> {
  if (!canApproveGatewayOperation(input.actor)) return err('approver_not_authorized')
  const operationId = asUuid(input.operationId)
  if (!operationId) return err('operation_not_found')

  const decidedAt = new Date()
  const claimed = await deps.operations.withLockedOperation(operationId, async (row, save) => {
    const denied = pendingDecisionError(row, input.tenantId)
    if (denied) return denied
    const updated = await save({
      status: 'rejected',
      approval: {
        decision: 'rejected',
        decidedByUserId: input.actor.userId,
        reason: input.reason ?? null,
        decidedAt,
      },
    })
    return ok(toGatewayOperationView(updated))
  })
  if (!claimed) return err('operation_not_found')
  if (claimed.ok) {
    await recordGatewayAudit(deps, {
      action: 'gateway.operation.rejected',
      actorType: 'human',
      actorId: input.actor.userId,
      tenantId: input.tenantId,
      operationId,
      policyDecision: 'denied',
      metadata: {
        operationId,
        decidedByUserId: input.actor.userId,
        tenantId: input.tenantId,
        ...(input.reason ? { reasonHash: computeDiffHash(input.reason) } : {}),
      },
    })
  }
  return claimed
}

export async function approveGatewayOperation(
  deps: GatewayOperationServiceDeps,
  input: { tenantId: string; operationId: string; actor: GatewayActor; reason?: string },
): Promise<GatewayOperationResult> {
  if (!canApproveGatewayOperation(input.actor)) return err('approver_not_authorized')
  const operationId = asUuid(input.operationId)
  if (!operationId) return err('operation_not_found')

  const decidedAt = new Date()
  const claimed = await deps.operations.withLockedOperation(operationId, async (row, save) => {
    const denied = pendingDecisionError(row, input.tenantId)
    if (denied) return denied
    await save({
      status: 'approved',
      approval: {
        decision: 'approved',
        decidedByUserId: input.actor.userId,
        reason: input.reason ?? null,
        decidedAt,
      },
    })
    const executing = await save({ status: 'executing' })
    return { ok: true as const, record: executing }
  })
  if (!claimed) return err('operation_not_found')
  if (!claimed.ok) return claimed

  await recordGatewayAudit(deps, {
    action: 'gateway.operation.approved',
    actorType: 'human',
    actorId: input.actor.userId,
    tenantId: input.tenantId,
    operationId,
    policyDecision: 'allowed',
    metadata: {
      operationId,
      decidedByUserId: input.actor.userId,
      tenantId: input.tenantId,
    },
  })
  await recordGatewayAudit(deps, {
    action: 'gateway.operation.executing',
    actorType: 'system',
    actorId: null,
    tenantId: input.tenantId,
    operationId,
    metadata: {
      operationId,
      connectorId: claimed.record.connectorId,
      tenantId: input.tenantId,
    },
  })

  const executed = await executeApprovedOperation(deps, claimed.record)
  return ok(toGatewayOperationView(executed))
}

async function executeApprovedOperation(
  deps: GatewayOperationServiceDeps,
  operation: GatewayOperationRecord,
): Promise<GatewayOperationRecord> {
  const args = asRecord(operation.argsJson)

  const fail = async (code: string) => {
    const updated = await deps.operations.update(operation.id, {
      status: 'failed',
      errorCode: code,
    })
    console.info('gateway.operation.failed', {
      operationId: operation.id,
      connectorId: operation.connectorId,
      tenantId: operation.tenantId,
      errorCode: code,
    })
    await writeAudit(deps.audit, {
      actorType: 'system',
      actorId: null,
      agentVersion: null,
      action: 'gateway.operation.failed',
      targetType: 'gateway_operation',
      targetId: operation.id,
      modelUsed: null,
      inputRef: operation.toolName,
      outputRef: code,
      policyDecision: 'denied',
      metadata: {
        operationId: operation.id,
        connectorId: operation.connectorId,
        tenantId: operation.tenantId,
        errorCode: code,
      },
      tenantId: operation.tenantId,
    })
    return updated ?? { ...operation, status: 'failed' as GatewayOperationStatus, errorCode: code }
  }

  const live = await deps.resolveRequester({
    tenantId: operation.tenantId,
    userId: operation.principalUserId,
  })
  if (!live) return fail('agent_access_denied')
  const requester: GatewayActor = {
    userId: operation.principalUserId,
    tenantId: operation.tenantId,
    role: live.role,
    assumed: live.assumed,
  }

  const definition = await deps.loadDefinition({
    tenantId: operation.tenantId,
    definitionId: operation.agentDefinitionVersionId,
  })
  if (!definition) return fail('definition_not_found')

  const agentGrant = await deps.findAgentGrant({
    tenantId: operation.tenantId,
    userId: operation.principalUserId,
    agentId: definition.agentId,
  })
  if (!canOperateAgent({ role: requester.role, grant: agentGrant, assumed: requester.assumed })) {
    return fail('agent_access_denied')
  }

  const authorized = await authorizeToolCall(deps, {
    principal: requester,
    definition,
    toolName: operation.toolName,
    args,
  })
  if (!authorized.allowed) return fail(authorized.reason)

  const grant = await deps.findActiveGrant({
    tenantId: operation.tenantId,
    connectorId: authorized.connectorId,
    userId: operation.principalUserId,
  })
  if (!grant) return fail('connector_grant_missing')

  try {
    assertGoogleDriveWriteAccess({
      tool: operation.toolName,
      args,
      scopes: grant.scopes as never,
      metadata: grant.metadata as never,
    })
  } catch (error) {
    if (error instanceof GoogleDriveWriteAccessError) return fail('drive_write_not_allowed')
    return fail('tool_execution_failed')
  }

  let accessToken: string
  try {
    accessToken = await deps.resolveAccessToken({
      connector: authorized.connector,
      grantId: authorized.grantId,
      tokenRef: authorized.tokenRef,
      actingUserId: operation.principalUserId,
      tenantId: operation.tenantId,
    })
  } catch {
    return fail('google_drive_auth_failed')
  }

  const execute = deps.executeDriveTool ?? executeGoogleDriveTool
  try {
    const result = await execute(operation.toolName, args, accessToken)
    const updated = await deps.operations.update(operation.id, {
      status: 'succeeded',
      resultJson: result,
      errorCode: null,
    })
    if (grantUsesSelectedWriteProfile(grant.scopes as never) && deps.recordCreatedDriveFiles) {
      const created = createdDriveFilesFromResult(operation.toolName, result)
      if (created.length > 0) {
        try {
          await deps.recordCreatedDriveFiles({ grantId: grant.id, files: created })
        } catch {
          // Drive write already succeeded; selected_write tracking must not fail the operation.
        }
      }
    }
    const file = result && typeof result === 'object' ? (result as { file?: { id?: string } }).file : undefined
    const payload = {
      operationId: operation.id,
      connectorId: authorized.connectorId,
      tenantId: operation.tenantId,
      ...(typeof file?.id === 'string' ? { fileId: file.id } : {}),
    }
    console.info('gateway.operation.succeeded', payload)
    await writeAudit(deps.audit, {
      actorType: 'system',
      actorId: null,
      agentVersion: null,
      action: 'gateway.operation.succeeded',
      targetType: 'gateway_operation',
      targetId: operation.id,
      modelUsed: null,
      inputRef: operation.toolName,
      outputRef: typeof file?.id === 'string' ? file.id : null,
      policyDecision: 'allowed',
      metadata: payload,
      tenantId: operation.tenantId,
    })
    return updated ?? { ...operation, status: 'succeeded', resultJson: result, errorCode: null }
  } catch (error) {
    return fail(mapDriveError(error))
  }
}

function mapDriveError(error: unknown): string {
  if (error instanceof GoogleDriveWriteAccessError) return 'drive_write_not_allowed'
  if (error instanceof GoogleDriveApiAuthError) return 'google_drive_auth_failed'
  if (error instanceof GoogleDriveApiError) return 'google_drive_api_error'
  return 'tool_execution_failed'
}
