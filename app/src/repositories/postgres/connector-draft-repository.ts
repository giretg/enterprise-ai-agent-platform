import type {
  Connector,
  ConnectorAccessMode,
  ConnectorAuthMode,
  ConnectorDraft,
  ConnectorDraftReviewStatus,
  ConnectorType,
} from '@prisma/client'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import type {
  ConnectorDraftRepository,
  ConnectorDraftWithConnector,
  CreateConnectorDraftInput,
} from '../interfaces'

/**
 * Postgres implementáció a provisioning draft-réteghez
 * (Feature-spec — Provisioning-Assistant §4.1, §4.2, §8). A provisioning-asszisztens
 * által generált connectorok `type = http_api` (a nem-HTTP típusok §1.2 szerint
 * out-of-scope). A draft `lifecycle_state = draft` állapotban jön létre, így a
 * Tool Brokerben SOHA nem oldódik fel aktiválás előtt.
 */
export class PostgresConnectorDraftRepository implements ConnectorDraftRepository {
  async createDraft(input: CreateConnectorDraftInput): Promise<ConnectorDraftWithConnector> {
    return prisma.$transaction(async (tx) => {
      const connector = await tx.connector.create({
        data: {
          type: 'http_api',
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
  }): Promise<Connector> {
    return prisma.$transaction(async (tx) => {
      const draft = await tx.connectorDraft.update({
        where: { id: params.draftId },
        data: { secondApproverId: params.secondApproverId },
      })
      return tx.connector.update({
        where: { id: draft.connectorId },
        data: {
          lifecycleState: 'active',
          secretAlias: params.secretAlias,
          authMode: params.authMode,
          ...(params.config !== undefined ? { config: params.config } : {}),
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
      // A gate resetelése — a javított config újra végigmegy a valid→review→sandbox úton.
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

  async decommission(params: {
    draftId: string
  }): Promise<{ connectorId: string; affectedAgentIds: string[] }> {
    return prisma.$transaction(async (tx) => {
      const draft = await tx.connectorDraft.findUnique({
        where: { id: params.draftId },
        include: { connector: true },
      })
      if (!draft) throw new Error('draft not found')
      if (draft.connector.lifecycleState !== 'active') {
        throw new Error('only an active connector can be decommissioned')
      }
      const connectorId = draft.connectorId

      // 1) Érintett agentek — a capability-synchez (a hívó action recomputeolja).
      const links = await tx.agentConnector.findMany({
        where: { connectorId },
        select: { agentId: true },
      })
      const affectedAgentIds = [...new Set(links.map((l) => l.agentId))]

      // 2) Agent-kötések levétele.
      await tx.agentConnector.deleteMany({ where: { connectorId } })

      // 3) Aktív user-grantek auditált visszavonása (revoked).
      await tx.connectorGrant.updateMany({
        where: { connectorId, status: 'active' },
        data: { status: 'revoked', revokedAt: new Date() },
      })

      // 4) Lifecycle → archived (nem hard-delete; az előzmény és az audit-lánc megmarad).
      await tx.connector.update({
        where: { id: connectorId },
        data: { lifecycleState: 'archived' },
      })

      return { connectorId, affectedAgentIds }
    })
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
    return prisma.connector.findMany({
      where: { tenantId, lifecycleState: 'active' },
      select: { id: true, type: true, name: true },
      orderBy: { name: 'asc' },
    })
  }
}
