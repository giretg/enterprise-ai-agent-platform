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
import { WikiCategoryError } from '@/domain/knowledge-base/wiki-category-service'
import { WikiMetadataError } from '@/domain/knowledge-base/wiki-metadata-service'
import { WIKI_FIELD_TYPES, type WikiViewFilter } from '@/lib/wiki-metadata'
import { WIKI_CATEGORY_MAX_COUNT, WIKI_CATEGORY_MAX_PAGE_ORDER, WIKI_CATEGORY_MAX_PINNED, WIKI_PAGE_SORTS } from '@/lib/wiki-categories'
import { fail, ok } from '@/lib/result'

const uuid = z.string().uuid()

async function actor(): Promise<WikiConsoleActor> {
  const ctx = await requireTenantRole('viewer')
  return { userId: ctx.user.id, tenantId: ctx.activeTenantId, role: ctx.activeTenantRole, assumed: ctx.assumed }
}

function failFrom(error: unknown, fallback: string) {
  if (
    error instanceof WikiConsoleError ||
    error instanceof WikiAccessError ||
    error instanceof WikiCategoryError ||
    error instanceof WikiMetadataError
  ) {
    return fail(error.code)
  }
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

const visibilityTarget = z.enum(['private', 'shared', 'members'])

export async function changeKnowledgeBaseVisibilityAction(input: { connectorId: string; to: string }) {
  try {
    const parsed = z.object({ connectorId: uuid, to: visibilityTarget }).parse(input)
    const result = await services.wikiConsole.changeVisibility(await actor(), parsed.connectorId, parsed.to)
    revalidatePath('/control-plane/knowledge')
    revalidatePath(`/control-plane/knowledge/${parsed.connectorId}`)
    return ok(result)
  } catch (e) {
    return failFrom(e, 'Failed to change visibility')
  }
}

/** #1061 NFR-1: a láthatóság-váltás előnézete (ki veszti el a hozzáférést, mely munkatársak). */
export async function previewKnowledgeBaseVisibilityAction(input: { connectorId: string; to: string }) {
  try {
    const parsed = z.object({ connectorId: uuid, to: visibilityTarget }).parse(input)
    return ok(await services.wikiConsole.previewVisibilityChange(await actor(), parsed.connectorId, parsed.to))
  } catch (e) {
    return failFrom(e, 'Failed to preview visibility change')
  }
}

// #1061 F2: „csak a kijelöltek” névsor.

export async function getKnowledgeBaseMembersAction(input: { connectorId: string }) {
  try {
    return ok(await services.wikiConsole.getMembers(await actor(), uuid.parse(input.connectorId)))
  } catch (e) {
    return failFrom(e, 'Failed to load members')
  }
}

export async function setKnowledgeBaseMemberAction(input: { connectorId: string; userId: string; member: boolean }) {
  try {
    const parsed = z.object({ connectorId: uuid, userId: uuid, member: z.boolean() }).parse(input)
    const current = await actor()
    const result = parsed.member
      ? await services.wikiConsole.addMember(current, parsed.connectorId, parsed.userId)
      : await services.wikiConsole.removeMember(current, parsed.connectorId, parsed.userId)
    revalidatePath('/control-plane/knowledge')
    revalidatePath(`/control-plane/knowledge/${parsed.connectorId}`)
    return ok(result)
  } catch (e) {
    return failFrom(e, 'Failed to change members')
  }
}

/** D9: az admin önmagát veszi fel egy névsoros tudástárra (külön auditált esemény). */
export async function joinKnowledgeBaseAction(input: { connectorId: string }) {
  try {
    const current = await actor()
    const connectorId = uuid.parse(input.connectorId)
    const result = await services.wikiConsole.addMember(current, connectorId, current.userId)
    revalidatePath('/control-plane/knowledge')
    revalidatePath(`/control-plane/knowledge/${connectorId}`)
    return ok(result)
  } catch (e) {
    return failFrom(e, 'Failed to join')
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

// ---------------------------------------------------------------------------
// #1061 F1: kezelt kategória-fa

const categoryApproval = z.enum(['inherit', 'always'])

export async function getWikiCategoriesAction(input: { connectorId: string }) {
  try {
    return ok(await services.wikiCategories.get(await actor(), uuid.parse(input.connectorId)))
  } catch (e) {
    return failFrom(e, 'Failed to load categories')
  }
}

export async function setWikiCategoriesManagedAction(input: { connectorId: string; managed: boolean }) {
  try {
    const parsed = z.object({ connectorId: uuid, managed: z.boolean() }).parse(input)
    const result = parsed.managed
      ? await services.wikiCategories.enable(await actor(), parsed.connectorId)
      : await services.wikiCategories.disable(await actor(), parsed.connectorId)
    revalidateWiki(parsed.connectorId)
    return ok(result)
  } catch (e) {
    return failFrom(e, 'Failed to change categories')
  }
}

export async function createWikiCategoryAction(input: {
  connectorId: string
  key: string
  name: string
  parentId?: string | null
  description?: string | null
  approval?: string
  linkedConnectorId?: string | null
}) {
  try {
    const parsed = z
      .object({
        connectorId: uuid,
        key: z.string().trim().min(1).max(60),
        name: z.string().trim().min(1).max(120),
        parentId: uuid.nullable().optional(),
        description: z.string().max(500).nullable().optional(),
        approval: categoryApproval.optional(),
        linkedConnectorId: uuid.nullable().optional(),
      })
      .parse(input)
    const result = await services.wikiCategories.create(await actor(), parsed.connectorId, parsed)
    revalidateWiki(parsed.connectorId)
    return ok(result)
  } catch (e) {
    return failFrom(e, 'Failed to create category')
  }
}

export async function updateWikiCategoryAction(input: {
  connectorId: string
  categoryId: string
  name?: string
  parentId?: string | null
  description?: string | null
  sortOrder?: number | null
  approval?: string
  pageSort?: string
  pinnedPages?: string[]
  pageOrder?: string[]
  collapsed?: boolean
  reviewCycleDays?: number | null
  requiredFields?: string[]
  requiredSections?: string[]
  sectionRule?: string
  templateMd?: string | null
}) {
  try {
    const parsed = z
      .object({
        connectorId: uuid,
        categoryId: uuid,
        name: z.string().trim().min(1).max(120).optional(),
        parentId: uuid.nullable().optional(),
        description: z.string().max(500).nullable().optional(),
        sortOrder: z.number().int().min(0).max(100_000).nullable().optional(),
        approval: categoryApproval.optional(),
        // Menü: oldalrendezés, kiemelt oldalak, kézi sorrend, alapból becsukva.
        pageSort: z.enum(WIKI_PAGE_SORTS).optional(),
        pinnedPages: z.array(z.string().min(1).max(300)).max(WIKI_CATEGORY_MAX_PINNED).optional(),
        pageOrder: z.array(z.string().min(1).max(300)).max(WIKI_CATEGORY_MAX_PAGE_ORDER).optional(),
        collapsed: z.boolean().optional(),
        // #1061 F3/F4: átnézési ciklus, kötelező mezők, oldalsablon.
        reviewCycleDays: z.number().int().min(1).max(3650).nullable().optional(),
        requiredFields: z.array(z.string().max(40)).max(31).optional(),
        requiredSections: z.array(z.string().max(200)).max(20).optional(),
        sectionRule: z.enum(['warn', 'error']).optional(),
        templateMd: z.string().max(5000).nullable().optional(),
      })
      .parse(input)
    const { connectorId, categoryId, ...patch } = parsed
    const result = await services.wikiCategories.update(await actor(), connectorId, categoryId, patch)
    revalidateWiki(connectorId)
    return ok(result)
  } catch (e) {
    return failFrom(e, 'Failed to update category')
  }
}

/** Húzásos rendezés: egy szülő alatti testvér-kategóriák új sorrendje (felső szint: `parentId: null`). */
export async function reorderWikiCategoriesAction(input: { connectorId: string; parentId: string | null; orderedIds: string[] }) {
  try {
    const parsed = z
      .object({ connectorId: uuid, parentId: uuid.nullable(), orderedIds: z.array(uuid).min(1).max(WIKI_CATEGORY_MAX_COUNT) })
      .parse(input)
    const result = await services.wikiCategories.reorder(await actor(), parsed.connectorId, parsed.parentId, parsed.orderedIds)
    revalidateWiki(parsed.connectorId)
    return ok(result)
  } catch (e) {
    return failFrom(e, 'Failed to reorder categories')
  }
}

export async function deleteWikiCategoryAction(input: { connectorId: string; categoryId: string }) {
  try {
    const parsed = z.object({ connectorId: uuid, categoryId: uuid }).parse(input)
    const result = await services.wikiCategories.remove(await actor(), parsed.connectorId, parsed.categoryId)
    revalidateWiki(parsed.connectorId)
    return ok(result)
  } catch (e) {
    return failFrom(e, 'Failed to delete category')
  }
}

// ---------------------------------------------------------------------------
// #1061 F3: metaadat-mezők, „Átnéztem”, nézetek

export async function getWikiMetadataAction(input: { connectorId: string }) {
  try {
    return ok(await services.wikiMetadata.get(await actor(), uuid.parse(input.connectorId)))
  } catch (e) {
    return failFrom(e, 'Failed to load metadata fields')
  }
}

export async function setWikiMetadataManagedAction(input: { connectorId: string; managed: boolean }) {
  try {
    const parsed = z.object({ connectorId: uuid, managed: z.boolean() }).parse(input)
    const result = parsed.managed
      ? await services.wikiMetadata.enable(await actor(), parsed.connectorId)
      : await services.wikiMetadata.disable(await actor(), parsed.connectorId)
    revalidateWiki(parsed.connectorId)
    return ok(result)
  } catch (e) {
    return failFrom(e, 'Failed to change metadata fields')
  }
}

const fieldOptions = z.array(z.string().max(200)).max(50)

export async function createWikiFieldAction(input: {
  connectorId: string
  key: string
  name: string
  type: string
  options?: string[]
  help?: string | null
}) {
  try {
    const parsed = z
      .object({
        connectorId: uuid,
        key: z.string().trim().min(1).max(40),
        name: z.string().trim().min(1).max(120),
        type: z.enum(WIKI_FIELD_TYPES),
        options: fieldOptions.optional(),
        help: z.string().max(500).nullable().optional(),
      })
      .parse(input)
    const { connectorId, ...field } = parsed
    const result = await services.wikiMetadata.createField(await actor(), connectorId, field)
    revalidateWiki(connectorId)
    return ok(result)
  } catch (e) {
    return failFrom(e, 'Failed to create field')
  }
}

export async function updateWikiFieldAction(input: {
  connectorId: string
  fieldId: string
  name?: string
  options?: string[]
  help?: string | null
  sortOrder?: number
}) {
  try {
    const parsed = z
      .object({
        connectorId: uuid,
        fieldId: uuid,
        name: z.string().trim().min(1).max(120).optional(),
        options: fieldOptions.optional(),
        help: z.string().max(500).nullable().optional(),
        sortOrder: z.number().int().min(0).max(100_000).optional(),
      })
      .parse(input)
    const { connectorId, fieldId, ...patch } = parsed
    const result = await services.wikiMetadata.updateField(await actor(), connectorId, fieldId, patch)
    revalidateWiki(connectorId)
    return ok(result)
  } catch (e) {
    return failFrom(e, 'Failed to update field')
  }
}

export async function deleteWikiFieldAction(input: { connectorId: string; fieldId: string }) {
  try {
    const parsed = z.object({ connectorId: uuid, fieldId: uuid }).parse(input)
    const result = await services.wikiMetadata.removeField(await actor(), parsed.connectorId, parsed.fieldId)
    revalidateWiki(parsed.connectorId)
    return ok(result)
  } catch (e) {
    return failFrom(e, 'Failed to delete field')
  }
}

export async function getWikiPageMetaAction(input: { connectorId: string; path: string }) {
  try {
    const parsed = z.object({ connectorId: uuid, path: z.string().min(1).max(300) }).parse(input)
    return ok(await services.wikiMetadata.getPage(await actor(), parsed.connectorId, parsed.path))
  } catch (e) {
    return failFrom(e, 'Failed to load page metadata')
  }
}

export async function reviewWikiPageAction(input: { connectorId: string; path: string }) {
  try {
    const parsed = z.object({ connectorId: uuid, path: z.string().min(1).max(300) }).parse(input)
    const result = await services.wikiMetadata.review(await actor(), parsed.connectorId, parsed.path)
    revalidateWiki(parsed.connectorId)
    return ok(result)
  } catch (e) {
    return failFrom(e, 'Failed to mark the page reviewed')
  }
}

export async function setWikiPageMetaAction(input: {
  connectorId: string
  path: string
  docStatus?: 'draft' | 'approved' | null
  ownerUserId?: string | null
  ownerRole?: string | null
  reviewCycleDays?: number | null
}) {
  try {
    const parsed = z
      .object({
        connectorId: uuid,
        path: z.string().min(1).max(300),
        docStatus: z.enum(['draft', 'approved']).nullable().optional(),
        ownerUserId: uuid.nullable().optional(),
        ownerRole: z.string().max(200).nullable().optional(),
        reviewCycleDays: z.number().int().min(1).max(3650).nullable().optional(),
      })
      .parse(input)
    const { connectorId, path, ...patch } = parsed
    const result = await services.wikiMetadata.setPage(await actor(), connectorId, path, patch)
    revalidateWiki(connectorId)
    return ok(result)
  } catch (e) {
    return failFrom(e, 'Failed to save page metadata')
  }
}

const WIKI_VIEWS = ['drafts', 'overdue', 'mine', 'owner', 'orphans', 'field'] as const

/** A „Nézetek” fül: egy nézet a Control Plane-en (ugyanaz a mag, mint a `kb_list_index` szűrő). */
export async function getWikiViewAction(input: { connectorId: string; view: string; owner?: string; field?: string; value?: string }) {
  try {
    const parsed = z
      .object({
        connectorId: uuid,
        view: z.enum(WIKI_VIEWS),
        owner: uuid.optional(),
        field: z.string().max(40).optional(),
        value: z.string().max(200).optional(),
      })
      .parse(input)
    const filter: WikiViewFilter =
      parsed.view === 'drafts'
        ? { docStatus: ['draft'] }
        : parsed.view === 'overdue'
          ? { reviewOverdue: true }
          : parsed.view === 'mine'
            ? { owner: ['me'] }
            : parsed.view === 'owner'
              ? parsed.owner ? { owner: [parsed.owner] } : {}
              : parsed.view === 'orphans'
                ? { orphans: true }
                : parsed.field && parsed.value
                  ? { fields: [{ key: parsed.field, values: [parsed.value] }] }
                  : {}
    return ok(await services.wikiMetadata.views(await actor(), parsed.connectorId, filter))
  } catch (e) {
    return failFrom(e, 'Failed to load view')
  }
}
