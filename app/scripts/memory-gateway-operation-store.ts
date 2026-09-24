import type {
  GatewayOperationCreateInput,
  GatewayOperationPatch,
  GatewayOperationRecord,
  GatewayOperationStore,
} from '../src/domain/gateway-operation'

export class MemoryGatewayOperationStore implements GatewayOperationStore {
  private rows = new Map<string, GatewayOperationRecord>()
  private byKey = new Map<string, string>()
  private lock: Promise<void> = Promise.resolve()

  async findById(id: string) {
    return this.rows.get(id) ?? null
  }

  async findByTenantAndIdempotencyKey(tenantId: string, idempotencyKey: string) {
    const id = this.byKey.get(`${tenantId}:${idempotencyKey}`)
    return id ? (this.rows.get(id) ?? null) : null
  }

  async createAwaitingApproval(input: GatewayOperationCreateInput) {
    const key = `${input.tenantId}:${input.idempotencyKey}`
    const existingId = this.byKey.get(key)
    if (existingId) {
      const existing = this.rows.get(existingId)
      if (existing) return { record: existing, created: false }
    }
    const now = new Date()
    const record: GatewayOperationRecord = {
      id: globalThis.crypto.randomUUID(),
      tenantId: input.tenantId,
      agentDefinitionVersionId: input.agentDefinitionVersionId,
      agentId: input.agentId,
      principalUserId: input.principalUserId,
      toolName: input.toolName,
      argsJson: input.argsJson,
      idempotencyKey: input.idempotencyKey,
      status: 'awaiting_approval',
      connectorId: input.connectorId,
      errorCode: null,
      resultJson: null,
      createdAt: now,
      updatedAt: now,
      approval: {
        id: globalThis.crypto.randomUUID(),
        decidedByUserId: null,
        decision: 'pending',
        reason: null,
        decidedAt: null,
      },
    }
    this.rows.set(record.id, record)
    this.byKey.set(key, record.id)
    return { record, created: true }
  }

  async listAwaitingApproval(tenantId: string, principalUserId?: string) {
    return [...this.rows.values()]
      .filter((row) => row.tenantId === tenantId && row.status === 'awaiting_approval')
      .filter((row) => !principalUserId || row.principalUserId === principalUserId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
  }

  async withLockedOperation<T>(
    operationId: string,
    fn: (
      row: GatewayOperationRecord,
      save: (patch: GatewayOperationPatch) => Promise<GatewayOperationRecord>,
    ) => Promise<T>,
  ): Promise<T | null> {
    const previous = this.lock
    let release!: () => void
    this.lock = new Promise((resolve) => {
      release = resolve
    })
    await previous
    try {
      const row = this.rows.get(operationId)
      if (!row) return null
      const save = async (patch: GatewayOperationPatch) => {
        const updated = applyPatch(row, patch)
        this.rows.set(operationId, updated)
        Object.assign(row, updated)
        return updated
      }
      return fn(row, save)
    } finally {
      release()
    }
  }

  async update(id: string, patch: GatewayOperationPatch) {
    const row = this.rows.get(id)
    if (!row) return null
    const updated = applyPatch(row, patch)
    this.rows.set(id, updated)
    return updated
  }
}

function applyPatch(row: GatewayOperationRecord, patch: GatewayOperationPatch): GatewayOperationRecord {
  return {
    ...row,
    status: patch.status ?? row.status,
    errorCode: patch.errorCode !== undefined ? patch.errorCode : row.errorCode,
    resultJson: patch.resultJson !== undefined ? patch.resultJson : row.resultJson,
    updatedAt: new Date(),
    approval: patch.approval
      ? {
          id: row.approval?.id ?? globalThis.crypto.randomUUID(),
          decidedByUserId: patch.approval.decidedByUserId,
          decision: patch.approval.decision,
          reason: patch.approval.reason ?? null,
          decidedAt: patch.approval.decidedAt,
        }
      : row.approval,
  }
}
