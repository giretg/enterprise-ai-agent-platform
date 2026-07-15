import assert from 'node:assert/strict'
import type { ConnectorConfig } from '../src/domain/provisioning/connector-config'
import {
  SelfUpdateError,
  SelfUpdatingConnectorService,
  type SelfUpdateAudit,
  type SelfUpdatingConnectorRepository,
  type SelfUpdatingContext,
  type SelfUpdatingSpecVersion,
} from '../src/domain/connector-self-update/self-update-service'
import type { SpecSyncResult } from '../src/domain/connector-self-update/spec-sync'

const TENANT = '00000000-0000-0000-0000-000000000001'
const OTHER_TENANT = '00000000-0000-0000-0000-000000000002'
const SETTER = '00000000-0000-0000-0000-000000000011'
const APPROVER = '00000000-0000-0000-0000-000000000012'

function capabilitySet(paths: Array<{ method: 'GET' | 'POST'; path: string }>): ConnectorConfig {
  return {
    provider: 'partner',
    baseUrl: 'https://partner.example/api',
    egressHosts: ['partner.example'],
    authMode: 'service',
    auth: { type: 'api_key_header', headerName: 'X-Api-Key' },
    scopesSuggested: [],
    restrictToEndpoints: true,
    proposedTools: paths.map((p) => ({
      name: `${p.method}_${p.path}`,
      method: p.method,
      path: p.path,
      access: p.method === 'GET' ? 'read' : 'write',
    })),
  }
}

class MemoryRepo implements SelfUpdatingConnectorRepository {
  context: SelfUpdatingContext | null = null
  versions: SelfUpdatingSpecVersion[] = []

  async create(input: { tenantId: string; name: string; specUrl: string; secretAlias: string; createdById: string }) {
    const id = '00000000-0000-0000-0000-000000000100'
    this.context = {
      connector: { id, tenantId: input.tenantId, name: input.name, activeSpecVersionId: null },
      source: {
        id: '00000000-0000-0000-0000-000000000101', connectorId: id, tenantId: input.tenantId,
        specUrl: input.specUrl, createdById: input.createdById, urlApprovedById: null,
        urlApprovedAt: null, trustedById: null, trustedAt: null, autoApprovePolicy: null,
        lastSyncedAt: null,
      },
      activeVersion: null,
      tenantAutoApproveEnabled: false,
    }
    return this.context
  }
  async deleteUninitialized() {}
  async findContext(connectorId: string, tenantId: string) {
    if (!this.context || this.context.connector.id !== connectorId || this.context.connector.tenantId !== tenantId) return null
    this.context.activeVersion = this.versions.find((v) => v.id === this.context!.connector.activeSpecVersionId) ?? null
    return this.context
  }
  async approveUrl(input: Parameters<SelfUpdatingConnectorRepository['approveUrl']>[0]) {
    this.context!.source.urlApprovedById = input.actorId; this.context!.source.urlApprovedAt = input.at
  }
  async markTrusted(input: Parameters<SelfUpdatingConnectorRepository['markTrusted']>[0]) {
    this.context!.source.trustedById = input.actorId; this.context!.source.trustedAt = input.at
  }
  async updatePolicy(input: Parameters<SelfUpdatingConnectorRepository['updatePolicy']>[0]) {
    this.context!.source.autoApprovePolicy = input.policy
  }
  async listUsage() { return {} }
  async findOpenProposalByHash(_connectorId: string, tenantId: string, rawHash: string) {
    return this.versions.find((version) => version.tenantId === tenantId && version.rawHash === rawHash && version.status === 'proposed') ?? null
  }
  async createProposal(input: Parameters<SelfUpdatingConnectorRepository['createProposal']>[0]) {
    const version: SelfUpdatingSpecVersion = {
      id: `00000000-0000-0000-0000-${String(this.versions.length + 200).padStart(12, '0')}`,
      connectorId: input.connectorId, tenantId: input.tenantId, versionNo: this.versions.length + 1,
      rawHash: input.rawHash, capabilitySet: input.capabilitySet, status: 'proposed',
      diffFromVersionId: input.diffFromVersionId, diffSummary: input.diffSummary,
      fetchedAt: input.fetchedAt, approvedById: null, approvedAt: null,
    }
    this.versions.push(version)
    return version
  }
  async activateVersion(input: Parameters<SelfUpdatingConnectorRepository['activateVersion']>[0]) {
    const next = this.versions.find((v) => v.id === input.versionId && v.connectorId === input.connectorId && v.tenantId === input.tenantId)
    if (!next || next.status !== 'proposed') throw new SelfUpdateError('INVALID_STATE', 'proposal required')
    if (next.diffFromVersionId !== this.context!.connector.activeSpecVersionId) throw new SelfUpdateError('INVALID_STATE', 'stale proposal')
    const active = this.versions.find((v) => v.id === this.context!.connector.activeSpecVersionId)
    if (active) active.status = 'superseded'
    next.status = 'approved'; next.approvedById = input.approvedById; next.approvedAt = input.approvedAt
    this.context!.connector.activeSpecVersionId = next.id
    return next
  }
  async rejectVersion(input: Parameters<SelfUpdatingConnectorRepository['rejectVersion']>[0]) {
    const version = this.versions.find((v) => v.id === input.versionId && v.tenantId === input.tenantId)
    if (!version || version.status !== 'proposed') throw new SelfUpdateError('INVALID_STATE', 'proposal required')
    version.status = 'rejected'; return version
  }
  async rollback(input: Parameters<SelfUpdatingConnectorRepository['rollback']>[0]) {
    const target = this.versions.find((v) => v.id === input.targetVersionId && v.tenantId === input.tenantId)
    if (!target || !['approved', 'superseded', 'rolled_back'].includes(target.status)) throw new SelfUpdateError('INVALID_STATE', 'approved history required')
    const active = this.versions.find((v) => v.id === this.context!.connector.activeSpecVersionId)
    if (active) active.status = 'rolled_back'
    for (const version of this.versions) if (version.status === 'proposed') version.status = 'rejected'
    target.status = 'approved'; target.approvedById = input.actorId; target.approvedAt = input.at
    this.context!.connector.activeSpecVersionId = target.id
    return target
  }
  async listVersions(_connectorId: string, tenantId: string) { return this.versions.filter((v) => v.tenantId === tenantId) }
  async touchSynced(_sourceId: string, at: Date) { this.context!.source.lastSyncedAt = at }
}

class AuditSpy implements SelfUpdateAudit {
  events: Array<{ action: string; actorId: string | null; tenantId: string; connectorId: string; policyDecision: string }> = []
  async append(input: { action: string; actorId: string | null; tenantId: string; connectorId: string; policyDecision: string }) {
    this.events.push(input)
  }
}

class SyncStub {
  result: SpecSyncResult = { ok: true, rawText: '{"v":1}', rawHash: 'hash-1', capabilitySet: capabilitySet([{ method: 'GET', path: '/customers' }]), host: 'partner.example' }
  async sync() { return this.result }
}

async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log(`✓ ${name}`) } catch (error) { console.error(`✗ ${name}`); throw error }
}

async function expectCode(code: SelfUpdateError['code'], fn: () => Promise<unknown>) {
  await assert.rejects(fn, (error: unknown) => error instanceof SelfUpdateError && error.code === code)
}

async function ready() {
  const repo = new MemoryRepo(); const sync = new SyncStub(); const audit = new AuditSpy()
  const service = new SelfUpdatingConnectorService(repo, sync, audit, () => new Date('2026-07-15T12:00:00Z'))
  const ctx = await service.create({ name: 'Partner CRM', specUrl: 'https://partner.example/openapi.json', secretAlias: 'secret-ref:x' }, { id: SETTER, tenantId: TENANT })
  return { repo, sync, audit, service, connectorId: ctx.connector.id }
}

async function run() {
  await test('SoD: a link beállítója nem hagyhatja jóvá a linket vagy a bizalmi minősítést', async () => {
    const { service, connectorId } = await ready()
    await expectCode('SEPARATION_OF_DUTIES', () => service.approveUrl(connectorId, { id: SETTER, tenantId: TENANT }))
    await expectCode('SEPARATION_OF_DUTIES', () => service.markTrusted(connectorId, { id: SETTER, tenantId: TENANT }))
  })

  await test('fail-closed: jóváhagyatlan linknél nem indul szinkron', async () => {
    const { service, connectorId } = await ready()
    await expectCode('URL_NOT_APPROVED', () => service.sync(connectorId, { id: APPROVER, tenantId: TENANT }))
  })

  await test('első verzió proposed marad és csak másik kolléga rögzítheti', async () => {
    const { service, repo, connectorId } = await ready()
    await service.approveUrl(connectorId, { id: APPROVER, tenantId: TENANT })
    await service.markTrusted(connectorId, { id: APPROVER, tenantId: TENANT })
    const proposal = await service.sync(connectorId, { id: SETTER, tenantId: TENANT })
    assert.equal(proposal.kind, 'proposed'); assert.equal(repo.context!.connector.activeSpecVersionId, null)
    const versionId = repo.versions[0].id
    await expectCode('SEPARATION_OF_DUTIES', () => service.approveVersion(connectorId, versionId, { id: SETTER, tenantId: TENANT }))
    await service.approveVersion(connectorId, versionId, { id: APPROVER, tenantId: TENANT })
    assert.equal(repo.context!.connector.activeSpecVersionId, versionId)
  })

  await test('rollback az előző approved snapshotot aktiválja és a jelenlegit rolled_back-ként megőrzi', async () => {
    const { service, repo, sync, connectorId } = await ready()
    await service.approveUrl(connectorId, { id: APPROVER, tenantId: TENANT }); await service.markTrusted(connectorId, { id: APPROVER, tenantId: TENANT })
    await service.sync(connectorId, { id: SETTER, tenantId: TENANT }); const v1 = repo.versions[0]
    await service.approveVersion(connectorId, v1.id, { id: APPROVER, tenantId: TENANT })
    sync.result = { ok: true, rawText: '{"v":2}', rawHash: 'hash-2', capabilitySet: capabilitySet([{ method: 'GET', path: '/customers' }, { method: 'GET', path: '/reports' }]), host: 'partner.example' }
    await service.sync(connectorId, { id: SETTER, tenantId: TENANT }); const v2 = repo.versions[1]
    await service.approveVersion(connectorId, v2.id, { id: APPROVER, tenantId: TENANT })
    await service.rollback(connectorId, v1.id, { id: APPROVER, tenantId: TENANT })
    assert.equal(repo.context!.connector.activeSpecVersionId, v1.id); assert.equal(v2.status, 'rolled_back'); assert.equal(v1.status, 'approved')
  })

  await test('auto-approve csak tenant opt-in + forrás-policy + tisztán read-only addíció esetén működik', async () => {
    const { service, repo, sync, connectorId } = await ready()
    await service.approveUrl(connectorId, { id: APPROVER, tenantId: TENANT }); await service.markTrusted(connectorId, { id: APPROVER, tenantId: TENANT })
    await service.sync(connectorId, { id: SETTER, tenantId: TENANT }); await service.approveVersion(connectorId, repo.versions[0].id, { id: APPROVER, tenantId: TENANT })
    repo.context!.tenantAutoApproveEnabled = true; await service.updatePolicy(connectorId, { enabled: true, allowAddedWrite: true }, { id: APPROVER, tenantId: TENANT })
    sync.result = { ok: true, rawText: '{"v":2}', rawHash: 'hash-2', capabilitySet: capabilitySet([{ method: 'GET', path: '/customers' }, { method: 'GET', path: '/reports' }]), host: 'partner.example' }
    const result = await service.sync(connectorId, { id: SETTER, tenantId: TENANT })
    assert.equal(result.kind, 'proposed'); if (result.kind === 'proposed') assert.equal(result.autoApproved, true)
    assert.equal(repo.context!.source.autoApprovePolicy?.allowAddedWrite, false)
  })

  await test('cross-tenant hozzáférés minden publikus műveleten fail-closed', async () => {
    const { service, connectorId } = await ready()
    await expectCode('NOT_FOUND', () => service.detail(connectorId, { id: APPROVER, tenantId: OTHER_TENANT }))
  })

  await test('hibás szinkron megtartja az aktív verziót és auditálja a kudarcot', async () => {
    const { service, repo, sync, audit, connectorId } = await ready()
    await service.approveUrl(connectorId, { id: APPROVER, tenantId: TENANT }); await service.markTrusted(connectorId, { id: APPROVER, tenantId: TENANT })
    await service.sync(connectorId, { id: SETTER, tenantId: TENANT }); await service.approveVersion(connectorId, repo.versions[0].id, { id: APPROVER, tenantId: TENANT })
    const active = repo.context!.connector.activeSpecVersionId
    sync.result = { ok: false, reason: 'parse_error' }
    const result = await service.sync(connectorId, { id: SETTER, tenantId: TENANT })
    assert.equal(result.kind, 'failed'); assert.equal(repo.context!.connector.activeSpecVersionId, active)
    assert.ok(audit.events.some((event) => event.action === 'connector.self_update.sync.failed'))
  })

  await test('rollback érvényteleníti a régi alapverzióhoz készült proposalokat', async () => {
    const { service, repo, sync, connectorId } = await ready()
    await service.approveUrl(connectorId, { id: APPROVER, tenantId: TENANT }); await service.markTrusted(connectorId, { id: APPROVER, tenantId: TENANT })
    await service.sync(connectorId, { id: SETTER, tenantId: TENANT }); const v1 = repo.versions[0]
    await service.approveVersion(connectorId, v1.id, { id: APPROVER, tenantId: TENANT })
    sync.result = { ok: true, rawText: '{"v":2}', rawHash: 'hash-2', capabilitySet: capabilitySet([{ method: 'GET', path: '/customers' }, { method: 'GET', path: '/reports' }]), host: 'partner.example' }
    await service.sync(connectorId, { id: SETTER, tenantId: TENANT }); const stale = repo.versions[1]
    const v0: SelfUpdatingSpecVersion = { ...v1, id: '00000000-0000-0000-0000-000000000099', versionNo: 0, status: 'superseded' }
    repo.versions.unshift(v0)
    await service.rollback(connectorId, v0.id, { id: APPROVER, tenantId: TENANT })
    assert.equal(stale.status, 'rejected')
    await expectCode('INVALID_STATE', () => service.approveVersion(connectorId, stale.id, { id: APPROVER, tenantId: TENANT }))
  })

  console.log('\n✅ Önfrissítő connector életciklus-tesztek zöldek')
}

run().catch((error) => { console.error(error); process.exit(1) })
