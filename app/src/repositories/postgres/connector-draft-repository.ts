import type {
  Connector,
  ConnectorAccessMode,
  ConnectorDraft,
  ConnectorDraftReviewStatus,
  ConnectorType,
  Prisma,
} from '@prisma/client'
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
          authMode: 'service',
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
    secondApproverId: string | null
  }): Promise<Connector> {
    return prisma.$transaction(async (tx) => {
      const draft = await tx.connectorDraft.update({
        where: { id: params.draftId },
        data: { secondApproverId: params.secondApproverId },
      })
      return tx.connector.update({
        where: { id: draft.connectorId },
        data: { lifecycleState: 'active', secretAlias: params.secretAlias },
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
