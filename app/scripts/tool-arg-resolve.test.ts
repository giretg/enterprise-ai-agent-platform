/**
 * APG-05 — tool-argumentum feloldás a brokerben (spec §10.1).
 *
 * A feloldott source ID csak a connector-hívás argumentumába kerül. A
 * `ToolCall.argsMeta` a surrogate-alakot naplózza. Ismeretlen álnév nem hív ki.
 *
 * Futtatás: npm run test:tool-arg-resolve
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { Connector, Ticket } from '@prisma/client'

import { ToolBrokerService, type Authorizer } from '../src/domain/tool-broker/tool-broker-service'
import { UnknownSurrogateError, resolveToolArgs } from '../src/domain/privacy/resolve-tool-args'
import { SurrogateEngine, type PrivacyAuditSink } from '../src/domain/privacy/surrogate-engine'
import {
  computeSurrogateHmac,
  SurrogateTakenError,
  verifySurrogateHmac,
  type InsertRefInput,
  type PrivacyScope,
  type RefEntityRef,
  type RefVaultRecord,
  type SurrogateHmacFields,
  type SurrogateVault,
  type VaultLookup,
} from '../src/domain/privacy/surrogate-vault'
import { parseSurrogate } from '../src/domain/privacy/surrogate-format'
import type {
  AgentRepository,
  AuditRepository,
  TicketRepository,
  ToolBrokerRepository,
} from '../src/repositories/interfaces'
import type { ConnectorGrantService } from '../src/domain/connector-grant/connector-grant-service'
import type { FileEditorService } from '../src/domain/file-editor/file-editor-service'
import type { TicketService } from '../src/domain/ticket/ticket-service'
import type { WebSearchPolicyService } from '../src/domain/web-search/web-search-policy-service'
import type { WebSearchService } from '../src/domain/web-search/web-search-service'

let failures = 0
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failures += 1
    console.error(`  ✗ ${name}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

const TENANT = 'aaaaaaaa-0000-4000-8000-000000000001'
const AGENT = 'bbbbbbbb-0000-4000-8000-000000000002'
const TICKET = 'cccccccc-0000-4000-8000-000000000003'
const CONNECTOR = 'dddddddd-0000-4000-8000-000000000004'
const CONVERSATION = 'eeeeeeee-0000-4000-8000-000000000005'
const HMAC_KEY = 'test-tenant-hmac-key'
const SOURCE_ID = 'crm/company/4821'

process.env.HTTP_API_STUB = 'true'

type AuditEvent =
  | Parameters<PrivacyAuditSink['recordUnknownSurrogate']>[0]
  | Parameters<PrivacyAuditSink['recordResolveDenied']>[0]

class RecordingAudit implements PrivacyAuditSink {
  readonly events: AuditEvent[] = []
  async recordUnknownSurrogate(event: Parameters<PrivacyAuditSink['recordUnknownSurrogate']>[0]): Promise<void> {
    this.events.push(event)
  }
  async recordResolveDenied(event: Parameters<PrivacyAuditSink['recordResolveDenied']>[0]): Promise<void> {
    this.events.push(event)
  }
}

class InMemorySurrogateVault implements SurrogateVault {
  readonly rows: RefVaultRecord[] = []

  constructor(private readonly resolveTenantKey: (tenantId: string) => string) {}

  private lookup(row: RefVaultRecord | undefined): VaultLookup {
    if (!row) return { status: 'miss' }
    const fields: SurrogateHmacFields = {
      tenantId: row.tenantId,
      scopeType: row.scopeType,
      scopeId: row.scopeId,
      entityType: row.entityType,
      surrogate: row.surrogate,
      class: row.class,
      connectorId: row.connectorId,
      sourceId: row.sourceId,
    }
    if (!verifySurrogateHmac(this.resolveTenantKey(row.tenantId), fields, row.hmac)) {
      return { status: 'tampered' }
    }
    return { status: 'hit', record: row }
  }

  async findByEntity(
    tenantId: string,
    scope: PrivacyScope,
    entity: RefEntityRef,
  ): Promise<VaultLookup> {
    return this.lookup(
      this.rows.find(
        (row) =>
          row.tenantId === tenantId &&
          row.scopeType === scope.type &&
          row.scopeId === scope.id &&
          row.entityType === entity.entityType &&
          row.connectorId === entity.connectorId &&
          row.sourceId === entity.sourceId,
      ),
    )
  }

  async findBySurrogate(
    tenantId: string,
    scope: PrivacyScope,
    surrogate: string,
  ): Promise<VaultLookup> {
    return this.lookup(
      this.rows.find(
        (row) =>
          row.tenantId === tenantId &&
          row.scopeType === scope.type &&
          row.scopeId === scope.id &&
          row.surrogate === surrogate,
      ),
    )
  }

  async findHitsBySurrogateInTenant(tenantId: string, surrogate: string): Promise<RefVaultRecord[]> {
    const hits: RefVaultRecord[] = []
    for (const row of this.rows) {
      if (row.tenantId !== tenantId || row.surrogate !== surrogate) continue
      const result = this.lookup(row)
      if (result.status === 'hit') hits.push(result.record)
    }
    return hits
  }

  async maxOrdinal(tenantId: string, scope: PrivacyScope, entityType: string): Promise<number> {
    let max = 0
    for (const row of this.rows) {
      if (row.tenantId !== tenantId || row.scopeType !== scope.type || row.scopeId !== scope.id) {
        continue
      }
      const parsed = parseSurrogate(row.surrogate)
      if (parsed && parsed.entityType === entityType && parsed.ordinal > max) max = parsed.ordinal
    }
    return max
  }

  async insertRef(input: InsertRefInput): Promise<RefVaultRecord> {
    const entityHit = this.rows.find(
      (row) =>
        row.tenantId === input.tenantId &&
        row.scopeType === input.scope.type &&
        row.scopeId === input.scope.id &&
        row.entityType === input.entityType &&
        row.connectorId === input.connectorId &&
        row.sourceId === input.sourceId,
    )
    if (entityHit) return entityHit

    const surrogateHit = this.rows.find(
      (row) =>
        row.tenantId === input.tenantId &&
        row.scopeType === input.scope.type &&
        row.scopeId === input.scope.id &&
        row.surrogate === input.surrogate,
    )
    if (surrogateHit) throw new SurrogateTakenError(input.surrogate)

    const fields: SurrogateHmacFields = {
      tenantId: input.tenantId,
      scopeType: input.scope.type,
      scopeId: input.scope.id,
      entityType: input.entityType,
      surrogate: input.surrogate,
      class: 'ref',
      connectorId: input.connectorId,
      sourceId: input.sourceId,
    }
    const record: RefVaultRecord = {
      ...fields,
      id: randomUUID(),
      hmac: computeSurrogateHmac(this.resolveTenantKey(input.tenantId), fields),
    }
    this.rows.push(record)
    return record
  }
}

function engine() {
  const vault = new InMemorySurrogateVault(() => HMAC_KEY)
  const audit = new RecordingAudit()
  return {
    vault,
    audit,
    engine: new SurrogateEngine(vault, audit),
    scope: { type: 'conversation' as const, id: CONVERSATION },
  }
}

const ticket = {
  id: TICKET,
  tenantId: TENANT,
  agentId: AGENT,
  payload: {},
  state: 'in_progress',
} as unknown as Ticket

function workspaceConnector(): Connector {
  return {
    id: CONNECTOR,
    tenantId: TENANT,
    type: 'workspace',
    authMode: 'none',
    config: {},
  } as unknown as Connector
}

function httpConnector(): Connector {
  return {
    id: CONNECTOR,
    tenantId: TENANT,
    type: 'http_api',
    name: 'CRM',
    authMode: 'service',
    config: {
      baseUrl: 'https://crm.example/api/v1',
      auth: { scheme: 'bearer' },
      endpoints: [{ method: 'GET', path: '/revenue' }],
    },
  } as unknown as Connector
}

type ToolCallRow = {
  status: string
  policyDecision: string
  argsMeta: Record<string, unknown>
}

function makeBroker(opts: {
  privacy: SurrogateEngine | null
  connector: Connector
  fileEditor?: FileEditorService
  toolCalls?: ToolCallRow[]
}): ToolBrokerService {
  const tools = {
    createToolCall: async (row: ToolCallRow) => {
      opts.toolCalls?.push(row)
      return row
    },
    findCapabilitiesForAgent: async () => [],
    findConnectorsForAgent: async () => [],
    countToolCallsForTicket: async () => 0,
    countToolCallsForConversation: async () => 0,
    countToolCallsForAgentSince: async () => 0,
  } as unknown as ToolBrokerRepository

  const auditRepo = {
    append: async (event: Record<string, unknown>) => event,
  } as unknown as AuditRepository

  const agents = {
    findById: async () => ({ id: AGENT, currentVersion: 1 }),
  } as unknown as AgentRepository

  const tickets = {
    findById: async (id: string) => (id === TICKET ? ticket : null),
  } as unknown as TicketRepository

  const authorizer: Authorizer = {
    authorize: async () => ({ allowed: true, connector: opts.connector }),
  }

  const broker = new ToolBrokerService(
    agents,
    tickets,
    tools,
    auditRepo,
    null as unknown as TicketService,
    authorizer,
    null as unknown as ConnectorGrantService,
    opts.fileEditor ?? (null as unknown as FileEditorService),
    null as never,
    null as never,
    null as unknown as WebSearchService,
    null as unknown as WebSearchPolicyService,
    null as never,
    null as never,
    null as never,
  )
  broker.setStructuredPrivacyEngine(opts.privacy)
  return broker
}

async function main() {
  console.log('tool-argumentum feloldás (APG-05)')

  await test('resolveToolArgs: álnév → source ID, az eredeti args érintetlen', async () => {
    const { engine: eng, scope } = engine()
    await eng.allocateRef({
      tenantId: TENANT,
      scope,
      entityType: 'company',
      connectorId: CONNECTOR,
      sourceId: SOURCE_ID,
    })
    const original = { company: '[[COMPANY_1]]', note: 'hagyd' }
    const snapshot = structuredClone(original)
    const resolved = await resolveToolArgs({
      args: original,
      engine: eng,
      tenantId: TENANT,
      scope,
    })
    assert.equal(resolved.ok, true)
    if (!resolved.ok) return
    assert.equal(resolved.resolvedCount, 1)
    assert.deepEqual(resolved.args, { company: SOURCE_ID, note: 'hagyd' })
    assert.deepEqual(original, snapshot)
  })

  await test('resolveToolArgs: nested query és tömb', async () => {
    const { engine: eng, scope } = engine()
    await eng.allocateRef({
      tenantId: TENANT,
      scope,
      entityType: 'company',
      connectorId: CONNECTOR,
      sourceId: SOURCE_ID,
    })
    const resolved = await resolveToolArgs({
      args: {
        path: '/revenue',
        query: { company: '[[COMPANY_1]]', year: 2026 },
        ids: ['[[COMPANY_1]]', 'nyers'],
      },
      engine: eng,
      tenantId: TENANT,
      scope,
    })
    assert.equal(resolved.ok, true)
    if (!resolved.ok) return
    assert.deepEqual(resolved.args, {
      path: '/revenue',
      query: { company: SOURCE_ID, year: 2026 },
      ids: [SOURCE_ID, 'nyers'],
    })
  })

  await test('resolveToolArgs: ismeretlen álnév nem cserél, vault-auditot ír', async () => {
    const { engine: eng, audit, scope } = engine()
    const resolved = await resolveToolArgs({
      args: { company: '[[COMPANY_99]]' },
      engine: eng,
      tenantId: TENANT,
      scope,
    })
    assert.equal(resolved.ok, false)
    if (resolved.ok) return
    assert.equal(resolved.surrogate, '[[COMPANY_99]]')
    assert.equal(audit.events[0]?.action, 'privacy.surrogate.unknown')
    assert.equal(audit.events[0]?.surrogate, '[[COMPANY_99]]')
  })

  await test('broker: surrogate-tal hívott tool a source ID-val éri el a connectort', async () => {
    const { engine: eng, scope } = engine()
    await eng.allocateRef({
      tenantId: TENANT,
      scope,
      entityType: 'company',
      connectorId: CONNECTOR,
      sourceId: SOURCE_ID,
    })
    const broker = makeBroker({ privacy: eng, connector: httpConnector() })
    const result = await broker.invoke({
      agentId: AGENT,
      agentVersion: 1,
      ticketId: TICKET,
      conversationId: CONVERSATION,
      tool: 'http_api_get',
      args: { path: '/revenue', query: { company: '[[COMPANY_1]]' } },
    })
    assert.equal(result.denied, false)
    if (result.denied) return
    const body = (result.machineData as { body?: { query?: { company?: string } } }).body
    assert.equal(body?.query?.company, SOURCE_ID)
    assert.equal(JSON.stringify(result.machineData).includes('[[COMPANY_1]]'), false)
  })

  await test('broker: argsMeta a surrogate-ot naplózza, nem a source ID-t', async () => {
    const { engine: eng, scope } = engine()
    await eng.allocateRef({
      tenantId: TENANT,
      scope,
      entityType: 'company',
      connectorId: CONNECTOR,
      sourceId: SOURCE_ID,
    })
    const seen: Array<{ path: string }> = []
    const toolCalls: ToolCallRow[] = []
    const broker = makeBroker({
      privacy: eng,
      connector: workspaceConnector(),
      toolCalls,
      fileEditor: {
        xlsxReadSheet: async (_tenant: string, _ws: string, args: { path: string }) => {
          seen.push(args)
          return { sheet: 'Cégek', headers: ['id'], rows: [], rowCount: 0 }
        },
      } as unknown as FileEditorService,
    })
    const result = await broker.invoke({
      agentId: AGENT,
      agentVersion: 1,
      ticketId: TICKET,
      conversationId: CONVERSATION,
      tool: 'xlsx_read_sheet',
      args: { path: '[[COMPANY_1]]' },
    })
    assert.equal(result.denied, false)
    if (result.denied) return
    assert.equal(seen[0]?.path, SOURCE_ID)
    assert.equal(toolCalls[0]?.argsMeta.path, '[[COMPANY_1]]')
    assert.equal(JSON.stringify(toolCalls[0]?.argsMeta).includes(SOURCE_ID), false)
    assert.equal(result.modelText.includes(SOURCE_ID), false)
  })

  await test('broker: ismeretlen álnév nem hív ki, hibát ad, auditot ír', async () => {
    const { engine: eng, audit } = engine()
    const seen: Array<{ path: string }> = []
    const toolCalls: ToolCallRow[] = []
    const broker = makeBroker({
      privacy: eng,
      connector: workspaceConnector(),
      toolCalls,
      fileEditor: {
        xlsxReadSheet: async (_tenant: string, _ws: string, args: { path: string }) => {
          seen.push(args)
          return { sheet: 'Cégek', headers: ['id'], rows: [], rowCount: 0 }
        },
      } as unknown as FileEditorService,
    })
    await assert.rejects(
      () =>
        broker.invoke({
          agentId: AGENT,
          agentVersion: 1,
          ticketId: TICKET,
          conversationId: CONVERSATION,
          tool: 'xlsx_read_sheet',
          args: { path: '[[COMPANY_99]]' },
        }),
      (err: unknown) => {
        assert.equal(err instanceof UnknownSurrogateError, true)
        assert.equal((err as UnknownSurrogateError).surrogate, '[[COMPANY_99]]')
        assert.match((err as Error).message, /Ismeretlen álnév/)
        return true
      },
    )
    assert.equal(seen.length, 0)
    assert.equal(toolCalls[0]?.status, 'error')
    assert.equal(toolCalls[0]?.policyDecision, 'privacy.surrogate.unknown')
    assert.equal(toolCalls[0]?.argsMeta.path, '[[COMPANY_99]]')
    assert.equal(audit.events[0]?.action, 'privacy.surrogate.unknown')
    assert.equal(audit.events[0]?.surrogate, '[[COMPANY_99]]')
  })

  await test('engine nélkül az argumentum érintetlenül megy a connectorhoz', async () => {
    const seen: Array<{ path: string }> = []
    const broker = makeBroker({
      privacy: null,
      connector: workspaceConnector(),
      fileEditor: {
        xlsxReadSheet: async (_tenant: string, _ws: string, args: { path: string }) => {
          seen.push(args)
          return { sheet: 'Cégek', headers: ['id'], rows: [], rowCount: 0 }
        },
      } as unknown as FileEditorService,
    })
    const result = await broker.invoke({
      agentId: AGENT,
      agentVersion: 1,
      ticketId: TICKET,
      conversationId: CONVERSATION,
      tool: 'xlsx_read_sheet',
      args: { path: '[[COMPANY_1]]' },
    })
    assert.equal(result.denied, false)
    assert.equal(seen[0]?.path, '[[COMPANY_1]]')
  })

  if (failures > 0) {
    console.error(`\n${failures} teszt elbukott`)
    process.exit(1)
  }
  console.log('\nOK')
}

void main()
