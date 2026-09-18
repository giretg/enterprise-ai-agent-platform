import type {
  Connector,
  ConnectorAccessMode,
  ConnectorAuthMode,
  ConnectorDraft,
  ConnectorDraftReviewStatus,
  ConnectorType,
} from '@prisma/client'
import { Prisma } from '@prisma/client'
import { isConnectorAssignableToAgent } from '@/domain/connector/runtime-config'
import { prisma } from '@/lib/db'
import { withConnectorPrivacySlot } from '@/lib/privacy-slot'
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
        data: await withConnectorPrivacySlot(tx, {
          type: input.connectorType ?? 'http_api',
          name: input.name,
          authMode: input.authMode,
          scope: 'single',
          secretAlias: input.secretAliasSuggested,
          config: input.config,
          lifecycleState: 'draft',
          tenantId: input.tenantId,
        }),
      })

      const draft = await tx.connectorDraft.create({
        data: {
          tenantId: input.tenantId,
          connectorId: connector.id,
          sourceType: input.sourceType,
          sourceRef: input.sourceRef,
          sourceHash: input.sourceHash,
          generatedByAgentId: input.generatedByAgentId,
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

  async list(tenantId: string): Promise<ConnectorDraftWithConnector[]> {
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
      },
      update: {
        accessMode: params.accessMode,
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
      },
    })
    if (!row) return null
    return {
      id: row.id,
      tenantId: row.tenantId,
      lifecycleState: row.lifecycleState,
      secretAlias: row.secretAlias,
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
    tenantId: string,
  ): Promise<
    Array<{
      id: string
      type: ConnectorType
      name: string
      description?: string | null
      baseUrl?: string | null
      tools?: Array<{ method: string; path: string; description?: string | null }>
    }>
  > {
    const rows = await prisma.connector.findMany({
      where: { tenantId, lifecycleState: 'active', type: { in: ['google_drive', 'http_api', 'gmail'] } },
      select: {
        id: true,
        type: true,
        name: true,
        config: true,
      },
      orderBy: { name: 'asc' },
    })
    return rows.map((row) => ({
      id: row.id,
      type: row.type,
      name: row.name,
      ...describeCatalogRow(row.type, row.config, null),
    }))
  }
}

/**
 * Katalógus-leírás a secret-mentes configból. Nincs új tábla: a leírás a már
 * tárolt proposedTools[].description / baseUrl / provider mezőkből áll össze.
 * Gmailre fix emberi mondat, mert ott nincs proposedTools.
 */
// ponytail: heurisztikus összefoglaló, nem tárolt leírás — külön description oszlop ha szerkeszthető szöveg kell
function describeCatalogRow(
  type: string,
  config: unknown,
  capabilitySet: unknown,
): {
  description: string | null
  baseUrl: string | null
  tools: Array<{ method: string; path: string; description?: string | null }>
} {
  if ((type as string) === 'gmail') {
    return {
      description: 'Gmail-fiók olvasása és írása a felhasználó nevében, engedélyhez kötve.',
      baseUrl: null,
      tools: [],
    }
  }
  if (type === 'code_sandbox') {
    const cfg = config as Record<string, unknown> | null
    const baseUrl = typeof cfg?.baseUrl === 'string' ? cfg.baseUrl : null
    return {
      description:
        'Izolált külső doboz, ahol az agent által írt kód fut. A platform-adatok csak a futtatás bemenetén kerülnek be.',
      baseUrl,
      tools: [],
    }
  }
  const cfg = (capabilitySet ?? config) as Record<string, unknown> | null
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
    return { description: null, baseUrl: null, tools: [] }
  }
  const baseUrl = typeof cfg.baseUrl === 'string' ? cfg.baseUrl : null
  const provider = typeof cfg.provider === 'string' ? cfg.provider : null
  const rawTools = Array.isArray(cfg.proposedTools)
    ? cfg.proposedTools
    : Array.isArray(cfg.endpoints)
      ? cfg.endpoints
      : []
  const tools = rawTools
    .filter((t): t is Record<string, unknown> => typeof t === 'object' && t !== null)
    .map((t) => ({
      method: String(t.method ?? ''),
      path: String(t.path ?? ''),
      ...(typeof t.description === 'string' && t.description.trim()
        ? { description: t.description.trim().slice(0, 300) }
        : {}),
    }))
    .filter((t) => t.method && t.path)
    .slice(0, 50)
  if (tools.length === 0) {
    if (!provider && !baseUrl) return { description: null, baseUrl, tools: [] }
    return {
      description: [provider, baseUrl].filter(Boolean).join(' · ') || null,
      baseUrl,
      tools: [],
    }
  }
  const withDesc = tools.filter((t) => t.description).length
  const head =
    withDesc > 0
      ? tools
          .filter((t) => t.description)
          .slice(0, 2)
          .map((t) => t.description as string)
          .join(' ')
          .slice(0, 300)
      : `${tools.length} művelet${provider ? ` · ${provider}` : ''}${baseUrl ? ` · ${baseUrl}` : ''}`
  return { description: head || null, baseUrl, tools }
}
