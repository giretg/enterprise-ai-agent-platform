/**
 * #946 LLM Wiki 5/6 — a Control Plane wiki-nézetének olvasásai (lista, tálca,
 * hozzáférés, export). Jogosultságot nem dönt: azt a `WikiConsoleService` végzi.
 */
import { parseWikiReprocess, type WikiEffectiveInboxStatus, type WikiReprocessMarker } from '@/lib/wiki-access'
import { effectiveStatusSql } from './wiki-repository'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import { readKbPurpose } from '@/lib/kb-retrieval'

export type WikiConsoleKbRow = {
  connectorId: string
  name: string
  config: Prisma.JsonValue
  visibility: 'shared' | 'private_to_user' | 'members'
  ownerUserId: string | null
  /** #1061 F2: `members` névsora (más láthatóságnál üres). */
  kbMemberUserIds: string[]
  ownerLabel: string | null
  lifecycleState: string
  createdAt: Date
  sourceCount: number
  pageCount: number
  /** Kinyert szöveg + oldal-törzsek (a nyers fájl nincs tárolva). */
  bytes: number
}

export type WikiConsoleInboxRow = {
  documentId: string
  filename: string
  purpose: string | null
  status: WikiEffectiveInboxStatus
  /** #1085: a legutóbbi újrafeldolgozási kérés + a kérő ember neve (agent neve külön jön). */
  reprocess?: WikiReprocessMarker | null
  reprocessRequestedByLabel?: string | null
  uploadedById: string
  uploadedByLabel: string | null
  submittedByAgentId: string | null
  claimedByAgentId: string | null
  claimExpiresAt: Date | null
  batchId: string | null
  batchSeq: number | null
  createdAt: Date
}

export type WikiConsoleBindingRow = {
  agentId: string
  agentName: string
  accessMode: 'read' | 'write'
  wikiAccess: 'none' | 'read' | 'submit' | 'write'
  wikiWriteMode: 'approval' | 'direct'
  wikiCollectFocus: string | null
}

/** Egy agent kötése egy tudástárhoz, a néző-jog és a név kiszámításához szükséges adatokkal. */
export type WikiConsoleAgentBindingRow = {
  agentId: string
  connectorId: string
  name: string
  config: Prisma.JsonValue
  visibility: 'shared' | 'private_to_user' | 'members'
  ownerUserId: string | null
  kbMemberUserIds: string[]
  accessMode: 'read' | 'write'
  wikiAccess: 'none' | 'read' | 'submit' | 'write'
  pageCount: number
}

export interface WikiConsoleRepository {
  listKnowledgeBases(tenantId: string): Promise<WikiConsoleKbRow[]>
  /** A megadott agentek aktív tudástár-kötései (a munkatárs-kártyák egyszerre kérik). */
  listAgentKnowledgeBindings(tenantId: string, agentIds: string[]): Promise<WikiConsoleAgentBindingRow[]>
  listInboxItems(connectorId: string, input: { now: Date; limit?: number }): Promise<WikiConsoleInboxRow[]>
  listBindingsForConnector(connectorId: string): Promise<WikiConsoleBindingRow[]>
  listSourceDocuments(
    connectorId: string,
    ids?: string[],
  ): Promise<Array<{ id: string; filename: string; extractedText: string | null; createdAt: Date }>>
  findSourceDocument(
    connectorId: string,
    documentId: string,
  ): Promise<{ id: string; filename: string; extractedText: string | null; createdAt: Date } | null>
  userLabels(ids: string[]): Promise<Map<string, string>>
  agentNames(tenantId: string, ids: string[]): Promise<Map<string, string>>
  /**
   * #965 folyt.: munkatársak, akiknek a wiki-jogát a hívó állíthatja. `userId: null` =
   * a tenant összes nem nyugdíjazott munkatársa (admin); különben csak a view/operate grantosak.
   */
  listAgentsForWikiAccess(tenantId: string, userId: string | null): Promise<Array<{ id: string; name: string }>>
  /** #1061 F2: a tenant aktív tagjai (a „csak a kijelöltek” névsor-választójához). */
  listTenantUsers(tenantId: string): Promise<Array<{ id: string; label: string; email: string }>>
}

export class PostgresWikiConsoleRepository implements WikiConsoleRepository {
  async listKnowledgeBases(tenantId: string): Promise<WikiConsoleKbRow[]> {
    const rows = await prisma.$queryRaw<
      Array<{
        id: string
        name: string
        config: Prisma.JsonValue
        visibility: 'shared' | 'private_to_user' | 'members'
        owner_user_id: string | null
        kb_member_user_ids: string[] | null
        owner_label: string | null
        lifecycle_state: string
        created_at: Date
        source_count: bigint
        page_count: bigint
        bytes: bigint | null
      }>
    >(Prisma.sql`
      SELECT c.id, c.name, c.config, c.visibility, c.owner_user_id, c.kb_member_user_ids,
             COALESCE(NULLIF(u.name, ''), u.email) AS owner_label,
             c.lifecycle_state::text AS lifecycle_state, c.created_at,
             (SELECT count(*) FROM documents d WHERE d.connector_id = c.id) AS source_count,
             (SELECT count(*) FROM wiki_pages p WHERE p.connector_id = c.id AND p.status = 'published') AS page_count,
             COALESCE((SELECT sum(octet_length(COALESCE(d.extracted_text, ''))) FROM documents d WHERE d.connector_id = c.id), 0)
               + COALESCE((SELECT sum(octet_length(p.body)) FROM wiki_pages p WHERE p.connector_id = c.id), 0) AS bytes
      FROM connectors c
      LEFT JOIN users u ON u.id = c.owner_user_id
      WHERE c.tenant_id = ${tenantId}::uuid AND c.type = 'knowledge_base'
      ORDER BY c.created_at
    `)
    return rows.map((row) => ({
      connectorId: row.id,
      name: row.name,
      config: row.config,
      visibility: row.visibility,
      ownerUserId: row.owner_user_id,
      kbMemberUserIds: row.kb_member_user_ids ?? [],
      ownerLabel: row.owner_label,
      lifecycleState: row.lifecycle_state,
      createdAt: row.created_at,
      sourceCount: Number(row.source_count),
      pageCount: Number(row.page_count),
      bytes: Number(row.bytes ?? 0),
    }))
  }

  async listAgentKnowledgeBindings(tenantId: string, agentIds: string[]): Promise<WikiConsoleAgentBindingRow[]> {
    const rows = await prisma.agentConnector.findMany({
      where: {
        agentId: { in: agentIds },
        connector: { tenantId, type: 'knowledge_base', lifecycleState: 'active' },
      },
      select: {
        agentId: true,
        connectorId: true,
        accessMode: true,
        wikiAccess: true,
        connector: {
          select: {
            name: true,
            config: true,
            visibility: true,
            ownerUserId: true,
            kbMemberUserIds: true,
            _count: { select: { wikiPages: { where: { status: 'published' } } } },
          },
        },
      },
    })
    return rows.map(({ connector, ...row }) => ({
      ...row,
      name: connector.name,
      config: connector.config,
      visibility: connector.visibility,
      ownerUserId: connector.ownerUserId,
      kbMemberUserIds: connector.kbMemberUserIds,
      pageCount: connector._count.wikiPages,
    }))
  }

  async listInboxItems(connectorId: string, input: { now: Date; limit?: number }): Promise<WikiConsoleInboxRow[]> {
    const limit = Math.min(Math.max(input.limit ?? 300, 1), 1000)
    const rows = await prisma.$queryRaw<
      Array<{
        id: string
        filename: string
        metadata: Prisma.JsonValue
        status: WikiConsoleInboxRow['status']
        uploaded_by: string
        uploaded_by_label: string | null
        wiki_submitted_by_agent_id: string | null
        wiki_claimed_by_agent_id: string | null
        wiki_claim_expires_at: Date | null
        wiki_batch_id: string | null
        wiki_batch_seq: number | null
        wiki_reprocess: Prisma.JsonValue
        reprocess_requested_by_label: string | null
        created_at: Date
      }>
    >(Prisma.sql`
      SELECT d.id, d.filename, d.metadata, ${effectiveStatusSql(input.now)} AS status, d.uploaded_by,
             COALESCE(NULLIF(u.name, ''), u.email) AS uploaded_by_label,
             d.wiki_submitted_by_agent_id, d.wiki_claimed_by_agent_id, d.wiki_claim_expires_at,
             d.wiki_batch_id, d.wiki_batch_seq, d.wiki_reprocess,
             COALESCE(NULLIF(r.name, ''), r.email) AS reprocess_requested_by_label,
             d.created_at
      FROM documents d
      LEFT JOIN users u ON u.id = d.uploaded_by
      LEFT JOIN users r ON r.id::text = d.wiki_reprocess->'requestedBy'->>'userId'
      WHERE d.connector_id = ${connectorId}::uuid AND d.wiki_status IS NOT NULL
      ORDER BY CASE WHEN d.wiki_status IN ('pending', 'in_progress') THEN 0 ELSE 1 END,
               d.created_at DESC, d.wiki_batch_seq NULLS LAST
      LIMIT ${limit}
    `)
    return rows.map((row) => {
      const active = row.status === 'in_progress'
      return {
        documentId: row.id,
        filename: row.filename,
        purpose: readKbPurpose(row.metadata),
        status: row.status,
        reprocess: parseWikiReprocess(row.wiki_reprocess),
        reprocessRequestedByLabel: row.reprocess_requested_by_label,
        uploadedById: row.uploaded_by,
        uploadedByLabel: row.uploaded_by_label,
        submittedByAgentId: row.wiki_submitted_by_agent_id,
        claimedByAgentId: active ? row.wiki_claimed_by_agent_id : null,
        claimExpiresAt: active ? row.wiki_claim_expires_at : null,
        batchId: row.wiki_batch_id,
        batchSeq: row.wiki_batch_seq,
        createdAt: row.created_at,
      }
    })
  }

  async listAgentsForWikiAccess(tenantId: string, userId: string | null): Promise<Array<{ id: string; name: string }>> {
    const grantedIds = userId
      ? (
          await prisma.resourceGrant.findMany({
            where: { tenantId, userId, resourceType: 'agent', accessLevel: { in: ['view', 'operate'] } },
            select: { resourceId: true },
          })
        ).map((grant) => grant.resourceId)
      : null
    return prisma.agent.findMany({
      where: { tenantId, status: { not: 'retired' }, ...(grantedIds ? { id: { in: grantedIds } } : {}) },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    })
  }

  async listBindingsForConnector(connectorId: string): Promise<WikiConsoleBindingRow[]> {
    const rows = await prisma.agentConnector.findMany({
      where: { connectorId },
      include: { agent: { select: { id: true, name: true } } },
      orderBy: { agent: { name: 'asc' } },
    })
    return rows.map((row) => ({
      agentId: row.agent.id,
      agentName: row.agent.name,
      accessMode: row.accessMode,
      wikiAccess: row.wikiAccess,
      wikiWriteMode: row.wikiWriteMode,
      wikiCollectFocus: row.wikiCollectFocus,
    }))
  }

  listSourceDocuments(connectorId: string, ids?: string[]) {
    return prisma.document.findMany({
      where: { connectorId, ...(ids ? { id: { in: ids } } : {}) },
      select: { id: true, filename: true, extractedText: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    })
  }

  findSourceDocument(connectorId: string, documentId: string) {
    return prisma.document.findFirst({
      where: { id: documentId, connectorId },
      select: { id: true, filename: true, extractedText: true, createdAt: true },
    })
  }

  async userLabels(ids: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter(Boolean))]
    if (unique.length === 0) return new Map()
    const rows = await prisma.user.findMany({ where: { id: { in: unique } }, select: { id: true, name: true, email: true } })
    return new Map(rows.map((row) => [row.id, row.name || row.email]))
  }

  async listTenantUsers(tenantId: string): Promise<Array<{ id: string; label: string; email: string }>> {
    const rows = await prisma.tenantMembership.findMany({
      where: { tenantId, status: 'active' },
      select: { user: { select: { id: true, name: true, email: true } } },
    })
    return rows
      .map((row) => ({ id: row.user.id, label: row.user.name || row.user.email, email: row.user.email }))
      .sort((a, b) => a.label.localeCompare(b.label))
  }

  async agentNames(tenantId: string, ids: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter(Boolean))]
    if (unique.length === 0) return new Map()
    const rows = await prisma.agent.findMany({ where: { tenantId, id: { in: unique } }, select: { id: true, name: true } })
    return new Map(rows.map((row) => [row.id, row.name]))
  }
}
