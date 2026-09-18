/**
 * Gateway operations and approvals.
 *
 * TODO(phase-E): enqueue / execute / approval UI. Prisma models exist
 * (`GatewayOperation`, `GatewayApproval`) so Drive write (#541) does not
 * need a second schema rewrite.
 */
export type GatewayOperationStatus =
  | 'requested'
  | 'awaiting_approval'
  | 'approved'
  | 'rejected'
  | 'executing'
  | 'succeeded'
  | 'failed'

export type GatewayApprovalDecision = 'pending' | 'approved' | 'rejected'

export type GatewayOperation = {
  id: string
  tenantId: string
  agentDefinitionVersionId: string
  principalUserId: string
  toolName: string
  argsJson: unknown
  idempotencyKey: string
  status: GatewayOperationStatus
  connectorId: string | null
  errorCode: string | null
}

export type GatewayApproval = {
  id: string
  operationId: string
  decidedByUserId: string | null
  decision: GatewayApprovalDecision
  reason: string | null
  decidedAt: string | null
}

export function enqueueGatewayOperation(
  _input: Pick<GatewayOperation, 'tenantId' | 'toolName' | 'agentDefinitionVersionId' | 'principalUserId'>,
): Promise<GatewayOperation> {
  return Promise.reject(new Error('TODO(phase-E): GatewayOperation is not implemented'))
}
