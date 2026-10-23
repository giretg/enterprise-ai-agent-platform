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
import { WikiConsoleError, WIKI_TEMPLATE_IDS, type WikiConsoleActor } from '@/domain/knowledge-base/wiki-console-service'
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
