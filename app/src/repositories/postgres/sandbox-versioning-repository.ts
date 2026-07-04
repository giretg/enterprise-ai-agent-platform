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

  async createCommit(input: CreateSandboxCommitInput): Promise<SandboxCommit> {
    return prisma.$transaction(async (tx) => {
      const last = await tx.sandboxCommit.findFirst({
        where: { projectId: input.projectId },
        orderBy: { seq: 'desc' },
        select: { seq: true },
      })
      const seq = (last?.seq ?? 0) + 1
      return tx.sandboxCommit.create({
        data: {
          tenantId: input.tenantId,
          projectId: input.projectId,
          seq,
          parentCommitId: input.parentCommitId,
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
