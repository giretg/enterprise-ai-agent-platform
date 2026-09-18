/**
 * Gateway operations and approvals.
 *
 * TODO(phase-E): GatewayOperation / GatewayApproval persistence and queue.
 * Phase 0 only establishes the module boundary.
 */
export type GatewayOperation = {
  id: string
  tenantId: string
  toolName: string
  status: 'pending' | 'approved' | 'denied' | 'executed'
}

export type GatewayApproval = {
  id: string
  operationId: string
  decidedByUserId: string | null
}

export function enqueueGatewayOperation(
  _input: Pick<GatewayOperation, 'tenantId' | 'toolName'>,
): Promise<GatewayOperation> {
  return Promise.reject(new Error('TODO(phase-E): GatewayOperation is not implemented'))
}
