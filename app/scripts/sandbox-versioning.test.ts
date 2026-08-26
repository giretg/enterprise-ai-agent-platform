/**
 * SandboxVersioning-Graduation regressziók: párhuzamos commit object-store
 * integritás és egyszer-használatos go-live döntés.
 *
 * Futtatás: npm run test:sandbox-versioning
 */
import assert from 'node:assert/strict'
import type { SandboxDataSnapshot, SandboxProject, SandboxPromotion } from '@prisma/client'
import { SandboxVersionError } from '../src/domain/sandbox-versioning/errors'
import { SandboxVersioningService } from '../src/domain/sandbox-versioning/sandbox-versioning-service'
import { GcsCodeTreeStore } from '../src/domain/sandbox-versioning/stores'
import type { AuditRepository, SandboxVersioningRepository } from '../src/repositories/interfaces'

let failures = 0

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn()
    console.log(`  OK  ${name}`)
  } catch (error) {
    failures++
    console.error(`FAIL  ${name}\n      ${error instanceof Error ? error.message : String(error)}`)
  }
}

function project(): SandboxProject {
  return {
    id: 'project-1',
    tenantId: 'tenant-1',
    sandboxId: null,
    name: 'Ügyfél CRM',
    description: null,
    testCommitId: 'commit-1',
    liveCommitId: null,
    headCommitId: 'commit-1',
    dataBinding: {},
    portability: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    archivedAt: null,
  }
}

function promotion(overrides: Partial<SandboxPromotion> = {}): SandboxPromotion {
  return {
    ...basePromotion(),
    ...overrides,
  }
}

function basePromotion(): SandboxPromotion {
  return {
    id: 'promotion-1',
    tenantId: 'tenant-1',
    projectId: 'project-1',
    fromCommitId: 'commit-1',
    prevLiveCommitId: null,
    prePromotionSnapshotId: null,
    status: 'pending_approval',
    requestedByType: 'agent',
    requestedByUserId: null,
    requestedByAgentId: 'agent-1',
    approvedByUserId: null,
    reason: null,
    requestedAt: new Date(),
    decidedAt: null,
    promotedAt: null,
  }
}

function approvalService(overrides: Partial<SandboxPromotion> = {}) {
  const sandbox = project()
  const row = promotion(overrides)
  let snapshotCalls = 0
  const audits: string[] = []

  const repo = {
    findPromotionById: async (id: string) => (id === row.id ? row : null),
    findProjectById: async (id: string) => (id === sandbox.id ? sandbox : null),
    decidePendingPromotion: async (_id: string, decision: { status: 'approved' | 'rejected'; approvedByUserId: string; reason: string | null; decidedAt: Date }) => {
      if (row.status !== 'pending_approval') return null
      row.status = decision.status
      row.approvedByUserId = decision.approvedByUserId
      row.reason = decision.reason
      row.decidedAt = decision.decidedAt
      return row
    },
    reclaimStalledApproval: async (_id: string, data: { approvedByUserId: string; reason: string | null; decidedAt: Date; staleBefore: Date }) => {
      if (row.status !== 'approved' || row.promotedAt !== null) return null
      if (!row.decidedAt || row.decidedAt >= data.staleBefore) return null
      row.approvedByUserId = data.approvedByUserId
      row.reason = data.reason
      row.decidedAt = data.decidedAt
      return row
    },
    createSnapshot: async () => ({ id: 'snapshot-1' }) as SandboxDataSnapshot,
    updateSnapshot: async () => ({ id: 'snapshot-1', schemaHash: 'sha256:snapshot' }) as SandboxDataSnapshot,
    updatePromotion: async (_id: string, patch: Partial<SandboxPromotion>) => {
      Object.assign(row, patch)
      return row
    },
    promoteApprovedPromotion: async (input: { promotionId: string; projectId: string; fromCommitId: string; prePromotionSnapshotId: string; reason: string | null; promotedAt: Date }) => {
      if (row.id !== input.promotionId || row.status !== 'approved' || sandbox.testCommitId !== input.fromCommitId) return null
      sandbox.liveCommitId = input.fromCommitId
      row.status = 'promoted'
      row.prePromotionSnapshotId = input.prePromotionSnapshotId
      row.reason = input.reason
      row.promotedAt = input.promotedAt
      return row
    },
  } as unknown as SandboxVersioningRepository

  const service = new SandboxVersioningService(
    repo,
    {} as never,
    {
      snapshot: async () => {
        snapshotCalls++
        await Promise.resolve()
        return { snapshotRef: 'snapshot-ref', schemaHash: 'sha256:snapshot', rowCount: 0, sizeBytes: 0 }
      },
      restore: async () => undefined,
    },
    {
      append: async (event: { action: string }) => {
        audits.push(event.action)
        return {} as never
      },
    } as unknown as AuditRepository,
    async () => '',
  )
  return { service, sandbox, row, audits, snapshotCalls: () => snapshotCalls }
}

async function main() {
  console.log('=== sandbox versioning regressziók ===')

  await test('párhuzamos eltérő commit-fa külön content-addressed objectet kap', async () => {
    const prior = process.env.SANDBOX_VERSIONING_STUB
    process.env.SANDBOX_VERSIONING_STUB = 'true'
    try {
      const store = new GcsCodeTreeStore('unused-in-stub')
      const [first, second] = await Promise.all([
        store.putTree({ tenantId: 'tenant-1', projectId: 'project-1', files: [{ path: 'app.ts', content: 'export const release = 1' }] }),
        store.putTree({ tenantId: 'tenant-1', projectId: 'project-1', files: [{ path: 'app.ts', content: 'export const release = 2' }] }),
      ])

      assert.notEqual(first.treeRef, second.treeRef, 'eltérő fákat nem szabad azonos object-kulcson tárolni')
      assert.equal(await store.getFile(first.treeRef, 'app.ts'), 'export const release = 1')
      assert.equal(await store.getFile(second.treeRef, 'app.ts'), 'export const release = 2')
    } finally {
      if (prior === undefined) delete process.env.SANDBOX_VERSIONING_STUB
      else process.env.SANDBOX_VERSIONING_STUB = prior
    }
  })

  await test('két egyidejű jóváhagyásból csak egy készít snapshotot és élesít', async () => {
    const { service, sandbox, row, audits, snapshotCalls } = approvalService()
    const actor = { userId: 'operator-1', tenantId: 'tenant-1', role: 'operator' as const }
    const settled = await Promise.allSettled([
      service.approvePromotion({ promotionId: row.id, decision: 'approve' }, actor),
      service.approvePromotion({ promotionId: row.id, decision: 'approve' }, actor),
    ])

    assert.equal(settled.filter((result) => result.status === 'fulfilled').length, 1)
    assert.equal(snapshotCalls(), 1)
    assert.equal(row.status, 'promoted')
    assert.equal(sandbox.liveCommitId, 'commit-1')
    assert.equal(audits.filter((action) => action === 'sandbox.promote.approve').length, 1)
  })

  await test('az indok nélküli jóváhagyás megőrzi a kérelmező indokát', async () => {
    const kérelmiIndok = 'Ügyfél sürgeti a számlázó modult'
    const { service, row } = approvalService({ reason: kérelmiIndok })
    const actor = { userId: 'operator-1', tenantId: 'tenant-1', role: 'operator' as const }

    const res = await service.approvePromotion({ promotionId: row.id, decision: 'approve' }, actor)

    assert.equal(res.status, 'promoted')
    assert.equal(row.reason, kérelmiIndok, 'a go-live rekordból nem tűnhet el, miért kérték az élesítést')
  })

  await test('a snapshot közben megszakadt jóváhagyás a türelmi idő után befejezhető', async () => {
    const { service, sandbox, row, snapshotCalls } = approvalService({
      status: 'approved',
      approvedByUserId: 'operator-1',
      reason: 'Ügyfél sürgeti a számlázó modult',
      decidedAt: new Date(Date.now() - 10 * 60_000),
    })
    const actor = { userId: 'operator-2', tenantId: 'tenant-1', role: 'operator' as const }

    const res = await service.approvePromotion({ promotionId: row.id, decision: 'approve' }, actor)

    assert.equal(res.status, 'promoted')
    assert.equal(snapshotCalls(), 1)
    assert.equal(sandbox.liveCommitId, 'commit-1')
    assert.equal(row.reason, 'Ügyfél sürgeti a számlázó modult')
  })

  await test('a még futó jóváhagyást nem lehet másodszor elindítani', async () => {
    const { service, sandbox, row, snapshotCalls } = approvalService({
      status: 'approved',
      approvedByUserId: 'operator-1',
      decidedAt: new Date(),
    })
    const actor = { userId: 'operator-2', tenantId: 'tenant-1', role: 'operator' as const }

    await assert.rejects(
      () => service.approvePromotion({ promotionId: row.id, decision: 'approve' }, actor),
      (error: unknown) => error instanceof SandboxVersionError && error.code === 'PROMOTION_ALREADY_DECIDED',
    )
    assert.equal(snapshotCalls(), 0)
    assert.equal(sandbox.liveCommitId, null)
  })

  if (failures > 0) {
    console.error(`\n${failures} sandbox-versioning teszt bukott`)
    process.exit(1)
  }
  console.log('\nÖsszes sandbox-versioning teszt zöld')
}

main()
