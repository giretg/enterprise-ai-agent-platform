'use server'

/**
 * #946 LLM Wiki 5/6 — Control Plane server actionök. Vékony réteg: a
 * jogosultságot a `WikiConsoleService` dönti el (privát KB-nál admin is `not_found`).
 */
import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { requireTenantRole } from '@/auth/tenant-context'
import { services } from '@/domain/gateway-services'
import { repositories } from '@/repositories/postgres'
import { canReadPublishedAgent } from '@/domain/agent-definition'
import { MAX_WIKI_SCHEMA_CHARS, WikiConsoleError, WIKI_TEMPLATE_IDS, type WikiConsoleActor } from '@/domain/knowledge-base/wiki-console-service'
import { WikiAccessError } from '@/domain/knowledge-base/wiki-access-service'
import { fail, ok } from '@/lib/result'

const uuid = z.string().uuid()

async function actor(): Promise<WikiConsoleActor> {
  const ctx = await requireTenantRole('viewer')
  return { userId: ctx.user.id, tenantId: ctx.activeTenantId, role: ctx.activeTenantRole, assumed: ctx.assumed }
}

function failFrom(error: unknown, fallback: string) {
  if (error instanceof WikiConsoleError || error instanceof WikiAccessError) return fail(error.code)
  if (error instanceof z.ZodError) return fail('invalid_args')
  if (error instanceof Error && error.message === 'not_found') return fail('not_found')
  if (error instanceof Error && /too large/i.test(error.message)) return fail('too_large')
  if (error instanceof Error && /empty/i.test(error.message)) return fail('invalid_args')
  return fail(error instanceof Error ? error.message : fallback)
}

export async function listKnowledgeBasesAction() {
  try {
    return ok(await services.wikiConsole.listKnowledgeBases(await actor()))
  } catch (e) {
    return failFrom(e, 'Failed to list knowledge bases')
  }
}

export async function createKnowledgeBaseAction(input: {
  displayName: string
  private: boolean
  template?: string
  kbLanguage?: string
}) {
  try {
    const parsed = z
      .object({
        displayName: z.string().trim().min(1).max(120),
        private: z.boolean(),
        template: z.enum(WIKI_TEMPLATE_IDS).optional(),
        kbLanguage: z.enum(['hu', 'en']).optional(),
      })
      .parse(input)
    const result = await services.wikiConsole.createKnowledgeBase(await actor(), parsed)
    revalidatePath('/control-plane/knowledge')
    return ok(result)
  } catch (e) {
    return failFrom(e, 'Failed to create knowledge base')
  }
}

export async function getWikiOverviewAction(input: { connectorId: string }) {
  try {
    return ok(await services.wikiConsole.getOverview(await actor(), uuid.parse(input.connectorId)))
  } catch (e) {
    return failFrom(e, 'Failed to load wiki')
  }
}

export async function getWikiPageAction(input: { connectorId: string; path: string }) {
  try {
    const parsed = z.object({ connectorId: uuid, path: z.string().min(1).max(300) }).parse(input)
    return ok(await services.wikiConsole.getPage(await actor(), parsed.connectorId, parsed.path))
  } catch (e) {
    return failFrom(e, 'Failed to load page')
  }
}

export async function getWikiSourceAction(input: { connectorId: string; documentId: string }) {
  try {
    const parsed = z.object({ connectorId: uuid, documentId: uuid }).parse(input)
    return ok(await services.wikiConsole.getSource(await actor(), parsed.connectorId, parsed.documentId))
  } catch (e) {
    return failFrom(e, 'Failed to load source')
  }
}

export async function listWikiInboxAction(input: { connectorId: string }) {
  try {
    return ok(await services.wikiConsole.listInbox(await actor(), uuid.parse(input.connectorId)))
  } catch (e) {
    return failFrom(e, 'Failed to load inbox')
  }
}

/** Egy fájl a köteg-feltöltésből; a kliens fájlonként hívja, közös `batchId`-vel. */
export async function uploadWikiInboxFileAction(formData: FormData) {
  try {
    const parsed = z
      .object({
        connectorId: uuid,
        batchId: uuid,
        batchSeq: z.coerce.number().int().min(0).max(100_000),
        purpose: z.string().max(240).optional(),
      })
      .parse({
        connectorId: formData.get('connectorId'),
        batchId: formData.get('batchId'),
        batchSeq: formData.get('batchSeq'),
        purpose: (formData.get('purpose') as string | null) || undefined,
      })
    const file = formData.get('file')
    if (!(file instanceof File) || file.size === 0) return fail('invalid_args')
    const result = await services.wikiConsole.uploadToInbox(await actor(), {
      ...parsed,
      filename: file.name,
      mimeType: file.type || null,
      buffer: Buffer.from(await file.arrayBuffer()),
    })
    return ok(result)
  } catch (e) {
    return failFrom(e, 'Failed to upload file')
  }
}

export async function skipWikiInboxItemAction(input: { connectorId: string; documentId: string }) {
  try {
    const parsed = z.object({ connectorId: uuid, documentId: uuid }).parse(input)
    return ok(await services.wikiConsole.skipInboxItem(await actor(), parsed.connectorId, parsed.documentId))
  } catch (e) {
    return failFrom(e, 'Failed to skip item')
  }
}

export async function purgePrivateKnowledgeBaseAction(input: { connectorId: string }) {
  try {
    const counts = await services.wikiConsole.purgePrivate(await actor(), uuid.parse(input.connectorId))
    revalidatePath('/control-plane/knowledge')
    return ok({ deleted: true, documents: counts.documents, pages: counts.pages })
  } catch (e) {
    return failFrom(e, 'Failed to delete knowledge base')
  }
}

export async function getWikiAgentAccessAction(input: { connectorId: string }) {
  try {
    return ok(await services.wikiConsole.getAgentAccess(await actor(), uuid.parse(input.connectorId)))
  } catch (e) {
    return failFrom(e, 'Failed to load agent access')
  }
}

export async function getWikiSettingsAction(input: { connectorId: string }) {
  try {
    return ok(await services.wikiConsole.getSettings(await actor(), uuid.parse(input.connectorId)))
  } catch (e) {
    return failFrom(e, 'Failed to load settings')
  }
}

export async function updateWikiSchemaAction(input: { connectorId: string; schemaMd: string }) {
  try {
    const parsed = z.object({ connectorId: uuid, schemaMd: z.string().min(1).max(MAX_WIKI_SCHEMA_CHARS) }).parse(input)
    const result = await services.wikiConsole.updateSchema(await actor(), parsed.connectorId, parsed.schemaMd)
    revalidatePath(`/control-plane/knowledge/${parsed.connectorId}`)
    return ok(result)
  } catch (e) {
    return failFrom(e, 'Failed to save wiki rules')
  }
}

export async function applyWikiTemplateAction(input: { connectorId: string; template: string }) {
  try {
    const parsed = z.object({ connectorId: uuid, template: z.enum(WIKI_TEMPLATE_IDS) }).parse(input)
    const result = await services.wikiConsole.applyTemplate(await actor(), parsed.connectorId, parsed.template)
    revalidatePath(`/control-plane/knowledge/${parsed.connectorId}`)
    return ok(result)
  } catch (e) {
    return failFrom(e, 'Failed to apply template')
  }
}

export async function changeKnowledgeBaseVisibilityAction(input: { connectorId: string; to: string }) {
  try {
    const parsed = z.object({ connectorId: uuid, to: z.enum(['private', 'shared']) }).parse(input)
    const result = await services.wikiConsole.changeVisibility(await actor(), parsed.connectorId, parsed.to)
    revalidatePath('/control-plane/knowledge')
    revalidatePath(`/control-plane/knowledge/${parsed.connectorId}`)
    return ok(result)
  } catch (e) {
    return failFrom(e, 'Failed to change visibility')
  }
}

async function readableAgentOrThrow(current: WikiConsoleActor, agentId: string) {
  const agent = await repositories.agents.findById(agentId, current.tenantId)
  if (!agent) throw new WikiConsoleError('not_found')
  const grant = await repositories.resourceGrants.findAgentGrant({
    tenantId: current.tenantId,
    userId: current.userId,
    agentId,
  })
  if (!canReadPublishedAgent({ role: String(current.role), grant })) throw new WikiConsoleError('not_found')
  return agent
}

export async function listAgentWikiLinksAction(input: { agentId: string }) {
  try {
    const current = await actor()
    const agent = await readableAgentOrThrow(current, uuid.parse(input.agentId))
    return ok(await services.wikiConsole.listAgentWikiLinks(current, agent.id))
  } catch (e) {
    return failFrom(e, 'Failed to load wiki access')
  }
}

export async function setAgentWikiLinkAction(input: {
  agentId: string
  connectorId: string
  wikiAccess: string
  wikiWriteMode?: string
  wikiCollectFocus?: string | null
}) {
  try {
    const parsed = z
      .object({
        agentId: uuid,
        connectorId: uuid,
        wikiAccess: z.enum(['none', 'read', 'submit', 'write']),
        wikiWriteMode: z.enum(['approval', 'direct']).optional(),
        wikiCollectFocus: z.string().max(2000).nullable().optional(),
      })
      .parse(input)
    const current = await actor()
    await readableAgentOrThrow(current, parsed.agentId)
    const result = await services.wikiConsole.setAgentWikiLink(current, parsed)
    revalidatePath(`/control-plane/agents/${parsed.agentId}`)
    revalidatePath(`/control-plane/knowledge/${parsed.connectorId}`)
    return ok(result)
  } catch (e) {
    return failFrom(e, 'Failed to update wiki access')
  }
}

export async function getWikiChangeSetReviewAction(input: { changeSetId: string }) {
  try {
    return ok(await services.wikiConsole.getChangeSetReview(await actor(), uuid.parse(input.changeSetId)))
  } catch (e) {
    return failFrom(e, 'Failed to load change')
  }
}

// ---------------------------------------------------------------------------
// #978 Wiki-előzmények

const version = z.coerce.number().int().min(1).max(1_000_000)
const revertTarget = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('changeset'), seq: version }),
  z.object({ kind: z.literal('page'), path: z.string().min(1).max(300), version }),
])

function revalidateWiki(connectorId: string) {
  revalidatePath(`/control-plane/knowledge/${connectorId}`)
  revalidatePath(`/control-plane/knowledge/${connectorId}/changes`, 'layout')
}

export async function getWikiPageHistoryAction(input: { connectorId: string; path: string }) {
  try {
    const parsed = z.object({ connectorId: uuid, path: z.string().min(1).max(300) }).parse(input)
    return ok(await services.wikiHistory.getPageHistory(await actor(), parsed.connectorId, parsed.path))
  } catch (e) {
    return failFrom(e, 'Failed to load history')
  }
}

export async function getWikiRevisionAction(input: { connectorId: string; path: string; version: number | string }) {
  try {
    const parsed = z.object({ connectorId: uuid, path: z.string().min(1).max(300), version }).parse(input)
    return ok(await services.wikiHistory.getRevision(await actor(), parsed.connectorId, parsed.path, parsed.version))
  } catch (e) {
    return failFrom(e, 'Failed to load version')
  }
}

export async function diffWikiRevisionsAction(input: { connectorId: string; path: string; from: number | string; to: number | string }) {
  try {
    const parsed = z.object({ connectorId: uuid, path: z.string().min(1).max(300), from: version, to: version }).parse(input)
    return ok(await services.wikiHistory.diffRevisions(await actor(), parsed.connectorId, parsed.path, parsed.from, parsed.to))
  } catch (e) {
    return failFrom(e, 'Failed to compare versions')
  }
}

export async function listWikiChangesAction(input: {
  connectorId: string
  author?: string
  from?: string
  to?: string
  beforeSeq?: number | string
}) {
  try {
    const parsed = z
      .object({
        connectorId: uuid,
        author: z.string().max(60).optional(),
        from: z.string().max(10).optional(),
        to: z.string().max(10).optional(),
        beforeSeq: version.optional(),
      })
      .parse(input)
    const { connectorId, ...filter } = parsed
    return ok(await services.wikiHistory.listChanges(await actor(), connectorId, filter))
  } catch (e) {
    return failFrom(e, 'Failed to load changes')
  }
}

export async function getWikiChangeSetAction(input: { connectorId: string; seq: number | string }) {
  try {
    const parsed = z.object({ connectorId: uuid, seq: version }).parse(input)
    return ok(await services.wikiHistory.getChangeSet(await actor(), parsed.connectorId, parsed.seq))
  } catch (e) {
    return failFrom(e, 'Failed to load change')
  }
}

export async function previewWikiRevertAction(input: { connectorId: string; target: unknown }) {
  try {
    const parsed = z.object({ connectorId: uuid, target: revertTarget }).parse(input)
    return ok(await services.wikiHistory.previewRevert(await actor(), parsed.connectorId, parsed.target))
  } catch (e) {
    return failFrom(e, 'Failed to prepare revert')
  }
}

export async function revertWikiAction(input: { connectorId: string; target: unknown }) {
  try {
    const parsed = z.object({ connectorId: uuid, target: revertTarget }).parse(input)
    const result = await services.wikiHistory.revert(await actor(), parsed.connectorId, parsed.target)
    if (result.ok) revalidateWiki(parsed.connectorId)
    return ok(result)
  } catch (e) {
    return failFrom(e, 'Failed to revert')
  }
}

export async function getWikiStateAtAction(input: { connectorId: string; asOf: string }) {
  try {
    const parsed = z.object({ connectorId: uuid, asOf: z.string().trim().min(1).max(40) }).parse(input)
    return ok(await services.wikiHistory.getStateAt(await actor(), parsed.connectorId, parsed.asOf))
  } catch (e) {
    return failFrom(e, 'Failed to load earlier state')
  }
}

export async function getWikiPageAtAction(input: { connectorId: string; path: string; asOf: string }) {
  try {
    const parsed = z
      .object({ connectorId: uuid, path: z.string().min(1).max(300), asOf: z.string().trim().min(1).max(40) })
      .parse(input)
    return ok(await services.wikiHistory.getPageAt(await actor(), parsed.connectorId, parsed.path, parsed.asOf))
  } catch (e) {
    return failFrom(e, 'Failed to load earlier page')
  }
}

export async function createWikiTagAction(input: { connectorId: string; seq: number | string; name: string; note?: string }) {
  try {
    const parsed = z
      .object({ connectorId: uuid, seq: version, name: z.string().trim().min(1).max(120), note: z.string().max(500).optional() })
      .parse(input)
    const result = await services.wikiHistory.createTag(await actor(), parsed.connectorId, parsed)
    revalidateWiki(parsed.connectorId)
    return ok(result)
  } catch (e) {
    return failFrom(e, 'Failed to name this state')
  }
}

export async function deleteWikiTagAction(input: { connectorId: string; tagId: string }) {
  try {
    const parsed = z.object({ connectorId: uuid, tagId: uuid }).parse(input)
    const result = await services.wikiHistory.deleteTag(await actor(), parsed.connectorId, parsed.tagId)
    revalidateWiki(parsed.connectorId)
    return ok(result)
  } catch (e) {
    return failFrom(e, 'Failed to delete the name')
  }
}

export async function getWikiRetentionAction(input: { connectorId: string }) {
  try {
    return ok(await services.wikiHistory.getRetention(await actor(), uuid.parse(input.connectorId)))
  } catch (e) {
    return failFrom(e, 'Failed to load retention')
  }
}

export async function updateWikiRetentionAction(input: {
  connectorId: string
  retentionFullDays: number
  retentionDeleteDays: number | null
}) {
  try {
    const parsed = z
      .object({
        connectorId: uuid,
        retentionFullDays: z.number().int(),
        retentionDeleteDays: z.number().int().nullable(),
      })
      .parse(input)
    const result = await services.wikiHistory.updateRetention(await actor(), parsed.connectorId, parsed)
    revalidateWiki(parsed.connectorId)
    return ok(result)
  } catch (e) {
    return failFrom(e, 'Failed to save retention')
  }
}

const erasureScope = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pages'), paths: z.array(z.string().min(1).max(300)).min(1).max(50) }),
  z.object({ kind: z.literal('revision'), path: z.string().min(1).max(300), version }),
  z.object({ kind: z.literal('text'), phrase: z.string().trim().min(3).max(200), mode: z.enum(['redact', 'erase']) }),
])

export async function previewWikiErasureAction(input: { connectorId: string; scope: unknown }) {
  try {
    const parsed = z.object({ connectorId: uuid, scope: erasureScope }).parse(input)
    return ok(await services.wikiHistory.previewErasure(await actor(), parsed.connectorId, parsed.scope))
  } catch (e) {
    return failFrom(e, 'Failed to preview erasure')
  }
}

export async function executeWikiErasureAction(input: { connectorId: string; scope: unknown; reason: string; confirmName: string }) {
  try {
    const parsed = z
      .object({
        connectorId: uuid,
        scope: erasureScope,
        reason: z.string().trim().min(3).max(500),
        confirmName: z.string().max(200),
      })
      .parse(input)
    const result = await services.wikiHistory.executeErasure(await actor(), parsed.connectorId, parsed)
    if (result.ok) revalidateWiki(parsed.connectorId)
    return ok(result)
  } catch (e) {
    return failFrom(e, 'Failed to erase')
  }
}
