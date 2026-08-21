/**
 * APG-09 — OBSERVE mód, kill-switch hierarchia és privacy-audit.
 *
 * DoD: OBSERVE-ban egy CRM-fordulón mérhető a fedettség; az audit-payload
 * semmilyen ágon nem tartalmaz nyers entitásértéket.
 *
 * Futtatás: npm run test:privacy-observe
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { Connector, Ticket } from '@prisma/client'

import { ToolBrokerService, type Authorizer } from '../src/domain/tool-broker/tool-broker-service'
import { resolveToolOutputContract } from '../src/domain/tool-broker/tool-output-contracts'
import { isSideEffectingTool, resolveTrustClass } from '../src/domain/tool-broker/tool-trust-registry'
import { buildPrivacyAwareOutcomeChannels } from '../src/domain/tool-broker/tool-output-privacy'
import { OSTOROSBOR_CRM_PRIVACY_FIELDS } from '../src/domain/privacy/connector-privacy'
import {
  buildPrivacyAuditMetadata,
  findRawEntityLeak,
  recordPrivacyGatewayAudit,
  summaryFromSurrogate,
} from '../src/domain/privacy/privacy-audit'
import {
  DEFAULT_PRIVACY_GATEWAY_MODE,
  resolvePrivacyGatewayMode,
} from '../src/domain/privacy/privacy-mode'
import {
  DEFAULT_SENSITIVITY_LAYER_MODE,
  resolveSensitivityLayerMode,
} from '../src/domain/gateway/sensitivity-mode'
import { PlatformSettingsService } from '../src/domain/platform-settings/platform-settings-service'
import { SurrogateEngine, type PrivacyAuditSink } from '../src/domain/privacy/surrogate-engine'
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
import { valVaultMethodStubs } from './test-surrogate-vault-val-stubs'
import { parseSurrogate } from '../src/domain/privacy/surrogate-format'
import type {
  AgentRepository,
  AuditRepository,
  PlatformSettingsRepository,
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
const SOURCE_ID = 'crm/company/4821'
const RAW_VALUES = [COMPANY, EMAIL, OTHER_COMPANY, SOURCE_ID, 'ada.lovelace']

const CRM_FIELDS = {
  ...OSTOROSBOR_CRM_PRIVACY_FIELDS,
  email: {
    type: 'string' as const,
    privacy: 'tokenize' as const,
    entity_type: 'email' as const,
    source_id: 'crm/email/{id}',
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

  async findByEntity(tenantId: string, scope: PrivacyScope, entity: RefEntityRef): Promise<VaultLookup> {
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

  async findBySurrogate(tenantId: string, scope: PrivacyScope, surrogate: string): Promise<VaultLookup> {
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
      if (row.tenantId !== tenantId || row.scopeType !== scope.type || row.scopeId !== scope.id) continue
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

  findValByFingerprint = valVaultMethodStubs.findValByFingerprint
  findValBySurrogate = valVaultMethodStubs.findValBySurrogate
  insertVal = valVaultMethodStubs.insertVal
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

function crmConnector(): Connector {
  return {
    id: CONNECTOR,
    tenantId: TENANT,
    type: 'workspace',
    authMode: 'none',
    config: { fields: CRM_FIELDS },
  } as unknown as Connector
}

function capturingAudit() {
  const events: Record<string, unknown>[] = []
  const audit = {
    append: async (event: Record<string, unknown>) => {
      events.push(event)
      return event
    },
  } as unknown as AuditRepository
  return { audit, events }
}

function makeBroker(opts: {
  privacy: SurrogateEngine
  fileEditor: FileEditorService
  audit: AuditRepository
  mode?: 'off' | 'observe' | 'enforce'
}): ToolBrokerService {
  const tools = {
    createToolCall: async (row: Record<string, unknown>) => row,
    findCapabilitiesForAgent: async () => [],
    findConnectorsForAgent: async () => [],
    countToolCallsForTicket: async () => 0,
    countToolCallsForConversation: async () => 0,
    countToolCallsForAgentSince: async () => 0,
  } as unknown as ToolBrokerRepository

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
    opts.audit,
    null as unknown as TicketService,
    authorizer,
    null as unknown as ConnectorGrantService,
    opts.fileEditor,
    null as never,
    null as never,
    null as unknown as WebSearchService,
    null as unknown as WebSearchPolicyService,
    null as never,
    null as never,
    null as never,
  )
  broker.setStructuredPrivacyEngine(opts.privacy)
  if (opts.mode) {
    broker.setPrivacyModeResolver(async () => opts.mode!)
  }
  return broker
}

function crmRows() {
  return [
    { id: 4821, company_name: COMPANY, email: EMAIL, revenue: 10 },
    { id: 7, company_name: OTHER_COMPANY, email: 'beszerzes@tesco.hu', revenue: 20 },
    { id: 4821, company_name: COMPANY, email: EMAIL, revenue: 10 },
  ]
}

function assertNoRaw(payload: unknown, label: string) {
  const leak = findRawEntityLeak(payload, RAW_VALUES)
  assert.equal(leak, null, `${label}: nyers érték a payloadban: ${leak}`)
}

function inMemorySettings() {
  const store = new Map<string, unknown>()
  const events: Record<string, unknown>[] = []
  const settingsRepo: PlatformSettingsRepository = {
    get: async (key) => store.get(key) ?? null,
    set: async (key, value) => {
      store.set(key, value)
    },
  }
  const auditRepo = {
    append: async (event: Record<string, unknown>) => {
      events.push(event)
      return event
    },
  } as unknown as AuditRepository
  return { svc: new PlatformSettingsService(settingsRepo, auditRepo), events }
}

async function main() {
  console.log('APG-09 OBSERVE mód, kill-switch hierarchia és privacy-audit\n')

  await test('alapértelmezés OBSERVE; hiányzó szintek öröklődnek', () => {
    assert.equal(DEFAULT_PRIVACY_GATEWAY_MODE, 'observe')
    assert.equal(resolvePrivacyGatewayMode({}), 'observe')
    assert.equal(resolvePrivacyGatewayMode({ platform: 'enforce' }), 'enforce')
    assert.equal(resolvePrivacyGatewayMode({ platform: 'observe', tenant: 'off' }), 'off')
  })

  await test('platform plafon: agent nem léphet ENFORCE-ba OBSERVE alatt', () => {
    assert.equal(
      resolvePrivacyGatewayMode({ platform: 'observe', tenant: 'enforce', agent: 'enforce' }),
      'observe',
    )
  })

  await test('platform OFF mindent elzár; agent OFF platform ENFORCE mellett él', () => {
    assert.equal(
      resolvePrivacyGatewayMode({ platform: 'off', tenant: 'observe', agent: 'enforce' }),
      'off',
    )
    assert.equal(
      resolvePrivacyGatewayMode({ platform: 'enforce', agent: 'off' }),
      'off',
    )
  })

  await test('mintaszűrő alapértelmezés ENFORCE; agent lefelé kapcsolhat', () => {
    assert.equal(DEFAULT_SENSITIVITY_LAYER_MODE, 'enforce')
    assert.equal(resolveSensitivityLayerMode({}), 'enforce')
    assert.equal(resolveSensitivityLayerMode({ platform: 'enforce', agent: 'observe' }), 'observe')
    assert.equal(resolveSensitivityLayerMode({ platform: 'enforce', agent: 'off' }), 'off')
    assert.equal(
      resolveSensitivityLayerMode({ platform: 'observe', tenant: 'enforce', agent: 'enforce' }),
      'observe',
      'a szülő megfigyelése plafon: az agent nem szigoríthat',
    )
  })

  await test('audit-builder eldobja a nyers értéket és az extra kulcsokat', () => {
    const metadata = buildPrivacyAuditMetadata({
      categories: ['company'],
      action: 'tokenize',
      spanCount: 2,
      byCategory: { company: 2 },
      scopeType: 'conversation',
      mode: 'observe',
      displayValue: COMPANY,
      rawValue: EMAIL,
      sourceId: SOURCE_ID,
      company_name: COMPANY,
    })
    assert.equal(metadata.spanCount, 2)
    assert.deepEqual(metadata.categories, ['company'])
    assert.equal('displayValue' in metadata, false)
    assert.equal('rawValue' in metadata, false)
    assert.equal('sourceId' in metadata, false)
    assert.equal('company_name' in metadata, false)
    assertNoRaw(metadata, 'sanitized metadata')
  })

  await test('OBSERVE CRM-forduló: modelText nyers, fedettség mérhető, vault üres', async () => {
    const { engine: eng, vault } = engine()
    const { audit, events } = capturingAudit()
    const rows = crmRows()
    const rawResult = { sheet: 'Cégek', headers: ['id', 'company_name', 'email', 'revenue'], rows, rowCount: 3 }
    const broker = makeBroker({
      privacy: eng,
      audit,
      mode: 'observe',
      fileEditor: { xlsxReadSheet: async () => structuredClone(rawResult) } as unknown as FileEditorService,
    })
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
    assert.equal(result.modelText.includes(COMPANY), true)
    assert.equal(result.modelText.includes(EMAIL), true)
    assert.equal(result.modelText.includes('[[COMPANY_'), false)
    assert.deepEqual(result.machineData, rawResult)
    assert.equal(vault.rows.length, 0)

    const observed = events.filter((e) => e.action === 'privacy.transform.observed')
    assert.equal(observed.length, 1)
    const event = observed[0]!
    assert.equal(event.policyDecision, 'observed')
    assert.equal(event.outputRef, 'spans:6')
    const meta = event.metadata as { spanCount: number; byCategory: Record<string, number> }
    assert.equal(meta.spanCount, 6)
    assert.equal(meta.byCategory.company, 3)
    assert.equal(meta.byCategory.email, 3)
    assertNoRaw(event, 'OBSERVE transform.observed')
  })

  await test('OFF: nincs transzformációs audit, modelText nyers', async () => {
    const { engine: eng, vault } = engine()
    const { audit, events } = capturingAudit()
    const rows = crmRows()
    const rawResult = { sheet: 'Cégek', headers: ['id', 'company_name'], rows, rowCount: 3 }
    const broker = makeBroker({
      privacy: eng,
      audit,
      mode: 'off',
      fileEditor: { xlsxReadSheet: async () => structuredClone(rawResult) } as unknown as FileEditorService,
    })
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
    assert.equal(result.modelText.includes(COMPANY), true)
    assert.equal(vault.rows.length, 0)
    assert.equal(events.some((e) => String(e.action).startsWith('privacy.transform')), false)
  })

  await test('ENFORCE: transform.applied, modelText álnév, auditban nincs nyers érték', async () => {
    const { engine: eng } = engine()
    const { audit, events } = capturingAudit()
    const snapshot = structuredClone({
      ok: true,
      status: 200,
      body: { id: 4821, company_name: COMPANY, email: EMAIL, revenue: 1 },
    })
    const channels = await buildPrivacyAwareOutcomeChannels({
      tool: 'http_api_get',
      trust: resolveTrustClass('http_api_get'),
      output: snapshot,
      contract: resolveToolOutputContract('http_api_get'),
      sideEffecting: isSideEffectingTool('http_api_get'),
      connector: crmConnector(),
      conversationId: CONVERSATION,
      actingTenantId: TENANT,
      engine: eng,
      mode: 'enforce',
      audit,
    })
    assert.equal(channels.modelText.includes(COMPANY), false)
    assert.match(channels.modelText, /\[\[COMPANY_1\]\]/)
    assert.deepEqual(channels.machineData, snapshot)
    const applied = events.filter((e) => e.action === 'privacy.transform.applied')
    assert.equal(applied.length, 1)
    assert.equal((applied[0]!.metadata as { spanCount: number }).spanCount, 2)
    assertNoRaw(applied[0], 'ENFORCE transform.applied')
  })

  await test('resolve.applied: álnév a payloadban, source ID nincs', async () => {
    const { engine: eng, scope } = engine()
    await eng.allocateRef({
      tenantId: TENANT,
      scope,
      entityType: 'company',
      connectorId: CONNECTOR,
      sourceId: SOURCE_ID,
      displayValue: COMPANY,
    })
    const { audit, events } = capturingAudit()
    const broker = makeBroker({
      privacy: eng,
      audit,
      mode: 'enforce',
      fileEditor: {
        xlsxReadSheet: async () => ({
          sheet: 'Cégek',
          headers: ['id'],
          rows: [],
          rowCount: 0,
        }),
      } as unknown as FileEditorService,
    })
    await broker.invoke({
      agentId: AGENT,
      agentVersion: 1,
      ticketId: TICKET,
      conversationId: CONVERSATION,
      tool: 'xlsx_read_sheet',
      args: { path: '[[COMPANY_1]]' },
    })
    const applied = events.filter((e) => e.action === 'privacy.resolve.applied')
    assert.equal(applied.length, 1)
    assert.equal(applied[0]?.outputRef, 'spans:1')
    assert.equal((applied[0]?.metadata as { spanCount: number }).spanCount, 1)
    assertNoRaw(applied[0], 'resolve.applied')
  })

  await test('denied és unknown auditban nincs nyers érték, csak álnév', async () => {
    const { engine: eng, audit, scope } = engine()
    await eng.allocateRef({
      tenantId: TENANT,
      scope,
      entityType: 'company',
      connectorId: CONNECTOR,
      sourceId: SOURCE_ID,
      displayValue: COMPANY,
    })
    await eng.resolveRef({
      tenantId: TENANT,
      scope,
      surrogate: '[[COMPANY_99]]',
      requester: { tenantId: TENANT, userId: 'user-1' },
    })
    await eng.resolveRef({
      tenantId: TENANT,
      scope: { type: 'conversation', id: 'other-conv' },
      surrogate: '[[COMPANY_1]]',
      requester: { tenantId: TENANT, userId: 'user-1' },
    })
    assert.equal(audit.events.some((e) => e.action === 'privacy.surrogate.unknown'), true)
    assert.equal(audit.events.some((e) => e.action === 'privacy.resolve.denied'), true)
    assertNoRaw(audit.events, 'engine sink events')
  })

  await test('hash-láncolt append útvonal: unknown/denied metadata sem visz nyers értéket', async () => {
    const { audit, events } = capturingAudit()
    await recordPrivacyGatewayAudit(audit, {
      action: 'privacy.surrogate.unknown',
      tenantId: TENANT,
      scope: { type: 'conversation', id: CONVERSATION },
      summary: summaryFromSurrogate('[[COMPANY_99]]'),
      reason: 'unknown',
      surrogate: '[[COMPANY_99]]',
    })
    await recordPrivacyGatewayAudit(audit, {
      action: 'privacy.resolve.denied',
      tenantId: TENANT,
      scope: { type: 'conversation', id: CONVERSATION },
      summary: summaryFromSurrogate('[[COMPANY_1]]'),
      reason: 'tenant',
      surrogate: '[[COMPANY_1]]',
      actorType: 'human',
      actorId: 'user-1',
    })
    assert.equal(events[0]?.inputRef, '[[COMPANY_99]]')
    assert.equal(events[1]?.policyDecision, 'denied')
    for (const event of events) assertNoRaw(event, String(event.action))
  })

  await test('PlatformSetting hierarchia: default observe, tenant off, agent inherit', async () => {
    const { svc, events } = inMemorySettings()
    assert.equal(await svc.resolvePrivacyGatewayMode({ tenantId: TENANT, agentId: AGENT }), 'observe')

    await svc.setPrivacyGatewayControls({ mode: 'observe' }, 'admin-1')
    await svc.setTenantPrivacyGatewayControls(TENANT, { mode: 'off' }, 'admin-1')
    assert.equal(await svc.resolvePrivacyGatewayMode({ tenantId: TENANT, agentId: AGENT }), 'off')

    await svc.setAgentPrivacyGatewayControls(AGENT, { mode: 'enforce' }, 'admin-1')
    assert.equal(
      await svc.resolvePrivacyGatewayMode({ tenantId: TENANT, agentId: AGENT }),
      'off',
      'platform observe + tenant off plafonja alatt az agent ENFORCE nem él',
    )

    await svc.setTenantPrivacyGatewayControls(TENANT, { mode: null }, 'admin-1')
    await svc.setPrivacyGatewayControls({ mode: 'enforce' }, 'admin-1')
    assert.equal(await svc.resolvePrivacyGatewayMode({ tenantId: TENANT, agentId: AGENT }), 'enforce')

    await svc.setAgentPrivacyGatewayControls(AGENT, { mode: 'off' }, 'admin-1')
    assert.equal(await svc.resolvePrivacyGatewayMode({ tenantId: TENANT, agentId: AGENT }), 'off')

    assert.equal(events.every((e) => e.action === 'privacy.gateway.mode.set'), true)
    assertNoRaw(events, 'mode.set')
  })

  await test('mintaszűrő PlatformSetting: default enforce, agent observe dial-down', async () => {
    const { svc, events } = inMemorySettings()
    assert.equal(
      await svc.resolveSensitivityLayerMode({ tenantId: TENANT, agentId: AGENT }),
      'enforce',
    )

    await svc.setAgentSensitivityLayerControls(AGENT, { mode: 'observe' }, 'admin-1')
    assert.equal(
      await svc.resolveSensitivityLayerMode({ tenantId: TENANT, agentId: AGENT }),
      'observe',
    )

    await svc.setTenantSensitivityLayerControls(TENANT, { mode: 'off' }, 'admin-1')
    assert.equal(
      await svc.resolveSensitivityLayerMode({ tenantId: TENANT, agentId: AGENT }),
      'off',
    )

    assert.equal(events.every((e) => e.action === 'sensitivity.layer.mode.set'), true)
    assertNoRaw(events, 'sensitivity.mode.set')
  })

  if (failures > 0) {
    console.error(`\n${failures} teszt elbukott`)
    process.exit(1)
  }
  console.log('\nOK')
}

void main()
