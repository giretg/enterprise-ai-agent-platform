/**
 * Megnevezett jóváhagyó agenthez/konnektorhoz (#663).
 * Futtatás: npm run test:named-approver
 *
 * - enqueue a megnevezett jóváhagyót pillanatképként tárolja (konnektor > agent),
 * - a megnevezett a saját kérését is jóváhagyhatja,
 * - más (még approver szerepű) felhasználó approver_not_authorized-ot kap,
 * - admin-helyettes és assumált superadmin dönthet,
 * - az MCP-válasz megnevezi, kire vár a művelet,
 * - idegen megnevezettnél a chat-form helyett Control Plane link megy (nem hazudik Approve gombot).
 */
import assert from 'node:assert/strict'
import type { AgentDefinition } from '../src/domain/agent-definition'
import {
  GOOGLE_DRIVE_CREATE_FOLDER_TOOL,
  type LiveConnectorRow,
  type ToolCallPrincipal,
  type WriteConfirmInput,
} from '../src/domain/enterprise-tools'
import {
  approveGatewayOperation,
  canSeeGatewayOperation,
  enqueueGatewayOperation,
  enqueueResultToMcp,
  enqueueWriteForMcp,
  listPendingGatewayOperations,
  type GatewayOperationServiceDeps,
} from '../src/domain/gateway-operation'
import { MemoryGatewayOperationStore } from './memory-gateway-operation-store'

const TENANT_ID = '22222222-2222-4222-8222-222222222222'
const AGENT_ID = '33333333-3333-4333-8333-333333333333'
const DEFINITION_ID = '44444444-4444-4444-8444-444444444444'
const CONNECTOR_ID = '55555555-5555-4555-8555-555555555555'
const CSILLA_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const REQUESTER_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

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
  return { userId: REQUESTER_ID, tenantId: TENANT_ID, role: 'operator', assumed: false, ...overrides }
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
      name: 'Blog agent',
      roleInstruction: 'Write blog',
      skills: [],
      connectors: [{ connectorId: CONNECTOR_ID, type: 'google_drive', accessMode: 'write' }],
      capabilities: [
        { toolName: 'google_drive_search', allowed: true },
        { toolName: GOOGLE_DRIVE_CREATE_FOLDER_TOOL, allowed: true },
      ],
    },
  }
}

function connector(): LiveConnectorRow {
  return {
    id: CONNECTOR_ID,
    tenantId: TENANT_ID,
    type: 'google_drive',
    authMode: 'user_delegated',
    lifecycleState: 'active',
  }
}

function deps(designated: { userId: string; name: string } | null = { userId: CSILLA_ID, name: 'Csilla' }) {
  const store = new MemoryGatewayOperationStore()
  const audit: Array<{ action: string; metadata?: unknown }> = []
  const serviceDeps: GatewayOperationServiceDeps = {
    operations: store,
    audit: {
      async append(data) {
        audit.push({ action: data.action, metadata: data.metadata })
      },
    },
    async loadDefinition() {
      return definition()
    },
    async findCurrentDefinitionId() {
      return DEFINITION_ID
    },
    async findAgentGrant() {
      return { accessLevel: 'operate' }
    },
    async findConnector() {
      return connector()
    },
    async findActiveGrant() {
      return {
        id: '66666666-6666-4666-8666-666666666666',
        tokenRef: 'stub-drive-token',
        scopes: [
          'https://www.googleapis.com/auth/drive.readonly',
          'https://www.googleapis.com/auth/drive.file',
        ],
        status: 'active',
      }
    },
    async resolveAccessToken() {
      return 'stub-drive-token'
    },
    async resolveRequester() {
      return { role: 'operator', assumed: false }
    },
    async resolveDesignatedApprover() {
      return designated
    },
    async executeDriveTool() {
      return { file: { id: 'folder-1' } }
    },
  }
  return { store, deps: serviceDeps, audit }
}

const ARGS = { definitionId: DEFINITION_ID, name: 'Q3 reports', idempotencyKey: 'idem-named-1' }

async function enqueue(wired: ReturnType<typeof deps>, idempotencyKey = ARGS.idempotencyKey) {
  const result = await enqueueGatewayOperation(wired.deps, {
    principal: principal(),
    toolName: GOOGLE_DRIVE_CREATE_FOLDER_TOOL,
    args: { ...ARGS, idempotencyKey },
  })
  assert.equal(result.ok, true)
  if (!result.ok) throw new Error('enqueue failed')
  return result.view
}

async function main() {
  await check('enqueue tárolja a megnevezett jóváhagyót', async () => {
    const wired = deps()
    const view = await enqueue(wired)
    assert.equal(view.designatedApproverUserId, CSILLA_ID)
    assert.equal(view.designatedApproverName, 'Csilla')
  })

  await check('megnevezett nélkül nincs designated', async () => {
    const wired = deps(null)
    const view = await enqueue(wired, 'idem-named-2')
    assert.equal(view.designatedApproverUserId, null)
    assert.equal(view.designatedApproverName, null)
  })

  await check('a megnevezett jóváhagyhatja a saját kérését', async () => {
    const wired = deps({ userId: REQUESTER_ID, name: 'Kérelmező' })
    const view = await enqueue(wired, 'idem-named-3')
    const approved = await approveGatewayOperation(wired.deps, {
      tenantId: TENANT_ID,
      operationId: view.operationId,
      actor: principal(),
    })
    assert.equal(approved.ok, true)
  })

  await check('idegen approver approver_not_authorized-ot kap', async () => {
    const wired = deps()
    const view = await enqueue(wired, 'idem-named-4')
    const result = await approveGatewayOperation(wired.deps, {
      tenantId: TENANT_ID,
      operationId: view.operationId,
      actor: principal({ userId: OTHER_ID, role: 'approver' }),
    })
    assert.deepEqual(result, { ok: false, code: 'approver_not_authorized' })
  })

  await check('admin-helyettes dönthet', async () => {
    const wired = deps()
    const view = await enqueue(wired, 'idem-named-5')
    const approved = await approveGatewayOperation(wired.deps, {
      tenantId: TENANT_ID,
      operationId: view.operationId,
      actor: principal({ userId: OTHER_ID, role: 'admin' }),
    })
    assert.equal(approved.ok, true)
  })

  await check('a megnevezett látja más kérését', async () => {
    assert.equal(
      canSeeGatewayOperation(
        principal({ userId: CSILLA_ID, role: 'operator' }),
        { principalUserId: REQUESTER_ID, designatedApproverUserId: CSILLA_ID },
      ),
      true,
    )
    assert.equal(
      canSeeGatewayOperation(
        principal({ userId: OTHER_ID, role: 'operator' }),
        { principalUserId: REQUESTER_ID, designatedApproverUserId: CSILLA_ID },
      ),
      false,
    )
  })

  await check('a megnevezett operator a sorban látja a rá váró idegen kérést', async () => {
    const wired = deps()
    const view = await enqueue(wired, 'idem-named-queue')
    const forCsilla = await listPendingGatewayOperations(wired.deps, {
      tenantId: TENANT_ID,
      principalUserId: CSILLA_ID,
    })
    const forOther = await listPendingGatewayOperations(wired.deps, {
      tenantId: TENANT_ID,
      principalUserId: OTHER_ID,
    })
    assert.equal(forCsilla.length, 1)
    assert.equal(forCsilla[0]?.operationId, view.operationId)
    assert.equal(forOther.length, 0)
  })

  await check('az MCP-válasz megnevezi, kire vár', async () => {
    const wired = deps()
    const view = await enqueue(wired, 'idem-named-6')
    const mcp = enqueueResultToMcp({ ok: true, view }, 'https://app.example')
    const text = mcp.content[0]?.type === 'text' ? mcp.content[0].text : ''
    const payload = JSON.parse(text) as { waitingForApprover?: { name?: string }; message?: string }
    assert.equal(payload.waitingForApprover?.name, 'Csilla')
    assert.ok(payload.message?.includes('Csilla'))
  })

  await check('idegen megnevezettnél mint ellenére Control Plane link megy, nem form', async () => {
    const wired = deps()
    let minted = 0
    const confirm: WriteConfirmInput = {
      async mint() {
        minted += 1
        return 'state-1'
      },
    }
    const result = await enqueueWriteForMcp(wired.deps, {
      principal: principal(),
      toolName: GOOGLE_DRIVE_CREATE_FOLDER_TOOL,
      args: { ...ARGS, idempotencyKey: 'idem-named-form-link' },
      origin: 'https://app.example',
      confirm,
    })
    assert.equal(minted, 0)
    assert.ok('content' in result, 'expected link tool result, not input_required')
    const payload = JSON.parse(result.content[0]!.text) as {
      status?: string
      approvalUrl?: string
      waitingForApprover?: { name?: string }
    }
    assert.equal(payload.status, 'awaiting_approval')
    assert.match(String(payload.approvalUrl), /\/control-plane\/operations/)
    assert.equal(payload.waitingForApprover?.name, 'Csilla')
    const enqueued = wired.audit.find((row) => row.action === 'gateway.operation.enqueued')
    const meta = enqueued?.metadata as Record<string, unknown>
    assert.equal(meta?.confirmBranch, 'link')
    assert.equal(meta?.confirmBranchReason, 'designated_approver_other')
  })

  await check('megnevezett = kérelmező: form továbbra is megy', async () => {
    const wired = deps({ userId: REQUESTER_ID, name: 'Kérelmező' })
    let minted = 0
    const confirm: WriteConfirmInput = {
      async mint() {
        minted += 1
        return 'state-self'
      },
    }
    const result = await enqueueWriteForMcp(wired.deps, {
      principal: principal(),
      toolName: GOOGLE_DRIVE_CREATE_FOLDER_TOOL,
      args: { ...ARGS, idempotencyKey: 'idem-named-form-self' },
      origin: 'https://app.example',
      confirm,
    })
    assert.equal(minted, 1)
    assert.equal('resultType' in result && result.resultType, 'input_required')
    const enqueued = wired.audit.find((row) => row.action === 'gateway.operation.enqueued')
    const meta = enqueued?.metadata as Record<string, unknown>
    assert.equal(meta?.confirmBranch, 'form')
    assert.equal(meta?.confirmBranchReason, 'mrtr_form')
  })

  console.log(`\nnamed-approver: ${failures === 0 ? 'ok' : `${failures} failed`}`)
  if (failures > 0) process.exit(1)
}

void main()
