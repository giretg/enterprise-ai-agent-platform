import type { AutoApprovePolicy, CapabilityDiff, UsageRef } from './spec-diff'
import { computeCapabilityDiff, isAutoApprovable } from './spec-diff'
import { parseCapabilitySet, type CapabilitySet } from './capability-set'
import type { SpecSyncResult } from './spec-sync'

export type SelfUpdateActor = {
  id: string
  tenantId: string
  /** Platform superadmin: SoD (T2) alól felmentve — egyedül is élesíthet. */
  sodExempt?: boolean
}

export type SelfUpdatingConnector = {
  id: string
  tenantId: string
  name: string
  activeSpecVersionId: string | null
}

export type SelfUpdatingSpecSource = {
  id: string
  connectorId: string
  tenantId: string
  specUrl: string
  createdById: string
  urlApprovedById: string | null
  urlApprovedAt: Date | null
  trustedById: string | null
  trustedAt: Date | null
  autoApprovePolicy: AutoApprovePolicy | null
  lastSyncedAt: Date | null
}

export type SelfUpdatingSpecVersion = {
  id: string
  connectorId: string
  tenantId: string
  versionNo: number
  rawHash: string
  capabilitySet: unknown
  status: 'proposed' | 'approved' | 'superseded' | 'rejected' | 'rolled_back'
  diffFromVersionId: string | null
  diffSummary: CapabilityDiff | null
  fetchedAt: Date
  approvedById: string | null
  approvedAt: Date | null
}

export type SelfUpdatingContext = {
  connector: SelfUpdatingConnector
  source: SelfUpdatingSpecSource
  activeVersion: SelfUpdatingSpecVersion | null
  tenantAutoApproveEnabled: boolean
}

export interface SelfUpdatingConnectorRepository {
  readonly atomicAudit?: boolean
  create(input: {
    connectorId?: string
    tenantId: string
    name: string
    specUrl: string
    secretAlias: string
    createdById: string
  }): Promise<SelfUpdatingContext>
  deleteUninitialized(connectorId: string, tenantId: string): Promise<void>
  findContext(connectorId: string, tenantId: string): Promise<SelfUpdatingContext | null>
  approveUrl(input: {
    sourceId: string
    connectorId: string
    tenantId: string
    actorId: string
    at: Date
    auditMetadata?: Record<string, unknown>
  }): Promise<void>
  markTrusted(input: {
    sourceId: string
    connectorId: string
    tenantId: string
    actorId: string
    at: Date
    auditMetadata?: Record<string, unknown>
  }): Promise<void>
  updatePolicy(input: { sourceId: string; connectorId: string; tenantId: string; actorId: string; policy: AutoApprovePolicy }): Promise<void>
  listUsage(connectorId: string, tenantId: string): Promise<Record<string, UsageRef[]>>
  findOpenProposalByHash(connectorId: string, tenantId: string, rawHash: string): Promise<SelfUpdatingSpecVersion | null>
  createProposal(input: {
    connectorId: string
    tenantId: string
    rawSnapshot: string
    rawHash: string
    capabilitySet: CapabilitySet
    diffFromVersionId: string | null
    diffSummary: CapabilityDiff
    fetchedAt: Date
    actorId: string
  }): Promise<SelfUpdatingSpecVersion>
  activateVersion(input: {
    connectorId: string
    tenantId: string
    versionId: string
    actorId: string
    approvedById: string | null
    approvedAt: Date
    auditMetadata?: Record<string, unknown>
  }): Promise<SelfUpdatingSpecVersion>
  rejectVersion(input: {
    connectorId: string
    tenantId: string
    versionId: string
    actorId: string
  }): Promise<SelfUpdatingSpecVersion>
  rollback(input: {
    connectorId: string
    tenantId: string
    targetVersionId: string
    actorId: string
    at: Date
  }): Promise<SelfUpdatingSpecVersion>
  listVersions(connectorId: string, tenantId: string): Promise<SelfUpdatingSpecVersion[]>
  touchSynced(sourceId: string, at: Date): Promise<void>
}

export interface SelfUpdateAudit {
  append(input: {
    action: string
    actorId: string | null
    tenantId: string
    connectorId: string
    policyDecision: string
    metadata?: Record<string, unknown>
  }): Promise<void>
}

export class SelfUpdateError extends Error {
  constructor(
    public readonly code:
      | 'NOT_FOUND'
      | 'TENANT_ISOLATION'
      | 'SEPARATION_OF_DUTIES'
      | 'URL_NOT_APPROVED'
      | 'PARTNER_NOT_TRUSTED'
      | 'INVALID_STATE'
      | 'INVALID_CAPABILITY_SET',
    message: string,
  ) {
    super(message)
    this.name = 'SelfUpdateError'
  }
}

type SyncEngine = { sync(specUrl: string, providerHint?: string): Promise<SpecSyncResult> }

/**
 * Az önfrissítő connector publikus domain-seamje. A repository felel az atomi DB-
 * állapotváltásokért; a service a tenant-, SoD-, trust-, diff- és auto-approve kapukat
 * kényszeríti ki, és minden átmenetet auditál.
 */
export class SelfUpdatingConnectorService {
  constructor(
    private readonly repo: SelfUpdatingConnectorRepository,
    private readonly syncEngine: SyncEngine,
    private readonly audit: SelfUpdateAudit,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async create(
    input: { connectorId?: string; name: string; specUrl: string; secretAlias: string },
    actor: SelfUpdateActor,
  ): Promise<SelfUpdatingContext> {
    const context = await this.repo.create({ ...input, tenantId: actor.tenantId, createdById: actor.id })
    try {
      if (this.repo.atomicAudit) return context
      await this.record('connector.self_update.create', actor, context.connector.id, 'pending_approval')
    } catch (error) {
      // A create csak akkor tekinthető sikeresnek, ha az audit-hash-lánc is megkapta.
      // A friss, verzió nélküli sort kompenzáljuk; az action ezután a secretet is törli.
      await this.repo.deleteUninitialized(context.connector.id, actor.tenantId).catch(() => {})
      throw error
    }
    return context
  }

  async approveUrl(connectorId: string, actor: SelfUpdateActor): Promise<void> {
    const ctx = await this.context(connectorId, actor)
    this.requireDifferentActor(ctx.source.createdById, actor, 'A linket másik kollégának kell jóváhagynia.')
    const at = this.now()
    const auditMetadata = this.sodMeta(actor, ctx.source.createdById)
    await this.repo.approveUrl({
      sourceId: ctx.source.id, connectorId, tenantId: actor.tenantId, actorId: actor.id, at, auditMetadata,
    })
    if (!this.repo.atomicAudit) {
      await this.record('connector.self_update.source.approve', actor, connectorId, 'allowed', auditMetadata)
    }
  }

  async markTrusted(connectorId: string, actor: SelfUpdateActor): Promise<void> {
    const ctx = await this.context(connectorId, actor)
    this.requireDifferentActor(ctx.source.createdById, actor, 'A megbízható minősítést másik kollégának kell megadnia.')
    const at = this.now()
    const auditMetadata = this.sodMeta(actor, ctx.source.createdById)
    await this.repo.markTrusted({
      sourceId: ctx.source.id, connectorId, tenantId: actor.tenantId, actorId: actor.id, at, auditMetadata,
    })
    if (!this.repo.atomicAudit) {
      await this.record('connector.self_update.trust.approve', actor, connectorId, 'allowed', auditMetadata)
    }
  }

  async updatePolicy(
    connectorId: string,
    policy: AutoApprovePolicy,
    actor: SelfUpdateActor,
  ): Promise<void> {
    const ctx = await this.context(connectorId, actor)
    // Az MVP csak read-only addíciót enged automatikusan; write opt-in sem kapcsolható be UI/API felől.
    const safePolicy: AutoApprovePolicy = { enabled: policy.enabled === true, allowAddedWrite: false }
    await this.repo.updatePolicy({ sourceId: ctx.source.id, connectorId, tenantId: actor.tenantId, actorId: actor.id, policy: safePolicy })
    if (!this.repo.atomicAudit) await this.record('connector.self_update.policy.update', actor, connectorId, 'allowed', safePolicy)
  }

  async sync(connectorId: string, actor: SelfUpdateActor): Promise<
    | { kind: 'failed'; reason: string; detail?: string }
    | { kind: 'unchanged'; activeVersionId: string | null }
    | { kind: 'proposed'; version: SelfUpdatingSpecVersion; autoApproved: boolean }
  > {
    const ctx = await this.context(connectorId, actor)
    if (!ctx.source.urlApprovedAt) throw new SelfUpdateError('URL_NOT_APPROVED', 'A link még nincs jóváhagyva.')
    if (!ctx.source.trustedAt) throw new SelfUpdateError('PARTNER_NOT_TRUSTED', 'A partner még nincs megbízhatónak minősítve.')

    const result = await this.syncEngine.sync(ctx.source.specUrl, ctx.connector.name)
    if (!result.ok) {
      await this.record('connector.self_update.sync.failed', actor, connectorId, result.reason, {
        reason: result.reason,
        detail: result.detail ?? null,
        active_version_id: ctx.connector.activeSpecVersionId,
      })
      return { kind: 'failed', reason: result.reason, ...(result.detail ? { detail: result.detail } : {}) }
    }

    if (ctx.activeVersion?.rawHash === result.rawHash) {
      await this.repo.touchSynced(ctx.source.id, this.now())
      await this.record('connector.self_update.sync.no_change', actor, connectorId, 'unchanged', {
        raw_hash: result.rawHash,
      })
      return { kind: 'unchanged', activeVersionId: ctx.connector.activeSpecVersionId }
    }

    const existingProposal = await this.repo.findOpenProposalByHash(connectorId, actor.tenantId, result.rawHash)
    if (existingProposal) {
      await this.repo.touchSynced(ctx.source.id, this.now())
      await this.record('connector.self_update.sync.no_change', actor, connectorId, 'proposal_already_exists', {
        raw_hash: result.rawHash,
        version_id: existingProposal.id,
      })
      return { kind: 'proposed', version: existingProposal, autoApproved: false }
    }

    const current = ctx.activeVersion ? parseCapabilitySet(ctx.activeVersion.capabilitySet) : null
    if (ctx.activeVersion && !current) {
      throw new SelfUpdateError('INVALID_CAPABILITY_SET', 'Az aktív pillanatkép nem értelmezhető; semmi nem változott.')
    }
    const usage = await this.repo.listUsage(connectorId, actor.tenantId)
    const diff = computeCapabilityDiff(current, result.capabilitySet, (op) => {
      const path = op.includes(' ') ? op.slice(op.indexOf(' ') + 1) : op
      const refs = [...(usage[op] ?? []), ...(usage[`PATH ${path}`] ?? []), ...(usage['*'] ?? [])]
      return [...new Map(refs.map((ref) => [`${ref.type}:${ref.id}`, ref])).values()]
    })
    const fetchedAt = this.now()
    const version = await this.repo.createProposal({
      connectorId,
      tenantId: actor.tenantId,
      rawSnapshot: result.rawText,
      rawHash: result.rawHash,
      capabilitySet: result.capabilitySet,
      diffFromVersionId: ctx.activeVersion?.id ?? null,
      diffSummary: diff,
      fetchedAt,
      actorId: actor.id,
    })
    await this.repo.touchSynced(ctx.source.id, fetchedAt)

    const autoApproved = Boolean(
      ctx.activeVersion &&
        ctx.tenantAutoApproveEnabled &&
        isAutoApprovable(diff, ctx.source.autoApprovePolicy),
    )
    const finalVersion = autoApproved
      ? await this.repo.activateVersion({
          connectorId,
          tenantId: actor.tenantId,
          versionId: version.id,
          approvedById: null,
          approvedAt: fetchedAt,
          actorId: actor.id,
        })
      : version
    if (!this.repo.atomicAudit) await this.record(
      autoApproved ? 'connector.self_update.version.auto_approve' : 'connector.self_update.sync.proposed',
      autoApproved ? null : actor,
      connectorId,
      autoApproved ? 'auto_approved' : 'human_approval_required',
      { version_id: version.id, version_no: version.versionNo, diff },
      actor.tenantId,
    )
    return { kind: 'proposed', version: finalVersion, autoApproved }
  }

  async approveVersion(connectorId: string, versionId: string, actor: SelfUpdateActor) {
    const ctx = await this.context(connectorId, actor)
    if (!ctx.source.trustedAt || !ctx.source.urlApprovedAt) {
      throw new SelfUpdateError('INVALID_STATE', 'A link és a partner jóváhagyása szükséges.')
    }
    if (!ctx.activeVersion) {
      this.requireDifferentActor(
        ctx.source.createdById,
        actor,
        'Az első verziót nem hagyhatja jóvá a link beállítója.',
      )
    }
    const sod = this.sodMeta(actor, ctx.source.createdById)
    const version = await this.repo.activateVersion({
      connectorId,
      tenantId: actor.tenantId,
      versionId,
      approvedById: actor.id,
      approvedAt: this.now(),
      actorId: actor.id,
      auditMetadata: sod,
    })
    if (!this.repo.atomicAudit) await this.record('connector.self_update.version.approve', actor, connectorId, 'allowed', {
      version_id: version.id,
      version_no: version.versionNo,
      previous_version_id: ctx.activeVersion?.id ?? null,
      ...sod,
    })
    return version
  }

  async rejectVersion(connectorId: string, versionId: string, actor: SelfUpdateActor) {
    await this.context(connectorId, actor)
    const version = await this.repo.rejectVersion({ connectorId, tenantId: actor.tenantId, versionId, actorId: actor.id })
    if (!this.repo.atomicAudit) await this.record('connector.self_update.version.reject', actor, connectorId, 'rejected', {
      version_id: version.id,
      version_no: version.versionNo,
    })
    return version
  }

  async rollback(connectorId: string, targetVersionId: string, actor: SelfUpdateActor) {
    const ctx = await this.context(connectorId, actor)
    if (ctx.connector.activeSpecVersionId === targetVersionId) {
      throw new SelfUpdateError('INVALID_STATE', 'Ez a verzió már jelenleg is aktív.')
    }
    const version = await this.repo.rollback({
      connectorId,
      tenantId: actor.tenantId,
      targetVersionId,
      actorId: actor.id,
      at: this.now(),
    })
    if (!this.repo.atomicAudit) await this.record('connector.self_update.version.rollback', actor, connectorId, 'allowed', {
      from_version_id: ctx.connector.activeSpecVersionId,
      to_version_id: version.id,
      to_version_no: version.versionNo,
    })
    return version
  }

  async detail(connectorId: string, actor: SelfUpdateActor) {
    const context = await this.context(connectorId, actor)
    const versions = await this.repo.listVersions(connectorId, actor.tenantId)
    return { context, versions }
  }

  private async context(connectorId: string, actor: SelfUpdateActor): Promise<SelfUpdatingContext> {
    const ctx = await this.repo.findContext(connectorId, actor.tenantId)
    if (!ctx) throw new SelfUpdateError('NOT_FOUND', 'Az önfrissítő kapcsolat nem található.')
    if (ctx.connector.tenantId !== actor.tenantId || ctx.source.tenantId !== actor.tenantId) {
      throw new SelfUpdateError('TENANT_ISOLATION', 'A kapcsolat nem érhető el ebben a tenantban.')
    }
    return ctx
  }

  private requireDifferentActor(configuredById: string, actor: SelfUpdateActor, message: string) {
    if (configuredById === actor.id && !actor.sodExempt) {
      throw new SelfUpdateError('SEPARATION_OF_DUTIES', message)
    }
  }

  private sodMeta(actor: SelfUpdateActor, configuredById: string): Record<string, unknown> | undefined {
    if (configuredById === actor.id && actor.sodExempt) return { sod_bypass: 'superadmin' }
    return undefined
  }

  private async record(
    action: string,
    actor: SelfUpdateActor | null,
    connectorId: string,
    policyDecision: string,
    metadata?: Record<string, unknown>,
    tenantId?: string,
  ) {
    await this.audit.append({
      action,
      actorId: actor?.id ?? null,
      tenantId: actor?.tenantId ?? tenantId!,
      connectorId,
      policyDecision,
      metadata,
    })
  }
}
