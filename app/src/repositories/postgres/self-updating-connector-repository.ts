import { Prisma, type ConnectorSpecSource, type ConnectorSpecVersion } from '@prisma/client'
import { prisma } from '@/lib/db'
import type { AutoApprovePolicy, CapabilityDiff, UsageRef } from '@/domain/connector-self-update/spec-diff'
import type { CapabilitySet } from '@/domain/connector-self-update/capability-set'
import {
  SelfUpdateError,
  type SelfUpdatingConnectorRepository,
  type SelfUpdatingContext,
  type SelfUpdatingSpecSource,
  type SelfUpdatingSpecVersion,
} from '@/domain/connector-self-update/self-update-service'
import { tenantSelfUpdateAutoApproveEnabled } from '@/domain/connector-self-update/tenant-settings'
import { appendAuditInTransaction } from './audit-repository'
import { withConnectorPrivacySlot } from '@/lib/privacy-slot'

type TransactionAuditInput = Parameters<typeof appendAuditInTransaction>[1]

function connectorAudit(input: {
  action: string
  actorId: string | null
  tenantId: string
  connectorId: string
  policyDecision: string
  metadata?: Record<string, unknown>
}): TransactionAuditInput {
  return {
    actorType: input.actorId ? 'human' : 'system',
    actorId: input.actorId,
    agentVersion: null,
    action: input.action,
    targetType: 'connector',
    targetId: input.connectorId,
    modelUsed: null,
    inputRef: null,
    outputRef: null,
    policyDecision: input.policyDecision,
    metadata: {
      tenant_id: input.tenantId,
      ...(input.metadata ?? {}),
    } as Prisma.JsonValue,
  }
}

function policyOf(value: unknown): AutoApprovePolicy | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  return { enabled: raw.enabled === true, allowAddedWrite: raw.allowAddedWrite === true }
}

function versionOf(row: ConnectorSpecVersion): SelfUpdatingSpecVersion {
  return {
    id: row.id,
    connectorId: row.connectorId,
    tenantId: row.tenantId!,
    versionNo: row.versionNo,
    rawHash: row.rawHash,
    capabilitySet: row.capabilitySet,
    status: row.status,
    diffFromVersionId: row.diffFromVersionId,
    diffSummary: row.diffSummary as CapabilityDiff | null,
    fetchedAt: row.fetchedAt,
    approvedById: row.approvedById,
    approvedAt: row.approvedAt,
  }
}

function sourceOf(row: ConnectorSpecSource): SelfUpdatingSpecSource {
  return {
    id: row.id,
    connectorId: row.connectorId,
    tenantId: row.tenantId!,
    specUrl: row.specUrl,
    createdById: row.createdById!,
    urlApprovedById: row.urlApprovedById,
    urlApprovedAt: row.urlApprovedAt,
    trustedById: row.trustedById,
    trustedAt: row.trustedAt,
    autoApprovePolicy: policyOf(row.autoApprovePolicy),
    lastSyncedAt: row.lastSyncedAt,
  }
}

function operationMentions(value: unknown): string[] {
  const text = JSON.stringify(value)
  const mentions = new Set<string>()
  for (const match of text.matchAll(/\b(GET|POST|PUT|PATCH|DELETE)\s+(\/[A-Za-z0-9_{}./:-]+)/gi)) {
    mentions.add(`${match[1].toUpperCase()} ${match[2]}`)
  }
  for (const match of text.matchAll(/(?:^|[\s"'`])(\/[A-Za-z][A-Za-z0-9_{}./:-]+)/g)) {
    mentions.add(`PATH ${match[1]}`)
  }
  return [...mentions]
}

function addUsage(target: Record<string, UsageRef[]>, keys: string[], ref: UsageRef) {
  for (const key of keys) {
    const list = target[key] ??= []
    if (!list.some((entry) => entry.type === ref.type && entry.id === ref.id)) list.push(ref)
  }
}

export class PostgresSelfUpdatingConnectorRepository implements SelfUpdatingConnectorRepository {
  readonly atomicAudit = true

  async create(input: {
    connectorId?: string
    tenantId: string
    name: string
    specUrl: string
    secretAlias: string
    createdById: string
  }): Promise<SelfUpdatingContext> {
    const row = await prisma.$transaction(async (tx) => {
      const created = await tx.connector.create({
        data: await withConnectorPrivacySlot(tx, {
          ...(input.connectorId ? { id: input.connectorId } : {}),
          tenantId: input.tenantId,
          name: input.name,
          type: 'http_api',
          authMode: 'service',
          scope: 'single',
          lifecycleState: 'active',
          connectorMode: 'self_updating',
          secretAlias: input.secretAlias,
          config: {},
          specSource: {
            create: {
              tenantId: input.tenantId,
              specUrl: input.specUrl,
              specFormat: 'openapi_3',
              createdById: input.createdById,
            },
          },
        }),
        include: { specSource: true },
      })
      await appendAuditInTransaction(tx, connectorAudit({
        action: 'connector.self_update.create',
        actorId: input.createdById,
        tenantId: input.tenantId,
        connectorId: created.id,
        policyDecision: 'pending_approval',
      }))
      return created
    }, { timeout: 60_000 })
    const tenant = await prisma.tenant.findUnique({ where: { id: input.tenantId }, select: { settings: true } })
    return {
      connector: { id: row.id, tenantId: input.tenantId, name: row.name, activeSpecVersionId: null },
      source: sourceOf(row.specSource!),
      activeVersion: null,
      tenantAutoApproveEnabled: tenantSelfUpdateAutoApproveEnabled(tenant?.settings),
    }
  }

  async deleteUninitialized(connectorId: string, tenantId: string): Promise<void> {
    await prisma.connector.deleteMany({
      where: { id: connectorId, tenantId, connectorMode: 'self_updating', activeSpecVersionId: null, specVersions: { none: {} } },
    })
  }

  async findContext(connectorId: string, tenantId: string): Promise<SelfUpdatingContext | null> {
    const [row, tenant] = await Promise.all([
      prisma.connector.findFirst({
        where: { id: connectorId, tenantId, connectorMode: 'self_updating' },
        include: { specSource: true, activeSpecVersion: true },
      }),
      prisma.tenant.findUnique({ where: { id: tenantId }, select: { settings: true } }),
    ])
    if (!row?.specSource) return null
    return {
      connector: { id: row.id, tenantId, name: row.name, activeSpecVersionId: row.activeSpecVersionId },
      source: sourceOf(row.specSource),
      activeVersion: row.activeSpecVersion ? versionOf(row.activeSpecVersion) : null,
      tenantAutoApproveEnabled: tenantSelfUpdateAutoApproveEnabled(tenant?.settings),
    }
  }

  async approveUrl(input: {
    sourceId: string; connectorId: string; tenantId: string; actorId: string; at: Date
    auditMetadata?: Record<string, unknown>
  }) {
    await prisma.$transaction(async (tx) => {
      const updated = await tx.connectorSpecSource.updateMany({
        where: { id: input.sourceId, connectorId: input.connectorId, tenantId: input.tenantId },
        data: { urlApprovedById: input.actorId, urlApprovedAt: input.at },
      })
      if (updated.count !== 1) throw new SelfUpdateError('NOT_FOUND', 'Az önfrissítő kapcsolat nem található.')
      await appendAuditInTransaction(tx, connectorAudit({
        action: 'connector.self_update.source.approve', actorId: input.actorId,
        tenantId: input.tenantId, connectorId: input.connectorId, policyDecision: 'allowed',
        metadata: input.auditMetadata,
      }))
    }, { timeout: 60_000 })
  }

  async markTrusted(input: {
    sourceId: string; connectorId: string; tenantId: string; actorId: string; at: Date
    auditMetadata?: Record<string, unknown>
  }) {
    await prisma.$transaction(async (tx) => {
      const updated = await tx.connectorSpecSource.updateMany({
        where: { id: input.sourceId, connectorId: input.connectorId, tenantId: input.tenantId },
        data: { trustedById: input.actorId, trustedAt: input.at },
      })
      if (updated.count !== 1) throw new SelfUpdateError('NOT_FOUND', 'Az önfrissítő kapcsolat nem található.')
      await appendAuditInTransaction(tx, connectorAudit({
        action: 'connector.self_update.trust.approve', actorId: input.actorId,
        tenantId: input.tenantId, connectorId: input.connectorId, policyDecision: 'allowed',
        metadata: input.auditMetadata,
      }))
    }, { timeout: 60_000 })
  }

  async updatePolicy(input: { sourceId: string; connectorId: string; tenantId: string; actorId: string; policy: AutoApprovePolicy }) {
    await prisma.$transaction(async (tx) => {
      const updated = await tx.connectorSpecSource.updateMany({
        where: { id: input.sourceId, connectorId: input.connectorId, tenantId: input.tenantId },
        data: { autoApprovePolicy: input.policy as Prisma.InputJsonValue },
      })
      if (updated.count !== 1) throw new SelfUpdateError('NOT_FOUND', 'Az önfrissítő kapcsolat nem található.')
      await appendAuditInTransaction(tx, connectorAudit({
        action: 'connector.self_update.policy.update', actorId: input.actorId,
        tenantId: input.tenantId, connectorId: input.connectorId, policyDecision: 'allowed',
        metadata: input.policy,
      }))
    }, { timeout: 60_000 })
  }

  async listUsage(connectorId: string, tenantId: string): Promise<Record<string, UsageRef[]>> {
    // Konzervatív közvetlen hatáslista: minden aktív, connectorhoz kötött agentet
    // felsorolunk. Így egy eltűnő capability sosem lesz tévesen „nem használt”.
    const [agentRows, legacyPlaybooks, playbooksV2, processes] = await Promise.all([
      prisma.agentConnector.findMany({
        where: { connectorId, connector: { tenantId }, agent: { status: 'active' } },
        select: { agent: { select: { id: true, name: true } } },
        orderBy: { agent: { name: 'asc' } },
      }),
      prisma.playbookVersion.findMany({
        where: { status: 'active', playbook: { tenantId } },
        select: { spec: true, playbook: { select: { id: true, name: true } } },
      }),
      prisma.playbookVersionV2.findMany({
        where: { status: 'published', tenantId },
        select: { spec: true, compiledSpec: true, playbook: { select: { id: true, name: true } } },
      }),
      prisma.processDefinition.findMany({
        where: { status: 'active', tenantId },
        select: { id: true, name: true, configValues: true, roleBindings: true, playbookVersion: { select: { spec: true, compiledSpec: true } } },
      }),
    ])
    const usage: Record<string, UsageRef[]> = {}
    const connectorAgentIds = new Set(agentRows.map((row) => row.agent.id))
    for (const row of agentRows) addUsage(usage, ['*'], { type: 'agent', id: row.agent.id, name: row.agent.name })
    for (const row of legacyPlaybooks) {
      if (JSON.stringify(row.spec).includes(connectorId)) {
        addUsage(usage, operationMentions(row.spec), { type: 'playbook', id: row.playbook.id, name: row.playbook.name })
      }
    }
    for (const row of playbooksV2) {
      if (JSON.stringify([row.spec, row.compiledSpec]).includes(connectorId)) {
        addUsage(usage, operationMentions([row.spec, row.compiledSpec]), { type: 'playbook', id: row.playbook.id, name: row.playbook.name })
      }
    }
    for (const row of processes) {
      const bindingText = JSON.stringify(row.roleBindings)
      const directlyBound = [...connectorAgentIds].some((agentId) => bindingText.includes(agentId))
      const explicitConnector = JSON.stringify([row.configValues, row.playbookVersion.spec, row.playbookVersion.compiledSpec]).includes(connectorId)
      if (directlyBound || explicitConnector) {
        addUsage(usage, operationMentions([row.configValues, row.playbookVersion.spec, row.playbookVersion.compiledSpec]), { type: 'process', id: row.id, name: row.name })
      }
    }
    return usage
  }

  async findOpenProposalByHash(
    connectorId: string,
    tenantId: string,
    rawHash: string,
    diffFromVersionId: string | null,
  ) {
    const row = await prisma.connectorSpecVersion.findFirst({
      where: { connectorId, tenantId, rawHash, diffFromVersionId, status: 'proposed' },
      orderBy: { versionNo: 'desc' },
    })
    return row ? versionOf(row) : null
  }

  async createProposal(input: {
    connectorId: string
    tenantId: string
    rawSnapshot: string
    rawHash: string
    capabilitySet: CapabilitySet
    diffFromVersionId: string | null
    diffSummary: CapabilityDiff
    fetchedAt: Date
    actorId: string
  }): Promise<SelfUpdatingSpecVersion> {
    const row = await prisma.$transaction(async (tx) => {
      const connector = await tx.connector.findFirst({
        where: { id: input.connectorId, tenantId: input.tenantId, connectorMode: 'self_updating' },
        select: { activeSpecVersionId: true },
      })
      if (!connector) throw new SelfUpdateError('NOT_FOUND', 'Az önfrissítő kapcsolat nem található.')
      if (connector.activeSpecVersionId !== input.diffFromVersionId) {
        throw new SelfUpdateError('INVALID_STATE', 'A jelenlegi verzió időközben megváltozott. Keress újra frissítést.')
      }
      const latest = await tx.connectorSpecVersion.aggregate({ where: { connectorId: input.connectorId }, _max: { versionNo: true } })
      const proposal = await tx.connectorSpecVersion.create({
        data: {
          connectorId: input.connectorId,
          tenantId: input.tenantId,
          versionNo: (latest._max.versionNo ?? 0) + 1,
          rawSnapshot: input.rawSnapshot,
          rawHash: input.rawHash,
          capabilitySet: input.capabilitySet as Prisma.InputJsonValue,
          diffFromVersionId: input.diffFromVersionId,
          diffSummary: input.diffSummary as unknown as Prisma.InputJsonValue,
          fetchedAt: input.fetchedAt,
          status: 'proposed',
        },
      })
      await appendAuditInTransaction(tx, connectorAudit({
        action: 'connector.self_update.sync.proposed', actorId: input.actorId,
        tenantId: input.tenantId, connectorId: input.connectorId,
        policyDecision: 'human_approval_required',
        metadata: { version_id: proposal.id, version_no: proposal.versionNo, diff: input.diffSummary },
      }))
      return proposal
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 60_000 })
    return versionOf(row)
  }

  async activateVersion(input: {
    connectorId: string; tenantId: string; versionId: string; actorId: string
    approvedById: string | null; approvedAt: Date
    auditMetadata?: Record<string, unknown>
  }) {
    const row = await prisma.$transaction(async (tx) => {
      const connector = await tx.connector.findFirst({ where: { id: input.connectorId, tenantId: input.tenantId, connectorMode: 'self_updating' }, select: { activeSpecVersionId: true } })
      const next = await tx.connectorSpecVersion.findFirst({ where: { id: input.versionId, connectorId: input.connectorId, tenantId: input.tenantId } })
      if (!connector || !next) throw new SelfUpdateError('NOT_FOUND', 'A verzió nem található.')
      if (next.status !== 'proposed') throw new SelfUpdateError('INVALID_STATE', 'Csak javasolt verzió hagyható jóvá.')
      if (next.diffFromVersionId !== connector.activeSpecVersionId) {
        throw new SelfUpdateError('INVALID_STATE', 'A javaslat már nem a jelenlegi verzióhoz készült. Keress újra frissítést.')
      }
      if (!input.approvedById) {
        const [source, tenant] = await Promise.all([
          tx.connectorSpecSource.findFirst({
            where: { connectorId: input.connectorId, tenantId: input.tenantId },
            select: { autoApprovePolicy: true },
          }),
          tx.tenant.findUnique({ where: { id: input.tenantId }, select: { settings: true } }),
        ])
        if (!policyOf(source?.autoApprovePolicy)?.enabled || !tenantSelfUpdateAutoApproveEnabled(tenant?.settings)) {
          throw new SelfUpdateError('INVALID_STATE', 'Az automatikus átvétel időközben ki lett kapcsolva; a javaslat emberi jóváhagyásra vár.')
        }
      }
      const rejectedProposals = await tx.connectorSpecVersion.findMany({
        where: { connectorId: input.connectorId, tenantId: input.tenantId, status: 'proposed', id: { not: next.id } },
        select: { id: true },
      })
      await tx.connectorSpecVersion.updateMany({
        where: { connectorId: input.connectorId, tenantId: input.tenantId, status: 'proposed', id: { not: next.id } },
        data: { status: 'rejected' },
      })
      if (connector.activeSpecVersionId) {
        await tx.connectorSpecVersion.update({ where: { id: connector.activeSpecVersionId }, data: { status: 'superseded' } })
      }
      const approved = await tx.connectorSpecVersion.update({
        where: { id: next.id },
        data: { status: 'approved', approvedById: input.approvedById, approvedAt: input.approvedAt },
      })
      const moved = await tx.connector.updateMany({
        where: { id: input.connectorId, tenantId: input.tenantId, activeSpecVersionId: next.diffFromVersionId },
        data: { activeSpecVersionId: approved.id },
      })
      if (moved.count !== 1) throw new SelfUpdateError('INVALID_STATE', 'A jelenlegi verzió időközben megváltozott. Keress újra frissítést.')
      await appendAuditInTransaction(tx, connectorAudit({
        action: input.approvedById
          ? 'connector.self_update.version.approve'
          : 'connector.self_update.version.auto_approve',
        actorId: input.approvedById,
        tenantId: input.tenantId,
        connectorId: input.connectorId,
        policyDecision: input.approvedById ? 'allowed' : 'auto_approved',
        metadata: {
          version_id: approved.id,
          version_no: approved.versionNo,
          previous_version_id: connector.activeSpecVersionId,
          triggered_by_id: input.actorId,
          rejected_proposal_ids: rejectedProposals.map(({ id }) => id),
          ...input.auditMetadata,
        },
      }))
      return approved
    }, { timeout: 60_000 })
    return versionOf(row)
  }

  async rejectVersion(input: { connectorId: string; tenantId: string; versionId: string; actorId: string }) {
    const row = await prisma.$transaction(async (tx) => {
      const version = await tx.connectorSpecVersion.findFirst({ where: { id: input.versionId, connectorId: input.connectorId, tenantId: input.tenantId } })
      if (!version) throw new SelfUpdateError('NOT_FOUND', 'A verzió nem található.')
      if (version.status !== 'proposed') throw new SelfUpdateError('INVALID_STATE', 'Csak javasolt verzió utasítható el.')
      const rejected = await tx.connectorSpecVersion.update({ where: { id: version.id }, data: { status: 'rejected' } })
      await appendAuditInTransaction(tx, connectorAudit({
        action: 'connector.self_update.version.reject', actorId: input.actorId,
        tenantId: input.tenantId, connectorId: input.connectorId, policyDecision: 'rejected',
        metadata: { version_id: rejected.id, version_no: rejected.versionNo },
      }))
      return rejected
    }, { timeout: 60_000 })
    return versionOf(row)
  }

  async rollback(input: { connectorId: string; tenantId: string; targetVersionId: string; actorId: string; at: Date }) {
    const row = await prisma.$transaction(async (tx) => {
      const connector = await tx.connector.findFirst({ where: { id: input.connectorId, tenantId: input.tenantId, connectorMode: 'self_updating' }, select: { activeSpecVersionId: true } })
      const target = await tx.connectorSpecVersion.findFirst({ where: { id: input.targetVersionId, connectorId: input.connectorId, tenantId: input.tenantId } })
      if (!connector || !target) throw new SelfUpdateError('NOT_FOUND', 'A korábbi verzió nem található.')
      if (!['approved', 'superseded', 'rolled_back'].includes(target.status)) throw new SelfUpdateError('INVALID_STATE', 'Csak korábban jóváhagyott verzió állítható vissza.')
      const rejectedProposals = await tx.connectorSpecVersion.findMany({
        where: { connectorId: input.connectorId, tenantId: input.tenantId, status: 'proposed' },
        select: { id: true },
      })
      if (connector.activeSpecVersionId) await tx.connectorSpecVersion.update({ where: { id: connector.activeSpecVersionId }, data: { status: 'rolled_back' } })
      await tx.connectorSpecVersion.updateMany({
        where: { connectorId: input.connectorId, tenantId: input.tenantId, status: 'proposed' },
        data: { status: 'rejected' },
      })
      const restored = await tx.connectorSpecVersion.update({ where: { id: target.id }, data: { status: 'approved', approvedById: input.actorId, approvedAt: input.at } })
      const moved = await tx.connector.updateMany({
        where: { id: input.connectorId, tenantId: input.tenantId, activeSpecVersionId: connector.activeSpecVersionId },
        data: { activeSpecVersionId: restored.id },
      })
      if (moved.count !== 1) throw new SelfUpdateError('INVALID_STATE', 'A jelenlegi verzió időközben megváltozott.')
      await appendAuditInTransaction(tx, connectorAudit({
        action: 'connector.self_update.version.rollback', actorId: input.actorId,
        tenantId: input.tenantId, connectorId: input.connectorId, policyDecision: 'allowed',
        metadata: {
          from_version_id: connector.activeSpecVersionId,
          to_version_id: restored.id,
          to_version_no: restored.versionNo,
          rejected_proposal_ids: rejectedProposals.map(({ id }) => id),
        },
      }))
      return restored
    }, { timeout: 60_000 })
    return versionOf(row)
  }

  async listVersions(connectorId: string, tenantId: string) {
    const rows = await prisma.connectorSpecVersion.findMany({ where: { connectorId, tenantId }, orderBy: { versionNo: 'desc' } })
    return rows.map(versionOf)
  }

  async touchSynced(sourceId: string, at: Date) {
    await prisma.connectorSpecSource.update({ where: { id: sourceId }, data: { lastSyncedAt: at } })
  }
}
