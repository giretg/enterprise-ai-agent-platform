/**
 * APG-04 — strukturált tool-output pszeudonimizáció a broker `modelText` csatornáján.
 *
 * A pszeudonimizáció a kimeneti szerződés validációja UTÁN fut (R6), és kizárólag
 * a modellnek szánt ágat érinti. A `machineData` (munkaterület, downstream tool,
 * export) nyers marad.
 *
 * Futtatás: npm run test:structured-output-privacy
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Connector, Ticket } from '@prisma/client'

import { ToolBrokerService, type Authorizer } from '../src/domain/tool-broker/tool-broker-service'
import {
  buildToolOutcomeChannels,
  validateToolOutput,
} from '../src/domain/tool-broker/tool-output-contract'
import { resolveToolOutputContract } from '../src/domain/tool-broker/tool-output-contracts'
import { isSideEffectingTool, resolveTrustClass } from '../src/domain/tool-broker/tool-trust-registry'
import { buildPrivacyAwareOutcomeChannels } from '../src/domain/tool-broker/tool-output-privacy'
import {
  OSTOROSBOR_CRM_PRIVACY_FIELDS,
  readConnectorPrivacyFields,
} from '../src/domain/privacy/connector-privacy'
import { SurrogateEngine, type PrivacyAuditSink } from '../src/domain/privacy/surrogate-engine'
import { pseudonymizeStructuredOutput } from '../src/domain/privacy/structured-output-transform'
import {
  computeSurrogateHmac,
  insertRefsSequentially,
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

const COMPANY = 'SPAR Magyarország Kereskedelmi Kft.'
const EMAIL = 'ada.lovelace@spar.hu'
const OTHER_COMPANY = 'Tesco Globál Áruházak Zrt.'

const CRM_FIELDS = {
  ...OSTOROSBOR_CRM_PRIVACY_FIELDS,
  email: {
    type: 'string' as const,
    privacy: 'tokenize' as const,
    entity_type: 'email' as const,
    source_id: 'crm/email/{id}',
  },
}

const RAW_GET = {
  ok: true,
  status: 200,
  body: {
    id: 4821,
    company_name: COMPANY,
    email: EMAIL,
    revenue: 1_200_000_000,
  },
}

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

  async listByScope(tenantId: string, scope: PrivacyScope): Promise<RefVaultRecord[]> {
    const hits: RefVaultRecord[] = []
    for (const row of this.rows) {
      if (row.tenantId !== tenantId || row.scopeType !== scope.type || row.scopeId !== scope.id) continue
      const result = this.lookup(row)
      if (result.status === 'hit') hits.push(result.record)
    }
    return hits
  }

  async insertRefs(inputs: InsertRefInput[]): Promise<RefVaultRecord[]> {
    return insertRefsSequentially((input) => this.insertRef(input), inputs)
  }
}

function engine() {
  const vault = new InMemorySurrogateVault(() => HMAC_KEY)
  return {
    vault,
    engine: new SurrogateEngine(vault, new RecordingAudit()),
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

function crmConnector(): Connector {
  return {
    id: CONNECTOR,
    tenantId: TENANT,
    type: 'workspace',
    authMode: 'none',
    config: { fields: CRM_FIELDS },
  } as unknown as Connector
}

function makeBroker(fileEditor: FileEditorService, privacy: SurrogateEngine | null): ToolBrokerService {
  const tools = {
    createToolCall: async (row: Record<string, unknown>) => row,
    findCapabilitiesForAgent: async () => [],
    findConnectorsForAgent: async () => [],
    countToolCallsForTicket: async () => 0,
    countToolCallsForConversation: async () => 0,
    countToolCallsForAgentSince: async () => 0,
  } as unknown as ToolBrokerRepository

  const audit = {
    append: async (event: Record<string, unknown>) => event,
  } as unknown as AuditRepository

  const agents = {
    findById: async () => ({ id: AGENT, currentVersion: 1 }),
  } as unknown as AgentRepository

  const tickets = {
    findById: async (id: string) => (id === TICKET ? ticket : null),
  } as unknown as TicketRepository

  const authorizer: Authorizer = {
    authorize: async () => ({ allowed: true, connector: crmConnector() }),
  }

  const broker = new ToolBrokerService(
    agents,
    tickets,
    tools,
    audit,
    null as unknown as TicketService,
    authorizer,
    null as unknown as ConnectorGrantService,
    fileEditor,
    null as never,
    null as never,
    null as unknown as WebSearchService,
    null as unknown as WebSearchPolicyService,
    null as never,
    null as never,
    null as never,
  )
  broker.setStructuredPrivacyEngine(privacy)
  return broker
}

async function main() {
  console.log('strukturált tool-output pszeudonimizáció (APG-04)')

  await test('connector config fields-je olvasható a CRM sémából', () => {
    const fields = readConnectorPrivacyFields({ fields: CRM_FIELDS })
    assert.equal(fields?.company_name.privacy, 'tokenize')
    assert.equal(fields?.email.privacy, 'tokenize')
    assert.equal(fields?.revenue.privacy, 'pass')
    assert.equal(readConnectorPrivacyFields({}), null)
  })

  await test('R6: e-mail formátumú séma a nyers értéket elfogadja, az álnevet nem', async () => {
    const { engine: eng, scope } = engine()
    const emailSchema = z.object({ email: z.string().email() })
    const raw = { id: 3, email: EMAIL }
    assert.equal(emailSchema.safeParse(raw).success, true)

    const transformed = await pseudonymizeStructuredOutput({
      output: raw,
      fields: CRM_FIELDS,
      engine: eng,
      tenantId: TENANT,
      connectorId: CONNECTOR,
      scope,
    })
    assert.deepEqual(transformed, { id: 3, email: '[[EMAIL_1]]' })
    assert.equal(emailSchema.safeParse(transformed).success, false)
    assert.deepEqual(raw, { id: 3, email: EMAIL })
  })

  await test('ENFORCE: a jelölt mező nyers értéke nincs a modelTextben; machineData bitre nyers; szerződés zöld', async () => {
    const { engine: eng } = engine()
    const snapshot = structuredClone(RAW_GET)
    const contract = resolveToolOutputContract('http_api_get')
    const verdict = validateToolOutput({
      tool: 'http_api_get',
      output: RAW_GET,
      contract,
      sideEffecting: false,
    })
    assert.equal(verdict.outcome, 'ok')

    const channels = await buildPrivacyAwareOutcomeChannels({
      tool: 'http_api_get',
      trust: resolveTrustClass('http_api_get'),
      output: RAW_GET,
      contract,
      sideEffecting: isSideEffectingTool('http_api_get'),
      connector: crmConnector(),
      conversationId: CONVERSATION,
      actingTenantId: TENANT,
      engine: eng,
    })

    assert.equal(channels.outcome, 'ok')
    assert.equal(channels.modelText.includes(COMPANY), false)
    assert.equal(channels.modelText.includes(EMAIL), false)
    assert.match(channels.modelText, /\[\[COMPANY_1\]\]/)
    assert.match(channels.modelText, /\[\[EMAIL_1\]\]/)
    assert.equal(channels.modelText.includes('1200000000'), true)
    assert.deepEqual(channels.machineData, snapshot)
    assert.equal(JSON.stringify(channels.machineData), JSON.stringify(snapshot))
    assert.deepEqual(RAW_GET, snapshot)
  })

  await test('tömb: ugyanaz az entitás ugyanazt az álnevet kapja a válaszon belül', async () => {
    const { engine: eng, scope } = engine()
    const output = {
      ok: true,
      status: 200,
      body: [
        { id: 4821, company_name: COMPANY, revenue: 10 },
        { id: 7, company_name: OTHER_COMPANY, revenue: 20 },
        { id: 4821, company_name: COMPANY, revenue: 10 },
      ],
    }
    const transformed = (await pseudonymizeStructuredOutput({
      output,
      fields: CRM_FIELDS,
      engine: eng,
      tenantId: TENANT,
      connectorId: CONNECTOR,
      scope,
    })) as typeof output

    assert.equal(transformed.body[0]?.company_name, '[[COMPANY_1]]')
    assert.equal(transformed.body[1]?.company_name, '[[COMPANY_2]]')
    assert.equal(transformed.body[2]?.company_name, '[[COMPANY_1]]')
    assert.equal(eng.peekDisplayValue(TENANT, scope, '[[COMPANY_1]]'), COMPANY)
    assert.equal(eng.peekDisplayValue(TENANT, scope, '[[COMPANY_2]]'), OTHER_COMPANY)
    assert.equal(transformed.body[0]?.revenue, 10)
    assert.equal(transformed.body[1]?.revenue, 20)
    assert.equal(output.body[0]?.company_name, COMPANY)
  })

  await test('privacy mezők nélkül a kimenet érintetlen', async () => {
    const { engine: eng, scope } = engine()
    const output = { ok: true, status: 200, body: { company_name: COMPANY } }
    const transformed = await pseudonymizeStructuredOutput({
      output,
      fields: undefined,
      engine: eng,
      tenantId: TENANT,
      connectorId: CONNECTOR,
      scope,
    })
    assert.equal(transformed, output)
    const channels = await buildPrivacyAwareOutcomeChannels({
      tool: 'http_api_get',
      trust: 'external_untrusted',
      output,
      contract: resolveToolOutputContract('http_api_get'),
      sideEffecting: false,
      connector: { id: CONNECTOR, tenantId: TENANT, config: {} },
      conversationId: CONVERSATION,
      actingTenantId: TENANT,
      engine: eng,
    })
    assert.equal(channels.modelText.includes(COMPANY), true)
    assert.equal(channels.machineData, output)
  })

  await test('buildToolOutcomeChannels: a modelOutput csak a modelTextet érinti', () => {
    const raw = { ok: true, status: 200, body: { company_name: COMPANY } }
    const model = { ok: true, status: 200, body: { company_name: '[[COMPANY_1]]' } }
    const channels = buildToolOutcomeChannels({
      tool: 'http_api_get',
      trust: 'internal',
      output: raw,
      modelOutput: model,
      contract: resolveToolOutputContract('http_api_get'),
      sideEffecting: false,
    })
    assert.equal(channels.machineData, raw)
    assert.equal(channels.modelText.includes(COMPANY), false)
    assert.equal(channels.modelText.includes('[[COMPANY_1]]'), true)
  })

  await test('broker invoke ENFORCE: xlsx sorok álnevei a modelTextben, machineData nyers', async () => {
    const { engine: eng } = engine()
    const rows = [
      { id: 4821, company_name: COMPANY, email: EMAIL, revenue: 10 },
      { id: 7, company_name: OTHER_COMPANY, email: 'beszerzes@tesco.hu', revenue: 20 },
      { id: 4821, company_name: COMPANY, email: EMAIL, revenue: 10 },
    ]
    const rawResult = { sheet: 'Cégek', headers: ['id', 'company_name', 'email', 'revenue'], rows, rowCount: 3 }
    const broker = makeBroker(
      { xlsxReadSheet: async () => structuredClone(rawResult) } as unknown as FileEditorService,
      eng,
    )
    const result = await broker.invoke({
      agentId: AGENT,
      agentVersion: 1,
      ticketId: TICKET,
      conversationId: CONVERSATION,
      tool: 'xlsx_read_sheet',
      args: { path: 'cegek.xlsx' },
    })
    assert.equal(result.denied, false)
    if (result.denied) return
    assert.equal(result.outcome, 'ok')
    assert.equal(result.modelText.includes(COMPANY), false)
    assert.equal(result.modelText.includes(EMAIL), false)
    assert.match(result.modelText, /\[\[COMPANY_1\]\]/)
    assert.match(result.modelText, /\[\[COMPANY_2\]\]/)
    assert.match(result.modelText, /\[\[EMAIL_1\]\]/)
    assert.deepEqual(result.machineData, rawResult)
    assert.equal(JSON.stringify(result.machineData), JSON.stringify(rawResult))
  })

  if (failures > 0) {
    console.error(`\n${failures} teszt elbukott`)
    process.exit(1)
  }
  console.log('\nOK')
}

void main()
