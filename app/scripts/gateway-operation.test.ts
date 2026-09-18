/**
 * GatewayOperation enqueue / approve / reject / get (#541).
 * Futtatás: npm run test:gateway-operation
 */
import assert from 'node:assert/strict'
import type { AgentDefinition } from '../src/domain/agent-definition'
import {
  GOOGLE_DRIVE_CREATE_FOLDER_TOOL,
  GOOGLE_DRIVE_SEARCH_TOOL,
  type LiveConnectorRow,
  type LiveGrantRow,
  type ToolCallPrincipal,
} from '../src/domain/enterprise-tools'
import {
  approveGatewayOperation,
  enqueueGatewayOperation,
  getGatewayOperation,
  rejectGatewayOperation,
  type GatewayOperationCreateInput,
  type GatewayOperationPatch,
  type GatewayOperationRecord,
  type GatewayOperationServiceDeps,
  type GatewayOperationStore,
} from '../src/domain/gateway-operation'

const USER_ID = '11111111-1111-4111-8111-111111111111'
const APPROVER_ID = '12121212-1212-4121-8121-121212121212'
const OTHER_USER = '13131313-1313-4131-8131-131313131313'
const TENANT_ID = '22222222-2222-4222-8222-222222222222'
const OTHER_TENANT = '23232323-2323-4232-8232-232323232323'
const AGENT_ID = '33333333-3333-4333-8333-333333333333'
const DEFINITION_ID = '44444444-4444-4444-8444-444444444444'
const CONNECTOR_ID = '55555555-5555-4555-8555-555555555555'
const GRANT_ID = '66666666-6666-4666-8666-666666666666'

let failures = 0
function check(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(() => fn())
    .then(() => console.log(`  OK  ${name}`))
    .catch((e: unknown) => {
      failures++
      console.log(`  FAIL ${name}: ${e instanceof Error ? e.message : e}`)
    })
}

function principal(overrides: Partial<ToolCallPrincipal> = {}): ToolCallPrincipal {
  return {
    userId: USER_ID,
    tenantId: TENANT_ID,
    role: 'admin',
    assumed: false,
    ...overrides,
  }
}

function definition(): AgentDefinition {
  return {
    definitionId: DEFINITION_ID,
    agentId: AGENT_ID,
    version: 1,
    tenantId: TENANT_ID,
    status: 'active',
    publishedAt: '2026-01-02T00:00:00.000Z',
    snapshot: {
      name: 'Drive assistant',
      roleInstruction: 'Write Drive',
      skills: [],
      connectors: [{ connectorId: CONNECTOR_ID, type: 'google_drive', accessMode: 'write' }],
      capabilities: [
        { toolName: GOOGLE_DRIVE_SEARCH_TOOL, allowed: true },
        { toolName: GOOGLE_DRIVE_CREATE_FOLDER_TOOL, allowed: true },
      ],
    },
  }
}

function connector(overrides: Partial<LiveConnectorRow> = {}): LiveConnectorRow {
  return {
    id: CONNECTOR_ID,
    tenantId: TENANT_ID,
    type: 'google_drive',
    authMode: 'user_delegated',
    lifecycleState: 'active',
    ...overrides,
  }
}

function grant(overrides: Partial<LiveGrantRow> = {}): LiveGrantRow {
  return {
    id: GRANT_ID,
    tokenRef: 'stub-drive-token',
    scopes: [
      'https://www.googleapis.com/auth/drive.readonly',
      'https://www.googleapis.com/auth/drive.file',
    ],
    status: 'active',
    ...overrides,
  }
}

class MemoryGatewayOperationStore implements GatewayOperationStore {
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

  async listAwaitingApproval(tenantId: string) {
    return [...this.rows.values()]
      .filter((row) => row.tenantId === tenantId && row.status === 'awaiting_approval')
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

function captureInfo() {
  const events: Array<{ event: string; payload: Record<string, unknown> }> = []
  const original = console.info
  console.info = ((event: unknown, payload?: unknown) => {
    if (typeof event === 'string' && payload && typeof payload === 'object') {
      events.push({ event, payload: payload as Record<string, unknown> })
    }
  }) as typeof console.info
  return {
    events,
    restore() {
      console.info = original
    },
  }
}

function deps(opts?: {
  connector?: LiveConnectorRow | null
  grant?: LiveGrantRow | null
  grantAccessLevel?: string | null
  executeDriveTool?: GatewayOperationServiceDeps['executeDriveTool']
  driveCalls?: unknown[]
}): { deps: GatewayOperationServiceDeps; store: MemoryGatewayOperationStore } {
  const store = new MemoryGatewayOperationStore()
  const driveCalls = opts?.driveCalls ?? []
  return {
    store,
    deps: {
      operations: store,
      async loadDefinition() {
        return definition()
      },
      async findAgentGrant() {
        if (opts && 'grantAccessLevel' in opts) {
          return opts.grantAccessLevel ? { accessLevel: opts.grantAccessLevel } : null
        }
        return { accessLevel: 'operate' }
      },
      async findConnector() {
        return opts && 'connector' in opts ? (opts.connector ?? null) : connector()
      },
      async findActiveGrant() {
        return opts && 'grant' in opts ? (opts.grant ?? null) : grant()
      },
      async resolveAccessToken() {
        return 'stub-drive-token'
      },
      executeDriveTool:
        opts?.executeDriveTool ??
        (async (_tool, args) => {
          driveCalls.push(args)
          return {
            file: {
              id: `folder-${driveCalls.length}`,
              name: typeof args.name === 'string' ? args.name : 'folder',
              mimeType: 'application/vnd.google-apps.folder',
            },
            created: true,
          }
        }),
    },
  }
}

const FOLDER_ARGS = {
  definitionId: DEFINITION_ID,
  name: 'Q3 reports',
  idempotencyKey: 'idem-1',
}

async function main() {
  await check('enqueue create_folder is awaiting_approval and does not call Drive', async () => {
    const driveCalls: unknown[] = []
    const logs = captureInfo()
    try {
      const wired = deps({ driveCalls })
      const result = await enqueueGatewayOperation(wired.deps, {
        principal: principal(),
        toolName: GOOGLE_DRIVE_CREATE_FOLDER_TOOL,
        args: FOLDER_ARGS,
      })
      assert.equal(result.ok, true)
      if (!result.ok) return
      assert.equal(result.view.status, 'awaiting_approval')
      assert.equal(result.view.toolName, GOOGLE_DRIVE_CREATE_FOLDER_TOOL)
      assert.equal(result.view.idempotencyKey, 'idem-1')
      assert.equal(result.view.approval?.decision, 'pending')
      assert.equal(driveCalls.length, 0)
      assert.ok(logs.events.some((row) => row.event === 'gateway.operation.enqueued'))
    } finally {
      logs.restore()
    }
  })

  await check('idempotent enqueue returns the same operation without a second row', async () => {
    const wired = deps()
    const first = await enqueueGatewayOperation(wired.deps, {
      principal: principal(),
      toolName: GOOGLE_DRIVE_CREATE_FOLDER_TOOL,
      args: FOLDER_ARGS,
    })
    const second = await enqueueGatewayOperation(wired.deps, {
      principal: principal(),
      toolName: GOOGLE_DRIVE_CREATE_FOLDER_TOOL,
      args: FOLDER_ARGS,
    })
    assert.equal(first.ok && second.ok, true)
    if (!first.ok || !second.ok) return
    assert.equal(second.view.operationId, first.view.operationId)
    assert.equal(second.created, false)
  })

  await check('self-approval by admin executes Drive once and stores resultJson', async () => {
    const driveCalls: unknown[] = []
    const logs = captureInfo()
    try {
      const wired = deps({ driveCalls })
      const enqueued = await enqueueGatewayOperation(wired.deps, {
        principal: principal(),
        toolName: GOOGLE_DRIVE_CREATE_FOLDER_TOOL,
        args: FOLDER_ARGS,
      })
      assert.equal(enqueued.ok, true)
      if (!enqueued.ok) return
      const approved = await approveGatewayOperation(wired.deps, {
        tenantId: TENANT_ID,
        operationId: enqueued.view.operationId,
        actor: principal(),
      })
      assert.equal(approved.ok, true)
      if (!approved.ok) return
      assert.equal(approved.view.status, 'succeeded')
      assert.equal(approved.view.approval?.decision, 'approved')
      assert.equal(approved.view.approval?.decidedByUserId, USER_ID)
      const result = approved.view.result as { file?: { id?: string }; created?: boolean }
      assert.equal(result.file?.id, 'folder-1')
      assert.equal(result.created, true)
      assert.equal(driveCalls.length, 1)
      assert.ok(logs.events.some((row) => row.event === 'gateway.operation.approved'))
      assert.ok(logs.events.some((row) => row.event === 'gateway.operation.executing'))
      assert.ok(logs.events.some((row) => row.event === 'gateway.operation.succeeded'))
    } finally {
      logs.restore()
    }
  })

  await check('double-approve executes Drive exactly once', async () => {
    const driveCalls: unknown[] = []
    const wired = deps({
      driveCalls,
      executeDriveTool: async (_tool, args) => {
        await new Promise((resolve) => setTimeout(resolve, 30))
        driveCalls.push(args)
        return {
          file: { id: 'folder-once', name: 'Q3 reports', mimeType: 'application/vnd.google-apps.folder' },
          created: true,
        }
      },
    })
    const enqueued = await enqueueGatewayOperation(wired.deps, {
      principal: principal(),
      toolName: GOOGLE_DRIVE_CREATE_FOLDER_TOOL,
      args: FOLDER_ARGS,
    })
    assert.equal(enqueued.ok, true)
    if (!enqueued.ok) return
    const actor = principal({ userId: APPROVER_ID, role: 'approver' })
    const [first, second] = await Promise.all([
      approveGatewayOperation(wired.deps, {
        tenantId: TENANT_ID,
        operationId: enqueued.view.operationId,
        actor,
      }),
      approveGatewayOperation(wired.deps, {
        tenantId: TENANT_ID,
        operationId: enqueued.view.operationId,
        actor,
      }),
    ])
    const statuses = [first, second].map((row) => (row.ok ? row.view.status : row.code)).sort()
    assert.equal(driveCalls.length, 1)
    assert.ok(statuses.includes('succeeded'))
    assert.ok(statuses.includes('operation_not_awaiting_approval'))
  })

  await check('reject leaves no Drive side effect', async () => {
    const driveCalls: unknown[] = []
    const logs = captureInfo()
    try {
      const wired = deps({ driveCalls })
      const enqueued = await enqueueGatewayOperation(wired.deps, {
        principal: principal(),
        toolName: GOOGLE_DRIVE_CREATE_FOLDER_TOOL,
        args: { ...FOLDER_ARGS, idempotencyKey: 'idem-reject' },
      })
      assert.equal(enqueued.ok, true)
      if (!enqueued.ok) return
      const rejected = await rejectGatewayOperation(wired.deps, {
        tenantId: TENANT_ID,
        operationId: enqueued.view.operationId,
        actor: principal({ userId: APPROVER_ID, role: 'approver' }),
        reason: 'not needed',
      })
      assert.equal(rejected.ok, true)
      if (!rejected.ok) return
      assert.equal(rejected.view.status, 'rejected')
      assert.equal(rejected.view.approval?.decision, 'rejected')
      assert.equal(driveCalls.length, 0)
      assert.ok(logs.events.some((row) => row.event === 'gateway.operation.rejected'))
    } finally {
      logs.restore()
    }
  })

  await check('get is visible to requester and hidden from other operators', async () => {
    const wired = deps()
    const enqueued = await enqueueGatewayOperation(wired.deps, {
      principal: principal({ role: 'operator' }),
      toolName: GOOGLE_DRIVE_CREATE_FOLDER_TOOL,
      args: FOLDER_ARGS,
    })
    assert.equal(enqueued.ok, true)
    if (!enqueued.ok) return
    const own = await getGatewayOperation(wired.deps, {
      principal: principal({ role: 'operator' }),
      operationId: enqueued.view.operationId,
    })
    assert.equal(own.ok, true)
    const other = await getGatewayOperation(wired.deps, {
      principal: principal({ userId: OTHER_USER, role: 'operator' }),
      operationId: enqueued.view.operationId,
    })
    assert.deepEqual(other, { ok: false, code: 'operation_not_found' })
    const admin = await getGatewayOperation(wired.deps, {
      principal: principal({ userId: APPROVER_ID, role: 'admin' }),
      operationId: enqueued.view.operationId,
    })
    assert.equal(admin.ok, true)
  })

  await check('operator cannot approve', async () => {
    const wired = deps()
    const enqueued = await enqueueGatewayOperation(wired.deps, {
      principal: principal(),
      toolName: GOOGLE_DRIVE_CREATE_FOLDER_TOOL,
      args: FOLDER_ARGS,
    })
    assert.equal(enqueued.ok, true)
    if (!enqueued.ok) return
    const result = await approveGatewayOperation(wired.deps, {
      tenantId: TENANT_ID,
      operationId: enqueued.view.operationId,
      actor: principal({ userId: OTHER_USER, role: 'operator' }),
    })
    assert.deepEqual(result, { ok: false, code: 'approver_not_authorized' })
  })

  await check('missing write binding is denied at enqueue', async () => {
    const wired = deps()
    const result = await enqueueGatewayOperation(
      {
        ...wired.deps,
        async loadDefinition() {
          return {
            ...definition(),
            snapshot: {
              ...definition().snapshot,
              connectors: [{ connectorId: CONNECTOR_ID, type: 'google_drive', accessMode: 'read' }],
            },
          }
        },
      },
      {
        principal: principal(),
        toolName: GOOGLE_DRIVE_CREATE_FOLDER_TOOL,
        args: FOLDER_ARGS,
      },
    )
    assert.deepEqual(result, { ok: false, code: 'missing_google_drive_connector_write' })
  })

  await check('terminal Drive failure sets failed + errorCode', async () => {
    const wired = deps({
      executeDriveTool: async () => {
        throw new Error('boom')
      },
    })
    const enqueued = await enqueueGatewayOperation(wired.deps, {
      principal: principal(),
      toolName: GOOGLE_DRIVE_CREATE_FOLDER_TOOL,
      args: FOLDER_ARGS,
    })
    assert.equal(enqueued.ok, true)
    if (!enqueued.ok) return
    const approved = await approveGatewayOperation(wired.deps, {
      tenantId: TENANT_ID,
      operationId: enqueued.view.operationId,
      actor: principal(),
    })
    assert.equal(approved.ok, true)
    if (!approved.ok) return
    assert.equal(approved.view.status, 'failed')
    assert.equal(approved.view.errorCode, 'tool_execution_failed')
    assert.equal(approved.view.result, null)
  })

  await check('cross-tenant get is operation_not_found', async () => {
    const wired = deps()
    const enqueued = await enqueueGatewayOperation(wired.deps, {
      principal: principal(),
      toolName: GOOGLE_DRIVE_CREATE_FOLDER_TOOL,
      args: FOLDER_ARGS,
    })
    assert.equal(enqueued.ok, true)
    if (!enqueued.ok) return
    const result = await getGatewayOperation(wired.deps, {
      principal: principal({ tenantId: OTHER_TENANT, role: 'admin' }),
      operationId: enqueued.view.operationId,
    })
    assert.deepEqual(result, { ok: false, code: 'operation_not_found' })
  })

  await check('idempotent replay after success returns succeeded without a second Drive call', async () => {
    const driveCalls: unknown[] = []
    const wired = deps({ driveCalls })
    const enqueued = await enqueueGatewayOperation(wired.deps, {
      principal: principal(),
      toolName: GOOGLE_DRIVE_CREATE_FOLDER_TOOL,
      args: FOLDER_ARGS,
    })
    assert.equal(enqueued.ok, true)
    if (!enqueued.ok) return
    await approveGatewayOperation(wired.deps, {
      tenantId: TENANT_ID,
      operationId: enqueued.view.operationId,
      actor: principal(),
    })
    const replay = await enqueueGatewayOperation(wired.deps, {
      principal: principal(),
      toolName: GOOGLE_DRIVE_CREATE_FOLDER_TOOL,
      args: FOLDER_ARGS,
    })
    assert.equal(replay.ok, true)
    if (!replay.ok) return
    assert.equal(replay.view.operationId, enqueued.view.operationId)
    assert.equal(replay.view.status, 'succeeded')
    assert.equal(driveCalls.length, 1)
  })

  await check('missing idempotencyKey is idempotency_key_required', async () => {
    const wired = deps()
    const result = await enqueueGatewayOperation(wired.deps, {
      principal: principal(),
      toolName: GOOGLE_DRIVE_CREATE_FOLDER_TOOL,
      args: { definitionId: DEFINITION_ID, name: 'Q3 reports' },
    })
    assert.deepEqual(result, { ok: false, code: 'idempotency_key_required' })
  })

  console.log(`\n${failures === 0 ? 'gateway-operation: ok' : `gateway-operation: ${failures} failed`}`)
  if (failures > 0) process.exit(1)
}

void main()
