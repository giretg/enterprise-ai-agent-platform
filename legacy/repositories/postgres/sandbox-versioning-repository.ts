import type {
  SandboxCommit,
  SandboxDataSnapshot,
  SandboxExport,
  SandboxProject,
  SandboxPromotion,
} from '@prisma/client'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import type {
  CreateSandboxCommitInput,
  CreateSandboxExportInput,
  CreateSandboxProjectInput,
  CreateSandboxPromotionInput,
  CreateSandboxSnapshotInput,
  SandboxProjectPointers,
  SandboxVersioningRepository,
} from '../interfaces'

/**
 * Postgres implementáció a Sandbox verziózás / promóció / graduation modellhez
 * (Feature-spec — SandboxVersioning-Graduation §3). A commit `seq` kiosztása
 * tranzakcióban, projektenként monoton (unique(project_id, seq)); a nyers fájl-
 * tartalom SOHA nem kerül ide, csak `tree_ref + tree_hash + méret`.
 */
export class PostgresSandboxVersioningRepository implements SandboxVersioningRepository {
  // ── projekt ────────────────────────────────────────────────────────────────

  async createProject(input: CreateSandboxProjectInput): Promise<SandboxProject> {
    return prisma.sandboxProject.create({
      data: {
        tenantId: input.tenantId,
        sandboxId: input.sandboxId,
        name: input.name,
        description: input.description,
        dataBinding: input.dataBinding ?? {},
        portability: input.portability ?? {},
      },
    })
  }

  async findProjectById(id: string): Promise<SandboxProject | null> {
    return prisma.sandboxProject.findUnique({ where: { id } })
  }

  async findProjectByName(
    tenantId: string | null,
    sandboxId: string | null,
    name: string,
  ): Promise<SandboxProject | null> {
    return prisma.sandboxProject.findFirst({ where: { tenantId, sandboxId, name } })
  }

  async listProjects(filter: {
    tenantId: string | null
    sandboxId?: string
    limit?: number
  }): Promise<SandboxProject[]> {
    return prisma.sandboxProject.findMany({
      where: {
        tenantId: filter.tenantId,
        ...(filter.sandboxId ? { sandboxId: filter.sandboxId } : {}),
        archivedAt: null,
      },
      orderBy: { updatedAt: 'desc' },
      take: filter.limit ?? 50,
    })
  }

  async updateProjectPointers(id: string, pointers: SandboxProjectPointers): Promise<SandboxProject> {
    return prisma.sandboxProject.update({
      where: { id },
      data: {
        ...(pointers.testCommitId !== undefined ? { testCommitId: pointers.testCommitId } : {}),
        ...(pointers.liveCommitId !== undefined ? { liveCommitId: pointers.liveCommitId } : {}),
        ...(pointers.headCommitId !== undefined ? { headCommitId: pointers.headCommitId } : {}),
      },
    })
  }

  async archiveProject(id: string): Promise<SandboxProject> {
    return prisma.sandboxProject.update({ where: { id }, data: { archivedAt: new Date() } })
  }

  // ── commit ─────────────────────────────────────────────────────────────────

  async createCommitAndAdvanceTest(input: CreateSandboxCommitInput): Promise<SandboxCommit> {
    return prisma.$transaction(async (tx) => {
      // A pointer- és a seq-verseny ugyanazon project-soron dől el. A lockot a
      // commit beszúrásáig ÉS a pointerek mozgatásáig megtartjuk.
      const locked = await tx.$queryRaw<Array<{ id: string; head_commit_id: string | null }>>`
        SELECT id, head_commit_id FROM sandbox_projects WHERE id = ${input.projectId} FOR UPDATE
      `
      if (locked.length !== 1) throw new Error('Sandbox project not found while creating commit')
      const last = await tx.sandboxCommit.findFirst({
        where: { projectId: input.projectId },
        orderBy: { seq: 'desc' },
        select: { seq: true },
      })
      const seq = (last?.seq ?? 0) + 1
      const commit = await tx.sandboxCommit.create({
        data: {
          tenantId: input.tenantId,
          projectId: input.projectId,
          seq,
          parentCommitId: locked[0].head_commit_id,
          basedOnCommitId: input.basedOnCommitId,
          source: input.source,
          changeSummary: input.changeSummary,
          treeRef: input.treeRef,
          treeHash: input.treeHash,
          fileCount: input.fileCount,
          totalSizeBytes: BigInt(input.totalSizeBytes),
          createdByType: input.createdByType,
          createdByUserId: input.createdByUserId,
          createdByAgentId: input.createdByAgentId,
          createdFromTicketId: input.createdFromTicketId,
          createdFromRunId: input.createdFromRunId,
          buildCost: input.buildCost ?? {},
        },
      })
      await tx.sandboxProject.update({
        where: { id: input.projectId },
        data: { headCommitId: commit.id, testCommitId: commit.id },
      })
      return commit
    })
  }

  async findCommitById(id: string): Promise<SandboxCommit | null> {
    return prisma.sandboxCommit.findUnique({ where: { id } })
  }

  async findCommitByTreeHash(projectId: string, treeHash: string): Promise<SandboxCommit | null> {
    return prisma.sandboxCommit.findFirst({ where: { projectId, treeHash }, orderBy: { seq: 'desc' } })
  }

  async listCommits(filter: {
    projectId: string
    limit?: number
    beforeSeq?: number
  }): Promise<SandboxCommit[]> {
    return prisma.sandboxCommit.findMany({
      where: {
        projectId: filter.projectId,
        ...(filter.beforeSeq !== undefined ? { seq: { lt: filter.beforeSeq } } : {}),
      },
      orderBy: { seq: 'desc' },
      take: filter.limit ?? 50,
    })
  }

  // ── promóció ─────────────────────────────────────────────────────────────────

  async createPromotion(input: CreateSandboxPromotionInput): Promise<SandboxPromotion> {
    return prisma.sandboxPromotion.create({
      data: {
        tenantId: input.tenantId,
        projectId: input.projectId,
        fromCommitId: input.fromCommitId,
        prevLiveCommitId: input.prevLiveCommitId,
        requestedByType: input.requestedByType,
        requestedByUserId: input.requestedByUserId,
        requestedByAgentId: input.requestedByAgentId,
        reason: input.reason,
      },
    })
  }

  async findPromotionById(id: string): Promise<SandboxPromotion | null> {
    return prisma.sandboxPromotion.findUnique({ where: { id } })
  }

  async listPromotions(filter: {
    projectId: string
    status?: SandboxPromotion['status']
  }): Promise<SandboxPromotion[]> {
    return prisma.sandboxPromotion.findMany({
      where: { projectId: filter.projectId, ...(filter.status ? { status: filter.status } : {}) },
      orderBy: { requestedAt: 'desc' },
    })
  }

  async updatePromotion(
    id: string,
    data: Partial<{
      status: SandboxPromotion['status']
      prePromotionSnapshotId: string | null
      approvedByUserId: string | null
      reason: string | null
      decidedAt: Date | null
      promotedAt: Date | null
    }>,
  ): Promise<SandboxPromotion> {
    return prisma.sandboxPromotion.update({ where: { id }, data })
  }

  async decidePendingPromotion(
    id: string,
    data: {
      status: 'approved' | 'rejected'
      approvedByUserId: string
      reason: string | null
      decidedAt: Date
    },
  ): Promise<SandboxPromotion | null> {
    const changed = await prisma.sandboxPromotion.updateMany({
      where: { id, status: 'pending_approval' },
      data,
    })
    if (changed.count !== 1) return null
    return prisma.sandboxPromotion.findUnique({ where: { id } })
  }

  async reclaimStalledApproval(
    id: string,
    data: {
      approvedByUserId: string
      reason: string | null
      decidedAt: Date
      staleBefore: Date
    },
  ): Promise<SandboxPromotion | null> {
    // A `decided_at` egyben lease is: az újrafoglalás előre tolja, így két egyidejű
    // újrapróbálásból csak az egyik updateMany talál sort.
    const changed = await prisma.sandboxPromotion.updateMany({
      where: {
        id,
        status: 'approved',
        promotedAt: null,
        decidedAt: { lt: data.staleBefore },
      },
      data: {
        approvedByUserId: data.approvedByUserId,
        reason: data.reason,
        decidedAt: data.decidedAt,
      },
    })
    if (changed.count !== 1) return null
    return prisma.sandboxPromotion.findUnique({ where: { id } })
  }

  async promoteApprovedPromotion(input: {
    promotionId: string
    projectId: string
    fromCommitId: string
    prePromotionSnapshotId: string
    reason: string | null
    promotedAt: Date
  }): Promise<SandboxPromotion | null> {
    return prisma.$transaction(async (tx) => {
      // A test fejének összehasonlítása és a live pointer mozgatása egyetlen
      // írási tranzakció: egy időközben érkezett commit nem élesíthet régi fát.
      const project = await tx.sandboxProject.updateMany({
        where: { id: input.projectId, testCommitId: input.fromCommitId },
        data: { liveCommitId: input.fromCommitId },
      })
      if (project.count !== 1) return null
      const promotion = await tx.sandboxPromotion.updateMany({
        where: { id: input.promotionId, status: 'approved' },
        data: {
          status: 'promoted',
          prePromotionSnapshotId: input.prePromotionSnapshotId,
          reason: input.reason,
          promotedAt: input.promotedAt,
        },
      })
      if (promotion.count !== 1) throw new Error('Claimed sandbox promotion was lost')
      return tx.sandboxPromotion.findUnique({ where: { id: input.promotionId } })
    })
  }

  // ── adat-snapshot ─────────────────────────────────────────────────────────────

  async createSnapshot(input: CreateSandboxSnapshotInput): Promise<SandboxDataSnapshot> {
    return prisma.sandboxDataSnapshot.create({
      data: {
        tenantId: input.tenantId,
        projectId: input.projectId,
        env: input.env,
        kind: input.kind,
        status: input.status,
        snapshotRef: input.snapshotRef,
        schemaHash: input.schemaHash,
        rowCount: input.rowCount != null ? BigInt(input.rowCount) : null,
        sizeBytes: input.sizeBytes != null ? BigInt(input.sizeBytes) : null,
        createdByType: input.createdByType,
        createdByUserId: input.createdByUserId,
        linkedPromotionId: input.linkedPromotionId,
        expiresAt: input.expiresAt,
      },
    })
  }

  async findSnapshotById(id: string): Promise<SandboxDataSnapshot | null> {
    return prisma.sandboxDataSnapshot.findUnique({ where: { id } })
  }

  async listSnapshots(filter: {
    projectId: string
    env?: SandboxDataSnapshot['env']
  }): Promise<SandboxDataSnapshot[]> {
    return prisma.sandboxDataSnapshot.findMany({
      where: { projectId: filter.projectId, ...(filter.env ? { env: filter.env } : {}) },
      orderBy: { createdAt: 'desc' },
    })
  }

  async updateSnapshot(
    id: string,
    data: Partial<{
      status: SandboxDataSnapshot['status']
      snapshotRef: string
      schemaHash: string
      rowCount: number | null
      sizeBytes: number | null
    }>,
  ): Promise<SandboxDataSnapshot> {
    return prisma.sandboxDataSnapshot.update({
      where: { id },
      data: {
        ...(data.status !== undefined ? { status: data.status } : {}),
        ...(data.snapshotRef !== undefined ? { snapshotRef: data.snapshotRef } : {}),
        ...(data.schemaHash !== undefined ? { schemaHash: data.schemaHash } : {}),
        ...(data.rowCount !== undefined ? { rowCount: data.rowCount != null ? BigInt(data.rowCount) : null } : {}),
        ...(data.sizeBytes !== undefined ? { sizeBytes: data.sizeBytes != null ? BigInt(data.sizeBytes) : null } : {}),
      },
    })
  }

  // ── export ─────────────────────────────────────────────────────────────────

  async createExport(input: CreateSandboxExportInput): Promise<SandboxExport> {
    return prisma.sandboxExport.create({
      data: {
        tenantId: input.tenantId,
        projectId: input.projectId,
        scope: input.scope,
        sourceCommitId: input.sourceCommitId,
        sourceSnapshotId: input.sourceSnapshotId,
        requestedByUserId: input.requestedByUserId,
        manifest: input.manifest ?? {},
        responsibilityTransferred: input.responsibilityTransferred,
      },
    })
  }

  async findExportById(id: string): Promise<SandboxExport | null> {
    return prisma.sandboxExport.findUnique({ where: { id } })
  }

  async listExports(filter: { projectId: string }): Promise<SandboxExport[]> {
    return prisma.sandboxExport.findMany({
      where: { projectId: filter.projectId },
      orderBy: { requestedAt: 'desc' },
    })
  }

  async updateExport(
    id: string,
    data: Partial<{
      status: SandboxExport['status']
      packageRef: string | null
      packageHash: string | null
      manifest: Prisma.InputJsonValue
      completedAt: Date | null
    }>,
  ): Promise<SandboxExport> {
    return prisma.sandboxExport.update({ where: { id }, data })
  }
}
