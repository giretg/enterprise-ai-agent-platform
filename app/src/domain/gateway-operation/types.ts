export type GatewayOperationStatus =
  | 'requested'
  | 'awaiting_approval'
  | 'approved'
  | 'rejected'
  | 'executing'
  | 'succeeded'
  | 'failed'

export type GatewayApprovalDecision = 'pending' | 'approved' | 'rejected'

export type GatewayOperationView = {
  operationId: string
  status: GatewayOperationStatus
  toolName: string
  idempotencyKey: string
  definitionId: string
  agentId: string
  principalUserId: string
  connectorId: string | null
  errorCode: string | null
  result: unknown | null
  approval: {
    decision: GatewayApprovalDecision
    decidedByUserId: string | null
    decidedAt: string | null
    reason: string | null
  } | null
  createdAt: string
  updatedAt: string
}

export type GatewayOperationRecord = {
  id: string
  tenantId: string
  agentDefinitionVersionId: string
  agentId: string
  principalUserId: string
  toolName: string
  argsJson: unknown
  idempotencyKey: string
  status: GatewayOperationStatus
  connectorId: string | null
  errorCode: string | null
  resultJson: unknown | null
  createdAt: Date
  updatedAt: Date
  approval: {
    id: string
    decidedByUserId: string | null
    decision: GatewayApprovalDecision
    reason: string | null
    decidedAt: Date | null
  } | null
}

export type GatewayOperationCreateInput = {
  tenantId: string
  agentDefinitionVersionId: string
  agentId: string
  principalUserId: string
  toolName: string
  argsJson: unknown
  idempotencyKey: string
  connectorId: string | null
}

export type GatewayOperationPatch = {
  status?: GatewayOperationStatus
  errorCode?: string | null
  resultJson?: unknown | null
  approval?: {
    decision: GatewayApprovalDecision
    decidedByUserId: string
    reason?: string | null
    decidedAt: Date
  }
}

export interface GatewayOperationStore {
  findById(id: string): Promise<GatewayOperationRecord | null>
  findByTenantAndIdempotencyKey(
    tenantId: string,
    idempotencyKey: string,
  ): Promise<GatewayOperationRecord | null>
  createAwaitingApproval(
    input: GatewayOperationCreateInput,
  ): Promise<{ record: GatewayOperationRecord; created: boolean }>
  listAwaitingApproval(tenantId: string, principalUserId?: string): Promise<GatewayOperationRecord[]>
  withLockedOperation<T>(
    operationId: string,
    fn: (
      row: GatewayOperationRecord,
      save: (patch: GatewayOperationPatch) => Promise<GatewayOperationRecord>,
    ) => Promise<T>,
  ): Promise<T | null>
  update(id: string, patch: GatewayOperationPatch): Promise<GatewayOperationRecord | null>
}
