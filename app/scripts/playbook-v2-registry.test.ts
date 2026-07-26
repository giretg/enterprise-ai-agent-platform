/**
 * Determinisztikus teszt a Fázis 2 Playbook Registry F2-A magjához
 * (Feature-spec — Playbook §8.1, §11.2, §12 F2-A, §13). Futtatás: npm run test:playbook-v2-registry
 *
 * DB és élő hálózat NÉLKÜL igazolja a create/version/validate/submit/publish/assign
 * folyamatot in-memory fake repókkal: content-hash, verzió-immutabilitás (P3),
 * hibás spec nem publikálható (P2), four-eyes (§11.2), tenant-izoláció (P10),
 * single-default assignment, és hogy a teljes spec SOHA nem kerül auditba (§10.2/§15).
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type {
  AuditLog,
  PlaybookV2,
  PlaybookVersionV2,
  PlaybookAssignment,
} from '@prisma/client'
import type {
  AuditRepository,
  CreatePlaybookAssignmentInput,
  CreatePlaybookV2Input,
  CreatePlaybookVersionV2Input,
  PlaybookV2Repository,
  PlaybookV2WithVersions,
} from '../src/repositories/interfaces'
import { PlaybookV2Service, PlaybookV2Error } from '../src/domain/playbook/playbook-v2-service'
import { computePlaybookContentHash } from '../src/lib/playbook-v2/spec'

let failures = 0
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    console.log(`  ✅ ${name}`)
  } catch (e) {
    failures++
    console.log(`  ❌ ${name}: ${e instanceof Error ? e.message : String(e)}`)
  }
}

// --- In-memory fakes --------------------------------------------------------

class FakeAuditRepository implements AuditRepository {
  entries: AuditLog[] = []
  async append(data: Omit<AuditLog, 'id' | 'seq' | 'createdAt' | 'hash' | 'prevHash'>) {
    const row = {
      ...data,
      id: randomUUID(),
      seq: BigInt(this.entries.length + 1),
      createdAt: new Date(),
      hash: null,
      prevHash: null,
    } as AuditLog
    this.entries.push(row)
    return row
  }
  async findMany(filter?: { action?: string; targetType?: string; targetId?: string; limit?: number }) {
    let rows = this.entries
    if (filter?.action) rows = rows.filter((e) => e.action === filter.action)
    if (filter?.targetType) rows = rows.filter((e) => e.targetType === filter.targetType)
    if (filter?.targetId) rows = rows.filter((e) => e.targetId === filter.targetId)
    return filter?.limit ? rows.slice(0, filter.limit) : rows
  }
  async findAll() {
    return this.entries
  }
  async getActionCounts(filter?: { actions?: string[]; since?: Date }) {
    const counts: Record<string, number> = {}
    for (const e of this.entries) {
      if (filter?.actions && !filter.actions.includes(e.action)) continue
      if (filter?.since && e.createdAt < filter.since) continue
      counts[e.action] = (counts[e.action] ?? 0) + 1
    }
    return counts
  }
  byAction(action: string) {
    return this.entries.filter((e) => e.action === action)
  }
}

class FakePlaybookV2Repository implements PlaybookV2Repository {
  playbooks: PlaybookV2[] = []
  versions: PlaybookVersionV2[] = []
  assignments: PlaybookAssignment[] = []

  async createPlaybook(input: CreatePlaybookV2Input): Promise<PlaybookV2> {
    const pb = {
      id: randomUUID(),
      tenantId: input.tenantId,
      key: input.key,
      name: input.name,
      description: input.description ?? null,
      processType: input.processType,
      status: 'draft',
      currentPublishedVersionId: null,
      ownerUserId: input.ownerUserId ?? null,
      createdAt: new Date(),
      updatedAt: new Date(),
      archivedAt: null,
    } as PlaybookV2
    this.playbooks.push(pb)
    return pb
  }
  async findPlaybook(tenantId: string | null, id: string) {
    return this.playbooks.find((p) => p.id === id && p.tenantId === tenantId) ?? null
  }
  async findPlaybookByKey(tenantId: string | null, key: string) {
    return this.playbooks.find((p) => p.key === key && p.tenantId === tenantId) ?? null
  }
  async listPlaybooks(tenantId: string | null): Promise<PlaybookV2WithVersions[]> {
    return this.playbooks
      .filter((p) => p.tenantId === tenantId)
      .map((p) => {
        const versions = this.versions.filter((v) => v.playbookId === p.id)
        return { ...p, versions, versionCount: versions.length }
      })
  }
  async listDefaultAssignments(tenantId: string | null, assignmentType: string) {
    return this.assignments
      .filter(
        (a) =>
          a.tenantId === tenantId &&
          a.assignmentType === assignmentType &&
          a.isDefault &&
          a.revokedAt === null,
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
  }
  async findVersionsByIds(tenantId: string | null, ids: string[]) {
    const idSet = new Set(ids)
    return this.versions.filter((v) => v.tenantId === tenantId && idSet.has(v.id))
  }
  async findPlaybooksByIds(tenantId: string | null, ids: string[]) {
    const idSet = new Set(ids)
    return this.playbooks.filter((p) => p.tenantId === tenantId && idSet.has(p.id))
  }
  async updatePlaybook(id: string, data: Record<string, unknown>) {
    const pb = this.playbooks.find((p) => p.id === id)!
    Object.assign(pb, data)
    return pb
  }
  async createVersion(input: CreatePlaybookVersionV2Input): Promise<PlaybookVersionV2> {
    const v = {
      id: randomUUID(),
      tenantId: input.tenantId,
      playbookId: input.playbookId,
      version: input.version,
      status: 'draft',
      spec: input.spec,
      compiledSpec: null,
      validationResult: input.validationResult,
      changeSummary: input.changeSummary,
      contentHash: input.contentHash,
      createdById: input.createdById,
      approvedById: null,
      approvedAt: null,
      publishedAt: null,
      retiredAt: null,
      createdAt: new Date(),
    } as unknown as PlaybookVersionV2
    this.versions.push(v)
    return v
  }
  async findVersion(tenantId: string | null, id: string) {
    return this.versions.find((v) => v.id === id && v.tenantId === tenantId) ?? null
  }
  async findVersionByContentHash(tenantId: string | null, playbookId: string, contentHash: string) {
    return (
      this.versions.find(
        (v) => v.tenantId === tenantId && v.playbookId === playbookId && v.contentHash === contentHash,
      ) ?? null
    )
  }
  async listVersions(playbookId: string) {
    return this.versions
      .filter((v) => v.playbookId === playbookId)
      .sort((a, b) => b.version - a.version)
  }
  async nextVersionNumber(playbookId: string) {
    const max = this.versions
      .filter((v) => v.playbookId === playbookId)
      .reduce((m, v) => Math.max(m, v.version), 0)
    return max + 1
  }
  async updateVersion(id: string, data: Record<string, unknown>) {
    const v = this.versions.find((x) => x.id === id)!
    Object.assign(v, data)
    return v
  }
  async publishVersion(input: {
    versionId: string
    playbookId: string
    approverId: string
    compiledSpec: unknown
  }) {
    const now = new Date()
    for (const v of this.versions) {
      if (v.playbookId === input.playbookId && v.status === 'published') {
        v.status = 'retired' as PlaybookVersionV2['status']
        v.retiredAt = now
      }
    }
    const target = this.versions.find((v) => v.id === input.versionId)!
    target.status = 'published' as PlaybookVersionV2['status']
    target.approvedById = input.approverId
    target.approvedAt = now
    target.publishedAt = now
    target.compiledSpec = input.compiledSpec as PlaybookVersionV2['compiledSpec']
    const pb = this.playbooks.find((p) => p.id === input.playbookId)!
    pb.status = 'published' as PlaybookV2['status']
    pb.currentPublishedVersionId = target.id
    return target
  }
  async createAssignment(input: CreatePlaybookAssignmentInput): Promise<PlaybookAssignment> {
    if (input.isDefault) {
      for (const a of this.assignments) {
        if (
          a.tenantId === input.tenantId &&
          a.assignmentType === input.assignmentType &&
          a.assignmentKey === input.assignmentKey &&
          a.isDefault &&
          a.revokedAt === null
        ) {
          a.revokedAt = new Date()
        }
      }
    }
    const assignment = {
      id: randomUUID(),
      tenantId: input.tenantId,
      playbookId: input.playbookId,
      playbookVersionId: input.playbookVersionId,
      assignmentType: input.assignmentType,
      assignmentKey: input.assignmentKey,
      isDefault: input.isDefault,
      createdById: input.createdById,
      createdAt: new Date(),
      revokedAt: null,
    } as PlaybookAssignment
    this.assignments.push(assignment)
    return assignment
  }
  async findDefaultAssignment(tenantId: string | null, assignmentType: string, assignmentKey: string) {
    return (
      this.assignments.find(
        (a) =>
          a.tenantId === tenantId &&
          a.assignmentType === assignmentType &&
          a.assignmentKey === assignmentKey &&
          a.isDefault &&
          a.revokedAt === null,
      ) ?? null
    )
  }
  async findDefaultAssignments(
    tenantId: string | null,
    assignmentType: string,
    assignmentKeys: string[],
  ) {
    const result = new Map<string, PlaybookAssignment>()
    for (const key of assignmentKeys) {
      const row = await this.findDefaultAssignment(tenantId, assignmentType, key)
      if (row) result.set(key, row)
    }
    return result
  }
}

// --- Spec-fixturák ----------------------------------------------------------

function validSpec(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: '1.0',
    key: 'invoice-processing',
    name: 'Bejövő számla feldolgozás',
    processType: 'invoice_processing',
    entryStepId: 'extract',
    roles: [
      { key: 'extractor', type: 'agent_role' },
      { key: 'approver', type: 'human_role', requiredPermissions: ['ticket:approve'] },
    ],
    steps: [
      {
        id: 'extract',
        name: 'Számlaadatok kinyerése',
        ticketType: 'invoice_extract',
        assignedRole: 'extractor',
        onComplete: [{ condition: 'default', nextStepId: 'approval' }],
      },
      {
        id: 'approval',
        name: 'Könyvelési jóváhagyás',
        ticketType: 'human_approval',
        assignedRole: 'approver',
        requiredGateIds: ['approve_posting'],
      },
    ],
    gates: [
      {
        id: 'approve_posting',
        type: 'human_approval',
        requiredActorRole: 'approver',
        blocking: true,
        criticality: 'L2', // → four-eyes kötelező (§11.2)
      },
    ],
    transitions: [{ fromStepId: 'extract', toStepId: 'approval', trigger: 'step.completed' }],
    outputContract: { requiredFields: ['decision'] },
    ...overrides,
  }
}

// Nem kritikus változat (nincs L2/L3) — four-eyes nélkül publikálható.
function nonCriticalSpec() {
  const spec = validSpec({ key: 'simple-flow' }) as Record<string, unknown>
  ;(spec.gates as Array<Record<string, unknown>>)[0].criticality = 'L1'
  return spec
}

const TENANT = randomUUID()
const OTHER_TENANT = randomUUID()
const AUTHOR = randomUUID()
const APPROVER = randomUUID()

async function main() {
  console.log('Playbook V2 Registry (F2-A) tesztek\n')

  await test('P1 — createPlaybook + version + audit', async () => {
    const repo = new FakePlaybookV2Repository()
    const audit = new FakeAuditRepository()
    const svc = new PlaybookV2Service(repo, audit)

    const pb = await svc.createPlaybook({
      tenantId: TENANT,
      key: 'invoice-processing',
      name: 'Számla',
      processType: 'invoice_processing',
      actorUserId: AUTHOR,
    })
    assert.equal(pb.status, 'draft')

    const { version, validation } = await svc.createPlaybookVersion({
      tenantId: TENANT,
      playbookId: pb.id,
      spec: nonCriticalSpec(),
      changeSummary: 'init',
      actorUserId: AUTHOR,
    })
    assert.equal(version.version, 1)
    assert.equal(validation.valid, true, JSON.stringify(validation.errors))
    assert.equal(version.contentHash, computePlaybookContentHash(nonCriticalSpec()))
    assert.equal(audit.byAction('playbook.create').length, 1)
    assert.equal(audit.byAction('playbook.version.create').length, 1)
  })

  await test('PLAYBOOK_EXISTS — azonos kulcs ugyanazon tenantban', async () => {
    const repo = new FakePlaybookV2Repository()
    const svc = new PlaybookV2Service(repo, new FakeAuditRepository())
    await svc.createPlaybook({
      tenantId: TENANT,
      key: 'dup',
      name: 'a',
      processType: 'p',
      actorUserId: AUTHOR,
    })
    await assert.rejects(
      () =>
        svc.createPlaybook({
          tenantId: TENANT,
          key: 'dup',
          name: 'b',
          processType: 'p',
          actorUserId: AUTHOR,
        }),
      (e: unknown) => e instanceof PlaybookV2Error && e.code === 'PLAYBOOK_EXISTS',
    )
  })

  await test('SCHEMA_INVALID — Zod-alak hibás spec elutasítva createVersion-nél', async () => {
    const repo = new FakePlaybookV2Repository()
    const svc = new PlaybookV2Service(repo, new FakeAuditRepository())
    const pb = await svc.createPlaybook({
      tenantId: TENANT,
      key: 'x',
      name: 'x',
      processType: 'p',
      actorUserId: AUTHOR,
    })
    await assert.rejects(
      () =>
        svc.createPlaybookVersion({
          tenantId: TENANT,
          playbookId: pb.id,
          spec: { schemaVersion: '1.0' }, // hiányzó kötelező mezők
          changeSummary: 'bad',
          actorUserId: AUTHOR,
        }),
      (e: unknown) => e instanceof PlaybookV2Error && e.code === 'SCHEMA_INVALID',
    )
  })

  await test('P2 — szemantikailag hibás spec draftként tárolható, de nem publikálható', async () => {
    const repo = new FakePlaybookV2Repository()
    const svc = new PlaybookV2Service(repo, new FakeAuditRepository())
    const pb = await svc.createPlaybook({
      tenantId: TENANT,
      key: 'bad-ref',
      name: 'x',
      processType: 'p',
      actorUserId: AUTHOR,
    })
    // Nem létező role-ra hivatkozó step (UNKNOWN_ROLE), de Zod-alak helyes.
    const bad = validSpec({ key: 'bad-ref' }) as Record<string, unknown>
    ;(bad.steps as Array<Record<string, unknown>>)[0].assignedRole = 'ghost'
    const { version, validation } = await svc.createPlaybookVersion({
      tenantId: TENANT,
      playbookId: pb.id,
      spec: bad,
      changeSummary: 'bad',
      actorUserId: AUTHOR,
    })
    assert.equal(validation.valid, false)
    assert.ok(validation.errors.some((e) => e.code === 'UNKNOWN_ROLE'))

    await assert.rejects(
      () =>
        svc.submitForApproval({
          tenantId: TENANT,
          playbookVersionId: version.id,
          actorUserId: AUTHOR,
        }),
      (e: unknown) => e instanceof PlaybookV2Error && e.code === 'NOT_VALID',
    )
  })

  await test('§11.2 four-eyes — L2 kritikus: jóváhagyó ≠ készítő', async () => {
    const repo = new FakePlaybookV2Repository()
    const svc = new PlaybookV2Service(repo, new FakeAuditRepository())
    const pb = await svc.createPlaybook({
      tenantId: TENANT,
      key: 'invoice-processing',
      name: 'x',
      processType: 'invoice_processing',
      actorUserId: AUTHOR,
    })
    const { version } = await svc.createPlaybookVersion({
      tenantId: TENANT,
      playbookId: pb.id,
      spec: validSpec(), // L2 gate
      changeSummary: 'init',
      actorUserId: AUTHOR,
    })
    await svc.submitForApproval({ tenantId: TENANT, playbookVersionId: version.id, actorUserId: AUTHOR })

    // Készítő próbál saját maga publikálni → DENY
    await assert.rejects(
      () =>
        svc.publishPlaybookVersion({
          tenantId: TENANT,
          playbookVersionId: version.id,
          approverUserId: AUTHOR,
        }),
      (e: unknown) => e instanceof PlaybookV2Error && e.code === 'FOUR_EYES_REQUIRED',
    )

    // Másik approver → OK, compiled_spec létrejön
    const published = await svc.publishPlaybookVersion({
      tenantId: TENANT,
      playbookVersionId: version.id,
      approverUserId: APPROVER,
    })
    assert.equal(published.status, 'published')
    assert.ok(published.compiledSpec, 'compiled_spec hiányzik')
    const pbAfter = await repo.findPlaybook(TENANT, pb.id)
    assert.equal(pbAfter?.currentPublishedVersionId, published.id)
  })

  await test('P3 — published immutable: azonos tartalom DUPLICATE_CONTENT, új tartalom új verzió', async () => {
    const repo = new FakePlaybookV2Repository()
    const svc = new PlaybookV2Service(repo, new FakeAuditRepository())
    const pb = await svc.createPlaybook({
      tenantId: TENANT,
      key: 'invoice-processing',
      name: 'x',
      processType: 'invoice_processing',
      actorUserId: AUTHOR,
    })
    const { version: v1 } = await svc.createPlaybookVersion({
      tenantId: TENANT,
      playbookId: pb.id,
      spec: validSpec(),
      changeSummary: 'init',
      actorUserId: AUTHOR,
    })
    await svc.submitForApproval({ tenantId: TENANT, playbookVersionId: v1.id, actorUserId: AUTHOR })
    await svc.publishPlaybookVersion({
      tenantId: TENANT,
      playbookVersionId: v1.id,
      approverUserId: APPROVER,
    })

    // Ugyanazzal a tartalommal → DUPLICATE_CONTENT
    await assert.rejects(
      () =>
        svc.createPlaybookVersion({
          tenantId: TENANT,
          playbookId: pb.id,
          spec: validSpec(),
          changeSummary: 'again',
          actorUserId: AUTHOR,
        }),
      (e: unknown) => e instanceof PlaybookV2Error && e.code === 'DUPLICATE_CONTENT',
    )

    // Új tartalom → v2; v1 published marad, majd publish után v1 retired
    const { version: v2 } = await svc.createPlaybookVersion({
      tenantId: TENANT,
      playbookId: pb.id,
      spec: validSpec({ name: 'Módosított név' }),
      changeSummary: 'rename',
      actorUserId: AUTHOR,
    })
    assert.equal(v2.version, 2)
    await svc.submitForApproval({ tenantId: TENANT, playbookVersionId: v2.id, actorUserId: AUTHOR })
    await svc.publishPlaybookVersion({
      tenantId: TENANT,
      playbookVersionId: v2.id,
      approverUserId: APPROVER,
    })
    const v1After = await repo.findVersion(TENANT, v1.id)
    assert.equal(v1After?.status, 'retired')
  })

  await test('draft in-place szerkesztés — spec/hash/summary frissül, published immutable', async () => {
    const repo = new FakePlaybookV2Repository()
    const svc = new PlaybookV2Service(repo, new FakeAuditRepository())
    const pb = await svc.createPlaybook({
      tenantId: TENANT,
      key: 'edit-flow',
      name: 'x',
      processType: 'edit_flow',
      actorUserId: AUTHOR,
    })
    const { version: v1 } = await svc.createPlaybookVersion({
      tenantId: TENANT,
      playbookId: pb.id,
      spec: validSpec(),
      changeSummary: 'init',
      actorUserId: AUTHOR,
    })
    const originalHash = v1.contentHash

    // Draft helyben szerkeszthető: új tartalom → új hash, ugyanaz a verziószám.
    const { version: edited } = await svc.updateDraftPlaybookVersion({
      tenantId: TENANT,
      playbookVersionId: v1.id,
      spec: validSpec({ name: 'Átnevezve' }),
      changeSummary: 'rename draft',
      actorUserId: AUTHOR,
    })
    assert.equal(edited.id, v1.id)
    assert.equal(edited.version, v1.version)
    assert.equal(edited.changeSummary, 'rename draft')
    assert.notEqual(edited.contentHash, originalHash)

    // Published verzió NEM szerkeszthető helyben → INVALID_STATE.
    await svc.submitForApproval({ tenantId: TENANT, playbookVersionId: v1.id, actorUserId: AUTHOR })
    await svc.publishPlaybookVersion({
      tenantId: TENANT,
      playbookVersionId: v1.id,
      approverUserId: APPROVER,
    })
    await assert.rejects(
      () =>
        svc.updateDraftPlaybookVersion({
          tenantId: TENANT,
          playbookVersionId: v1.id,
          spec: validSpec({ name: 'Megint' }),
          changeSummary: 'nem szabad',
          actorUserId: AUTHOR,
        }),
      (e: unknown) => e instanceof PlaybookV2Error && e.code === 'INVALID_STATE',
    )
  })

  await test('P10 — tenant-izoláció: másik tenant verziója NOT_FOUND_OR_FORBIDDEN', async () => {
    const repo = new FakePlaybookV2Repository()
    const svc = new PlaybookV2Service(repo, new FakeAuditRepository())
    const pb = await svc.createPlaybook({
      tenantId: TENANT,
      key: 'invoice-processing',
      name: 'x',
      processType: 'invoice_processing',
      actorUserId: AUTHOR,
    })
    const { version } = await svc.createPlaybookVersion({
      tenantId: TENANT,
      playbookId: pb.id,
      spec: validSpec(),
      changeSummary: 'init',
      actorUserId: AUTHOR,
    })
    await assert.rejects(
      () =>
        svc.validatePlaybookVersion({
          tenantId: OTHER_TENANT,
          playbookVersionId: version.id,
          actorUserId: AUTHOR,
        }),
      (e: unknown) => e instanceof PlaybookV2Error && e.code === 'NOT_FOUND_OR_FORBIDDEN',
    )
  })

  await test('assignment — csak published; single-default revoke', async () => {
    const repo = new FakePlaybookV2Repository()
    const svc = new PlaybookV2Service(repo, new FakeAuditRepository())
    const pb = await svc.createPlaybook({
      tenantId: TENANT,
      key: 'invoice-processing',
      name: 'x',
      processType: 'invoice_processing',
      actorUserId: AUTHOR,
    })
    const { version: v1 } = await svc.createPlaybookVersion({
      tenantId: TENANT,
      playbookId: pb.id,
      spec: validSpec(),
      changeSummary: 'init',
      actorUserId: AUTHOR,
    })

    // Draft → nem rendelhető
    await assert.rejects(
      () =>
        svc.assignPlaybook({
          tenantId: TENANT,
          playbookVersionId: v1.id,
          assignmentType: 'process_type',
          assignmentKey: 'invoice_processing',
          isDefault: true,
          actorUserId: AUTHOR,
        }),
      (e: unknown) => e instanceof PlaybookV2Error && e.code === 'VERSION_NOT_PUBLISHED',
    )

    await svc.submitForApproval({ tenantId: TENANT, playbookVersionId: v1.id, actorUserId: AUTHOR })
    await svc.publishPlaybookVersion({
      tenantId: TENANT,
      playbookVersionId: v1.id,
      approverUserId: APPROVER,
    })
    const a1 = await svc.assignPlaybook({
      tenantId: TENANT,
      playbookVersionId: v1.id,
      assignmentType: 'process_type',
      assignmentKey: 'invoice_processing',
      isDefault: true,
      actorUserId: AUTHOR,
    })

    // Új tartalmú verzió → publish → default újra → a régi default revoke-olt
    const { version: v2 } = await svc.createPlaybookVersion({
      tenantId: TENANT,
      playbookId: pb.id,
      spec: validSpec({ name: 'v2' }),
      changeSummary: 'v2',
      actorUserId: AUTHOR,
    })
    await svc.submitForApproval({ tenantId: TENANT, playbookVersionId: v2.id, actorUserId: AUTHOR })
    await svc.publishPlaybookVersion({
      tenantId: TENANT,
      playbookVersionId: v2.id,
      approverUserId: APPROVER,
    })
    await svc.assignPlaybook({
      tenantId: TENANT,
      playbookVersionId: v2.id,
      assignmentType: 'process_type',
      assignmentKey: 'invoice_processing',
      isDefault: true,
      actorUserId: AUTHOR,
    })

    const active = await repo.findDefaultAssignment(TENANT, 'process_type', 'invoice_processing')
    assert.equal(active?.playbookVersionId, v2.id)
    const a1After = repo.assignments.find((a) => a.id === a1.id)
    assert.ok(a1After?.revokedAt, 'a régi default nincs revoke-olva')
  })

  await test('assignment — agent_role roster nem írható többé', async () => {
    const repo = new FakePlaybookV2Repository()
    const svc = new PlaybookV2Service(repo, new FakeAuditRepository())
    const pb = await svc.createPlaybook({
      tenantId: TENANT,
      key: 'invoice-processing',
      name: 'x',
      processType: 'invoice_processing',
      actorUserId: AUTHOR,
    })
    const { version } = await svc.createPlaybookVersion({
      tenantId: TENANT,
      playbookId: pb.id,
      spec: validSpec(),
      changeSummary: 'init',
      actorUserId: AUTHOR,
    })
    await svc.submitForApproval({ tenantId: TENANT, playbookVersionId: version.id, actorUserId: AUTHOR })
    await svc.publishPlaybookVersion({
      tenantId: TENANT,
      playbookVersionId: version.id,
      approverUserId: APPROVER,
    })

    await assert.rejects(
      () =>
        svc.assignPlaybook({
          tenantId: TENANT,
          playbookVersionId: version.id,
          assignmentType: 'agent_role',
          assignmentKey: 'extractor',
          isDefault: true,
          actorUserId: AUTHOR,
        }),
      (e: unknown) => e instanceof PlaybookV2Error && e.code === 'ASSIGNMENT_TYPE_DEPRECATED',
    )
    assert.equal(repo.assignments.length, 0)
  })

  await test('startable — csak aktív process_type default published verzió indítható', async () => {
    const repo = new FakePlaybookV2Repository()
    const svc = new PlaybookV2Service(repo, new FakeAuditRepository())
    const pb = await svc.createPlaybook({
      tenantId: TENANT,
      key: 'invoice-processing',
      name: 'Invoice',
      processType: 'invoice_processing',
      actorUserId: AUTHOR,
    })
    const { version: v1 } = await svc.createPlaybookVersion({
      tenantId: TENANT,
      playbookId: pb.id,
      spec: validSpec(),
      changeSummary: 'init',
      actorUserId: AUTHOR,
    })
    await svc.submitForApproval({ tenantId: TENANT, playbookVersionId: v1.id, actorUserId: AUTHOR })
    await svc.publishPlaybookVersion({ tenantId: TENANT, playbookVersionId: v1.id, approverUserId: APPROVER })

    assert.deepEqual(await svc.listStartablePlaybooks(TENANT), [])

    await svc.assignPlaybook({
      tenantId: TENANT,
      playbookVersionId: v1.id,
      assignmentType: 'process_type',
      assignmentKey: 'invoice_processing',
      isDefault: true,
      actorUserId: AUTHOR,
    })
    assert.deepEqual(await svc.listStartablePlaybooks(TENANT), [
      {
        playbookId: pb.id,
        name: 'Invoice',
        processType: 'invoice_processing',
        publishedVersionId: v1.id,
        version: 1,
      },
    ])

    const { version: v2 } = await svc.createPlaybookVersion({
      tenantId: TENANT,
      playbookId: pb.id,
      spec: validSpec({ name: 'v2' }),
      changeSummary: 'v2',
      actorUserId: AUTHOR,
    })
    await svc.submitForApproval({ tenantId: TENANT, playbookVersionId: v2.id, actorUserId: AUTHOR })
    await svc.publishPlaybookVersion({ tenantId: TENANT, playbookVersionId: v2.id, approverUserId: APPROVER })

    assert.deepEqual(await svc.listStartablePlaybooks(TENANT), [])
  })

  await test('§10.2/§15 — a teljes spec SOHA nem kerül auditba', async () => {
    const repo = new FakePlaybookV2Repository()
    const audit = new FakeAuditRepository()
    const svc = new PlaybookV2Service(repo, audit)
    const pb = await svc.createPlaybook({
      tenantId: TENANT,
      key: 'invoice-processing',
      name: 'x',
      processType: 'invoice_processing',
      actorUserId: AUTHOR,
    })
    await svc.createPlaybookVersion({
      tenantId: TENANT,
      playbookId: pb.id,
      spec: validSpec(),
      changeSummary: 'init',
      actorUserId: AUTHOR,
    })
    for (const entry of audit.entries) {
      const blob = JSON.stringify(entry.metadata ?? {})
      assert.ok(!blob.includes('"steps"'), 'audit metaadat tartalmazza a spec steps-et')
      assert.ok(!blob.includes('"roles"'), 'audit metaadat tartalmazza a spec roles-t')
    }
  })

  console.log(`\n${failures === 0 ? '✅ Mind zöld' : `❌ ${failures} bukott teszt`}`)
  if (failures > 0) process.exit(1)
}

void main()
