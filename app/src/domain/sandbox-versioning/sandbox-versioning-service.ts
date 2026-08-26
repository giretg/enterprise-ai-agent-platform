import { createHash } from 'node:crypto'
import type { Prisma, SandboxCommit, SandboxDataSnapshot, SandboxPromotion } from '@prisma/client'
import type { AuditRepository, SandboxVersioningRepository } from '@/repositories/interfaces'
import type { CodeTreeStore, DataSnapshotStore } from './stores'
import { diffTrees, type ChangedFile, type DiffFileSource } from './tree'
import { SandboxVersionError } from './errors'

/**
 * Sandbox verziózás, test→live promóció és graduation/export szolgáltatás
 * (Feature-spec — SandboxVersioning-Graduation §4). Egy facade a spec négy
 * al-szolgáltatása fölött (Version / Promotion / DataSnapshot / Graduation),
 * hogy a Tool Broker és a Control Plane action-ök egyetlen belépési ponton át
 * hívják, de a kritikus invariánsok (kettős sín, ember-only go-live/export,
 * immutable history) itt, kódszinten kikényszerülnek.
 */

export type SandboxRole = 'viewer' | 'operator' | 'approver' | 'admin'

const ROLE_RANK: Record<SandboxRole, number> = { viewer: 0, operator: 1, approver: 2, admin: 3 }

export type SandboxActor =
  | { userId: string; agentId?: undefined; tenantId: string | null; role?: SandboxRole }
  | { agentId: string; userId?: undefined; tenantId: string | null; agentVersion?: number | null }

/** A File Editor által előkészített `contentRef` feloldása nyers tartalommá. */
export type ContentResolver = (contentRef: string) => Promise<string>

function isAgent(actor: SandboxActor): actor is Extract<SandboxActor, { agentId: string }> {
  return actor.agentId !== undefined
}

function actorAuditFields(actor: SandboxActor) {
  if (isAgent(actor)) {
    return {
      actorType: 'agent' as const,
      actorId: actor.agentId,
      agentVersion: actor.agentVersion ?? null,
      createdByType: 'agent' as const,
      createdByUserId: null as string | null,
      createdByAgentId: actor.agentId as string | null,
    }
  }
  return {
    actorType: 'human' as const,
    actorId: actor.userId,
    agentVersion: null,
    createdByType: 'user' as const,
    createdByUserId: actor.userId as string | null,
    createdByAgentId: null as string | null,
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

export class SandboxVersioningService {
  constructor(
    private readonly repo: SandboxVersioningRepository,
    private readonly codeStore: CodeTreeStore,
    private readonly dataStore: DataSnapshotStore,
    private readonly audit: AuditRepository,
    private readonly resolveContent: ContentResolver,
  ) {}

  // ── Projekt bootstrap ──────────────────────────────────────────────────────

  async createSandboxProject(
    input: { name: string; description?: string; sandboxId?: string; dataBinding?: Record<string, unknown> },
    actor: SandboxActor,
  ): Promise<{ projectId: string }> {
    this.requireOperator(actor)
    const name = input.name.trim()
    if (name.length < 3 || name.length > 120) {
      throw new SandboxVersionError('SANDBOX_INVALID_INPUT', 'name must be 3-120 characters')
    }
    const project = await this.repo.createProject({
      tenantId: actor.tenantId,
      sandboxId: input.sandboxId ?? null,
      name,
      description: input.description ?? null,
      dataBinding: (input.dataBinding ?? {}) as Prisma.InputJsonValue,
    })
    return { projectId: project.id }
  }

  async listSandboxProjects(input: { sandboxId?: string; limit?: number }, actor: SandboxActor) {
    const projects = await this.repo.listProjects({
      tenantId: actor.tenantId,
      sandboxId: input.sandboxId,
      limit: input.limit,
    })
    return projects.map((p) => ({
      projectId: p.id,
      name: p.name,
      description: p.description ?? undefined,
      testCommitId: p.testCommitId ?? undefined,
      liveCommitId: p.liveCommitId ?? undefined,
      headCommitId: p.headCommitId ?? undefined,
      portability: p.portability,
      updatedAt: p.updatedAt.toISOString(),
    }))
  }

  // ── F-SV-1: commit ─────────────────────────────────────────────────────────

  async createSandboxCommit(
    input: {
      projectId: string
      files: Array<{ path: string; contentRef: string }>
      changeSummary: string
      createdFromTicketId?: string
      createdFromRunId?: string
      buildCost?: Record<string, unknown>
    },
    actor: SandboxActor,
  ): Promise<{ commitId: string; seq: number; treeHash: string }> {
    const project = await this.ensureProject(input.projectId, actor)
    if (!input.changeSummary.trim()) {
      throw new SandboxVersionError('SANDBOX_INVALID_INPUT', 'changeSummary is required')
    }
    if (input.files.length === 0) {
      throw new SandboxVersionError('SANDBOX_INVALID_INPUT', 'at least one file is required')
    }

    const files = await Promise.all(
      input.files.map(async (f) => ({ path: f.path, content: await this.resolveContent(f.contentRef) })),
    )
    const stored = await this.codeStore.putTree({
      tenantId: project.tenantId,
      projectId: project.id,
      files,
    })

    const af = actorAuditFields(actor)
    const commit = await this.repo.createCommitAndAdvanceTest({
      tenantId: project.tenantId,
      projectId: project.id,
      basedOnCommitId: null,
      source: af.createdByType === 'agent' ? 'agent' : 'user',
      changeSummary: input.changeSummary,
      treeRef: stored.treeRef,
      treeHash: stored.treeHash,
      fileCount: stored.fileCount,
      totalSizeBytes: stored.totalSizeBytes,
      createdByType: af.createdByType,
      createdByUserId: af.createdByUserId,
      createdByAgentId: af.createdByAgentId,
      createdFromTicketId: input.createdFromTicketId ?? null,
      createdFromRunId: input.createdFromRunId ?? null,
      buildCost: (input.buildCost ?? {}) as Prisma.InputJsonValue,
    })

    await this.appendAudit(actor, 'sandbox.commit', {
      projectId: project.id,
      commitId: commit.id,
      treeHash: commit.treeHash,
      env: 'test',
      metadata: {
        seq: commit.seq,
        fileCount: commit.fileCount,
        totalSizeBytes: Number(commit.totalSizeBytes),
        createdFromTicketId: input.createdFromTicketId ?? null,
      },
    })

    return { commitId: commit.id, seq: commit.seq, treeHash: commit.treeHash }
  }

  // ── F-SV-2: history + diff + rollback ───────────────────────────────────────

  async getSandboxHistory(
    input: { projectId: string; limit?: number; beforeSeq?: number },
    actor: SandboxActor,
  ) {
    const project = await this.ensureProject(input.projectId, actor)
    const commits = await this.repo.listCommits({
      projectId: project.id,
      limit: input.limit ?? 50,
      beforeSeq: input.beforeSeq,
    })
    return {
      commits: commits.map((c) => ({
        commitId: c.id,
        seq: c.seq,
        source: c.source,
        changeSummary: c.changeSummary,
        treeHash: c.treeHash,
        createdByLabel: c.createdByType === 'agent' ? 'agent' : 'user',
        createdAt: c.createdAt.toISOString(),
        isTest: c.id === project.testCommitId,
        isLive: c.id === project.liveCommitId,
        basedOnCommitId: c.basedOnCommitId ?? undefined,
      })),
      nextCursor: commits.length ? commits[commits.length - 1].seq : undefined,
    }
  }

  async diffSandboxCommits(
    input: { projectId: string; fromCommitId: string; toCommitId: string },
    actor: SandboxActor,
  ): Promise<{ changedFiles: ChangedFile[] }> {
    const project = await this.ensureProject(input.projectId, actor)
    const from = await this.ensureCommit(project.id, input.fromCommitId)
    const to = await this.ensureCommit(project.id, input.toCommitId)

    const fromSources = await this.diffSourcesFor(from)
    const toSources = await this.diffSourcesFor(to)
    const changedFiles = await diffTrees(fromSources, toSources)
    return { changedFiles }
  }

  async rollbackSandboxCode(
    input: { projectId: string; toCommitId: string; reason: string },
    actor: SandboxActor,
  ): Promise<{ commitId: string; seq: number }> {
    // Rollback = KÓD-sín, ember-only operator+ (§4.3). Agent SOHA (invariáns 6/§5.4).
    this.requireHuman(actor)
    this.requireOperator(actor)
    if (!input.reason.trim()) {
      throw new SandboxVersionError('SANDBOX_INVALID_INPUT', 'reason is required for rollback')
    }
    const project = await this.ensureProject(input.projectId, actor)
    const target = await this.ensureCommit(project.id, input.toCommitId)

    // Invariáns 2: NEM töröljük a history-t; új commitot hozunk létre, ami a régi
    // fát állítja vissza (based_on_commit_id = target). A live-t nem érinti.
    const af = actorAuditFields(actor)
    const commit = await this.repo.createCommitAndAdvanceTest({
      tenantId: project.tenantId,
      projectId: project.id,
      basedOnCommitId: target.id,
      source: 'user',
      changeSummary: `Rollback → seq ${target.seq}: ${input.reason.trim()}`,
      treeRef: target.treeRef,
      treeHash: target.treeHash,
      fileCount: target.fileCount,
      totalSizeBytes: Number(target.totalSizeBytes),
      createdByType: af.createdByType,
      createdByUserId: af.createdByUserId,
      createdByAgentId: af.createdByAgentId,
      createdFromTicketId: null,
      createdFromRunId: null,
    })

    await this.appendAudit(actor, 'sandbox.rollback', {
      projectId: project.id,
      commitId: commit.id,
      treeHash: commit.treeHash,
      env: 'test',
      reason: input.reason.trim(),
      metadata: { basedOnCommitId: target.id, basedOnSeq: target.seq, seq: commit.seq },
    })

    return { commitId: commit.id, seq: commit.seq }
  }

  // ── F-SV-3: adat-snapshot / restore ─────────────────────────────────────────

  async createDataSnapshot(
    input: { projectId: string; env: 'test' | 'live'; label?: string; kind?: 'manual' | 'scheduled' },
    actor: SandboxActor,
  ): Promise<{ snapshotId: string; status: 'available'; schemaHash: string }> {
    const project = await this.ensureProject(input.projectId, actor)
    // Az agent CSAK `test` env adatát snapshotolhatja; a `live` ember-only (§5.1/N7).
    if (isAgent(actor) && input.env === 'live') {
      await this.denyLiveAgent(actor, project.id, 'snapshot')
      throw new SandboxVersionError('TOOL_NOT_AUTHORIZED', 'agent cannot snapshot live data')
    }
    if (!isAgent(actor)) this.requireOperator(actor)

    const snapshot = await this.persistSnapshot(project, {
      env: input.env,
      kind: input.kind ?? 'manual',
      actor,
      linkedPromotionId: null,
    })
    return { snapshotId: snapshot.id, status: 'available', schemaHash: snapshot.schemaHash }
  }

  async restoreDataSnapshot(
    input: { projectId: string; snapshotId: string; targetEnv: 'test' | 'live'; reason: string },
    actor: SandboxActor,
  ): Promise<{ snapshotId: string; restoredTo: 'test' | 'live' }> {
    // Restore live → ember-only operator+ (§4.5/N7). Agent SOHA.
    if (isAgent(actor)) {
      await this.denyLiveAgent(actor, input.projectId, 'restore')
      throw new SandboxVersionError('TOOL_NOT_AUTHORIZED', 'agent cannot restore data snapshots')
    }
    this.requireOperator(actor)
    if (!input.reason.trim()) {
      throw new SandboxVersionError('SANDBOX_INVALID_INPUT', 'reason is required for restore')
    }
    const project = await this.ensureProject(input.projectId, actor)
    const snapshot = await this.repo.findSnapshotById(input.snapshotId)
    if (!snapshot || snapshot.projectId !== project.id) {
      throw new SandboxVersionError('SNAPSHOT_NOT_FOUND', 'snapshot not found')
    }

    // A felülírás előtt kötelező pre_rollback snapshot a cél-környezetről (§4.5).
    await this.persistSnapshot(project, {
      env: input.targetEnv,
      kind: 'pre_rollback',
      actor,
      linkedPromotionId: null,
    })

    await this.repo.updateSnapshot(snapshot.id, { status: 'restoring' })
    await this.dataStore.restore({ snapshotRef: snapshot.snapshotRef, targetEnv: input.targetEnv })
    await this.repo.updateSnapshot(snapshot.id, { status: 'available' })

    await this.appendAudit(actor, 'sandbox.snapshot.restore', {
      projectId: project.id,
      snapshotId: snapshot.id,
      schemaHash: snapshot.schemaHash,
      env: input.targetEnv,
      reason: input.reason.trim(),
      metadata: { kind: snapshot.kind },
    })

    return { snapshotId: snapshot.id, restoredTo: input.targetEnv }
  }

  async listDataSnapshots(input: { projectId: string; env?: 'test' | 'live' }, actor: SandboxActor) {
    const project = await this.ensureProject(input.projectId, actor)
    const snapshots = await this.repo.listSnapshots({ projectId: project.id, env: input.env })
    return snapshots.map((s) => this.toSnapshotView(s))
  }

  // ── F-SV-4: promóció + go-live kapu ─────────────────────────────────────────

  async requestPromotion(
    input: { projectId: string; reason?: string },
    actor: SandboxActor,
  ): Promise<{ promotionId: string; status: 'pending_approval'; fromCommitId: string }> {
    if (!isAgent(actor)) this.requireOperator(actor)
    const project = await this.ensureProject(input.projectId, actor)
    if (!project.testCommitId) {
      throw new SandboxVersionError('SANDBOX_INVALID_INPUT', 'no test commit to promote')
    }

    const af = actorAuditFields(actor)
    const promotion = await this.repo.createPromotion({
      tenantId: project.tenantId,
      projectId: project.id,
      fromCommitId: project.testCommitId,
      prevLiveCommitId: project.liveCommitId,
      requestedByType: af.createdByType === 'agent' ? 'agent' : 'user',
      requestedByUserId: af.createdByUserId,
      requestedByAgentId: af.createdByAgentId,
      reason: input.reason ?? null,
    })

    await this.appendAudit(actor, 'sandbox.promote.request', {
      projectId: project.id,
      commitId: project.testCommitId,
      env: 'test',
      reason: input.reason ?? null,
      metadata: { promotionId: promotion.id, prevLiveCommitId: project.liveCommitId },
    })

    return { promotionId: promotion.id, status: 'pending_approval', fromCommitId: project.testCommitId }
  }

  async approvePromotion(
    input: { promotionId: string; decision: 'approve' | 'reject'; reason?: string },
    actor: SandboxActor,
  ): Promise<{ promotionId: string; status: 'promoted' | 'rejected'; liveCommitId?: string }> {
    // KEMÉNY PADLÓ (invariáns 3, §6.3): a jóváhagyás KIZÁRÓLAG ember-only operator+.
    // Agent → TOOL_NOT_AUTHORIZED (nincs ilyen capability, N2).
    if (isAgent(actor)) {
      await this.denyLiveAgent(actor, undefined, 'approve_promotion')
      throw new SandboxVersionError('TOOL_NOT_AUTHORIZED', 'agent cannot approve promotions')
    }
    this.requireOperator(actor)

    const promotion = await this.repo.findPromotionById(input.promotionId)
    if (!promotion) throw new SandboxVersionError('PROMOTION_NOT_FOUND', 'promotion not found')
    const project = await this.ensureProject(promotion.projectId, actor)
    if (promotion.status !== 'pending_approval') {
      throw new SandboxVersionError('PROMOTION_ALREADY_DECIDED', `promotion is ${promotion.status}`)
    }

    const decidedAt = new Date()
    const decided = await this.repo.decidePendingPromotion(promotion.id, {
      status: input.decision === 'reject' ? 'rejected' : 'approved',
      approvedByUserId: actor.userId,
      reason: input.reason ?? null,
      decidedAt,
    })
    if (!decided) {
      throw new SandboxVersionError('PROMOTION_ALREADY_DECIDED', 'promotion decision is already in progress or completed')
    }

    if (input.decision === 'reject') {
      await this.appendAudit(actor, 'sandbox.promote.reject', {
        projectId: project.id,
        commitId: decided.fromCommitId,
        env: 'live',
        reason: input.reason ?? null,
        approvedByUserId: actor.userId,
        metadata: { promotionId: decided.id },
      })
      return { promotionId: decided.id, status: 'rejected' }
    }

    // A from_commit legyen még a `test` aktuális feje (stale-védelem).
    if (decided.fromCommitId !== project.testCommitId) {
      await this.repo.updatePromotion(decided.id, { status: 'rejected', reason: 'test head moved since request' })
      await this.appendAudit(actor, 'sandbox.promote.reject', {
        projectId: project.id,
        commitId: decided.fromCommitId,
        env: 'live',
        approvedByUserId: actor.userId,
        metadata: { promotionId: decided.id, reason: 'test_head_moved' },
        policyDecision: 'denied',
      })
      throw new SandboxVersionError('PROMOTION_STALE_HEAD', 'test head moved since request')
    }

    // Invariáns 4: KÖTELEZŐ pre-promotion snapshot a LIVE adatról. Ha nem áll elő,
    // a promóció `failed`, nem `promoted` (N5).
    let snapshot: { id: string; schemaHash: string }
    try {
      snapshot = await this.persistSnapshot(project, {
        env: 'live',
        kind: 'pre_promotion',
        actor,
        linkedPromotionId: decided.id,
      })
    } catch (err) {
      await this.repo.updatePromotion(decided.id, {
        status: 'rejected',
        decidedAt: new Date(),
        reason: 'pre-promotion snapshot failed',
      })
      throw new SandboxVersionError(
        'PROMOTION_FAILED_NO_SNAPSHOT',
        'pre-promotion live snapshot failed; live_commit_id unchanged',
        { cause: err instanceof Error ? err.message : String(err) },
      )
    }

    const promotedAt = new Date()
    const promoted = await this.repo.promoteApprovedPromotion({
      promotionId: decided.id,
      projectId: project.id,
      fromCommitId: decided.fromCommitId,
      prePromotionSnapshotId: snapshot.id,
      reason: input.reason ?? decided.reason,
      promotedAt,
    })
    if (!promoted) {
      await this.repo.updatePromotion(decided.id, { status: 'rejected', reason: 'test head moved during approval' })
      await this.appendAudit(actor, 'sandbox.promote.reject', {
        projectId: project.id,
        commitId: decided.fromCommitId,
        env: 'live',
        approvedByUserId: actor.userId,
        metadata: { promotionId: decided.id, reason: 'test_head_moved_during_approval' },
        policyDecision: 'denied',
      })
      throw new SandboxVersionError('PROMOTION_STALE_HEAD', 'test head moved during approval')
    }

    await this.appendAudit(actor, 'sandbox.promote.approve', {
      projectId: project.id,
      commitId: decided.fromCommitId,
      env: 'live',
      reason: input.reason ?? null,
      approvedByUserId: actor.userId,
      snapshotId: snapshot.id,
      schemaHash: snapshot.schemaHash,
      metadata: { promotionId: decided.id, prevLiveCommitId: decided.prevLiveCommitId },
    })

    return { promotionId: promoted.id, status: 'promoted', liveCommitId: decided.fromCommitId }
  }

  async listPromotions(input: { projectId: string; status?: SandboxPromotion['status'] }, actor: SandboxActor) {
    const project = await this.ensureProject(input.projectId, actor)
    const rows = await this.repo.listPromotions({ projectId: project.id, status: input.status })
    return rows.map((p) => ({
      promotionId: p.id,
      status: p.status,
      fromCommitId: p.fromCommitId,
      prevLiveCommitId: p.prevLiveCommitId ?? undefined,
      requestedByLabel: p.requestedByType === 'agent' ? 'agent' : 'user',
      approvedByUserId: p.approvedByUserId ?? undefined,
      reason: p.reason ?? undefined,
      requestedAt: p.requestedAt.toISOString(),
      promotedAt: p.promotedAt?.toISOString(),
    }))
  }

  // ── F-SV-5: graduation / export ─────────────────────────────────────────────

  async requestExport(
    input: {
      projectId: string
      scope: 'code_only' | 'code_and_schema' | 'full'
      sourceCommitId?: string
      sourceSnapshotId?: string
      markResponsibilityTransfer?: boolean
    },
    actor: SandboxActor,
  ): Promise<{ exportId: string; status: 'ready' | 'failed'; packageHash?: string }> {
    // Export KIZÁRÓLAG ember-only operator+ (invariáns 6, N3). Agent SOHA.
    if (isAgent(actor)) {
      await this.denyLiveAgent(actor, input.projectId, 'export')
      throw new SandboxVersionError('TOOL_NOT_AUTHORIZED', 'agent cannot export (graduation)')
    }
    this.requireOperator(actor)
    if (input.markResponsibilityTransfer && !this.hasRole(actor, 'admin')) {
      throw new SandboxVersionError('FORBIDDEN_ROLE', 'responsibility transfer requires admin')
    }

    const project = await this.ensureProject(input.projectId, actor)
    const sourceCommitId = input.sourceCommitId ?? project.liveCommitId
    if (!sourceCommitId) {
      throw new SandboxVersionError('SANDBOX_INVALID_INPUT', 'no source commit (live_commit_id is empty)')
    }
    const commit = await this.ensureCommit(project.id, sourceCommitId)

    if (input.scope === 'full' && !input.sourceSnapshotId) {
      throw new SandboxVersionError('EXPORT_SNAPSHOT_REQUIRED', 'full export requires a sourceSnapshotId')
    }
    let snapshot: SandboxDataSnapshot | null = null
    if (input.sourceSnapshotId) {
      snapshot = await this.repo.findSnapshotById(input.sourceSnapshotId)
      if (!snapshot || snapshot.projectId !== project.id) {
        throw new SandboxVersionError('SNAPSHOT_NOT_FOUND', 'source snapshot not found')
      }
    }

    const exportRow = await this.repo.createExport({
      tenantId: project.tenantId,
      projectId: project.id,
      scope: input.scope,
      sourceCommitId: commit.id,
      sourceSnapshotId: snapshot?.id ?? null,
      requestedByUserId: actor.userId,
      responsibilityTransferred: input.markResponsibilityTransfer ?? false,
    })

    await this.appendAudit(actor, 'sandbox.export.request', {
      projectId: project.id,
      commitId: commit.id,
      treeHash: commit.treeHash,
      snapshotId: snapshot?.id ?? null,
      schemaHash: snapshot?.schemaHash,
      metadata: { exportId: exportRow.id, scope: input.scope },
    })

    // Determinisztikus, reprodukálható package_hash a hash-ekből (§7.2, SV7).
    const manifest = {
      projectId: project.id,
      projectName: project.name,
      scope: input.scope,
      commitId: commit.id,
      treeHash: commit.treeHash,
      schemaHash: snapshot?.schemaHash ?? null,
      snapshotId: snapshot?.id ?? null,
      exportedByUserId: actor.userId,
      exportedAt: new Date().toISOString(),
      portability: project.portability,
      responsibilityTransferred: input.markResponsibilityTransfer ?? false,
    }
    const packageHash = `sha256:${sha256(
      [input.scope, commit.treeHash, snapshot?.schemaHash ?? '', snapshot?.id ?? ''].join('|'),
    )}`
    const packageRef = `sandbox-exports/${project.tenantId ?? '_global'}/${project.id}/${exportRow.id}/package.tar.zst`

    const ready = await this.repo.updateExport(exportRow.id, {
      status: 'ready',
      packageRef,
      packageHash,
      manifest: manifest as unknown as Prisma.InputJsonValue,
      completedAt: new Date(),
    })

    await this.appendAudit(actor, 'sandbox.export.ready', {
      projectId: project.id,
      commitId: commit.id,
      treeHash: commit.treeHash,
      metadata: { exportId: ready.id, scope: input.scope, packageHash },
    })

    return { exportId: ready.id, status: 'ready', packageHash }
  }

  async getExport(input: { exportId: string }, actor: SandboxActor) {
    const exportRow = await this.repo.findExportById(input.exportId)
    if (!exportRow) throw new SandboxVersionError('EXPORT_NOT_FOUND', 'export not found')
    await this.ensureProject(exportRow.projectId, actor)
    return {
      exportId: exportRow.id,
      status: exportRow.status,
      scope: exportRow.scope,
      packageRef: exportRow.packageRef ?? undefined,
      packageHash: exportRow.packageHash ?? undefined,
      manifest: exportRow.manifest,
      responsibilityTransferred: exportRow.responsibilityTransferred,
    }
  }

  async markExportDelivered(input: { exportId: string }, actor: SandboxActor) {
    this.requireHuman(actor)
    const exportRow = await this.repo.findExportById(input.exportId)
    if (!exportRow) throw new SandboxVersionError('EXPORT_NOT_FOUND', 'export not found')
    const project = await this.ensureProject(exportRow.projectId, actor)
    await this.repo.updateExport(exportRow.id, { status: 'delivered' })
    await this.appendAudit(actor, 'sandbox.export.delivered', {
      projectId: project.id,
      commitId: exportRow.sourceCommitId,
      metadata: { exportId: exportRow.id, packageHash: exportRow.packageHash },
    })
    return { exportId: exportRow.id, status: 'delivered' as const }
  }

  // ── Belső segédek ────────────────────────────────────────────────────────────

  private async persistSnapshot(
    project: { id: string; tenantId: string | null; dataBinding: unknown },
    params: {
      env: 'test' | 'live'
      kind: 'manual' | 'pre_promotion' | 'scheduled' | 'pre_rollback'
      actor: SandboxActor
      linkedPromotionId: string | null
    },
  ): Promise<SandboxDataSnapshot & { schemaHash: string }> {
    const af = actorAuditFields(params.actor)
    // 1) DB-sor `creating` állapotban → 2) tényleges dump → 3) `available`.
    const row = await this.repo.createSnapshot({
      tenantId: project.tenantId,
      projectId: project.id,
      env: params.env,
      kind: params.kind,
      status: 'creating',
      snapshotRef: '',
      schemaHash: '',
      rowCount: null,
      sizeBytes: null,
      createdByType: af.createdByType,
      createdByUserId: af.createdByUserId,
      linkedPromotionId: params.linkedPromotionId,
      expiresAt: null,
    })

    const created = await this.dataStore.snapshot({
      tenantId: project.tenantId,
      projectId: project.id,
      env: params.env,
      snapshotId: row.id,
      dataBinding: project.dataBinding,
    })

    // A store-ból jövő ref/hash/méret visszaírása + státusz `available`.
    const finalized = await this.repo.updateSnapshot(row.id, {
      status: 'available',
      snapshotRef: created.snapshotRef,
      schemaHash: created.schemaHash,
      rowCount: created.rowCount,
      sizeBytes: created.sizeBytes,
    })

    await this.appendAudit(params.actor, 'sandbox.snapshot.create', {
      projectId: project.id,
      snapshotId: finalized.id,
      schemaHash: finalized.schemaHash,
      env: params.env,
      metadata: { kind: params.kind, linkedPromotionId: params.linkedPromotionId },
    })

    return finalized as SandboxDataSnapshot & { schemaHash: string }
  }

  private async diffSourcesFor(commit: SandboxCommit): Promise<Map<string, DiffFileSource>> {
    const manifest = await this.codeStore.getManifest(commit.treeRef)
    const map = new Map<string, DiffFileSource>()
    for (const entry of manifest) {
      map.set(entry.path, {
        entry,
        loadContent: async () => (await this.codeStore.getFile(commit.treeRef, entry.path)) ?? '',
      })
    }
    return map
  }

  private toSnapshotView(s: SandboxDataSnapshot) {
    return {
      snapshotId: s.id,
      env: s.env,
      kind: s.kind,
      status: s.status,
      schemaHash: s.schemaHash,
      rowCount: s.rowCount != null ? Number(s.rowCount) : undefined,
      sizeBytes: s.sizeBytes != null ? Number(s.sizeBytes) : undefined,
      createdByLabel: s.createdByType === 'agent' ? 'agent' : 'user',
      linkedPromotionId: s.linkedPromotionId ?? undefined,
      createdAt: s.createdAt.toISOString(),
    }
  }

  private hasRole(actor: SandboxActor, min: SandboxRole): boolean {
    if (isAgent(actor)) return false
    if (!actor.role) return true // a role-kényszer az action/RBAC rétegben; itt csak admin-flag
    return ROLE_RANK[actor.role] >= ROLE_RANK[min]
  }

  private requireOperator(actor: SandboxActor): void {
    if (isAgent(actor)) return // agent-jog a Tool Broker capability-gate-jén dől el
    if (actor.role && ROLE_RANK[actor.role] < ROLE_RANK.operator) {
      throw new SandboxVersionError('FORBIDDEN_ROLE', 'operator+ role required')
    }
  }

  private requireHuman(actor: SandboxActor): void {
    if (isAgent(actor)) {
      throw new SandboxVersionError('FORBIDDEN_AGENT_ACTION', 'human-only action')
    }
  }

  private async ensureProject(projectId: string, actor: SandboxActor) {
    const project = await this.repo.findProjectById(projectId)
    if (!project) throw new SandboxVersionError('SANDBOX_NOT_FOUND_OR_FORBIDDEN', 'project not found')
    if (project.tenantId !== actor.tenantId) {
      await this.appendAudit(actor, 'sandbox.access_denied', {
        projectId: project.id,
        metadata: { reason: 'tenant_mismatch', actorTenant: actor.tenantId, projectTenant: project.tenantId },
      })
      throw new SandboxVersionError('SANDBOX_NOT_FOUND_OR_FORBIDDEN', 'project access denied')
    }
    return project
  }

  private async ensureCommit(projectId: string, commitId: string): Promise<SandboxCommit> {
    const commit = await this.repo.findCommitById(commitId)
    if (!commit || commit.projectId !== projectId) {
      throw new SandboxVersionError('COMMIT_NOT_FOUND', 'commit not found')
    }
    return commit
  }

  private async denyLiveAgent(actor: SandboxActor, projectId: string | undefined, op: string): Promise<void> {
    await this.appendAudit(actor, 'sandbox.access_denied', {
      projectId: projectId ?? null,
      metadata: { reason: 'agent_forbidden', op },
      policyDecision: 'denied',
    })
  }

  private async appendAudit(
    actor: SandboxActor,
    action: string,
    args: {
      projectId?: string | null
      commitId?: string | null
      treeHash?: string | null
      snapshotId?: string | null
      schemaHash?: string | null
      env?: 'test' | 'live'
      reason?: string | null
      approvedByUserId?: string | null
      policyDecision?: 'allowed' | 'denied'
      metadata?: Record<string, unknown>
    },
  ): Promise<void> {
    const af = actorAuditFields(actor)
    // §8.2: kód-/adattartalom SOHA nem kerül auditba — csak referencia, hash, meta (N10).
    const metadata: Record<string, unknown> = {
      ...(args.env ? { env: args.env } : {}),
      ...(args.commitId ? { commitId: args.commitId } : {}),
      ...(args.treeHash ? { treeHash: args.treeHash } : {}),
      ...(args.snapshotId ? { snapshotId: args.snapshotId } : {}),
      ...(args.schemaHash ? { schemaHash: args.schemaHash } : {}),
      ...(args.approvedByUserId ? { approvedByUserId: args.approvedByUserId } : {}),
      ...(args.reason ? { reason: args.reason } : {}),
      ...(args.metadata ?? {}),
    }
    await this.audit.append({
      actorType: af.actorType,
      actorId: af.actorId,
      agentVersion: af.agentVersion,
      action,
      targetType: 'sandbox_project',
      targetId: args.projectId ?? null,
      modelUsed: null,
      inputRef: null,
      outputRef: args.treeHash ?? args.schemaHash ?? null,
      policyDecision: args.policyDecision ?? 'allowed',
      metadata: metadata as unknown as Prisma.JsonValue,
    })
  }
}
