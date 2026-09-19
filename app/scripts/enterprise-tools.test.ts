/**
 * Enterprise Drive read authorizer + invoke gateway (#540).
 * Futtatás: npm run test:enterprise-tools
 */
import assert from 'node:assert/strict'
import type { AgentDefinition } from '../src/domain/agent-definition'
import {
  authorizeToolCall,
  invokeEnterpriseTool,
  GOOGLE_DRIVE_CREATE_FOLDER_TOOL,
  GOOGLE_DRIVE_READ_FILE_TOOL,
  GOOGLE_DRIVE_SEARCH_TOOL,
  KB_INGEST_TOOL,
  KB_SEARCH_TOOL,
  type AuthorizeToolCallDeps,
  type EnterpriseToolDeps,
  type LiveConnectorRow,
  type LiveGrantRow,
  type ToolCallPrincipal,
} from '../src/domain/enterprise-tools'
import {
  GoogleDriveApiAuthError,
  GoogleDriveApiError,
} from '../src/domain/connector-grant/google-drive-api-client'

const USER_ID = '11111111-1111-4111-8111-111111111111'
const TENANT_ID = '22222222-2222-4222-8222-222222222222'
const AGENT_ID = '33333333-3333-4333-8333-333333333333'
const DEFINITION_ID = '44444444-4444-4444-8444-444444444444'
const CONNECTOR_ID = '55555555-5555-4555-8555-555555555555'
const GRANT_ID = '66666666-6666-4666-8666-666666666666'
const OTHER_TENANT = '77777777-7777-4777-8777-777777777777'

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
    role: 'operator',
    assumed: false,
    ...overrides,
  }
}

function definition(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    definitionId: DEFINITION_ID,
    agentId: AGENT_ID,
    version: 1,
    tenantId: TENANT_ID,
    status: 'active',
    publishedAt: '2026-01-02T00:00:00.000Z',
    snapshot: {
      name: 'Drive assistant',
      roleInstruction: 'Inspect Drive',
      skills: [],
      connectors: [{ connectorId: CONNECTOR_ID, type: 'google_drive', accessMode: 'read' }],
      capabilities: [
        { toolName: GOOGLE_DRIVE_SEARCH_TOOL, allowed: true },
        { toolName: GOOGLE_DRIVE_READ_FILE_TOOL, allowed: true },
      ],
    },
    ...overrides,
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
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
    status: 'active',
    ...overrides,
  }
}

function authorizeDeps(opts?: {
  connector?: LiveConnectorRow | null
  grant?: LiveGrantRow | null
}): AuthorizeToolCallDeps {
  return {
    async findConnector() {
      return opts && 'connector' in opts ? (opts.connector ?? null) : connector()
    },
    async findActiveGrant() {
      return opts && 'grant' in opts ? (opts.grant ?? null) : grant()
    },
  }
}

function invokeDeps(opts?: {
  definition?: AgentDefinition | null
  grantAccessLevel?: string | null
  connector?: LiveConnectorRow | null
  grant?: LiveGrantRow | null
  accessToken?: string
  executeDriveTool?: EnterpriseToolDeps['executeDriveTool']
  executeKbTool?: EnterpriseToolDeps['executeKbTool']
  resolveError?: Error
  audit?: Array<{ action: string }>
}): EnterpriseToolDeps {
  const audit = opts?.audit
  return {
    ...authorizeDeps(opts),
    audit: audit
      ? {
          async append(data) {
            audit.push({ action: data.action })
          },
        }
      : undefined,
    async loadDefinition() {
      return opts && 'definition' in opts ? (opts.definition ?? null) : definition()
    },
    async findAgentGrant() {
      if (opts && 'grantAccessLevel' in opts) {
        return opts.grantAccessLevel ? { accessLevel: opts.grantAccessLevel } : null
      }
      return { accessLevel: 'operate' }
    },
    async resolveAccessToken() {
      if (opts?.resolveError) throw opts.resolveError
      return opts?.accessToken ?? 'stub-drive-token'
    },
    executeDriveTool: opts?.executeDriveTool,
    executeKbTool: opts?.executeKbTool,
  }
}

function parsePayload(result: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>
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

async function main() {
  await check('authorize happy path returns grant identifiers', async () => {
    const result = await authorizeToolCall(authorizeDeps(), {
      principal: principal(),
      definition: definition(),
      toolName: GOOGLE_DRIVE_SEARCH_TOOL,
      args: {},
    })
    assert.deepEqual(result, {
      allowed: true,
      connectorId: CONNECTOR_ID,
      connector: connector(),
      grantId: GRANT_ID,
      tokenRef: 'stub-drive-token',
    })
  })

  await check('capability deny uses snapshot, not a live draft', async () => {
    const result = await authorizeToolCall(authorizeDeps(), {
      principal: principal(),
      definition: {
        ...definition({
          snapshot: {
            name: 'Drive assistant',
            roleInstruction: 'Inspect Drive',
            skills: [],
            connectors: [{ connectorId: CONNECTOR_ID, type: 'google_drive', accessMode: 'read' }],
            capabilities: [{ toolName: GOOGLE_DRIVE_SEARCH_TOOL, allowed: false }],
          },
        }),
        // Trap: live-looking extras must not override the published snapshot.
        ...({
          capabilities: [{ toolName: GOOGLE_DRIVE_SEARCH_TOOL, allowed: true }],
          liveCapabilities: [{ toolName: GOOGLE_DRIVE_SEARCH_TOOL, allowed: true }],
        } as object),
      } as AgentDefinition,
      toolName: GOOGLE_DRIVE_SEARCH_TOOL,
      args: {},
    })
    assert.deepEqual(result, { allowed: false, reason: 'capability_not_allowed' })
  })

  await check('missing snapshot connector binding', async () => {
    const result = await authorizeToolCall(authorizeDeps(), {
      principal: principal(),
      definition: definition({
        snapshot: {
          name: 'Drive assistant',
          roleInstruction: 'Inspect Drive',
          skills: [],
          connectors: [],
          capabilities: [{ toolName: GOOGLE_DRIVE_SEARCH_TOOL, allowed: true }],
        },
      }),
      toolName: GOOGLE_DRIVE_SEARCH_TOOL,
      args: {},
    })
    assert.deepEqual(result, { allowed: false, reason: 'missing_google_drive_connector_read' })
  })

  await check('write binding satisfies read tool requirements', async () => {
    const result = await authorizeToolCall(authorizeDeps(), {
      principal: principal(),
      definition: definition({
        snapshot: {
          name: 'Drive assistant',
          roleInstruction: 'Inspect Drive',
          skills: [],
          connectors: [{ connectorId: CONNECTOR_ID, type: 'google_drive', accessMode: 'write' }],
          capabilities: [{ toolName: GOOGLE_DRIVE_SEARCH_TOOL, allowed: true }],
        },
      }),
      toolName: GOOGLE_DRIVE_SEARCH_TOOL,
      args: {},
    })
    assert.equal(result.allowed, true)
  })

  await check('write tool requires write binding', async () => {
    const result = await authorizeToolCall(authorizeDeps(), {
      principal: principal(),
      definition: definition({
        snapshot: {
          name: 'Drive assistant',
          roleInstruction: 'Inspect Drive',
          skills: [],
          connectors: [{ connectorId: CONNECTOR_ID, type: 'google_drive', accessMode: 'read' }],
          capabilities: [{ toolName: GOOGLE_DRIVE_CREATE_FOLDER_TOOL, allowed: true }],
        },
      }),
      toolName: GOOGLE_DRIVE_CREATE_FOLDER_TOOL,
      args: { name: 'Q3', idempotencyKey: 'k1' },
    })
    assert.deepEqual(result, { allowed: false, reason: 'missing_google_drive_connector_write' })
  })

  await check('write tool with write binding and selected_write scopes is allowed', async () => {
    const result = await authorizeToolCall(
      authorizeDeps({
        grant: grant({
          scopes: [
            'https://www.googleapis.com/auth/drive.readonly',
            'https://www.googleapis.com/auth/drive.file',
          ],
        }),
      }),
      {
        principal: principal(),
        definition: definition({
          snapshot: {
            name: 'Drive assistant',
            roleInstruction: 'Inspect Drive',
            skills: [],
            connectors: [{ connectorId: CONNECTOR_ID, type: 'google_drive', accessMode: 'write' }],
            capabilities: [{ toolName: GOOGLE_DRIVE_CREATE_FOLDER_TOOL, allowed: true }],
          },
        }),
        toolName: GOOGLE_DRIVE_CREATE_FOLDER_TOOL,
        args: { name: 'Q3', idempotencyKey: 'k1' },
      },
    )
    assert.equal(result.allowed, true)
  })

  await check('write tool with readonly scopes is google_drive_scope_not_granted', async () => {
    const result = await authorizeToolCall(authorizeDeps(), {
      principal: principal(),
      definition: definition({
        snapshot: {
          name: 'Drive assistant',
          roleInstruction: 'Inspect Drive',
          skills: [],
          connectors: [{ connectorId: CONNECTOR_ID, type: 'google_drive', accessMode: 'write' }],
          capabilities: [{ toolName: GOOGLE_DRIVE_CREATE_FOLDER_TOOL, allowed: true }],
        },
      }),
      toolName: GOOGLE_DRIVE_CREATE_FOLDER_TOOL,
      args: { name: 'Q3', idempotencyKey: 'k1' },
    })
    assert.deepEqual(result, { allowed: false, reason: 'google_drive_scope_not_granted' })
  })

  await check('grant missing', async () => {
    const result = await authorizeToolCall(authorizeDeps({ grant: null }), {
      principal: principal(),
      definition: definition(),
      toolName: GOOGLE_DRIVE_SEARCH_TOOL,
      args: {},
    })
    assert.deepEqual(result, { allowed: false, reason: 'connector_grant_missing' })
  })

  await check('scope deny', async () => {
    const result = await authorizeToolCall(
      authorizeDeps({
        grant: grant({ scopes: ['https://www.googleapis.com/auth/drive.metadata.readonly'] }),
      }),
      {
        principal: principal(),
        definition: definition(),
        toolName: GOOGLE_DRIVE_SEARCH_TOOL,
        args: {},
      },
    )
    assert.deepEqual(result, { allowed: false, reason: 'google_drive_scope_not_granted' })
  })

  await check('tenant isolation', async () => {
    const result = await authorizeToolCall(
      authorizeDeps({ connector: connector({ tenantId: OTHER_TENANT }) }),
      {
        principal: principal(),
        definition: definition(),
        toolName: GOOGLE_DRIVE_SEARCH_TOOL,
        args: {},
      },
    )
    assert.deepEqual(result, { allowed: false, reason: 'tenant_isolation' })
  })

  await check('decommissioned live connector is connector_not_active', async () => {
    const result = await authorizeToolCall(
      authorizeDeps({ connector: connector({ lifecycleState: 'archived' }) }),
      {
        principal: principal(),
        definition: definition(),
        toolName: GOOGLE_DRIVE_SEARCH_TOOL,
        args: {},
      },
    )
    assert.deepEqual(result, { allowed: false, reason: 'connector_not_active' })
  })

  await check('non-delegated connector is acting_user_required', async () => {
    const result = await authorizeToolCall(
      authorizeDeps({ connector: connector({ authMode: 'service' }) }),
      {
        principal: principal(),
        definition: definition(),
        toolName: GOOGLE_DRIVE_READ_FILE_TOOL,
        args: { fileId: 'stub-file-1' },
      },
    )
    assert.deepEqual(result, { allowed: false, reason: 'acting_user_required' })
  })

  await check('unknown tool is tool_not_configured', async () => {
    const result = await authorizeToolCall(authorizeDeps(), {
      principal: principal(),
      definition: definition(),
      toolName: 'not_a_real_tool',
      args: {},
    })
    assert.deepEqual(result, { allowed: false, reason: 'tool_not_configured' })
  })

  await check('invoke search happy path uses stub client and audits ok', async () => {
    const logs = captureInfo()
    try {
      const result = await invokeEnterpriseTool(invokeDeps(), {
        principal: principal(),
        toolName: GOOGLE_DRIVE_SEARCH_TOOL,
        args: { definitionId: DEFINITION_ID, nameContains: 'Platform' },
      })
      assert.equal(result.isError, undefined)
      const payload = parsePayload(result)
      const files = payload.files as Array<{ id: string }>
      assert.ok(Array.isArray(files) && files.length > 0)
      assert.equal(files[0]?.id, 'stub-file-1')
      const serialized = result.content[0]?.text ?? ''
      assert.equal(serialized.includes('stub-drive-token'), false)
      assert.equal(serialized.includes('tokenRef'), false)
      assert.ok(logs.events.some((row) => row.event === 'enterprise.tool.ok'))
    } finally {
      logs.restore()
    }
  })

  await check('invoke read_file happy path', async () => {
    const result = await invokeEnterpriseTool(invokeDeps(), {
      principal: principal(),
      toolName: GOOGLE_DRIVE_READ_FILE_TOOL,
      args: { definitionId: DEFINITION_ID, fileId: 'stub-file-1' },
    })
    assert.equal(result.isError, undefined)
    const payload = parsePayload(result)
    assert.equal(typeof payload.text, 'string')
    assert.equal(payload.truncated, false)
  })

  await check('missing definitionId is definition_not_found', async () => {
    const logs = captureInfo()
    try {
      const result = await invokeEnterpriseTool(invokeDeps(), {
        principal: principal(),
        toolName: GOOGLE_DRIVE_SEARCH_TOOL,
        args: { nameContains: 'Platform' },
      })
      assert.equal(result.isError, true)
      assert.equal(parsePayload(result).code, 'definition_not_found')
      assert.ok(logs.events.some((row) => row.event === 'enterprise.tool.denied'))
    } finally {
      logs.restore()
    }
  })

  await check('view grant cannot invoke tools', async () => {
    const audit: Array<{ action: string }> = []
    const result = await invokeEnterpriseTool(invokeDeps({ grantAccessLevel: 'view', audit }), {
      principal: principal(),
      toolName: GOOGLE_DRIVE_SEARCH_TOOL,
      args: { definitionId: DEFINITION_ID },
    })
    assert.equal(result.isError, true)
    assert.equal(parsePayload(result).code, 'agent_access_denied')
    assert.ok(audit.some((row) => row.action === 'enterprise.tool.denied'))
    assert.equal(audit.some((row) => row.action === 'enterprise.tool.ok'), false)
  })

  await check('mismatched agentId is definition_mismatch', async () => {
    const result = await invokeEnterpriseTool(invokeDeps(), {
      principal: principal(),
      toolName: GOOGLE_DRIVE_SEARCH_TOOL,
      args: {
        definitionId: DEFINITION_ID,
        agentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      },
    })
    assert.equal(result.isError, true)
    assert.equal(parsePayload(result).code, 'definition_mismatch')
  })

  await check('non-UUID agentId is definition_mismatch, not invalid_args', async () => {
    const result = await invokeEnterpriseTool(invokeDeps(), {
      principal: principal(),
      toolName: GOOGLE_DRIVE_SEARCH_TOOL,
      args: {
        definitionId: DEFINITION_ID,
        agentId: 'not-a-uuid',
      },
    })
    assert.equal(result.isError, true)
    assert.equal(parsePayload(result).code, 'definition_mismatch')
  })

  await check('invoke deny uses published snapshot even if live-looking extras would allow', async () => {
    const publishedDenied = {
      ...definition({
        snapshot: {
          name: 'Drive assistant',
          roleInstruction: 'Inspect Drive',
          skills: [],
          connectors: [{ connectorId: CONNECTOR_ID, type: 'google_drive', accessMode: 'read' }],
          capabilities: [{ toolName: GOOGLE_DRIVE_SEARCH_TOOL, allowed: false }],
        },
      }),
      ...({
        capabilities: [{ toolName: GOOGLE_DRIVE_SEARCH_TOOL, allowed: true }],
        liveCapabilities: [{ toolName: GOOGLE_DRIVE_SEARCH_TOOL, allowed: true }],
      } as object),
    } as AgentDefinition
    const result = await invokeEnterpriseTool(invokeDeps({ definition: publishedDenied }), {
      principal: principal(),
      toolName: GOOGLE_DRIVE_SEARCH_TOOL,
      args: { definitionId: DEFINITION_ID, nameContains: 'Platform' },
    })
    assert.equal(result.isError, true)
    assert.equal(parsePayload(result).code, 'capability_not_allowed')
  })

  await check('extra JSON cannot override tenant or user', async () => {
    let seenUser: string | undefined
    let seenTenant: string | undefined
    const result = await invokeEnterpriseTool(
      {
        ...invokeDeps(),
        async resolveAccessToken(params) {
          seenUser = params.actingUserId
          seenTenant = params.tenantId
          return 'stub-drive-token'
        },
      },
      {
        principal: principal(),
        toolName: GOOGLE_DRIVE_SEARCH_TOOL,
        args: {
          definitionId: DEFINITION_ID,
          tenantId: OTHER_TENANT,
          userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        },
      },
    )
    assert.equal(result.isError, undefined)
    assert.equal(seenUser, USER_ID)
    assert.equal(seenTenant, TENANT_ID)
  })

  await check('Drive auth error maps to google_drive_auth_failed', async () => {
    const logs = captureInfo()
    try {
      const result = await invokeEnterpriseTool(
        invokeDeps({
          executeDriveTool: async () => {
            throw new GoogleDriveApiAuthError('nope', 401)
          },
        }),
        {
          principal: principal(),
          toolName: GOOGLE_DRIVE_SEARCH_TOOL,
          args: { definitionId: DEFINITION_ID },
        },
      )
      assert.equal(result.isError, true)
      const payload = parsePayload(result)
      assert.equal(payload.code, 'google_drive_auth_failed')
      assert.equal(payload.status, 401)
      assert.ok(logs.events.some((row) => row.event === 'enterprise.tool.error'))
    } finally {
      logs.restore()
    }
  })

  await check('Drive API error maps status and googleCode', async () => {
    const result = await invokeEnterpriseTool(
      invokeDeps({
        executeDriveTool: async () => {
          throw new GoogleDriveApiError('too big', 413, 'file_too_large')
        },
      }),
      {
        principal: principal({ role: 'admin' }),
        toolName: GOOGLE_DRIVE_READ_FILE_TOOL,
        args: { definitionId: DEFINITION_ID, fileId: 'stub-file-1' },
      },
    )
    assert.equal(result.isError, true)
    const payload = parsePayload(result)
    assert.equal(payload.code, 'google_drive_api_error')
    assert.equal(payload.status, 413)
    assert.equal(payload.googleCode, 'file_too_large')
  })

  await check('invoke create_folder enqueues instead of calling Drive', async () => {
    let driveCalled = false
    let enqueued: { toolName?: string; name?: unknown } | null = null
    const result = await invokeEnterpriseTool(
      invokeDeps({
        executeDriveTool: async () => {
          driveCalled = true
          return { leaked: true }
        },
      }),
      {
        principal: principal({ role: 'admin' }),
        toolName: GOOGLE_DRIVE_CREATE_FOLDER_TOOL,
        args: { definitionId: DEFINITION_ID, name: 'Q3 reports', idempotencyKey: 'idem-1' },
      },
    )
    assert.equal(driveCalled, false)
    assert.equal(result.isError, true)
    assert.equal(parsePayload(result).code, 'tool_not_configured')

    const withEnqueue = await invokeEnterpriseTool(
      {
        ...invokeDeps({
          executeDriveTool: async () => {
            driveCalled = true
            return { leaked: true }
          },
        }),
        async enqueueWrite(input) {
          enqueued = { toolName: input.toolName, name: input.args.name }
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                  status: 'awaiting_approval',
                  idempotencyKey: 'idem-1',
                  toolName: GOOGLE_DRIVE_CREATE_FOLDER_TOOL,
                }),
              },
            ],
          }
        },
      },
      {
        principal: principal({ role: 'admin' }),
        toolName: GOOGLE_DRIVE_CREATE_FOLDER_TOOL,
        args: { definitionId: DEFINITION_ID, name: 'Q3 reports', idempotencyKey: 'idem-1' },
      },
    )
    assert.equal(driveCalled, false)
    assert.equal(withEnqueue.isError, undefined)
    const payload = parsePayload(withEnqueue)
    assert.equal(payload.status, 'awaiting_approval')
    assert.equal(enqueued?.toolName, GOOGLE_DRIVE_CREATE_FOLDER_TOOL)
    assert.equal(enqueued?.name, 'Q3 reports')
  })

  await check('token resolution failure does not leak tokenRef', async () => {
    const result = await invokeEnterpriseTool(invokeDeps({ resolveError: new Error('grant_token_expired') }), {
      principal: principal(),
      toolName: GOOGLE_DRIVE_SEARCH_TOOL,
      args: { definitionId: DEFINITION_ID },
    })
    assert.equal(result.isError, true)
    const text = result.content[0]?.text ?? ''
    assert.equal(text.includes('stub-drive-token'), false)
    assert.equal(text.includes('tokenRef'), false)
    assert.equal(parsePayload(result).code, 'google_drive_auth_failed')
  })

  const kbDefinition = definition({
    snapshot: {
      name: 'Wiki',
      roleInstruction: 'Answer from the knowledge base',
      skills: [],
      connectors: [{ connectorId: CONNECTOR_ID, type: 'knowledge_base', accessMode: 'write' }],
      capabilities: [
        { toolName: KB_SEARCH_TOOL, allowed: true },
        { toolName: KB_INGEST_TOOL, allowed: true },
      ],
    },
  })
  const kbConnector = connector({ type: 'knowledge_base', authMode: 'agent_owned' })

  await check('kb_search authorizes without a user OAuth grant', async () => {
    const result = await authorizeToolCall(
      authorizeDeps({ connector: kbConnector, grant: null }),
      {
        principal: principal(),
        definition: kbDefinition,
        toolName: KB_SEARCH_TOOL,
        args: {},
      },
    )
    assert.equal(result.allowed, true)
    if (result.allowed) {
      assert.equal(result.connectorId, CONNECTOR_ID)
      assert.equal(result.grantId, null)
      assert.equal(result.tokenRef, null)
    }
  })

  await check('kb_ingest requires write binding', async () => {
    const result = await authorizeToolCall(
      authorizeDeps({ connector: kbConnector }),
      {
        principal: principal(),
        definition: definition({
          snapshot: {
            name: 'Wiki',
            roleInstruction: 'Answer',
            skills: [],
            connectors: [{ connectorId: CONNECTOR_ID, type: 'knowledge_base', accessMode: 'read' }],
            capabilities: [{ toolName: KB_INGEST_TOOL, allowed: true }],
          },
        }),
        toolName: KB_INGEST_TOOL,
        args: {},
      },
    )
    assert.deepEqual(result, { allowed: false, reason: 'missing_knowledge_base_connector_write' })
  })

  await check('kb_ingest invoke publishes without Drive token lookup', async () => {
    let seen: { toolName: string; filename: string } | undefined
    const result = await invokeEnterpriseTool(
      invokeDeps({
        definition: kbDefinition,
        connector: kbConnector,
        grant: null,
        executeKbTool: async (toolName, args) => {
          seen = { toolName, filename: String(args.filename) }
          return { documentId: 'doc-1', processingMode: 'okf', searchable: true }
        },
      }),
      {
        principal: principal(),
        toolName: KB_INGEST_TOOL,
        args: {
          definitionId: DEFINITION_ID,
          filename: 'policy.md',
          processingMode: 'okf',
          content: '# Remote\nWork from home is allowed.',
        },
      },
    )
    assert.equal(result.isError, undefined)
    assert.equal(seen?.toolName, KB_INGEST_TOOL)
    assert.equal(seen?.filename, 'policy.md')
    assert.equal(parsePayload(result).searchable, true)
  })

  console.log(`\n${failures === 0 ? 'enterprise-tools: ok' : `enterprise-tools: ${failures} failed`}`)
  if (failures > 0) process.exit(1)
}

void main()
