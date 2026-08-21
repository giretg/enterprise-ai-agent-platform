import type {
  Connector,
  ConnectorAccessMode,
  ConnectorAuthMode,
  ConnectorDraft,
  ConnectorDraftReviewStatus,
  ConnectorType,
} from '@prisma/client'
import { Prisma } from '@prisma/client'
import { isConnectorAssignableToAgent } from '@/domain/connector-self-update/pinned-runtime-config'
import { prisma } from '@/lib/db'
import type {
  ConnectorDraftRepository,
  ConnectorDraftWithConnector,
  CreateConnectorDraftInput,
} from '../interfaces'

/**
 * Postgres implementáció a provisioning draft-réteghez
 * (Feature-spec — Provisioning-Assistant §4.1, §4.2, §8). A provisioning-asszisztens
 * által generált connectorok alapértelmezetten `type = http_api`. A `gmail`
 * connectorType sablonok `type = gmail` rekordot kapnak (google-workspace sablon).
 * Tool Brokerben SOHA nem oldódik fel aktiválás előtt.
 */
export class PostgresConnectorDraftRepository implements ConnectorDraftRepository {
  async createDraft(input: CreateConnectorDraftInput): Promise<ConnectorDraftWithConnector> {
    return prisma.$transaction(async (tx) => {
      const connector = await tx.connector.create({
        data: {
          type: input.connectorType ?? 'http_api',
          name: input.name,
          authMode: input.authMode,
          scope: 'single',
          secretAlias: input.secretAliasSuggested,
          config: input.config,
          lifecycleState: 'draft',
          tenantId: input.tenantId,
        },
      })

      const draft = await tx.connectorDraft.create({
        data: {
          tenantId: input.tenantId,
          connectorId: connector.id,
          sourceType: input.sourceType,
          sourceRef: input.sourceRef,
          sourceHash: input.sourceHash,
          generatedByAgentId: input.generatedByAgentId,
          generatedByAgentVersion: input.generatedByAgentVersion,
          generatedFromConversationId: input.generatedFromConversationId,
          reviewStatus: 'pending',
        },
        include: { connector: true },
      })

      return draft
    })
  }

  async findById(draftId: string): Promise<ConnectorDraftWithConnector | null> {
    return prisma.connectorDraft.findUnique({
      where: { id: draftId },
      include: { connector: true },
    })
  }

  async findByConnectorId(connectorId: string): Promise<ConnectorDraftWithConnector | null> {
    return prisma.connectorDraft.findUnique({
      where: { connectorId },
      include: { connector: true },
    })
  }

  async list(tenantId: string | null): Promise<ConnectorDraftWithConnector[]> {
    return prisma.connectorDraft.findMany({
      where: { tenantId },
      include: { connector: true },
      orderBy: { createdAt: 'desc' },
    })
  }

  async setValidationResult(
    draftId: string,
    result: Prisma.InputJsonValue,
  ): Promise<ConnectorDraft> {
    return prisma.connectorDraft.update({
      where: { id: draftId },
      data: { validationResult: result },
    })
  }

  async setReview(params: {
    draftId: string
    reviewStatus: ConnectorDraftReviewStatus
    reviewedById: string
  }): Promise<ConnectorDraft> {
    return prisma.connectorDraft.update({
      where: { id: params.draftId },
      data: { reviewStatus: params.reviewStatus, reviewedById: params.reviewedById },
    })
  }

  async setSandboxTestResult(draftId: string, ok: boolean): Promise<ConnectorDraft> {
    return prisma.connectorDraft.update({
      where: { id: draftId },
      data: { sandboxTestOk: ok },
    })
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
  }): Promise<Connector> {
    return prisma.$transaction(async (tx) => {
      const draft = await tx.connectorDraft.update({
        where: { id: params.draftId },
        data: { secondApproverId: params.secondApproverId },
      })
      const latestSpecVersion = params.initialSpecVersion
        ? await tx.connectorSpecVersion.aggregate({
            where: { connectorId: draft.connectorId },
            _max: { versionNo: true },
          })
        : null
      const initialVersion = params.initialSpecVersion
        ? await tx.connectorSpecVersion.create({
            data: {
              tenantId: draft.tenantId,
              connectorId: draft.connectorId,
              versionNo: (latestSpecVersion?._max.versionNo ?? 0) + 1,
              rawSnapshot: params.initialSpecVersion.rawSnapshot,
              rawHash: params.initialSpecVersion.rawHash,
              capabilitySet: params.initialSpecVersion.capabilitySet,
              status: 'approved',
              approvedById: params.initialSpecVersion.approvedById,
              approvedAt: new Date(),
            },
          })
        : null
      return tx.connector.update({
        where: { id: draft.connectorId },
        data: {
          lifecycleState: 'active',
          secretAlias: params.secretAlias,
          authMode: params.authMode,
          ...(params.config !== undefined ? { config: params.config } : {}),
          ...(initialVersion ? { activeSpecVersionId: initialVersion.id } : {}),
        },
      })
    })
  }

  async assignToAgent(params: {
    connectorId: string
    agentId: string
    accessMode: ConnectorAccessMode
    secretAlias?: string | null
  }): Promise<void> {
    await prisma.agentConnector.upsert({
      where: { agentId_connectorId: { agentId: params.agentId, connectorId: params.connectorId } },
      create: {
        agentId: params.agentId,
        connectorId: params.connectorId,
        accessMode: params.accessMode,
        ...(params.secretAlias ? { secretAlias: params.secretAlias } : {}),
      },
      update: {
        accessMode: params.accessMode,
        ...(params.secretAlias ? { secretAlias: params.secretAlias } : {}),
      },
    })
  }

  async unassignFromAgent(params: {
    connectorId: string
    agentId: string
  }): Promise<{ removed: boolean }> {
    const result = await prisma.agentConnector.deleteMany({
      where: { agentId: params.agentId, connectorId: params.connectorId },
    })
    return { removed: result.count > 0 }
  }

  async updateDraftConfig(params: {
    draftId: string
    config: Prisma.InputJsonValue
    authMode: ConnectorAuthMode
    sourceHash: string
    secretAliasSuggested: string | null
  }): Promise<ConnectorDraftWithConnector> {
    return prisma.$transaction(async (tx) => {
      const draft = await tx.connectorDraft.findUnique({
        where: { id: params.draftId },
        include: { connector: true },
      })
      if (!draft) throw new Error('draft not found')
      // Kemény padló: csak még NEM aktivált connector configja írható itt felül.
      if (draft.connector.lifecycleState !== 'draft' && draft.connector.lifecycleState !== 'validated') {
        throw new Error('only draft/validated connector config is editable')
      }

      await tx.connector.update({
        where: { id: draft.connectorId },
        data: {
          config: params.config,
          authMode: params.authMode,
          secretAlias: params.secretAliasSuggested,
          lifecycleState: 'draft',
        },
      })
      // A config megváltozott → a gate resetelődik, hogy újra végigfusson.
      return tx.connectorDraft.update({
        where: { id: params.draftId },
        data: {
          sourceHash: params.sourceHash,
          validationResult: Prisma.DbNull,
          reviewStatus: 'pending',
          reviewedById: null,
          secondApproverId: null,
          sandboxTestOk: null,
        },
        include: { connector: true },
      })
    })
  }

  async reopen(params: { draftId: string }): Promise<Connector> {
    return prisma.$transaction(async (tx) => {
      const draft = await tx.connectorDraft.findUnique({
        where: { id: params.draftId },
        include: { connector: true },
      })
      if (!draft) throw new Error('draft not found')
      if (draft.connector.lifecycleState !== 'active') {
        throw new Error('only an active connector can be reopened')
      }
      // A gate resetelése — a javított config újra végigmegy a valid→sandbox→review úton.
      await tx.connectorDraft.update({
        where: { id: params.draftId },
        data: {
          validationResult: Prisma.DbNull,
          reviewStatus: 'pending',
          reviewedById: null,
          secondApproverId: null,
          sandboxTestOk: null,
        },
      })
      // Offline: a Tool Broker `lifecycle_state != active` esetén tilt. Az agent-kötéseket
      // és capability-ket szándékosan MEGTARTJUK — újraaktiváláskor a wiring visszaáll.
      return tx.connector.update({
        where: { id: draft.connectorId },
        data: { lifecycleState: 'draft' },
      })
    })
  }

  async findConnectorById(connectorId: string) {
    const row = await prisma.connector.findUnique({
      where: { id: connectorId },
      select: {
        id: true,
        tenantId: true,
        lifecycleState: true,
        secretAlias: true,
        connectorMode: true,
        activeSpecVersion: { select: { capabilitySet: true } },
      },
    })
    if (!row) return null
    return {
      id: row.id,
      tenantId: row.tenantId,
      lifecycleState: row.lifecycleState,
      secretAlias: row.secretAlias,
      connectorMode: row.connectorMode,
      activeCapabilitySet: row.activeSpecVersion?.capabilitySet ?? null,
    }
  }

  async decommission(params: {
    draftId: string
  }): Promise<{ connectorId: string; affectedAgentIds: string[] }> {
    return prisma.$transaction(async (tx) => {
      const draft = await tx.connectorDraft.findUnique({
        where: { id: params.draftId },
        include: { connector: true },
      })
      if (!draft) throw new Error('draft not found')
      return this.decommissionActiveConnectorTx(tx, draft.connectorId)
    })
  }

  async decommissionByConnectorId(params: {
    connectorId: string
  }): Promise<{ connectorId: string; affectedAgentIds: string[] }> {
    return prisma.$transaction(async (tx) =>
      this.decommissionActiveConnectorTx(tx, params.connectorId),
    )
  }

  private async decommissionActiveConnectorTx(
    tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
    connectorId: string,
  ): Promise<{ connectorId: string; affectedAgentIds: string[] }> {
    const connector = await tx.connector.findUnique({ where: { id: connectorId } })
    if (!connector) throw new Error('connector not found')
    if (connector.lifecycleState !== 'active') {
      throw new Error('only an active connector can be decommissioned')
    }

    const links = await tx.agentConnector.findMany({
      where: { connectorId },
      select: { agentId: true },
    })
    const affectedAgentIds = [...new Set(links.map((l) => l.agentId))]

    await tx.agentConnector.deleteMany({ where: { connectorId } })

    await tx.connector.update({
      where: { id: connectorId },
      data: { lifecycleState: 'archived' },
    })

    return { connectorId, affectedAgentIds }
  }

  async deleteDraft(params: { draftId: string }): Promise<void> {
    await prisma.$transaction(async (tx) => {
      const draft = await tx.connectorDraft.findUnique({
        where: { id: params.draftId },
        include: { connector: true },
      })
      if (!draft) throw new Error('draft not found')
      // Csak SOSEM aktivált draft törölhető véglegesen (aktív connectorra archiválás jár).
      if (draft.connector.lifecycleState !== 'draft' && draft.connector.lifecycleState !== 'validated') {
        throw new Error('only a never-activated draft can be hard-deleted')
      }
      // A connector-sor törlése kaszkádban viszi a draftot, agent_connectors/grantek sorait.
      await tx.connector.delete({ where: { id: draft.connectorId } })
    })
  }

  async listActiveCatalog(
    tenantId: string | null,
  ): Promise<Array<{ id: string; type: ConnectorType; name: string }>> {
    const rows = await prisma.connector.findMany({
      where: { tenantId, lifecycleState: 'active' },
      select: {
        id: true,
        type: true,
        name: true,
        connectorMode: true,
        activeSpecVersion: { select: { capabilitySet: true } },
      },
      orderBy: { name: 'asc' },
    })
    return rows
      .filter((row) =>
        isConnectorAssignableToAgent(
          row.connectorMode,
          row.activeSpecVersion?.capabilitySet ?? null,
        ),
      )
      .map(({ id, type, name }) => ({ id, type, name }))
  }
}
