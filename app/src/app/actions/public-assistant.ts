'use server'

/**
 * #1016 nyilvános ügyfélszolgálati asszisztens — Control Plane műveletek.
 * Szerkesztés (draft): operator+. Élesítés, szüneteltetés, domain-lista, végleges törlés: admin (D16, D18).
 */
import { revalidatePath } from 'next/cache'
import { tenantMailboxOf } from '@/domain/connector-grant/tenant-mailbox'
import { Prisma } from '@prisma/client'
import { requireTenantRole } from '@/auth/tenant-context'
import { publicChatSecret } from '@/auth/public-chat-deps'
import { services } from '@/domain/gateway-services'
import { envProviderRegistry } from '@/domain/model-gateway/proxy'
import {
  defaultPublicAssistantConfig,
  normalizeWidgetDomain,
  publicAssistantConfigSchema,
  PUBLIC_SLUG_RE,
  readPublicAssistantConfig,
  suggestPublicSlug,
  withWidgetDomains,
  type PublicAssistantConfig,
} from '@/domain/public-chat/config'
import { createPublicModelCaller } from '@/domain/public-chat/model-client'
import { issueTestToken } from '@/domain/public-chat/service'
import { writeAudit } from '@/lib/audit/types'
import { prisma } from '@/lib/db'
import { extractJsonObject } from '@/lib/extract-json-object'
import { readTenantLanguage } from '@/lib/tenant-language'
import { fail, ok } from '@/lib/result'
import { repositories } from '@/repositories/postgres'

const MAX_KB_TEXT_CHARS = 200_000

function message(e: unknown): string {
  return e instanceof Error ? e.message : 'unexpected_error'
}

const path = (agentId: string) => `/control-plane/agents/${agentId}`

async function loadOwned(tenantId: string, agentId: string) {
  const row = await prisma.publicAssistant.findFirst({
    where: { agentId, tenantId, agent: { kind: 'public' } },
    include: { agent: { select: { name: true } } },
  })
  if (!row) throw new Error('not_found')
  return row
}

async function uniqueSlug(base: string): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const candidate = i === 0 ? base : `${base}-${i + 1}`
    if (!(await prisma.publicAssistant.findUnique({ where: { slug: candidate }, select: { agentId: true } }))) return candidate
  }
  return `${base}-${Date.now().toString(36)}`
}

async function createPublicKb(tenantId: string, agentId: string) {
  const tenant = await repositories.tenants.findById(tenantId)
  return prisma.connector.create({
    data: {
      tenantId,
      type: 'knowledge_base',
      name: `kb:public:${agentId}`,
      authMode: 'agent_owned',
      scope: 'single',
      publicKb: true,
      kbLanguage: readTenantLanguage(tenant?.settings),
    },
  })
}

/**
 * D1 „Nyilvános asszisztens készítése ebből”: a belső agent szerepleírásából vázlat — emberileg
 * átnézendő. Memóriát, eszközt, KB-t NEM másol; csak a szerep-szöveg megy a modellhez, egyszer.
 */
async function draftFromInternalAgent(tenantId: string, source: { name: string; roleInstruction: string; description: string | null }) {
  const fallback = {
    topicGuide: '',
    welcome: 'Szia! Miben segíthetek?',
  }
  try {
    const call = createPublicModelCaller(
      {
        getTenantPolicy: (id) => services.platformSettings.getModelPolicy(id),
        getGlobalFallbackChain: () => services.platformSettings.getFallbackChain(),
        providers: envProviderRegistry(),
      },
      { tenantId, config: defaultPublicAssistantConfig(source.name) },
    )
    const reply = await call({
      toolChoice: 'none',
      tools: [],
      messages: [
        {
          role: 'system',
          content:
            'Egy cég belső AI-munkatársának leírásából nyilvános ügyfélszolgálati asszisztens vázlatát írod. ' +
            'Hagyj ki MINDEN belső részletet (rendszernevek, eszközök, belső folyamatok, munkatársak, jelszavak, ügyféladatok). ' +
            'Csak azt írd le, miben segíthet egy külső érdeklődőnek. Válasz: csak JSON {"topicGuide": "...", "welcome": "..."}.',
        },
        {
          role: 'user',
          content: `Név: ${source.name}\nFeladatkör: ${source.description ?? ''}\nSzerepleírás:\n${source.roleInstruction.slice(0, 6000)}`,
        },
      ],
    })
    const parsed = extractJsonObject(reply.content ?? '') as { topicGuide?: unknown; welcome?: unknown } | null
    return {
      topicGuide: typeof parsed?.topicGuide === 'string' ? parsed.topicGuide.slice(0, 4000) : fallback.topicGuide,
      welcome: typeof parsed?.welcome === 'string' && parsed.welcome.trim() ? parsed.welcome.slice(0, 500) : fallback.welcome,
    }
  } catch {
    return fallback
  }
}

/** D1: új nyilvános asszisztens (a típus utólag nem váltható). `fromAgentId` = belső agentből vázlat. */
export async function createPublicAssistantAction(input: { name: string; fromAgentId?: string }) {
  try {
    const ctx = await requireTenantRole('admin')
    const name = input.name.trim().slice(0, 60)
    if (!name) return fail('Adj nevet az asszisztensnek.')
    let draftExtras: Partial<PublicAssistantConfig> = {}
    let generatedFrom: string | null = null
    if (input.fromAgentId) {
      const source = await repositories.agents.findById(input.fromAgentId, ctx.activeTenantId)
      if (!source || source.kind !== 'internal') return fail('A kiinduló munkatárs nem található.')
      draftExtras = await draftFromInternalAgent(ctx.activeTenantId, source)
      generatedFrom = source.name
    }
    const agent = await prisma.agent.create({
      data: {
        tenantId: ctx.activeTenantId,
        name,
        roleInstruction: '',
        description: 'Nyilvános ügyfélszolgálati asszisztens',
        kind: 'public',
        status: 'draft',
        platformChatEnabled: false,
      },
    })
    const kb = await createPublicKb(ctx.activeTenantId, agent.id)
    const draft = {
      ...defaultPublicAssistantConfig(name),
      ...draftExtras,
      kbConnectorIds: [kb.id],
      ...(generatedFrom ? { reviewNote: `Automatikus vázlat „${generatedFrom}” leírásából — élesítés előtt nézd át.` } : {}),
    }
    await prisma.publicAssistant.create({
      data: {
        agentId: agent.id,
        tenantId: ctx.activeTenantId,
        slug: await uniqueSlug(suggestPublicSlug(name)),
        draft: draft as unknown as Prisma.InputJsonValue,
      },
    })
    await writeAudit(repositories.audit, {
      actorType: 'human',
      actorId: ctx.user.id,
      action: 'public_assistant.created',
      targetType: 'agent',
      targetId: agent.id,
      policyDecision: 'allowed',
      metadata: { fromAgentId: input.fromAgentId ?? null },
      tenantId: ctx.activeTenantId,
    })
    revalidatePath('/control-plane/agents')
    return ok({ agentId: agent.id })
  } catch (e) {
    return fail(message(e))
  }
}

export async function savePublicAssistantDraftAction(input: { agentId: string; config: unknown }) {
  try {
    const ctx = await requireTenantRole(['admin', 'approver', 'operator'])
    const row = await loadOwned(ctx.activeTenantId, input.agentId)
    const parsed = publicAssistantConfigSchema.safeParse(input.config)
    if (!parsed.success) {
      const field = parsed.error.issues[0]?.path.join('.') ?? ''
      return fail(`Hibás mező: ${field}`)
    }
    const config = parsed.data
    // D4: csak a tenant nyilvános tudásbázisa köthető be.
    if (config.kbConnectorIds.length) {
      const allowed = await prisma.connector.count({
        where: { id: { in: config.kbConnectorIds }, tenantId: ctx.activeTenantId, type: 'knowledge_base', publicKb: true },
      })
      if (allowed !== new Set(config.kbConnectorIds).size) return fail('Csak nyilvános tudásbázis köthető be.')
    }
    if (config.forwardConnectorId) {
      const sender = await repositories.connectors.findById(config.forwardConnectorId, ctx.activeTenantId)
      const mailbox = sender ? tenantMailboxOf(sender) : null
      if (!sender || (!mailbox && sender.type !== 'gmail')) {
        return fail('A továbbításhoz Gmail-kapcsolatot vagy közös postafiókot válassz.')
      }
      if (mailbox?.readOnly) return fail('Ez a közös postafiók csak olvasásra van bekötve, ezért nem küldhet levelet.')
      // #1028: tenant-postafióknál nincs „küldő munkatárs” — a postafiók a tenanté.
      if (mailbox) config.forwardSenderUserId = null
    }
    await prisma.publicAssistant.update({
      where: { agentId: row.agentId },
      data: { draft: config as unknown as Prisma.InputJsonValue },
    })
    if (config.displayName !== row.agent.name) {
      await prisma.agent.update({ where: { id: row.agentId }, data: { name: config.displayName } })
    }
    revalidatePath(path(row.agentId))
    return ok({ saved: true })
  } catch (e) {
    return fail(message(e))
  }
}

/** D16: csak admin élesít; a látogató ettől kezdve ezt a pillanatképet kapja. */
export async function publishPublicAssistantAction(input: { agentId: string }) {
  try {
    const ctx = await requireTenantRole('admin')
    const row = await loadOwned(ctx.activeTenantId, input.agentId)
    const config = readPublicAssistantConfig(row.draft, row.agent.name)
    await prisma.publicAssistant.update({
      where: { agentId: row.agentId },
      data: {
        published: config as unknown as Prisma.InputJsonValue,
        publishedAt: new Date(),
        publishedById: ctx.user.id,
        draft: config as unknown as Prisma.InputJsonValue,
      },
    })
    await writeAudit(repositories.audit, {
      actorType: 'human',
      actorId: ctx.user.id,
      action: 'public_assistant.published',
      targetType: 'agent',
      targetId: row.agentId,
      policyDecision: 'allowed',
      metadata: { slug: row.slug },
      tenantId: ctx.activeTenantId,
    })
    revalidatePath(path(row.agentId))
    return ok({ published: true })
  } catch (e) {
    return fail(message(e))
  }
}

/** D16: azonnali szünet / folytatás. */
export async function setPublicAssistantPausedAction(input: { agentId: string; paused: boolean }) {
  try {
    const ctx = await requireTenantRole('admin')
    const row = await loadOwned(ctx.activeTenantId, input.agentId)
    await prisma.publicAssistant.update({ where: { agentId: row.agentId }, data: { paused: input.paused } })
    await writeAudit(repositories.audit, {
      actorType: 'human',
      actorId: ctx.user.id,
      action: input.paused ? 'public_assistant.paused' : 'public_assistant.resumed',
      targetType: 'agent',
      targetId: row.agentId,
      policyDecision: 'allowed',
      metadata: {},
      tenantId: ctx.activeTenantId,
    })
    revalidatePath(path(row.agentId))
    return ok({ paused: input.paused })
  } catch (e) {
    return fail(message(e))
  }
}

export async function updatePublicAssistantSlugAction(input: { agentId: string; slug: string }) {
  try {
    const ctx = await requireTenantRole('admin')
    const row = await loadOwned(ctx.activeTenantId, input.agentId)
    const slug = input.slug.trim().toLowerCase()
    if (!PUBLIC_SLUG_RE.test(slug)) return fail('A cím 3–48 karakter lehet: kisbetű, szám és kötőjel.')
    if (slug === row.slug) return ok({ slug })
    const taken = await prisma.publicAssistant.findUnique({ where: { slug }, select: { agentId: true } })
    if (taken) return fail('Ez a cím már foglalt.')
    await prisma.publicAssistant.update({ where: { agentId: row.agentId }, data: { slug } })
    revalidatePath(path(row.agentId))
    return ok({ slug })
  } catch (e) {
    return fail(message(e))
  }
}

/** D10: tenant-szintű domain-lista (minden nyilvános asszisztens widgetjére érvényes). */
export async function setWidgetDomainsAction(input: { agentId: string; domains: string[] }) {
  try {
    const ctx = await requireTenantRole('admin')
    const domains: string[] = []
    for (const raw of input.domains) {
      if (!raw.trim()) continue
      const domain = normalizeWidgetDomain(raw)
      if (!domain) return fail(`Érvénytelen domain: ${raw}`)
      if (!domains.includes(domain)) domains.push(domain)
    }
    const tenant = await repositories.tenants.findById(ctx.activeTenantId)
    await prisma.tenant.update({
      where: { id: ctx.activeTenantId },
      data: { settings: withWidgetDomains(tenant?.settings, domains) },
    })
    await writeAudit(repositories.audit, {
      actorType: 'human',
      actorId: ctx.user.id,
      action: 'public_assistant.domains_updated',
      targetType: 'tenant',
      targetId: ctx.activeTenantId,
      policyDecision: 'allowed',
      metadata: { domains },
      tenantId: ctx.activeTenantId,
    })
    revalidatePath(path(input.agentId))
    return ok({ domains })
  } catch (e) {
    return fail(message(e))
  }
}

/** D22: „Kipróbálás látogatóként” — 1 órás link a draft profilhoz (teszt-címke, analitikán kívül). */
export async function publicAssistantTestLinkAction(input: { agentId: string }) {
  try {
    const ctx = await requireTenantRole(['admin', 'approver', 'operator'])
    const row = await loadOwned(ctx.activeTenantId, input.agentId)
    const token = issueTestToken(publicChatSecret(), row.agentId, new Date())
    return ok({ href: `/c/${row.slug}?t=${encodeURIComponent(token)}` })
  } catch (e) {
    return fail(message(e))
  }
}

// --- D4: nyilvános tudásbázis ---

async function assertPublicKb(tenantId: string, agentId: string, connectorId: string) {
  const row = await loadOwned(tenantId, agentId)
  const config = readPublicAssistantConfig(row.draft, row.agent.name)
  const connector = await prisma.connector.findFirst({
    where: { id: connectorId, tenantId, type: 'knowledge_base', publicKb: true },
  })
  if (!connector || !config.kbConnectorIds.includes(connectorId)) throw new Error('Ez nem az asszisztens nyilvános tudásbázisa.')
  return { row, connector }
}

/** Szöveg felvétele a nyilvános KB-ba („ami ide kerül, az nyilvános”). */
export async function addPublicKbTextAction(input: { agentId: string; connectorId: string; title: string; text: string }) {
  try {
    const ctx = await requireTenantRole(['admin', 'approver', 'operator'])
    const { row } = await assertPublicKb(ctx.activeTenantId, input.agentId, input.connectorId)
    const text = input.text.trim()
    if (!text) return fail('Üres a szöveg.')
    if (text.length > MAX_KB_TEXT_CHARS) return fail('Túl hosszú szöveg.')
    const title = (input.title.trim() || 'Tudnivaló').slice(0, 120)
    await services.knowledgeBase.ingest({
      tenantId: ctx.activeTenantId,
      agentId: row.agentId,
      uploadedById: ctx.user.id,
      filename: `${title}.md`,
      mimeType: 'text/markdown',
      buffer: Buffer.from(`# ${title}\n\n${text}\n`, 'utf8'),
      processingMode: 'raw_text_only',
      actor: 'human',
      connectorId: input.connectorId,
    })
    revalidatePath(path(row.agentId))
    return ok({ added: true })
  } catch (e) {
    return fail(message(e))
  }
}

export async function uploadPublicKbFileAction(formData: FormData) {
  try {
    const ctx = await requireTenantRole(['admin', 'approver', 'operator'])
    const agentId = String(formData.get('agentId') ?? '')
    const connectorId = String(formData.get('connectorId') ?? '')
    const file = formData.get('file')
    if (!(file instanceof File) || file.size === 0) return fail('Válassz fájlt.')
    const { row } = await assertPublicKb(ctx.activeTenantId, agentId, connectorId)
    await services.knowledgeBase.ingest({
      tenantId: ctx.activeTenantId,
      agentId: row.agentId,
      uploadedById: ctx.user.id,
      filename: file.name,
      mimeType: file.type || null,
      buffer: Buffer.from(await file.arrayBuffer()),
      processingMode: 'raw_text_only',
      actor: 'human',
      connectorId,
    })
    revalidatePath(path(row.agentId))
    return ok({ added: true })
  } catch (e) {
    return fail(message(e))
  }
}

/** D4: meglévő (belső) dokumentum MÁSOLÁSSAL kerülhet a nyilvános KB-ba — az eredeti érintetlen. */
export async function copyDocumentToPublicKbAction(input: { agentId: string; connectorId: string; documentId: string }) {
  try {
    const ctx = await requireTenantRole(['admin', 'approver', 'operator'])
    const { row } = await assertPublicKb(ctx.activeTenantId, input.agentId, input.connectorId)
    const doc = await prisma.document.findFirst({
      where: { id: input.documentId, tenantId: ctx.activeTenantId },
      include: { connector: { select: { visibility: true, ownerUserId: true } } },
    })
    if (!doc || !doc.extractedText?.trim()) return fail('A dokumentum nem található, vagy nincs kinyert szövege.')
    if (doc.connector?.visibility === 'private_to_user' && doc.connector.ownerUserId !== ctx.user.id) {
      return fail('A dokumentum nem található, vagy nincs kinyert szövege.')
    }
    await services.knowledgeBase.ingest({
      tenantId: ctx.activeTenantId,
      agentId: row.agentId,
      uploadedById: ctx.user.id,
      filename: `${doc.filename.replace(/\.[^.]+$/, '')}.md`,
      mimeType: 'text/markdown',
      buffer: Buffer.from(doc.extractedText, 'utf8'),
      processingMode: 'raw_text_only',
      actor: 'human',
      connectorId: input.connectorId,
    })
    revalidatePath(path(row.agentId))
    return ok({ copied: true })
  } catch (e) {
    return fail(message(e))
  }
}

export async function deletePublicKbDocumentAction(input: { agentId: string; connectorId: string; documentId: string }) {
  try {
    const ctx = await requireTenantRole(['admin', 'approver', 'operator'])
    const { row } = await assertPublicKb(ctx.activeTenantId, input.agentId, input.connectorId)
    const doc = await prisma.document.findFirst({
      where: { id: input.documentId, tenantId: ctx.activeTenantId, connectorId: input.connectorId },
    })
    if (!doc) return fail('A dokumentum nem található.')
    await repositories.knowledgeArtifacts.deleteBySourceDocumentId(doc.id)
    await repositories.documents.delete(doc.id)
    await writeAudit(repositories.audit, {
      actorType: 'human',
      actorId: ctx.user.id,
      action: 'kb.document.deleted',
      targetType: 'document',
      targetId: doc.id,
      policyDecision: 'deleted',
      metadata: { agentId: row.agentId, publicKb: true },
      tenantId: ctx.activeTenantId,
    })
    revalidatePath(path(row.agentId))
    return ok({ deleted: true })
  } catch (e) {
    return fail(message(e))
  }
}

// --- D17/D18: nyilvános beszélgetések, GDPR-törlés ---

export async function deletePublicConversationAction(input: { agentId: string; sessionId?: string; visitorId?: string }) {
  try {
    const ctx = await requireTenantRole('admin')
    const row = await loadOwned(ctx.activeTenantId, input.agentId)
    if (!input.sessionId && !input.visitorId) return fail('Hiányzik, mit töröljünk.')
    const where = input.sessionId
      ? { id: input.sessionId, agentId: row.agentId, tenantId: ctx.activeTenantId }
      : { visitorId: input.visitorId!, agentId: row.agentId, tenantId: ctx.activeTenantId }
    const res = await prisma.publicChatSession.deleteMany({ where })
    await writeAudit(repositories.audit, {
      actorType: 'human',
      actorId: ctx.user.id,
      action: input.sessionId ? 'public_chat.conversation_deleted' : 'public_chat.visitor_erased',
      targetType: 'agent',
      targetId: row.agentId,
      policyDecision: 'deleted',
      // A látogató-azonosítót nem írjuk az auditba (törlés után se maradjon visszakereshető nyom).
      metadata: { deleted: res.count, scope: input.sessionId ? 'session' : 'visitor' },
      tenantId: ctx.activeTenantId,
    })
    revalidatePath(path(row.agentId))
    return ok({ deleted: res.count })
  } catch (e) {
    return fail(message(e))
  }
}

// --- D20: megválaszolatlan kérdések → nyilvános KB (jóváhagyással) ---

async function loadSignal(tenantId: string, agentId: string, signalId: string) {
  const signal = await prisma.publicChatSignal.findFirst({ where: { id: signalId, tenantId, agentId } })
  if (!signal) throw new Error('not_found')
  return signal
}

/** A munkatárs válasz-javaslata; admin jóváhagyásáig nem kerül a KB-ba. */
export async function savePublicAnswerDraftAction(input: { agentId: string; signalId: string; answer: string }) {
  try {
    const ctx = await requireTenantRole(['admin', 'approver', 'operator'])
    await loadOwned(ctx.activeTenantId, input.agentId)
    const signal = await loadSignal(ctx.activeTenantId, input.agentId, input.signalId)
    const answer = input.answer.trim().slice(0, 8000)
    if (!answer) return fail('Írd be a választ.')
    await prisma.publicChatSignal.updateMany({
      where: { tenantId: ctx.activeTenantId, agentId: input.agentId, OR: [{ id: signal.id }, ...(signal.groupLabel ? [{ groupLabel: signal.groupLabel, answeredAt: null }] : [])] },
      data: { answerDraft: answer },
    })
    revalidatePath(path(input.agentId))
    return ok({ saved: true })
  } catch (e) {
    return fail(message(e))
  }
}

export async function approvePublicAnswerAction(input: { agentId: string; signalId: string }) {
  try {
    const ctx = await requireTenantRole('admin')
    const row = await loadOwned(ctx.activeTenantId, input.agentId)
    const signal = await loadSignal(ctx.activeTenantId, input.agentId, input.signalId)
    if (!signal.answerDraft) return fail('Előbb írj választ.')
    const config = readPublicAssistantConfig(row.draft, row.agent.name)
    const connectorId = config.kbConnectorIds[0]
    if (!connectorId) return fail('Az asszisztensnek nincs nyilvános tudásbázisa.')
    await assertPublicKb(ctx.activeTenantId, row.agentId, connectorId)
    const question = signal.groupLabel ?? signal.question
    await services.knowledgeBase.ingest({
      tenantId: ctx.activeTenantId,
      agentId: row.agentId,
      uploadedById: ctx.user.id,
      filename: `GYIK - ${question.slice(0, 80).replace(/[\\/:*?"<>|]/g, ' ')}.md`,
      mimeType: 'text/markdown',
      buffer: Buffer.from(`# ${question}\n\n${signal.answerDraft}\n`, 'utf8'),
      processingMode: 'raw_text_only',
      actor: 'human',
      connectorId,
    })
    const now = new Date()
    await prisma.publicChatSignal.updateMany({
      where: {
        tenantId: ctx.activeTenantId,
        agentId: row.agentId,
        answeredAt: null,
        OR: [{ id: signal.id }, ...(signal.groupLabel ? [{ groupLabel: signal.groupLabel }] : [])],
      },
      data: { answeredAt: now },
    })
    await writeAudit(repositories.audit, {
      actorType: 'human',
      actorId: ctx.user.id,
      action: 'public_chat.answer_approved',
      targetType: 'connector',
      targetId: connectorId,
      policyDecision: 'allowed',
      metadata: { signalId: signal.id },
      tenantId: ctx.activeTenantId,
    })
    revalidatePath(path(row.agentId))
    return ok({ approved: true })
  } catch (e) {
    return fail(message(e))
  }
}

export async function dismissPublicSignalAction(input: { agentId: string; signalId: string }) {
  try {
    const ctx = await requireTenantRole(['admin', 'approver', 'operator'])
    await loadOwned(ctx.activeTenantId, input.agentId)
    const signal = await loadSignal(ctx.activeTenantId, input.agentId, input.signalId)
    await prisma.publicChatSignal.updateMany({
      where: {
        tenantId: ctx.activeTenantId,
        agentId: input.agentId,
        dismissedAt: null,
        OR: [{ id: signal.id }, ...(signal.groupLabel ? [{ groupLabel: signal.groupLabel, answeredAt: null }] : [])],
      },
      data: { dismissedAt: new Date() },
    })
    revalidatePath(path(input.agentId))
    return ok({ dismissed: true })
  } catch (e) {
    return fail(message(e))
  }
}
