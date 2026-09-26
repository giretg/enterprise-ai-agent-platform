/**
 * Determinisztikus teszt a Provisioning Assistant (Connector Onboarding) feature-höz
 * (Feature-spec — Provisioning-Assistant §4, §7, §8, §12). Futtatás: npm run test:provisioning
 *
 * DB és élő hálózat NÉLKÜL igazolja a propose-not-apply munkafolyamatot: draft
 * generálás + determinisztikus validáció + emberi review/activate/assign, a kemény
 * padlót (CR-MVP-002), a dual-control four-eyes kaput, a tenant-izolációt és azt,
 * hogy a forrásdoksi/secret NEM kerül auditba. Lefedi a §12.1 (P1–P8) és a
 * kötelező §12.2 negatív teszteket (PN1–PN10).
 */
import assert from 'node:assert/strict'
import type {
  AuditLog,
  Connector,
  ConnectorAccessMode,
  ConnectorAuthMode,
  ConnectorDraftReviewStatus,
  ConnectorType,
  Prisma,
} from '@prisma/client'
import type {
  AuditRepository,
  ConnectorDraftRepository,
  ConnectorDraftWithConnector,
  CreateConnectorDraftInput,
} from '../src/repositories/interfaces'
import {
  ProvisioningService,
  type ProvisioningActor,
  type SandboxConnectionTester,
} from '../src/domain/provisioning/provisioning-service'
import { ProvisioningError } from '../src/domain/provisioning/errors'
import { isConnectorAssignableToAgent } from '../src/domain/connector-self-update/pinned-runtime-config'
import { validateDraftConfig } from '../src/domain/provisioning/draft-validator'
import {
  normalizeConnectorConfig,
  type ConnectorConfig,
} from '../src/domain/provisioning/connector-config'
import { HttpSandboxConnectionTester } from '../src/domain/provisioning/sandbox-connection-tester'

let failures = 0
/** Az agentnek grantolható draft-capability-k (a ProvisioningService kapuja ezeket nézi). */
const DRAFT_CAPABILITIES = [
  'provisioning.draft.create',
  'provisioning.draft.validate',
  'provisioning.catalog.read',
]

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    console.log(`  ✅ ${name}`)
  } catch (e) {
    failures++
    console.log(`  ❌ ${name}: ${e instanceof Error ? e.message : String(e)}`)
  }
}

async function expectError(code: string, fn: () => Promise<unknown>): Promise<ProvisioningError> {
  try {
    await fn()
  } catch (e) {
    if (e instanceof ProvisioningError) {
      assert.equal(e.code, code, `expected ${code}, got ${e.code}`)
      return e
    }
    throw e
  }
  throw new Error(`expected ProvisioningError ${code}, but no error was thrown`)
}

// ---- Fake-ek ----------------------------------------------------------------

class FakeAudit implements AuditRepository {
  events: AuditLog[] = []
  async append(data: Omit<AuditLog, 'id' | 'seq' | 'createdAt' | 'hash' | 'prevHash'>) {
    const row = {
      ...data,
      id: `audit-${this.events.length + 1}`,
      seq: BigInt(this.events.length + 1),
      createdAt: new Date(),
      hash: null,
      prevHash: null,
    } as AuditLog
    this.events.push(row)
    return row
  }
  async findMany(filter?: { action?: string }) {
    return this.events.filter((e) => !filter?.action || e.action === filter.action)
  }
  async findAll() {
    return this.events
  }
  async getActionCounts(): Promise<Record<string, number>> {
    return {}
  }
  byAction(action: string) {
    return this.events.filter((e) => e.action === action)
  }
}

type DraftRow = ConnectorDraftWithConnector

class FakeDraftRepo implements ConnectorDraftRepository {
  drafts = new Map<string, DraftRow>()
  initialSpecVersions = new Map<
    string,
    NonNullable<Parameters<ConnectorDraftRepository['activate']>[0]['initialSpecVersion']>
  >()
  agentConnectors: Array<{ agentId: string; connectorId: string; accessMode: ConnectorAccessMode }> = []
  private seq = 0

  async createDraft(input: CreateConnectorDraftInput): Promise<DraftRow> {
    this.seq++
    const connectorId = `conn-${this.seq}`
    const draftId = `draft-${this.seq}`
    const connector: Connector = {
      id: connectorId,
      type: (input.connectorType ?? 'http_api') as ConnectorType,
      name: input.name,
      authMode: input.authMode,
      scope: 'single',
      secretAlias: input.secretAliasSuggested,
      version: 1,
      config: input.config as Prisma.JsonValue,
      lifecycleState: 'draft',
      connectorMode: 'fixed',
      activeSpecVersionId: null,
      consequenceBoundary: null,
      tenantId: input.tenantId,
      privacySlot: this.seq,
      createdAt: new Date(),
    }
    const row = {
      id: draftId,
      tenantId: input.tenantId,
      connectorId,
      sourceType: input.sourceType,
      sourceRef: input.sourceRef,
      sourceHash: input.sourceHash,
      generatedByAgentId: input.generatedByAgentId,
      generatedByAgentVersion: input.generatedByAgentVersion,
      generatedFromConversationId: input.generatedFromConversationId,
      validationResult: null,
      reviewStatus: 'pending' as ConnectorDraftReviewStatus,
      reviewedById: null,
      secondApproverId: null,
      sandboxTestOk: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      connector,
    } as DraftRow
    this.drafts.set(draftId, row)
    return row
  }
  async findById(draftId: string) {
    return this.drafts.get(draftId) ?? null
  }
  async findByConnectorId(connectorId: string) {
    return [...this.drafts.values()].find((d) => d.connectorId === connectorId) ?? null
  }
  async list(tenantId: string | null) {
    return [...this.drafts.values()].filter((d) => d.tenantId === tenantId)
  }
  async setValidationResult(draftId: string, result: Prisma.InputJsonValue) {
    const d = this.drafts.get(draftId)!
    d.validationResult = result as Prisma.JsonValue
    return d
  }
  async setReview(params: {
    draftId: string
    reviewStatus: ConnectorDraftReviewStatus
    reviewedById: string
  }) {
    const d = this.drafts.get(params.draftId)!
    d.reviewStatus = params.reviewStatus
    d.reviewedById = params.reviewedById
    return d
  }
  async setSandboxTestResult(draftId: string, ok: boolean) {
    const d = this.drafts.get(draftId)!
    d.sandboxTestOk = ok
    return d
  }
  async activate(params: {
    draftId: string
    secretAlias: string
    authMode: ConnectorAuthMode
    secondApproverId: string | null
    config?: Prisma.InputJsonValue
    initialSpecVersion?: {
      rawSnapshot: Prisma.InputJsonValue
      rawHash: string
      capabilitySet: Prisma.InputJsonValue
      approvedById: string
    }
  }) {
    const d = this.drafts.get(params.draftId)!
    d.secondApproverId = params.secondApproverId
    d.connector.lifecycleState = 'active'
    d.connector.secretAlias = params.secretAlias
    d.connector.authMode = params.authMode
    if (params.config !== undefined) {
      d.connector.config = params.config as Prisma.JsonValue
    }
    if (params.initialSpecVersion) {
      d.connector.activeSpecVersionId = crypto.randomUUID()
      this.initialSpecVersions.set(d.connectorId, params.initialSpecVersion)
    }
    return d.connector
  }
  async assignToAgent(params: {
    connectorId: string
    agentId: string
    accessMode: ConnectorAccessMode
  }) {
    this.agentConnectors.push(params)
  }
  async unassignFromAgent(params: { connectorId: string; agentId: string }) {
    const before = this.agentConnectors.length
    this.agentConnectors = this.agentConnectors.filter(
      (ac) => ac.connectorId !== params.connectorId || ac.agentId !== params.agentId,
    )
    return { removed: this.agentConnectors.length < before }
  }
  async updateDraftConfig(params: {
    draftId: string
    config: Prisma.InputJsonValue
    authMode: ConnectorAuthMode
    sourceHash: string
    secretAliasSuggested: string | null
  }) {
    const d = this.drafts.get(params.draftId)!
    d.connector.config = params.config as Prisma.JsonValue
    d.connector.authMode = params.authMode
    d.connector.secretAlias = params.secretAliasSuggested
    d.connector.lifecycleState = 'draft'
    d.sourceHash = params.sourceHash
    d.validationResult = null
    d.reviewStatus = 'pending'
    d.reviewedById = null
    d.secondApproverId = null
    d.sandboxTestOk = null
    return d
  }
  async reopen(params: { draftId: string }) {
    const d = this.drafts.get(params.draftId)!
    d.validationResult = null
    d.reviewStatus = 'pending'
    d.reviewedById = null
    d.secondApproverId = null
    d.sandboxTestOk = null
    d.connector.lifecycleState = 'draft'
    return d.connector
  }
  async decommission(params: { draftId: string }) {
    const d = this.drafts.get(params.draftId)!
    const affectedAgentIds = [
      ...new Set(
        this.agentConnectors.filter((ac) => ac.connectorId === d.connectorId).map((ac) => ac.agentId),
      ),
    ]
    this.agentConnectors = this.agentConnectors.filter((ac) => ac.connectorId !== d.connectorId)
    d.connector.lifecycleState = 'archived'
    return { connectorId: d.connectorId, affectedAgentIds }
  }
  async decommissionByConnectorId(params: { connectorId: string }) {
    const draft = [...this.drafts.values()].find((d) => d.connectorId === params.connectorId)
    if (!draft) throw new Error('connector not found')
    return this.decommission({ draftId: draft.id })
  }
  async deleteDraft(params: { draftId: string; allowArchived?: boolean }) {
    const d = this.drafts.get(params.draftId)!
    const state = d.connector.lifecycleState
    const deletable =
      state === 'draft' ||
      state === 'validated' ||
      (params.allowArchived === true && state === 'archived')
    if (!deletable) throw new Error('only a never-activated draft can be hard-deleted')
    this.agentConnectors = this.agentConnectors.filter((ac) => ac.connectorId !== d.connectorId)
    this.drafts.delete(params.draftId)
  }
  async hardDeleteArchivedConnector(params: { connectorId: string }) {
    const draft = [...this.drafts.values()].find((d) => d.connectorId === params.connectorId)
    if (!draft || draft.connector.lifecycleState !== 'archived') {
      throw new Error('only an archived connector can be hard-deleted')
    }
    this.agentConnectors = this.agentConnectors.filter((ac) => ac.connectorId !== params.connectorId)
    this.drafts.delete(draft.id)
  }
  async listActiveCatalog(tenantId: string | null) {
    return [...this.drafts.values()]
      .filter((d) => d.tenantId === tenantId && d.connector.lifecycleState === 'active')
      .filter((d) =>
        isConnectorAssignableToAgent(
          d.connector.connectorMode,
          (d.connector as Connector & { activeCapabilitySet?: unknown }).activeCapabilitySet ?? null,
        ),
      )
      .map((d) => ({
        id: d.connectorId,
        type: d.connector.type,
        name: d.connector.name,
        connectorMode: d.connector.connectorMode,
      }))
  }
  async findConnectorById(connectorId: string) {
    const draft = [...this.drafts.values()].find((d) => d.connectorId === connectorId)
    if (!draft) return null
    return {
      id: draft.connectorId,
      tenantId: draft.tenantId,
      lifecycleState: draft.connector.lifecycleState,
      secretAlias: draft.connector.secretAlias,
      connectorMode: draft.connector.connectorMode,
      activeCapabilitySet:
        (draft.connector as Connector & { activeCapabilitySet?: unknown }).activeCapabilitySet ??
        null,
    }
  }
  async isAssignableToAgent(connectorId: string) {
    const draft = [...this.drafts.values()].find((d) => d.connectorId === connectorId)
    if (!draft || draft.connector.lifecycleState !== 'active') return false
    return isConnectorAssignableToAgent(
      draft.connector.connectorMode,
      (draft.connector as Connector & { activeCapabilitySet?: unknown }).activeCapabilitySet ??
        null,
    )
  }
}

const okTester: SandboxConnectionTester = {
  async test() {
    return { ok: true, statusCode: 200 }
  },
}
const failTester: SandboxConnectionTester = {
  async test() {
    return { ok: false, statusCode: 503, detail: 'sandbox unreachable' }
  },
}
const authFailTester: SandboxConnectionTester = {
  async test(input) {
    if (input.token) return { ok: false, statusCode: 401, detail: 'bad token' }
    return { ok: true, statusCode: 401, detail: 'reachable_auth_required' }
  },
}

const TENANT = 'tenant-a'
const adminActor: ProvisioningActor = {
  type: 'user',
  userId: 'user-admin',
  role: 'admin',
  tenantId: TENANT,
}
const superadminActor: ProvisioningActor = {
  ...adminActor,
  userId: 'user-superadmin',
  canManagePlatformConnectors: true,
}
const agentActor: ProvisioningActor = {
  type: 'agent',
  agentId: 'agent-prov',
  agentVersion: 3,
  tenantId: TENANT,
}

const ALLOWLIST = ['api.acme-crm.example']

function cleanConfig() {
  return {
    provider: 'acme-crm',
    baseUrl: 'https://api.acme-crm.example',
    egressHosts: ['api.acme-crm.example'],
    authMode: 'service',
    auth: { type: 'api_key_header', headerName: 'X-Api-Key', secretAliasSuggested: 'env:ACME_CRM_SERVICE_KEY' },
    scopesSuggested: ['contacts.read', 'deals.read'],
    rateLimit: { rps: 5, burst: 10 },
    proposedTools: [
      { name: 'acme_crm.search_contacts', method: 'GET', path: '/v1/contacts', access: 'read' },
      { name: 'acme_crm.get_deal', method: 'GET', path: '/v1/deals/{id}', access: 'read' },
    ],
  }
}

function makeService(opts?: {
  bankPreset?: boolean
  tester?: SandboxConnectionTester
  audit?: FakeAudit
  drafts?: FakeDraftRepo
  allowlist?: string[]
  agentCapabilities?: readonly string[]
  /** Négy-szem jóváhagyó-hitelesítés felülbírálása; alap: az azonos-tenant jóváhagyó admin. */
  verifyApprover?: (input: { approverId: string; tenantId: string | null }) => Promise<boolean>
  /** A külső secret-alias platform-oldali, tenant-scope-os engedélyezésének fake-je. */
  isTrustedExternalSecretAlias?: (alias: string, tenantId: string | null) => boolean
  resolvePlatformGoogleOAuth?: () => Promise<{ configured: boolean }>
}) {
  const audit = opts?.audit ?? new FakeAudit()
  const drafts = opts?.drafts ?? new FakeDraftRepo()
  const svc = new ProvisioningService({
    drafts,
    audit,
    resolveEgressAllowlist: async () => opts?.allowlist ?? ALLOWLIST,
    resolveBankPreset: async () => opts?.bankPreset ?? false,
    sandboxTester: opts?.tester ?? okTester,
    resolveAgentCapabilities: async () => opts?.agentCapabilities ?? [],
    // A dual-control jóváhagyót hitelesíteni KELL (négy-szem): alapból az aktor
    // tenantjának bármely (aktivátortól különböző) jóváhagyója érvényes adminnak számít.
    verifyDualControlApprover:
      opts?.verifyApprover ?? (async ({ tenantId }) => tenantId === TENANT),
    isTrustedExternalSecretAlias: opts?.isTrustedExternalSecretAlias ?? (() => true),
    resolvePlatformGoogleOAuth: opts?.resolvePlatformGoogleOAuth,
  })
  return { svc, audit, drafts }
}

/** Teljes happy-path az aktiválás előfeltételeinek beállításához. */
async function draftToActivatable(
  svc: ProvisioningService,
  actor: ProvisioningActor = adminActor,
  generatedConfig: Record<string, unknown> = cleanConfig(),
) {
  const created = await svc.createConnectorDraft(
    { name: 'Acme CRM', sourceType: 'api_doc', sourceContent: 'API docs...', generatedConfig },
    actor,
  )
  await svc.validateConnectorDraft({ draftId: created.draftId }, adminActor)
  await svc.testConnectorDraft({ draftId: created.draftId }, adminActor)
  await svc.reviewConnectorDraft({ draftId: created.draftId, decision: 'approve' }, adminActor)
  return created
}

// ---- Tesztek ----------------------------------------------------------------

async function run() {
  console.log('Provisioning Assistant — determinisztikus teszt\n')
  process.env.K = process.env.K ?? 'test-key'
  process.env.ACME_CRM_SERVICE_KEY = process.env.ACME_CRM_SERVICE_KEY ?? 'test-key'
  process.env.ACME_OAUTH_SECRET = process.env.ACME_OAUTH_SECRET ?? 'test-secret'
  process.env.GSC_CLIENT_SECRET = process.env.GSC_CLIENT_SECRET ?? 'test-gsc-secret'

  // P1: admin draft generál connector_drafts + source_hash
  await test('P1: createConnectorDraft → draft + source_hash, lifecycle draft', async () => {
    const { svc, audit, drafts } = makeService()
    const res = await svc.createConnectorDraft(
      { name: 'Acme CRM', sourceType: 'api_doc', sourceContent: 'docs', generatedConfig: cleanConfig() },
      adminActor,
    )
    assert.equal(res.lifecycleState, 'draft')
    const draft = drafts.drafts.get(res.draftId)!
    assert.ok(draft.sourceHash.startsWith('sha256:'))
    assert.equal(draft.connector.lifecycleState, 'draft')
    assert.equal(draft.connector.secretAlias, 'env:ACME_CRM_SERVICE_KEY')
    assert.equal(audit.byAction('provisioning.draft.create').length, 1)
  })

  // P2: validátor lefut, write-tool/scope kiemelés
  await test('P2: validateConnectorDraft → result, write/scope warnings', async () => {
    const { svc, drafts } = makeService()
    const created = await svc.createConnectorDraft(
      {
        name: 'Acme CRM',
        sourceType: 'api_doc',
        generatedConfig: {
          ...cleanConfig(),
          scopesSuggested: ['contacts.read', 'admin.all'],
          proposedTools: [
            { name: 'acme_crm.create_contact', method: 'POST', path: '/v1/contacts', access: 'read' },
          ],
        },
      },
      adminActor,
    )
    const { validationResult } = await svc.validateConnectorDraft({ draftId: created.draftId }, adminActor)
    // POST → write normalizálva
    assert.equal(validationResult.checks.writeToolsFlagged, 'warned')
    assert.equal(validationResult.status, 'warned')
    // a tárolt draft config-ja POST-ra write access-t kapott
    const cfg = normalizeConnectorConfig(drafts.drafts.get(created.draftId)!.connector.config)
    assert.equal(cfg.proposedTools[0].access, 'write')
  })

  // P3 / PN5: a draft (lifecycle != active) connectort a Tool Broker nem oldja fel.
  // (A runtime DENY a tool-broker-service authorizer-ében; itt a lifecycle-állapotot
  // igazoljuk, ami a DENY bemenete.)
  await test('P3/PN5: draft connector lifecycle != active (Tool Broker DENY input)', async () => {
    const { svc, drafts } = makeService()
    const created = await svc.createConnectorDraft(
      { name: 'Acme CRM', sourceType: 'api_doc', generatedConfig: cleanConfig() },
      adminActor,
    )
    assert.notEqual(drafts.drafts.get(created.draftId)!.connector.lifecycleState, 'active')
  })

  await test('user_delegated draft authMode átkerül a connector metaadatba', async () => {
    const { svc, drafts } = makeService()
    const created = await svc.createConnectorDraft(
      {
        name: 'Google Search Console',
        sourceType: 'manual',
        generatedConfig: {
          ...cleanConfig(),
          provider: 'google_search_console',
          authMode: 'user_delegated',
          auth: {
            type: 'oauth2',
            tokenUrl: 'https://oauth2.googleapis.com/token',
            clientId: 'google-client-id',
            scope: 'https://www.googleapis.com/auth/webmasters.readonly',
            secretAliasSuggested: 'google_search_console_oauth2',
          },
        },
      },
      adminActor,
    )
    assert.equal(drafts.drafts.get(created.draftId)!.connector.authMode, 'user_delegated')
  })

  // P4: a sandbox után az admin review jóváhagy/módosítást kér; auditált
  await test('P4: sandbox utáni review changes_requested + approve auditált', async () => {
    const { svc, audit } = makeService()
    const created = await svc.createConnectorDraft(
      { name: 'Acme CRM', sourceType: 'api_doc', generatedConfig: cleanConfig() },
      adminActor,
    )
    await svc.validateConnectorDraft({ draftId: created.draftId }, adminActor)
    await svc.testConnectorDraft({ draftId: created.draftId }, adminActor)
    const r1 = await svc.reviewConnectorDraft(
      { draftId: created.draftId, decision: 'changes_requested' },
      adminActor,
    )
    assert.equal(r1.reviewStatus, 'changes_requested')
    const r2 = await svc.reviewConnectorDraft({ draftId: created.draftId, decision: 'approve' }, adminActor)
    assert.equal(r2.reviewStatus, 'approved')
    assert.equal(audit.byAction('provisioning.draft.review').length, 2)
  })

  await test('P4-neg: review sandbox-teszt előtt → SANDBOX_TEST_FAILED', async () => {
    const { svc } = makeService()
    const created = await svc.createConnectorDraft(
      { name: 'Acme CRM', sourceType: 'api_doc', generatedConfig: cleanConfig() },
      adminActor,
    )
    await svc.validateConnectorDraft({ draftId: created.draftId }, adminActor)
    await expectError('SANDBOX_TEST_FAILED', () =>
      svc.reviewConnectorDraft({ draftId: created.draftId, decision: 'approve' }, adminActor),
    )
  })

  // P5: aktiválás csak approved + nem-failed + sikeres sandbox + secret-alias mellett
  await test('P5: activateConnector teljes előfeltétellel → active', async () => {
    const { svc, audit, drafts } = makeService()
    const created = await draftToActivatable(svc)
    const res = await svc.activateConnector(
      { draftId: created.draftId, secretAlias: 'env:ACME_CRM_SERVICE_KEY' },
      adminActor,
    )
    assert.equal(res.lifecycleState, 'active')
    assert.ok(drafts.drafts.get(created.draftId)?.connector.activeSpecVersionId)
    assert.equal(audit.byAction('provisioning.connector.activate').length, 1)
  })

  await test('P5-neg: nem allowlistelt egress-hosttal a jóváhagyott draft sem aktiválható', async () => {
    const { svc } = makeService({ allowlist: [] })
    const created = await draftToActivatable(svc)
    await expectError('DRAFT_VALIDATION_FAILED', () =>
      svc.activateConnector({ draftId: created.draftId, secretAlias: 'env:ACME_CRM_SERVICE_KEY' }, adminActor),
    )
  })

  await test('P5/APG-03: CRM privacy capability append-only spec-verzióba kerül', async () => {
    const { svc, drafts } = makeService()
    const created = await draftToActivatable(svc, adminActor, {
      ...cleanConfig(),
      provider: 'ostorosbor-crm-sales-delegated',
    })
    await svc.activateConnector(
      { draftId: created.draftId, secretAlias: 'env:ACME_CRM_SERVICE_KEY' },
      adminActor,
    )
    const stored = drafts.drafts.get(created.draftId)!
    const version = drafts.initialSpecVersions.get(stored.connectorId)
    assert.ok(version)
    const capabilitySet = version.capabilitySet as Record<string, unknown>
    const privacy = capabilitySet.privacy as Record<string, unknown>
    assert.equal(privacy.structured_field_privacy, true)
    assert.equal(privacy.stable_entity_ids, true)
  })

  await test('P5-security: tenant-admin nem használhat tetszőleges runtime secret aliast', async () => {
    const { svc } = makeService({ isTrustedExternalSecretAlias: () => false })
    const created = await draftToActivatable(svc)
    await expectError('SECRET_ALIAS_NOT_TRUSTED', () =>
      svc.activateConnector({ draftId: created.draftId, secretAlias: 'env:WRITE_GATE_SECRET' }, adminActor),
    )
    await expectError('SECRET_ALIAS_NOT_TRUSTED', () =>
      svc.testConnectorDraftWithCredentials(
        { draftId: created.draftId, secretAlias: 'env:WRITE_GATE_SECRET' },
        adminActor,
      ),
    )
  })

  await test('P5-security: nem engedélyezett draft aliasból a sandbox nem old fel titkot', async () => {
    let seenSecretAlias: string | null | undefined
    const tester: SandboxConnectionTester = {
      async test(input) {
        seenSecretAlias = input.secretAlias
        return { ok: true }
      },
    }
    const { svc } = makeService({ tester, isTrustedExternalSecretAlias: () => false })
    const created = await svc.createConnectorDraft(
      { name: 'Acme CRM', sourceType: 'api_doc', generatedConfig: cleanConfig() },
      adminActor,
    )
    await svc.testConnectorDraft({ draftId: created.draftId }, adminActor)
    assert.equal(seenSecretAlias, null)
  })

  await test('P5-neg: aktiválás approved review nélkül → DRAFT_NOT_APPROVED', async () => {
    const { svc } = makeService()
    const created = await svc.createConnectorDraft(
      { name: 'Acme CRM', sourceType: 'api_doc', generatedConfig: cleanConfig() },
      adminActor,
    )
    await svc.validateConnectorDraft({ draftId: created.draftId }, adminActor)
    await svc.testConnectorDraft({ draftId: created.draftId }, adminActor)
    await expectError('DRAFT_NOT_APPROVED', () =>
      svc.activateConnector({ draftId: created.draftId, secretAlias: 'x' }, adminActor),
    )
  })

  await test('P5-neg: aktiválás kulcs/alias nélkül → ACTIVATION_KEYLESS_UNCONFIRMED', async () => {
    const { svc } = makeService()
    const created = await draftToActivatable(svc)
    await expectError('ACTIVATION_KEYLESS_UNCONFIRMED', () =>
      svc.activateConnector({ draftId: created.draftId, secretAlias: '  ' }, adminActor),
    )
  })

  await test('P5-neg: kulcsos auth-teszt bukása → ACTIVATION_AUTH_TEST_FAILED', async () => {
    const { svc } = makeService({ tester: authFailTester })
    const created = await draftToActivatable(svc)
    await expectError('ACTIVATION_AUTH_TEST_FAILED', () =>
      svc.activateConnector({ draftId: created.draftId, apiKey: 'bad-key' }, adminActor),
    )
  })

  // oauth2 client_id: nem-titkos, a configba megy — a discovery nem tudja kitalálni,
  // ezért az admin adja meg aktiváláskor (config.auth.clientId).
  function oauth2ServiceConfig() {
    return {
      ...cleanConfig(),
      authMode: 'service',
      auth: { type: 'oauth2', tokenUrl: 'https://api.acme-crm.example/oauth/token', scope: 'contacts.read' },
    }
  }
  async function oauth2Activatable(svc: ProvisioningService) {
    const created = await svc.createConnectorDraft(
      { name: 'Acme OAuth', sourceType: 'api_doc', sourceContent: 'API docs...', generatedConfig: oauth2ServiceConfig() },
      adminActor,
    )
    await svc.validateConnectorDraft({ draftId: created.draftId }, adminActor)
    await svc.testConnectorDraft({ draftId: created.draftId }, adminActor)
    await svc.reviewConnectorDraft({ draftId: created.draftId, decision: 'approve' }, adminActor)
    return created
  }

  await test('oauth2 service: aktiválás clientId nélkül → OAUTH_CLIENT_ID_MISSING (fail-fast)', async () => {
    const { svc } = makeService()
    const created = await oauth2Activatable(svc)
    await expectError('OAUTH_CLIENT_ID_MISSING', () =>
      svc.activateConnector({ draftId: created.draftId, secretAlias: 'env:ACME_OAUTH_SECRET' }, adminActor),
    )
  })

  await test('oauth2 service: clientId megadva → active + config.auth.clientId perzisztálva', async () => {
    const { svc, drafts } = makeService()
    const created = await oauth2Activatable(svc)
    const res = await svc.activateConnector(
      { draftId: created.draftId, secretAlias: 'env:ACME_OAUTH_SECRET', clientId: '  acme-client-123  ' },
      adminActor,
    )
    assert.equal(res.lifecycleState, 'active')
    const stored = drafts.drafts.get(created.draftId)!.connector.config as {
      auth: { clientId?: string; type?: string }
    }
    assert.equal(stored.auth.clientId, 'acme-client-123')
    // a modellezetlen mezők (type, tokenUrl) nem vesznek el
    assert.equal(stored.auth.type, 'oauth2')
  })

  await test('non-oauth2 (api_key): clientId nélkül is aktiválható (nincs fail-fast)', async () => {
    const { svc } = makeService()
    const created = await draftToActivatable(svc)
    const res = await svc.activateConnector(
      { draftId: created.draftId, secretAlias: 'env:ACME_CRM_SERVICE_KEY' },
      adminActor,
    )
    assert.equal(res.lifecycleState, 'active')
  })

  // Gyökér-fix (a): a delegált oauth2 draftot aktiváláskor a runtime-alakra normalizáljuk
  // (auth.scheme=bearer + oauth blokk), különben a http-api-kliens SERVICE oauth2-ként
  // értelmezné és a per-user Bearer-injekció kimaradna → minden tool-hívás elhasalna.
  await test('oauth2 delegated: aktiváláskor runtime-alakra normalizálódik (auth.scheme=bearer + oauth blokk)', async () => {
    const oauthHosts = ['accounts.google.com', 'oauth2.googleapis.com', 'www.googleapis.com']
    const { svc, drafts } = makeService({ allowlist: [...ALLOWLIST, ...oauthHosts] })
    const created = await svc.createConnectorDraft(
      {
        name: 'Google Search Console',
        sourceType: 'api_doc',
        sourceContent: 'API docs...',
        generatedConfig: {
          ...cleanConfig(),
          provider: 'google_search_console',
          authMode: 'user_delegated',
          egressHosts: [...ALLOWLIST, ...oauthHosts],
          scopesSuggested: ['https://www.googleapis.com/auth/webmasters.readonly'],
          auth: {
            type: 'oauth2',
            authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
            tokenUrl: 'https://oauth2.googleapis.com/token',
            userInfoUrl: 'https://www.googleapis.com/oauth2/v2/userinfo',
            accountEmailField: 'email',
            offlineParams: { access_type: 'offline' },
            scopeTransform: 'gmailAlias',
            clientId: 'seed-client-id',
          },
        },
      },
      adminActor,
    )
    await svc.validateConnectorDraft({ draftId: created.draftId }, adminActor)
    await svc.testConnectorDraft({ draftId: created.draftId }, adminActor)
    await svc.reviewConnectorDraft({ draftId: created.draftId, decision: 'approve' }, adminActor)
    const res = await svc.activateConnector(
      { draftId: created.draftId, secretAlias: 'env:GSC_CLIENT_SECRET' },
      adminActor,
    )
    assert.equal(res.lifecycleState, 'active')
    const stored = drafts.drafts.get(created.draftId)!.connector.config as {
      auth: { scheme?: string; type?: string }
      oauth?: {
        authUrl?: string
        tokenUrl?: string
        userInfoUrl?: string
        accountEmailField?: string
        offlineParams?: Record<string, string>
        scopeTransform?: string
        clientId?: string
        scopes?: string[]
      }
    }
    // runtime-alak: auth.scheme=bearer (NEM oauth2 client_credentials)
    assert.equal(stored.auth.scheme, 'bearer')
    assert.equal(stored.auth.type, undefined)
    assert.equal(stored.oauth?.authUrl, 'https://accounts.google.com/o/oauth2/v2/auth')
    assert.equal(stored.oauth?.tokenUrl, 'https://oauth2.googleapis.com/token')
    assert.equal(stored.oauth?.userInfoUrl, 'https://www.googleapis.com/oauth2/v2/userinfo')
    assert.equal(stored.oauth?.accountEmailField, 'email')
    assert.deepEqual(stored.oauth?.offlineParams, { access_type: 'offline' })
    assert.equal(stored.oauth?.scopeTransform, 'gmailAlias')
    assert.equal(stored.oauth?.clientId, 'seed-client-id')
    assert.deepEqual(stored.oauth?.scopes, ['https://www.googleapis.com/auth/webmasters.readonly'])
  })

  // P6: banki preset → második, eltérő admin kell (dual-control)
  await test('P6: bank preset → dual-control kötelező + második admin', async () => {
    const { svc } = makeService({ bankPreset: true })
    const created = await draftToActivatable(svc)
    // approver nélkül → DUAL_CONTROL_REQUIRED
    await expectError('DUAL_CONTROL_REQUIRED', () =>
      svc.activateConnector({ draftId: created.draftId, secretAlias: 'env:K' }, adminActor),
    )
    // második, eltérő approverrel → siker
    const res = await svc.activateConnector(
      { draftId: created.draftId, secretAlias: 'env:K', approverId: 'user-admin-2' },
      adminActor,
    )
    assert.equal(res.lifecycleState, 'active')
  })

  // P6b: a második jóváhagyó HITELESÍTVE van — tetszőleges (nem admin / nem létező)
  // approverId NEM elég a négy-szemhez (a régi kódban elég volt).
  await test('P6b: bank preset → hitelesítetlen jóváhagyó → APPROVER_NOT_AUTHORIZED', async () => {
    const { svc } = makeService({
      bankPreset: true,
      // Csak a valós admin ('user-admin-2') fogadható el; más nem.
      verifyApprover: async ({ approverId }) => approverId === 'user-admin-2',
    })
    const created = await draftToActivatable(svc)
    await expectError('APPROVER_NOT_AUTHORIZED', () =>
      svc.activateConnector(
        { draftId: created.draftId, secretAlias: 'env:K', approverId: 'nem-letezo-user' },
        adminActor,
      ),
    )
  })

  // P7: connector → agent hozzárendelés külön emberi admin-aktus, auditált
  await test('P7: assignConnectorToAgent emberi admin + provisioning.connector.assign', async () => {
    const { svc, audit, drafts } = makeService()
    const created = await draftToActivatable(svc)
    await svc.activateConnector({ draftId: created.draftId, secretAlias: 'env:K' }, adminActor)
    const res = await svc.assignConnectorToAgent(
      { connectorId: created.connectorId, agentId: 'agent-x', accessMode: 'read' },
      adminActor,
    )
    assert.equal(res.connectorId, created.connectorId)
    assert.equal(drafts.agentConnectors.length, 1)
    assert.equal(audit.byAction('provisioning.connector.assign').length, 1)
  })

  await test('P7c: self_updating connector aktív snapshot nélkül nem rendelhető agenthez', async () => {
    const { svc, drafts } = makeService()
    const created = await draftToActivatable(svc)
    await svc.activateConnector({ draftId: created.draftId, secretAlias: 'env:K' }, adminActor)
    const draft = drafts.drafts.get(created.draftId)!
    draft.connector.connectorMode = 'self_updating'
    draft.connector.activeSpecVersionId = null
    ;(draft.connector as Connector & { activeCapabilitySet?: unknown }).activeCapabilitySet = null

    await expectError('CONNECTOR_NOT_ASSIGNABLE', () =>
      svc.assignConnectorToAgent(
        { connectorId: created.connectorId, agentId: 'agent-x', accessMode: 'read' },
        adminActor,
      ),
    )
    assert.equal(drafts.agentConnectors.length, 0)

    const catalog = await svc.listCatalog(adminActor)
    assert.equal(
      catalog.some((c) => c.id === created.connectorId),
      false,
      'catalog must hide non-assignable self_updating connectors',
    )
  })

  await test('P7d: self_updating connector érvényes aktív snapshottal hozzárendelhető', async () => {
    const { svc, drafts } = makeService()
    const created = await draftToActivatable(svc)
    await svc.activateConnector({ draftId: created.draftId, secretAlias: 'env:K' }, adminActor)
    const draft = drafts.drafts.get(created.draftId)!
    draft.connector.connectorMode = 'self_updating'
    ;(draft.connector as Connector & { activeCapabilitySet?: unknown }).activeCapabilitySet =
      cleanConfig()

    const res = await svc.assignConnectorToAgent(
      { connectorId: created.connectorId, agentId: 'agent-x', accessMode: 'read' },
      adminActor,
    )
    assert.equal(res.connectorId, created.connectorId)
    assert.equal(drafts.agentConnectors.length, 1)
  })

  await test('P7b: unassignConnectorFromAgent emberi admin + provisioning.connector.unassign', async () => {
    const { svc, audit, drafts } = makeService()
    const created = await draftToActivatable(svc)
    await svc.activateConnector({ draftId: created.draftId, secretAlias: 'env:K' }, adminActor)
    await svc.assignConnectorToAgent(
      { connectorId: created.connectorId, agentId: 'agent-x', accessMode: 'read' },
      adminActor,
    )
    const res = await svc.unassignConnectorFromAgent(
      { connectorId: created.connectorId, agentId: 'agent-x', reason: 'teszt' },
      adminActor,
    )
    assert.equal(res.removed, true)
    assert.equal(drafts.agentConnectors.length, 0)
    assert.equal(audit.byAction('provisioning.connector.unassign').length, 1)
  })

  // P8: a forrásdoksi tartalma és secret nem kerül auditba
  await test('P8: audit nem tartalmaz doksi-tartalmat / secretet', async () => {
    const { svc, audit } = makeService()
    const secretDoc = 'TOP_SECRET_DOC_BODY_should_never_be_logged'
    const created = await svc.createConnectorDraft(
      { name: 'Acme CRM', sourceType: 'api_doc', sourceContent: secretDoc, generatedConfig: cleanConfig() },
      adminActor,
    )
    await svc.validateConnectorDraft({ draftId: created.draftId }, adminActor)
    await svc.testConnectorDraft({ draftId: created.draftId }, adminActor)
    await svc.reviewConnectorDraft({ draftId: created.draftId, decision: 'approve' }, adminActor)
    await svc.activateConnector(
      { draftId: created.draftId, secretAlias: 'env:ACME_CRM_SERVICE_KEY' },
      adminActor,
    )
    const blob = JSON.stringify(audit.events, (_k, v) =>
      typeof v === 'bigint' ? v.toString() : v,
    )
    assert.ok(!blob.includes(secretDoc), 'audit must not contain source document body')
    // a hash igen, a tartalom nem
    assert.ok(blob.includes('sha256:'))
  })

  // PN1: mérgezett doksi exfil-endpointtal → validátor failed
  await test('PN1: mérgezett doksi (exfil host) → validation failed, nem aktiválható', async () => {
    const { svc } = makeService()
    const created = await svc.createConnectorDraft(
      {
        name: 'Evil CRM',
        sourceType: 'api_doc',
        generatedConfig: {
          ...cleanConfig(),
          egressHosts: ['api.acme-crm.example', 'webhook.site'],
        },
      },
      adminActor,
    )
    const { validationResult } = await svc.validateConnectorDraft({ draftId: created.draftId }, adminActor)
    assert.equal(validationResult.status, 'failed')
    assert.equal(validationResult.checks.forbiddenPatterns, 'failed')
    // A failed validáció a sandboxot és a review-t is megelőzi.
    await svc.testConnectorDraft({ draftId: created.draftId }, adminActor)
    await expectError('DRAFT_VALIDATION_FAILED', () =>
      svc.activateConnector({ draftId: created.draftId, secretAlias: 'env:K' }, adminActor),
    )
  })

  // PN2/PN3: az asszisztens (agent) megpróbál aktiválni/hozzárendelni → FORBIDDEN + access_denied
  await test('PN2: agent activateConnector → PROVISIONING_FORBIDDEN + access_denied', async () => {
    const { svc, audit } = makeService()
    const created = await draftToActivatable(svc)
    await expectError('PROVISIONING_FORBIDDEN', () =>
      svc.activateConnector({ draftId: created.draftId, secretAlias: 'env:K' }, agentActor),
    )
    assert.ok(audit.byAction('provisioning.access_denied').length >= 1)
  })

  await test('PN3: agent assignConnectorToAgent → PROVISIONING_FORBIDDEN', async () => {
    const { svc, audit, drafts } = makeService()
    await expectError('PROVISIONING_FORBIDDEN', () =>
      svc.assignConnectorToAgent(
        { connectorId: 'conn-x', agentId: 'agent-x', accessMode: 'write' },
        agentActor,
      ),
    )
    // jogosultság nem változott
    assert.equal(drafts.agentConnectors.length, 0)
    assert.ok(audit.byAction('provisioning.access_denied').length >= 1)
  })

  await test('PN3c: agent unassignConnectorFromAgent → PROVISIONING_FORBIDDEN', async () => {
    const { svc, audit, drafts } = makeService()
    await expectError('PROVISIONING_FORBIDDEN', () =>
      svc.unassignConnectorFromAgent(
        { connectorId: 'conn-x', agentId: 'agent-x', reason: 'nope' },
        agentActor,
      ),
    )
    assert.equal(drafts.agentConnectors.length, 0)
    assert.ok(audit.byAction('provisioning.access_denied').length >= 1)
  })

  await test('PN3b: nem-admin user (operator) sem aktiválhat → FORBIDDEN', async () => {
    const { svc } = makeService()
    const created = await draftToActivatable(svc)
    const operator: ProvisioningActor = {
      type: 'user',
      userId: 'op',
      role: 'operator',
      tenantId: TENANT,
    }
    await expectError('PROVISIONING_FORBIDDEN', () =>
      svc.activateConnector({ draftId: created.draftId, secretAlias: 'env:K' }, operator),
    )
  })

  // PN6: aktiválás bukott sandbox-teszt után → SANDBOX_TEST_FAILED
  await test('PN6: bukott sandbox-teszt → aktiválás blokk, connector draft marad', async () => {
    const { svc, drafts } = makeService({ tester: failTester })
    const created = await svc.createConnectorDraft(
      { name: 'Acme CRM', sourceType: 'api_doc', generatedConfig: cleanConfig() },
      adminActor,
    )
    await svc.validateConnectorDraft({ draftId: created.draftId }, adminActor)
    const t = await svc.testConnectorDraft({ draftId: created.draftId }, adminActor)
    assert.equal(t.ok, false)
    await expectError('SANDBOX_TEST_FAILED', () =>
      svc.activateConnector({ draftId: created.draftId, secretAlias: 'env:K' }, adminActor),
    )
    assert.equal(drafts.drafts.get(created.draftId)!.connector.lifecycleState, 'draft')
  })

  // PN7: dual-control presetben ugyanaz a user reviewer és approver → APPROVAL_SAME_ACTOR
  await test('PN7: dual-control — reviewer === approver → APPROVAL_SAME_ACTOR', async () => {
    const { svc } = makeService({ bankPreset: true })
    const created = await draftToActivatable(svc) // reviewer = user-admin
    await expectError('APPROVAL_SAME_ACTOR', () =>
      svc.activateConnector(
        { draftId: created.draftId, secretAlias: 'env:K', approverId: 'user-admin' },
        adminActor,
      ),
    )
  })

  // PN9: más tenant draftjának elérése → DRAFT_NOT_FOUND_OR_FORBIDDEN + access_denied
  await test('PN9: más tenant draftja → DRAFT_NOT_FOUND_OR_FORBIDDEN', async () => {
    const { svc, audit } = makeService()
    const created = await svc.createConnectorDraft(
      { name: 'Acme CRM', sourceType: 'api_doc', generatedConfig: cleanConfig() },
      adminActor,
    )
    const otherTenant: ProvisioningActor = {
      type: 'user',
      userId: 'user-b',
      role: 'admin',
      tenantId: 'tenant-b',
    }
    await expectError('DRAFT_NOT_FOUND_OR_FORBIDDEN', () =>
      svc.validateConnectorDraft({ draftId: created.draftId }, otherTenant),
    )
    assert.ok(audit.byAction('provisioning.access_denied').length >= 1)
  })

  // L2/L3 kritikusság → dual-control akkor is, ha nincs banki preset (§14/4)
  await test('L2 kritikusság → dual-control kötelező bank preset nélkül is', async () => {
    const { svc } = makeService({ bankPreset: false })
    const created = await draftToActivatable(svc)
    await expectError('DUAL_CONTROL_REQUIRED', () =>
      svc.activateConnector(
        { draftId: created.draftId, secretAlias: 'env:K', criticality: 'L2' },
        adminActor,
      ),
    )
  })

  await test('L1 kritikusság (nincs preset) → egy admin elég', async () => {
    const { svc } = makeService({ bankPreset: false })
    const created = await draftToActivatable(svc)
    const res = await svc.activateConnector(
      { draftId: created.draftId, secretAlias: 'env:K', criticality: 'L1' },
      adminActor,
    )
    assert.equal(res.lifecycleState, 'active')
  })

  // Validátor egységtesztek (LLM-en kívül)
  await test('Validátor: inline-secret a config-ban → failed (PN8 alap)', () => {
    const cfg = normalizeConnectorConfig({
      ...cleanConfig(),
      proposedTools: [
        {
          name: 'leaky',
          method: 'GET',
          path: '/v1/x',
          access: 'read',
          description: 'use Bearer abcdef0123456789abcdef token',
        },
      ],
    })
    const r = validateDraftConfig(cfg, { egressAllowlist: ALLOWLIST })
    assert.equal(r.checks.secretInline, 'failed')
    assert.equal(r.status, 'failed')
  })

  await test('Validátor: banki preset → ismeretlen host failed (allowlist-only)', () => {
    const cfg = normalizeConnectorConfig({ ...cleanConfig(), egressHosts: ['api.other.example'] })
    const warned = validateDraftConfig(cfg, { egressAllowlist: ALLOWLIST, bankPreset: false })
    assert.equal(warned.checks.egressAllowlist, 'warned')
    const failed = validateDraftConfig(cfg, { egressAllowlist: ALLOWLIST, bankPreset: true })
    assert.equal(failed.checks.egressAllowlist, 'failed')
    assert.equal(failed.status, 'failed')
  })

  await test('Validátor: metaadat-host (SSRF) → forbiddenPatterns failed', () => {
    const cfg = normalizeConnectorConfig({
      ...cleanConfig(),
      egressHosts: ['api.acme-crm.example', '169.254.169.254'],
    })
    const r = validateDraftConfig(cfg, { egressAllowlist: [...ALLOWLIST, '169.254.169.254'] })
    assert.equal(r.checks.forbiddenPatterns, 'failed')
  })

  // oauthCompleteness authMode-tudatos (draft-validator §6): a service és a delegált út
  // MÁS mezőket követel, ezért a validátor is másképp bírálja.
  await test('Validátor: service oauth2 tokenUrl nélkül → oauthCompleteness failed', () => {
    const cfg = normalizeConnectorConfig({
      ...cleanConfig(),
      authMode: 'service',
      auth: { type: 'oauth2', clientId: 'x', secretAliasSuggested: 'env:ACME_OAUTH' },
    })
    const r = validateDraftConfig(cfg, { egressAllowlist: ALLOWLIST })
    assert.equal(r.checks.oauthCompleteness, 'failed')
    assert.equal(r.status, 'failed')
    assert.ok(r.errors.includes('oauth2_missing_token_url'))
  })

  await test('Validátor: service oauth2 abszolút tokenUrl-lel → oauthCompleteness passed', () => {
    const cfg = normalizeConnectorConfig({
      ...cleanConfig(),
      authMode: 'service',
      auth: { type: 'oauth2', tokenUrl: 'https://api.acme-crm.example/oauth/token', clientId: 'x' },
    })
    const r = validateDraftConfig(cfg, { egressAllowlist: ALLOWLIST })
    assert.equal(r.checks.oauthCompleteness, 'passed')
  })

  await test('Validátor: user_delegated oauth2 Google-providernél is explicit endpoint kell', () => {
    const cfg = normalizeConnectorConfig({
      ...cleanConfig(),
      provider: 'google_search_console',
      authMode: 'user_delegated',
      auth: { type: 'oauth2', clientId: 'x', secretAliasSuggested: 'google_oauth2' },
    })
    const r = validateDraftConfig(cfg, { egressAllowlist: ALLOWLIST })
    assert.equal(r.checks.oauthCompleteness, 'failed')
    assert.equal(r.status, 'failed')
    assert.ok(r.errors.includes('oauth2_delegated_missing_endpoints'))
  })

  await test('Validátor: user_delegated oauth2 nem-Google providernél endpoint nélkül → failed', () => {
    const cfg = normalizeConnectorConfig({
      ...cleanConfig(),
      provider: 'acme-crm',
      authMode: 'user_delegated',
      auth: { type: 'oauth2', clientId: 'x', secretAliasSuggested: 'env:ACME_OAUTH' },
    })
    const r = validateDraftConfig(cfg, { egressAllowlist: ALLOWLIST })
    assert.equal(r.checks.oauthCompleteness, 'failed')
    assert.equal(r.status, 'failed')
    assert.ok(r.errors.includes('oauth2_delegated_missing_endpoints'))
  })

  await test('Validátor: user_delegated oauth2 nem-Google providernél authUrl+tokenUrl-lel → passed', () => {
    const cfg = normalizeConnectorConfig({
      ...cleanConfig(),
      provider: 'acme-crm',
      authMode: 'user_delegated',
      auth: {
        type: 'oauth2',
        authUrl: 'https://auth.acme-crm.example/authorize',
        tokenUrl: 'https://api.acme-crm.example/oauth/token',
        clientId: 'x',
      },
    })
    const r = validateDraftConfig(cfg, { egressAllowlist: ALLOWLIST })
    assert.equal(r.checks.oauthCompleteness, 'passed')
  })

  await test('Validátor: átfedő végpont-sablonok → endpoint_templates_overlap figyelmeztetés', () => {
    const cfg = normalizeConnectorConfig({
      ...cleanConfig(),
      proposedTools: [
        { name: 'get_object', method: 'GET', path: '/{id}', access: 'read' },
        { name: 'get_account', method: 'GET', path: '/act_{id}', access: 'read' },
      ],
    })
    const r = validateDraftConfig(cfg, { egressAllowlist: ['api.acme-crm.example'] })
    assert.ok(r.warnings.includes('endpoint_templates_overlap: GET /{id} ↔ GET /act_{id}'), r.warnings.join('; '))
  })

  // ── F2-P-D: HttpSandboxConnectionTester (valódi próbahívás, SSRF/egress-őr) ──

  type FetchCall = { url: string; init: RequestInit }
  function recordingFetch(response: Partial<Response> & { status: number }) {
    const calls: FetchCall[] = []
    const fn = async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return { type: 'basic', ...response } as Response
    }
    return { fn, calls }
  }

  await test('SBX: GET tool path-paraméterrel → placeholder ID a próba URL-ben', async () => {
    const { fn, calls } = recordingFetch({ status: 200 })
    const tester = new HttpSandboxConnectionTester({
      resolveEgressAllowlist: async () => ALLOWLIST,
      fetchImpl: fn,
    })
    const r = await tester.test({
      config: {
        ...cleanConfig(),
        proposedTools: [
          { name: 'get_bank', method: 'GET', path: '/banks/{bankId}', access: 'read' },
        ],
      } as unknown as ConnectorConfig,
      secretAlias: null,
      tenantId: TENANT,
    })
    assert.equal(r.ok, true)
    assert.ok(calls[0].url.includes('/banks/507f1f77bcf86cd799439011'))
  })

  await test('SBX: allowlistolt host, GET 200 → ok=reachable, csak GET hívódik', async () => {
    const { fn, calls } = recordingFetch({ status: 200 })
    const tester = new HttpSandboxConnectionTester({
      resolveEgressAllowlist: async () => ALLOWLIST,
      fetchImpl: fn,
    })
    const r = await tester.test({
      config: cleanConfig() as unknown as ConnectorConfig,
      secretAlias: null,
      tenantId: TENANT,
    })
    assert.equal(r.ok, true)
    assert.equal(r.statusCode, 200)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].init.method, 'GET')
    assert.equal(calls[0].init.redirect, 'manual')
    // az első path-paraméter NÉLKÜLI olvasó toolra megy (/v1/contacts), nem a {id}-sre
    assert.ok(calls[0].url.endsWith('/v1/contacts'))
  })

  await test('SBX: ismeretlen host → egress_not_allowlisted, NINCS hálózati hívás', async () => {
    const { fn, calls } = recordingFetch({ status: 200 })
    const tester = new HttpSandboxConnectionTester({
      resolveEgressAllowlist: async () => ['api.other.example'],
      fetchImpl: fn,
    })
    const r = await tester.test({
      config: cleanConfig() as unknown as ConnectorConfig,
      secretAlias: null,
      tenantId: TENANT,
    })
    assert.equal(r.ok, false)
    assert.equal(r.detail, 'egress_not_allowlisted')
    assert.equal(calls.length, 0)
  })

  await test('SBX: metaadat-host (SSRF) → blocked_by_validation, NINCS hívás', async () => {
    const { fn, calls } = recordingFetch({ status: 200 })
    const tester = new HttpSandboxConnectionTester({
      resolveEgressAllowlist: async () => [...ALLOWLIST, '169.254.169.254'],
      fetchImpl: fn,
    })
    const r = await tester.test({
      config: {
        ...cleanConfig(),
        baseUrl: 'https://169.254.169.254',
        egressHosts: ['169.254.169.254'],
        proposedTools: [],
      } as unknown as ConnectorConfig,
      secretAlias: null,
      tenantId: TENANT,
    })
    assert.equal(r.ok, false)
    // a determinisztikus validátor forbiddenPatterns-en már elbukik a hívás előtt
    assert.equal(r.detail, 'blocked_by_validation')
    assert.equal(calls.length, 0)
  })

  await test('SBX: 3xx redirect (manual) → redirect_blocked, nem siker', async () => {
    const { fn } = recordingFetch({ status: 302 })
    const tester = new HttpSandboxConnectionTester({
      resolveEgressAllowlist: async () => ALLOWLIST,
      fetchImpl: fn,
    })
    const r = await tester.test({
      config: cleanConfig() as unknown as ConnectorConfig,
      secretAlias: null,
      tenantId: TENANT,
    })
    assert.equal(r.ok, false)
    assert.equal(r.detail, 'redirect_blocked')
  })

  await test('SBX: non-2xx (503) → ok=false http_503', async () => {
    const { fn } = recordingFetch({ status: 503 })
    const tester = new HttpSandboxConnectionTester({
      resolveEgressAllowlist: async () => ALLOWLIST,
      fetchImpl: fn,
    })
    const r = await tester.test({
      config: cleanConfig() as unknown as ConnectorConfig,
      secretAlias: null,
      tenantId: TENANT,
    })
    assert.equal(r.ok, false)
    assert.equal(r.detail, 'http_503')
  })

  await test('SBX: non-prod token alias-ből → auth header injektálva, token NEM szivárog', async () => {
    const { fn, calls } = recordingFetch({ status: 200 })
    const SECRET = 'np-token-xyz-should-not-leak'
    const tester = new HttpSandboxConnectionTester({
      resolveEgressAllowlist: async () => ALLOWLIST,
      resolveSandboxToken: async ({ secretAlias }) =>
        secretAlias === 'env:ACME_CRM_SERVICE_KEY' ? SECRET : null,
      fetchImpl: fn,
    })
    const r = await tester.test({
      config: cleanConfig() as unknown as ConnectorConfig,
      secretAlias: 'env:ACME_CRM_SERVICE_KEY',
      tenantId: TENANT,
    })
    assert.equal(r.ok, true)
    const headers = calls[0].init.headers as Record<string, string>
    assert.equal(headers['X-Api-Key'], SECRET) // a fejlécben ott a token...
    assert.ok(!JSON.stringify(r).includes(SECRET)) // ...de a visszaadott eredményben SOHA
    assert.equal(r.detail, 'reachable')
  })

  await test('SBX: token NÉLKÜLI 400 → reachable_auth_required (Meta Graph /me stílus)', async () => {
    const { fn } = recordingFetch({ status: 400 })
    const tester = new HttpSandboxConnectionTester({
      resolveEgressAllowlist: async () => ALLOWLIST,
      fetchImpl: fn,
    })
    const r = await tester.test({
      config: cleanConfig() as unknown as ConnectorConfig,
      secretAlias: null,
      tenantId: TENANT,
    })
    assert.equal(r.ok, true)
    assert.equal(r.statusCode, 400)
    assert.equal(r.detail, 'reachable_auth_required')
  })

  await test('SBX: token NÉLKÜLI 401 → reachable_auth_required (elért, auth később)', async () => {
    const { fn } = recordingFetch({ status: 401 })
    const tester = new HttpSandboxConnectionTester({
      resolveEgressAllowlist: async () => ALLOWLIST,
      fetchImpl: fn,
    })
    const r = await tester.test({
      config: cleanConfig() as unknown as ConnectorConfig,
      secretAlias: null,
      tenantId: TENANT,
    })
    assert.equal(r.ok, true)
    assert.equal(r.detail, 'reachable_auth_required')
  })

  await test('SBX: VALÓDI tokennel 401 → ok=false, explicit auth-formátum üzenet (WP-1)', async () => {
    const { fn } = recordingFetch({ status: 401 })
    const tester = new HttpSandboxConnectionTester({
      resolveEgressAllowlist: async () => ALLOWLIST,
      resolveSandboxToken: async () => 'np-token-should-not-leak',
      fetchImpl: fn,
    })
    const r = await tester.test({
      // bearer séma → az üzenet a Bearer-csapdára figyelmeztet
      config: { ...cleanConfig(), auth: { type: 'bearer_token' } } as unknown as ConnectorConfig,
      secretAlias: 'env:ACME_CRM_SERVICE_KEY',
      tenantId: TENANT,
    })
    assert.equal(r.ok, false)
    assert.equal(r.statusCode, 401)
    assert.ok(/Bearer/.test(r.detail ?? ''), 'üzenet említse a Bearer előtagot')
    assert.ok(!JSON.stringify(r).includes('np-token-should-not-leak'))
  })

  await test('SBX: VALÓDI tokennel 403 → ok=true (kulcs elfogadva, scope korlátozott)', async () => {
    const { fn } = recordingFetch({ status: 403 })
    const tester = new HttpSandboxConnectionTester({
      resolveEgressAllowlist: async () => ALLOWLIST,
      fetchImpl: fn,
    })
    const r = await tester.test({
      config: { ...cleanConfig(), auth: { type: 'bearer_token' } } as unknown as ConnectorConfig,
      secretAlias: null,
      tenantId: TENANT,
      token: 'valid-token',
    })
    assert.equal(r.ok, true)
    assert.equal(r.statusCode, 403)
    assert.equal(r.detail, 'authenticated_scope_limited')
  })

  await test('SBX: VALÓDI tokennel 404 → acting user nem található üzenet', async () => {
    const { fn } = recordingFetch({ status: 404 })
    const tester = new HttpSandboxConnectionTester({
      resolveEgressAllowlist: async () => ALLOWLIST,
      fetchImpl: fn,
    })
    const r = await tester.test({
      config: {
        ...cleanConfig(),
        auth: { type: 'bearer_token' },
        defaultActingUserEmail: 'unknown@example.com',
      } as unknown as ConnectorConfig,
      secretAlias: null,
      tenantId: TENANT,
      token: 'valid-token',
    })
    assert.equal(r.ok, false)
    assert.equal(r.statusCode, 404)
    assert.ok(/acting user/i.test(r.detail ?? ''))
    assert.ok(/unknown@example.com/.test(r.detail ?? ''))
  })

  await test('SBX: fetch dob (hálózati hiba) → request_failed, sanitizált detail', async () => {
    const tester = new HttpSandboxConnectionTester({
      resolveEgressAllowlist: async () => ALLOWLIST,
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED api.acme-crm.example:443')
      },
    })
    const r = await tester.test({
      config: cleanConfig() as unknown as ConnectorConfig,
      secretAlias: null,
      tenantId: TENANT,
    })
    assert.equal(r.ok, false)
    assert.equal(r.detail, 'request_failed')
    assert.ok(!JSON.stringify(r).includes('api.acme-crm.example'))
  })

  await test('SBX: Google Drive sandbox zöld clientId nélkül (platform OAuth az aktiváláskor kell)', async () => {
    const audit = new FakeAudit()
    const drafts = new FakeDraftRepo()
    const svc = new ProvisioningService({
      drafts,
      audit,
      resolveEgressAllowlist: async () => ALLOWLIST,
      resolveBankPreset: async () => false,
    })
    const created = await svc.createConnectorDraft(
      {
        name: 'Google Drive',
        sourceType: 'template',
        connectorType: 'google_drive',
        generatedConfig: {
          provider: 'google-drive',
          oauth: {
            authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
            tokenUrl: 'https://oauth2.googleapis.com/token',
            userInfoUrl: 'https://www.googleapis.com/oauth2/v2/userinfo',
            scopes: ['https://www.googleapis.com/auth/drive.file'],
            scopeTransform: 'none',
          },
        },
      },
      adminActor,
    )
    const t = await svc.testConnectorDraft({ draftId: created.draftId }, adminActor)
    assert.equal(t.ok, true)
    assert.equal(t.detail, 'google_drive_oauth_metadata_check')
    assert.equal(drafts.drafts.get(created.draftId)!.sandboxTestOk, true)
  })

  await test('SBX: Gmail sandbox zöld clientId nélkül (platform OAuth az aktiváláskor kell)', async () => {
    const audit = new FakeAudit()
    const drafts = new FakeDraftRepo()
    const svc = new ProvisioningService({
      drafts,
      audit,
      resolveEgressAllowlist: async () => ALLOWLIST,
      resolveBankPreset: async () => false,
    })
    const created = await svc.createConnectorDraft(
      {
        name: 'Gmail',
        sourceType: 'template',
        connectorType: 'gmail',
        generatedConfig: {
          provider: 'google',
          oauth: {
            authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
            tokenUrl: 'https://oauth2.googleapis.com/token',
            userInfoUrl: 'https://www.googleapis.com/oauth2/v2/userinfo',
            scopes: ['https://www.googleapis.com/auth/gmail.modify'],
            scopeTransform: 'gmailAlias',
          },
        },
      },
      adminActor,
    )
    const t = await svc.testConnectorDraft({ draftId: created.draftId }, adminActor)
    assert.equal(t.ok, true)
    assert.equal(t.detail, 'gmail_oauth_metadata_check')
    assert.equal(drafts.drafts.get(created.draftId)!.sandboxTestOk, true)
  })

  async function gmailActivatable(svc: ProvisioningService) {
    const created = await svc.createConnectorDraft(
      {
        name: 'Gmail',
        sourceType: 'template',
        connectorType: 'gmail',
        generatedConfig: {
          provider: 'google',
          oauth: {
            authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
            tokenUrl: 'https://oauth2.googleapis.com/token',
            userInfoUrl: 'https://www.googleapis.com/oauth2/v2/userinfo',
            scopes: ['https://www.googleapis.com/auth/gmail.modify'],
            scopeTransform: 'gmailAlias',
          },
        },
      },
      adminActor,
    )
    await svc.validateConnectorDraft({ draftId: created.draftId }, adminActor)
    await svc.testConnectorDraft({ draftId: created.draftId }, adminActor)
    await svc.reviewConnectorDraft({ draftId: created.draftId, decision: 'approve' }, adminActor)
    return created
  }

  await test('Gmail: aktiválás platform OAuth nélkül → PLATFORM_GOOGLE_OAUTH_MISSING', async () => {
    const { svc } = makeService({
      resolvePlatformGoogleOAuth: async () => ({ configured: false }),
    })
    const created = await gmailActivatable(svc)
    await expectError('PLATFORM_GOOGLE_OAUTH_MISSING', () =>
      svc.activateConnector({ draftId: created.draftId }, adminActor),
    )
  })

  await test('Gmail: platform OAuth mellett clientId/secret nélkül aktiválható', async () => {
    const { svc } = makeService({
      resolvePlatformGoogleOAuth: async () => ({ configured: true }),
    })
    const created = await gmailActivatable(svc)
    const res = await svc.activateConnector({ draftId: created.draftId }, adminActor)
    assert.equal(res.lifecycleState, 'active')
  })

  await test('SBX: integráció — testConnectorDraft a valódi testerrel zöld utat ad', async () => {
    const { fn } = recordingFetch({ status: 200 })
    const audit = new FakeAudit()
    const drafts = new FakeDraftRepo()
    const svc = new ProvisioningService({
      drafts,
      audit,
      resolveEgressAllowlist: async () => ALLOWLIST,
      resolveBankPreset: async () => false,
      sandboxTester: new HttpSandboxConnectionTester({
        resolveEgressAllowlist: async () => ALLOWLIST,
        fetchImpl: fn,
      }),
    })
    const created = await svc.createConnectorDraft(
      { name: 'Acme CRM', sourceType: 'api_doc', generatedConfig: cleanConfig() },
      adminActor,
    )
    await svc.validateConnectorDraft({ draftId: created.draftId }, adminActor)
    const t = await svc.testConnectorDraft({ draftId: created.draftId }, adminActor)
    assert.equal(t.ok, true)
    assert.equal(drafts.drafts.get(created.draftId)!.sandboxTestOk, true)
  })

  // ── F2-P-F: provisioning-asszisztens agent (capability-gate + doksi→config) ──

  // Capability-gate: agent CSAK a megadott provisioning.draft.* capability-vel hozhat draftot.
  await test('F2-P-F: agent capability NÉLKÜL → createConnectorDraft FORBIDDEN + access_denied', async () => {
    const { svc, audit } = makeService({ agentCapabilities: [] })
    await expectError('PROVISIONING_FORBIDDEN', () =>
      svc.createConnectorDraft(
        { name: 'Acme CRM', sourceType: 'api_doc', generatedConfig: cleanConfig() },
        agentActor,
      ),
    )
    assert.ok(audit.byAction('provisioning.access_denied').length >= 1)
  })

  await test('F2-P-F: agent provisioning.draft.create capabilityvel → draftot KÉSZÍTHET', async () => {
    const { svc, drafts } = makeService({ agentCapabilities: ['provisioning.draft.create'] })
    const res = await svc.createConnectorDraft(
      { name: 'Acme CRM', sourceType: 'api_doc', generatedConfig: cleanConfig() },
      agentActor,
    )
    assert.equal(res.lifecycleState, 'draft')
    assert.equal(drafts.drafts.get(res.draftId)!.generatedByAgentId, 'agent-prov')
    // de validate-hez külön capability kell:
    await expectError('PROVISIONING_FORBIDDEN', () =>
      svc.validateConnectorDraft({ draftId: res.draftId }, agentActor),
    )
  })

  await test('F2-P-F: agent draftot KÉSZÍT, de aktiválni SOHA nem tud (kemény padló)', async () => {
    const { svc } = makeService({
      agentCapabilities: DRAFT_CAPABILITIES,
    })
    const created = await svc.createConnectorDraft(
      { name: 'Acme CRM', sourceType: 'api_doc', generatedConfig: cleanConfig() },
      agentActor,
    )
    await svc.validateConnectorDraft({ draftId: created.draftId }, agentActor)
    // még full draft-capability-vel is: review/test/activate emberi-only
    await expectError('PROVISIONING_FORBIDDEN', () =>
      svc.reviewConnectorDraft({ draftId: created.draftId, decision: 'approve' }, agentActor),
    )
    await expectError('PROVISIONING_FORBIDDEN', () =>
      svc.activateConnector({ draftId: created.draftId, secretAlias: 'env:K' }, agentActor),
    )
  })

  // PN4: a secret elérhetetlen a provisioning.* úton (§4.9.2, §6.1, §9). Az asszisztens
  // secretet nem olvas/ír; legfeljebb az alias NEVÉT javasolja, érték nélkül.
  await test('PN4: az agent draftja CSAK alias-nevet hordoz, nyers secretet SOHA', async () => {
    const { svc, audit, drafts } = makeService({
      agentCapabilities: DRAFT_CAPABILITIES,
    })
    const created = await svc.createConnectorDraft(
      { name: 'Acme CRM', sourceType: 'api_doc', generatedConfig: cleanConfig() },
      agentActor,
    )
    // A draft secretAlias mezője a JAVASOLT alias NEVE, mögötte nincs érték (a secretet
    // később admin injektálja külön aktusban). A config sosem tárol nyers tokent.
    const stored = drafts.drafts.get(created.draftId)!
    assert.equal(stored.connector.secretAlias, 'env:ACME_CRM_SERVICE_KEY')
    assert.ok('auth' in created.config)
    assert.equal(created.config.auth.secretAliasSuggested, 'env:ACME_CRM_SERVICE_KEY')
    // Az auditban sem alias-érték, sem secret nem szerepel — csak hash + referencia (P8).
    const blob = JSON.stringify(audit.events, (_k, v) =>
      typeof v === 'bigint' ? v.toString() : v,
    )
    assert.ok(!/secretValue|api[_-]?key=|bearer\s+[A-Za-z0-9]/i.test(blob))
  })

  // ── Javítás + megszüntetés (edit / reopen / decommission / delete) ─────────

  await test('EDIT: updateDraftConfig resetteli a gate-et (validation/review/sandbox)', async () => {
    const { svc, drafts } = makeService()
    const created = await draftToActivatable(svc)
    // draftToActivatable után: validált + approved + sandbox ok
    const before = drafts.drafts.get(created.draftId)!
    assert.equal(before.reviewStatus, 'approved')
    assert.equal(before.sandboxTestOk, true)

    const edited = cleanConfig()
    edited.scopesSuggested = ['contacts.read']
    const res = await svc.updateConnectorDraftConfig(
      { draftId: created.draftId, generatedConfig: edited },
      adminActor,
    )
    assert.equal(res.lifecycleState, 'draft')
    const after = drafts.drafts.get(created.draftId)!
    assert.equal(after.validationResult, null)
    assert.equal(after.reviewStatus, 'pending')
    assert.equal(after.sandboxTestOk, null)
    assert.equal(after.connector.lifecycleState, 'draft')
  })

  await test('EDIT: agent-aktor SOHA nem szerkeszthet draft-configot (kemény padló)', async () => {
    const { svc, audit } = makeService({ agentCapabilities: ['provisioning.draft.create'] })
    const created = await svc.createConnectorDraft(
      { name: 'Acme CRM', sourceType: 'api_doc', sourceContent: 'x', generatedConfig: cleanConfig() },
      agentActor,
    )
    await expectError('PROVISIONING_FORBIDDEN', () =>
      svc.updateConnectorDraftConfig({ draftId: created.draftId, generatedConfig: cleanConfig() }, agentActor),
    )
    assert.ok(audit.byAction('provisioning.access_denied').length > 0)
  })

  await test('EDIT: aktív connector configját NEM lehet közvetlenül szerkeszteni', async () => {
    const { svc } = makeService()
    const created = await draftToActivatable(svc)
    await svc.activateConnector(
      { draftId: created.draftId, secretAlias: 'env:ACME_CRM_SERVICE_KEY' },
      adminActor,
    )
    await expectError('DRAFT_NOT_EDITABLE', () =>
      svc.updateConnectorDraftConfig({ draftId: created.draftId, generatedConfig: cleanConfig() }, adminActor),
    )
  })

  await test('REOPEN: aktív → draft, gate reset + audit', async () => {
    const { svc, drafts, audit } = makeService()
    const created = await draftToActivatable(svc)
    await svc.activateConnector(
      { draftId: created.draftId, secretAlias: 'env:ACME_CRM_SERVICE_KEY' },
      adminActor,
    )
    const res = await svc.reopenConnector({ draftId: created.draftId }, adminActor)
    assert.equal(res.lifecycleState, 'draft')
    const after = drafts.drafts.get(created.draftId)!
    assert.equal(after.connector.lifecycleState, 'draft')
    assert.equal(after.reviewStatus, 'pending')
    assert.equal(after.sandboxTestOk, null)
    assert.equal(audit.byAction('provisioning.connector.reopen').length, 1)
  })

  await test('REOPEN: nem-aktív connectorra → CONNECTOR_NOT_ACTIVE', async () => {
    const { svc } = makeService()
    const created = await draftToActivatable(svc)
    await expectError('CONNECTOR_NOT_ACTIVE', () =>
      svc.reopenConnector({ draftId: created.draftId }, adminActor),
    )
  })

  await test('REOPEN: agent-aktor SOHA (kemény padló)', async () => {
    const { svc } = makeService()
    const created = await draftToActivatable(svc)
    await svc.activateConnector(
      { draftId: created.draftId, secretAlias: 'env:ACME_CRM_SERVICE_KEY' },
      adminActor,
    )
    await expectError('PROVISIONING_FORBIDDEN', () =>
      svc.reopenConnector({ draftId: created.draftId }, agentActor),
    )
  })

  await test('DECOMMISSION: agent-kötések levétele + archived + affectedAgentIds + audit', async () => {
    const { svc, drafts, audit } = makeService()
    const created = await draftToActivatable(svc)
    await svc.activateConnector(
      { draftId: created.draftId, secretAlias: 'env:ACME_CRM_SERVICE_KEY' },
      adminActor,
    )
    await svc.assignConnectorToAgent(
      { connectorId: created.connectorId, agentId: 'agent-x', accessMode: 'read' },
      adminActor,
    )
    const res = await svc.decommissionConnector(
      { draftId: created.draftId, reason: 'lecserélt szolgáltató' },
      adminActor,
    )
    assert.equal(res.lifecycleState, 'archived')
    assert.deepEqual(res.affectedAgentIds, ['agent-x'])
    assert.equal(drafts.drafts.get(created.draftId)!.connector.lifecycleState, 'archived')
    assert.equal(drafts.agentConnectors.filter((ac) => ac.connectorId === created.connectorId).length, 0)
    const ev = audit.byAction('provisioning.connector.decommission')
    assert.equal(ev.length, 1)
    // Az indok csak hash-ként kerül az auditba, secret SOHA.
    const decommMeta = ev[0].metadata as Record<string, unknown>
    assert.match(String(decommMeta.reasonHash), /^[a-f0-9]{64}$/)
    assert.equal('reason' in decommMeta, false)
    assert.doesNotMatch(JSON.stringify(decommMeta), /lecserélt szolgáltató/)
  })

  await test('DECOMMISSION: bank-preset → dual-control kötelező', async () => {
    const { svc } = makeService({ bankPreset: true })
    const created = await draftToActivatable(svc)
    await svc.activateConnector(
      { draftId: created.draftId, secretAlias: 'env:ACME_CRM_SERVICE_KEY', approverId: 'user-2', criticality: 'L1' },
      adminActor,
    )
    await expectError('DUAL_CONTROL_REQUIRED', () =>
      svc.decommissionConnector({ draftId: created.draftId }, adminActor),
    )
  })

  await test('DECOMMISSION: L2 + approver === aktor → APPROVAL_SAME_ACTOR', async () => {
    const { svc } = makeService()
    const created = await draftToActivatable(svc)
    await svc.activateConnector(
      { draftId: created.draftId, secretAlias: 'env:ACME_CRM_SERVICE_KEY', approverId: 'user-2', criticality: 'L2' },
      adminActor,
    )
    await expectError('APPROVAL_SAME_ACTOR', () =>
      svc.decommissionConnector(
        { draftId: created.draftId, criticality: 'L2', approverId: 'user-admin' },
        adminActor,
      ),
    )
  })

  await test('DECOMMISSION: agent-aktor SOHA (kemény padló)', async () => {
    const { svc } = makeService()
    const created = await draftToActivatable(svc)
    await svc.activateConnector(
      { draftId: created.draftId, secretAlias: 'env:ACME_CRM_SERVICE_KEY' },
      adminActor,
    )
    await expectError('PROVISIONING_FORBIDDEN', () =>
      svc.decommissionConnector({ draftId: created.draftId }, agentActor),
    )
  })

  await test('DELETE: sosem aktivált draft hard-delete + audit', async () => {
    const { svc, drafts, audit } = makeService()
    const created = await svc.createConnectorDraft(
      { name: 'Acme CRM', sourceType: 'api_doc', sourceContent: 'x', generatedConfig: cleanConfig() },
      adminActor,
    )
    await svc.deleteConnectorDraft({ draftId: created.draftId, reason: 'elrontott draft' }, adminActor)
    assert.equal(drafts.drafts.get(created.draftId), undefined)
    assert.equal(audit.byAction('provisioning.draft.delete').length, 1)
  })

  await test('DELETE: aktivált connectort NEM lehet hard-delete-elni → DRAFT_ALREADY_ACTIVATED', async () => {
    const { svc } = makeService()
    const created = await draftToActivatable(svc)
    await svc.activateConnector(
      { draftId: created.draftId, secretAlias: 'env:ACME_CRM_SERVICE_KEY' },
      adminActor,
    )
    await expectError('DRAFT_ALREADY_ACTIVATED', () =>
      svc.deleteConnectorDraft({ draftId: created.draftId }, adminActor),
    )
  })

  await test('DELETE: archivált draft — sima admin tiltva, superadmin törölheti', async () => {
    const { svc, drafts } = makeService()
    const created = await draftToActivatable(svc)
    await svc.activateConnector(
      { draftId: created.draftId, secretAlias: 'env:ACME_CRM_SERVICE_KEY' },
      adminActor,
    )
    await svc.decommissionConnector({ draftId: created.draftId, reason: 'teszt' }, adminActor)
    await expectError('DRAFT_ALREADY_ACTIVATED', () =>
      svc.deleteConnectorDraft({ draftId: created.draftId }, adminActor),
    )
    await svc.deleteConnectorDraft({ draftId: created.draftId }, superadminActor)
    assert.equal(drafts.drafts.get(created.draftId), undefined)
  })

  await test('DELETE: agent-aktor SOHA (kemény padló)', async () => {
    const { svc } = makeService()
    const created = await draftToActivatable(svc)
    await expectError('PROVISIONING_FORBIDDEN', () =>
      svc.deleteConnectorDraft({ draftId: created.draftId }, agentActor),
    )
  })

  console.log('')
  if (failures > 0) {
    console.error(`❌ ${failures} teszt bukott`)
    process.exit(1)
  }
  console.log('✅ Minden Provisioning Assistant teszt zöld')
}

run()
