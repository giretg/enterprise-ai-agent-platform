/**
 * SandboxVersioning-Graduation regressziók: párhuzamos commit object-store
 * integritás és egyszer-használatos go-live döntés.
 *
 * Futtatás: npm run test:sandbox-versioning
 */
import assert from 'node:assert/strict'
import type { SandboxDataSnapshot, SandboxProject, SandboxPromotion } from '@prisma/client'
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

function promotion(): SandboxPromotion {
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

function approvalService() {
  const sandbox = project()
  const row = promotion()
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

  if (failures > 0) {
    console.error(`\n${failures} sandbox-versioning teszt bukott`)
    process.exit(1)
  }
  console.log('\nÖsszes sandbox-versioning teszt zöld')
}

main()
