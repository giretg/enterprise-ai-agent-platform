/**
 * #1061 F3 — metaadat-mezők és nézetek a Control Plane-en.
 *
 * - Bekapcsolás (előnézettel): a régi frontmatter `status` / `owner` / `last_reviewed`
 *   értékei a beépített mezőkbe kerülnek (emberi change-set, revízió, NFR-4).
 * - Egyedi mezők (kulcs, név, típus, választási értékek, súgó): a kulcs és a típus nem változik.
 * - Oldal: „Átnéztem, rendben” (csak ember), állapot, gazda, átnézési ciklus.
 * - Nézetek: tervezetek, lejárt átnézés, saját / gazdánként, árva oldalak, mező szerint.
 *
 * Jog (a `WikiConsoleService.authorize` szerint): mezősémát a wiki kezelője (`manage`)
 * állít; átnézni aki tölthet fel (`contribute`); állapotot, gazdát, ciklust a kezelő vagy
 * az oldal gazdája. Az audit-sorba azonosítók kerülnek, név / érték nem (NFR-3).
 */
import type { Connector, WikiPage } from '@prisma/client'
import type { AuditRepository, WikiRepository, WikiStructureRepository } from '@/repositories/interfaces'
import { redactKbAuditForVisibility } from '@/lib/audit/kb-private-redaction'
import { stripManagedFrontmatter } from '@/lib/kb-wiki'
import {
  EMPTY_WIKI_META,
  WIKI_FIELD_MAX_COUNT,
  WIKI_FIELD_MAX_HELP,
  WIKI_FIELD_MAX_NAME,
  WIKI_FIELD_MAX_OPTION,
  WIKI_FIELD_MAX_OPTIONS,
  WIKI_OWNER_ROLE_MAX,
  WIKI_REVIEW_CYCLE_MAX_DAYS,
  categoryRulesFor,
  effectiveReviewCycle,
  isReviewOverdue,
  isValidFieldKey,
  legacyMetaFromFrontmatter,
  metaFromColumns,
  reviewDueAt,
  type WikiDocStatusName,
  type WikiFieldDef,
  type WikiFieldTypeName,
  type WikiPageMeta,
  type WikiViewFilter,
} from '@/lib/wiki-metadata'
import { WikiConsoleError, type WikiConsoleActor, type WikiConsoleService } from './wiki-console-service'
import type { WikiService } from './wiki-service'

export type WikiMetadataDeps = {
  wikiConsole: Pick<WikiConsoleService, 'authorize'>
  wiki: Pick<WikiService, 'wikiIdForConnector' | 'setMetaAsHuman' | 'queryView' | 'managedCategories'>
  wikis: Pick<WikiRepository, 'listPages' | 'findPage'>
  structure: Pick<WikiStructureRepository, 'fieldSettings' | 'setFieldsManaged' | 'createField' | 'updateField' | 'deleteField'>
  users: {
    listTenantUsers(tenantId: string): Promise<Array<{ id: string; label: string; email?: string }>>
    userLabels(ids: string[]): Promise<Map<string, string>>
  }
  audit: Pick<AuditRepository, 'append'>
  now?: () => Date
}

export type WikiFieldInput = {
  key: string
  name: string
  type: WikiFieldTypeName
  options?: string[]
  help?: string | null
}

export type WikiFieldPatch = { name?: string; options?: string[]; help?: string | null; sortOrder?: number }

export type WikiPageMetaPatch = {
  docStatus?: WikiDocStatusName | null
  ownerUserId?: string | null
  ownerRole?: string | null
  reviewCycleDays?: number | null
}

export class WikiMetadataError extends Error {
  constructor(readonly code: 'key_taken' | 'invalid_key' | 'too_many' | 'not_enabled' | 'conflict' | 'unknown_owner') {
    super(code)
    this.name = 'WikiMetadataError'
  }
}

export class WikiMetadataService {
  constructor(private readonly deps: WikiMetadataDeps) {}

  private now() {
    return this.deps.now?.() ?? new Date()
  }

  private async open(actor: WikiConsoleActor, connectorId: string, need: 'view' | 'contribute' | 'manage') {
    const { connector, access } = await this.deps.wikiConsole.authorize(actor, connectorId, need)
    const wikiId = await this.deps.wiki.wikiIdForConnector(actor.tenantId, connector.id)
    if (!wikiId) throw new WikiConsoleError('not_found')
    const settings = (await this.deps.structure.fieldSettings?.(wikiId)) ?? { managed: false, fields: [] }
    return { connector, access, wikiId, settings }
  }

  private allPages(connectorId: string) {
    return this.deps.wikis.listPages(connectorId, { status: ['published', 'archived'] })
  }

  // -------------------------------------------------------------------------
  // Beállítások → Metaadat-mezők

  /** A mezők listája; kikapcsolva az átemelés előnézete (NFR-1: mi lesz a régi értékekből). */
  async get(actor: WikiConsoleActor, connectorId: string) {
    const { connector, settings } = await this.open(actor, connectorId, 'manage')
    const preview = settings.managed ? null : await this.importPlan(actor.tenantId, connector.id)
    return {
      managed: settings.managed,
      maxFields: WIKI_FIELD_MAX_COUNT,
      fields: settings.fields,
      importPreview: preview
        ? {
            pages: preview.changes.length,
            docStatus: preview.counts.docStatus,
            owner: preview.counts.owner,
            ownerUnmatched: preview.counts.ownerUnmatched,
            reviewedAt: preview.counts.reviewedAt,
            /** Néhány példa a felületnek (cím, mi lesz belőle). */
            samples: preview.samples,
          }
        : null,
    }
  }

  /**
   * A régi frontmatter-értékek átemelése: csak ahol a beépített mező még üres. A gazda
   * e-mail vagy név szerint párosul; a nem párosítható szöveg a frontmatterben marad.
   */
  private async importPlan(tenantId: string, connectorId: string) {
    const [pages, users] = await Promise.all([this.allPages(connectorId), this.deps.users.listTenantUsers(tenantId)])
    // E-mail egyedi; a név nem feltétlenül — kétértelmű név nem párosul (a szöveg a frontmatterben marad).
    const byEmail = new Map<string, string>()
    const byName = new Map<string, string | null>()
    for (const user of users) {
      if (user.email) byEmail.set(user.email.trim().toLowerCase(), user.id)
      const name = user.label.trim().toLowerCase()
      const seen = byName.get(name)
      byName.set(name, seen === undefined || seen === user.id ? user.id : null)
    }
    const matchOwner = (text: string) => byEmail.get(text.toLowerCase()) ?? byName.get(text.toLowerCase()) ?? null
    const labels = new Map(users.map((user) => [user.id, user.label]))
    const counts = { docStatus: 0, owner: 0, ownerUnmatched: 0, reviewedAt: 0 }
    const changes: Array<{ path: string; meta: Partial<WikiPageMeta>; frontmatter: Record<string, unknown>; baseVersion: string }> = []
    const samples: Array<{ path: string; title: string; docStatus: WikiDocStatusName | null; owner: string | null; reviewedAt: string | null }> = []
    for (const page of pages) {
      const frontmatter = stripManagedFrontmatter(page.frontmatter)
      const legacy = legacyMetaFromFrontmatter(frontmatter)
      if (!legacy.consumedKeys.length) continue
      const current = metaFromColumns(page)
      const meta: Partial<WikiPageMeta> = {}
      const consumed: string[] = []
      if (legacy.docStatus && !current.docStatus) {
        meta.docStatus = legacy.docStatus
        consumed.push('status')
      }
      if (legacy.owner && !current.ownerUserId) {
        const ownerId = matchOwner(legacy.owner)
        if (ownerId) {
          meta.ownerUserId = ownerId
          consumed.push('owner')
        } else counts.ownerUnmatched++
      }
      const reviewKey = legacy.consumedKeys.find((key) => key !== 'status' && key !== 'owner')
      if (legacy.reviewedAt && reviewKey && !current.reviewedAt) {
        // Átemelt dátum: az átnéző ismeretlen (nem a bekapcsoló ember tanúsítja).
        meta.reviewedAt = legacy.reviewedAt
        meta.reviewedByUserId = null
        consumed.push(reviewKey)
      }
      if (!consumed.length) continue
      if (meta.docStatus) counts.docStatus++
      if (meta.ownerUserId) counts.owner++
      if (meta.reviewedAt) counts.reviewedAt++
      const rest = { ...frontmatter }
      for (const key of consumed) delete rest[key]
      changes.push({ path: page.path, meta, frontmatter: rest, baseVersion: page.contentHash })
      if (samples.length < 5) {
        samples.push({
          path: page.path,
          title: page.title,
          docStatus: meta.docStatus ?? null,
          owner: meta.ownerUserId ? labels.get(meta.ownerUserId) ?? null : null,
          reviewedAt: meta.reviewedAt ?? null,
        })
      }
    }
    return { changes, counts, samples }
  }

  async enable(actor: WikiConsoleActor, connectorId: string) {
    const { connector, wikiId, settings } = await this.open(actor, connectorId, 'manage')
    if (settings.managed) return { imported: 0 }
    const plan = await this.importPlan(actor.tenantId, connector.id)
    if (plan.changes.length) {
      const result = await this.deps.wiki.setMetaAsHuman({
        tenantId: actor.tenantId,
        userId: actor.userId,
        connector,
        wikiId,
        changes: plan.changes,
        title: 'Metadata fields turned on: existing values imported',
      })
      if (!result.ok) throw new WikiMetadataError('conflict')
    }
    await this.deps.structure.setFieldsManaged!(wikiId, true)
    await this.audit(connector, actor, 'kb.wiki.fields.enabled', wikiId, 'wiki', { wikiId, pageCount: plan.changes.length })
    return { imported: plan.changes.length }
  }

  /** Kikapcsolás: az értékek megmaradnak, csak az ellenőrzés és a nézetek állnak le (NFR-2). */
  async disable(actor: WikiConsoleActor, connectorId: string) {
    const { connector, wikiId, settings } = await this.open(actor, connectorId, 'manage')
    if (!settings.managed) return { managed: false }
    await this.deps.structure.setFieldsManaged!(wikiId, false)
    await this.audit(connector, actor, 'kb.wiki.fields.disabled', wikiId, 'wiki', { wikiId })
    return { managed: false }
  }

  async createField(actor: WikiConsoleActor, connectorId: string, input: WikiFieldInput) {
    const { connector, wikiId, settings } = await this.open(actor, connectorId, 'manage')
    const key = input.key.trim().toLowerCase()
    if (!isValidFieldKey(key)) throw new WikiMetadataError('invalid_key')
    if (settings.fields.some((field) => field.key === key)) throw new WikiMetadataError('key_taken')
    if (settings.fields.length >= WIKI_FIELD_MAX_COUNT) throw new WikiMetadataError('too_many')
    const options = cleanOptions(input.type, input.options ?? [])
    const created = await this.deps.structure.createField!({
      wikiId,
      key,
      name: cleanName(input.name),
      type: input.type,
      options,
      help: cleanHelp(input.help),
      sortOrder: settings.fields.reduce((max, field) => Math.max(max, field.sortOrder), 0) + 10,
    })
    await this.audit(connector, actor, 'kb.wiki.field.created', created.id, 'wiki_field', {
      wikiId,
      fieldId: created.id,
      fieldType: created.type,
      optionCount: options.length,
    })
    return created
  }

  /** Név, választási értékek, súgó, sorrend — a kulcs és a típus nem változik (a meglévő értékek miatt). */
  async updateField(actor: WikiConsoleActor, connectorId: string, fieldId: string, patch: WikiFieldPatch) {
    const { connector, wikiId, settings } = await this.open(actor, connectorId, 'manage')
    const current = settings.fields.find((field) => field.id === fieldId)
    if (!current) throw new WikiConsoleError('not_found')
    const next = {
      ...(patch.name !== undefined ? { name: cleanName(patch.name) } : {}),
      ...(patch.options !== undefined ? { options: cleanOptions(current.type, patch.options) } : {}),
      ...(patch.help !== undefined ? { help: cleanHelp(patch.help) } : {}),
      ...(patch.sortOrder !== undefined ? { sortOrder: Math.max(0, Math.min(100_000, Math.floor(patch.sortOrder))) } : {}),
    }
    const updated = await this.deps.structure.updateField!(wikiId, fieldId, next)
    if (!updated) throw new WikiConsoleError('not_found')
    await this.audit(connector, actor, 'kb.wiki.field.updated', fieldId, 'wiki_field', {
      wikiId,
      fieldId,
      ...(next.options ? { optionCount: next.options.length } : {}),
    })
    return updated
  }

  /** Törlés: az oldalakon lévő értékek szabad frontmatter-kulcsként maradnak (AC14 szellemében). */
  async removeField(actor: WikiConsoleActor, connectorId: string, fieldId: string) {
    const { connector, wikiId } = await this.open(actor, connectorId, 'manage')
    if (!(await this.deps.structure.deleteField!(wikiId, fieldId))) throw new WikiConsoleError('not_found')
    await this.audit(connector, actor, 'kb.wiki.field.deleted', fieldId, 'wiki_field', { wikiId, fieldId })
    return { deleted: true }
  }

  // -------------------------------------------------------------------------
  // Oldal: metaadat-doboz, „Átnéztem”, állapot, gazda, ciklus

  /** Az oldal metaadatai a felületre, a néző lehetőségeivel együtt. */
  async getPage(actor: WikiConsoleActor, connectorId: string, path: string) {
    const { connector, access, wikiId, settings } = await this.open(actor, connectorId, 'view')
    const page = await this.deps.wikis.findPage(connector.id, path.trim())
    if (!page || page.status === 'pending_approval') throw new WikiConsoleError('not_found')
    const meta = metaFromColumns(page)
    if (!settings.managed && sameAsEmpty(meta)) return null
    const categories = (await this.deps.wiki.managedCategories(wikiId)) ?? []
    const rules = categoryRulesFor(page.category, categories)
    const cycle = effectiveReviewCycle(meta, rules)
    const due = reviewDueAt({ reviewedAt: meta.reviewedAt, createdAt: page.createdAt, cycleDays: cycle })
    const labels = await this.deps.users.userLabels([meta.ownerUserId, meta.reviewedByUserId].filter((id): id is string => !!id))
    const frontmatter = stripManagedFrontmatter(page.frontmatter)
    const curate = access.manage || (!!meta.ownerUserId && meta.ownerUserId === actor.userId)
    return {
      managed: settings.managed,
      docStatus: meta.docStatus,
      owner: meta.ownerUserId ? { userId: meta.ownerUserId, name: labels.get(meta.ownerUserId) ?? null, role: meta.ownerRole } : null,
      lastReviewed: meta.reviewedAt
        ? { at: meta.reviewedAt, by: meta.reviewedByUserId ? labels.get(meta.reviewedByUserId) ?? null : null }
        : null,
      /** Az oldal saját ciklusa (`null` = a kategóriáé) és a hatásos ciklus. */
      ownCycleDays: meta.reviewCycleDays,
      categoryCycleDays: rules?.reviewCycleDays ?? null,
      cycleDays: cycle,
      reviewDue: due ? due.toISOString() : null,
      reviewOverdue: isReviewOverdue(due, this.now()),
      fields: settings.fields.map((field) => ({ key: field.key, name: field.name, type: field.type, help: field.help, value: frontmatter[field.key] ?? null })),
      requiredFields: rules?.requiredFields ?? [],
      canReview: access.contribute && page.status === 'published',
      canCurate: curate,
      users: curate ? await this.deps.users.listTenantUsers(actor.tenantId) : [],
    }
  }

  /** „Átnéztem, rendben” (AC13): csak ember; az átnéző és az idő a munkamenetből. */
  async review(actor: WikiConsoleActor, connectorId: string, path: string) {
    const { connector, wikiId } = await this.open(actor, connectorId, 'contribute')
    const page = await this.livePage(connector.id, path)
    if (page.status !== 'published') throw new WikiConsoleError('invalid_args')
    return this.write(actor, connector, wikiId, page, { reviewedAt: this.now().toISOString(), reviewedByUserId: actor.userId }, `Reviewed ${page.path}`)
  }

  /** Állapot, gazda, ciklus — a wiki kezelője vagy az oldal gazdája (D5: ember közvetlenül jóváhagyottra is állíthat). */
  async setPage(actor: WikiConsoleActor, connectorId: string, path: string, patch: WikiPageMetaPatch) {
    const { connector, access, wikiId, settings } = await this.open(actor, connectorId, 'view')
    if (!settings.managed) throw new WikiMetadataError('not_enabled')
    const page = await this.livePage(connector.id, path)
    const current = metaFromColumns(page)
    if (!access.manage && !(current.ownerUserId && current.ownerUserId === actor.userId)) throw new WikiConsoleError('forbidden')
    const meta: Partial<WikiPageMeta> = {}
    if (patch.docStatus !== undefined) meta.docStatus = patch.docStatus
    if (patch.ownerUserId !== undefined) {
      if (patch.ownerUserId && !(await this.deps.users.listTenantUsers(actor.tenantId)).some((user) => user.id === patch.ownerUserId)) {
        throw new WikiMetadataError('unknown_owner')
      }
      meta.ownerUserId = patch.ownerUserId
      if (!patch.ownerUserId) meta.ownerRole = null
    }
    if (patch.ownerRole !== undefined && meta.ownerRole === undefined) {
      meta.ownerRole = patch.ownerRole?.replace(/\s+/g, ' ').trim().slice(0, WIKI_OWNER_ROLE_MAX) || null
    }
    if (patch.reviewCycleDays !== undefined) {
      const days = patch.reviewCycleDays
      if (days !== null && (!Number.isInteger(days) || days < 1 || days > WIKI_REVIEW_CYCLE_MAX_DAYS)) throw new WikiConsoleError('invalid_args')
      meta.reviewCycleDays = days
    }
    if (Object.keys(meta).length === 0) return { changed: false }
    return this.write(actor, connector, wikiId, page, meta, `Metadata of ${page.path} changed`)
  }

  private async livePage(connectorId: string, path: string): Promise<WikiPage> {
    const page = await this.deps.wikis.findPage(connectorId, path.trim())
    if (!page || page.status === 'pending_approval') throw new WikiConsoleError('not_found')
    return page
  }

  private async write(actor: WikiConsoleActor, connector: Connector, wikiId: string, page: WikiPage, meta: Partial<WikiPageMeta>, title: string) {
    const result = await this.deps.wiki.setMetaAsHuman({
      tenantId: actor.tenantId,
      userId: actor.userId,
      connector,
      wikiId,
      changes: [{ path: page.path, meta, baseVersion: page.contentHash }],
      title,
    })
    if (!result.ok) throw new WikiMetadataError('conflict')
    return { changed: true, seq: result.result.seq }
  }

  // -------------------------------------------------------------------------
  // Nézetek

  async views(actor: WikiConsoleActor, connectorId: string, filter: WikiViewFilter) {
    const { connector, wikiId, settings } = await this.open(actor, connectorId, 'view')
    if (!settings.managed) return { managed: false as const, fields: [] as WikiFieldDef[] }
    const result = await this.deps.wiki.queryView({ tenantId: actor.tenantId, connectorId: connector.id, wikiId, viewerUserId: actor.userId, filter, limit: 500 })
    return { managed: true as const, ...(result ?? { filter, count: 0, truncated: false, pages: [], fields: [] }), fields: settings.fields }
  }

  private async audit(
    connector: Connector,
    actor: WikiConsoleActor,
    action: string,
    targetId: string,
    targetType: string,
    metadata: Record<string, unknown>,
  ) {
    await this.deps.audit.append(
      redactKbAuditForVisibility(connector, {
        actorType: 'human',
        actorId: actor.userId,
        agentVersion: null,
        action,
        targetType,
        targetId,
        modelUsed: null,
        inputRef: null,
        outputRef: connector.id,
        policyDecision: 'allowed',
        metadata: { ...metadata, userId: actor.userId, connectorId: connector.id },
        tenantId: actor.tenantId,
      }),
    )
  }
}

function sameAsEmpty(meta: WikiPageMeta) {
  return (Object.keys(EMPTY_WIKI_META) as Array<keyof WikiPageMeta>).every((key) => meta[key] === EMPTY_WIKI_META[key])
}

function cleanName(name: string): string {
  const value = name.replace(/\s+/g, ' ').trim().slice(0, WIKI_FIELD_MAX_NAME)
  if (!value) throw new WikiConsoleError('invalid_args')
  return value
}

function cleanHelp(help: string | null | undefined): string | null {
  return (help ?? '').trim().slice(0, WIKI_FIELD_MAX_HELP) || null
}

/** Választólistánál legalább egy érték kell; a többi típusnál nincs választási érték. */
function cleanOptions(type: WikiFieldTypeName, options: string[]): string[] {
  if (type !== 'select' && type !== 'multi_select') return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of options) {
    const value = raw.replace(/\s+/g, ' ').trim().replace(/,/g, ' ').slice(0, WIKI_FIELD_MAX_OPTION)
    if (!value || seen.has(value.toLowerCase())) continue
    seen.add(value.toLowerCase())
    out.push(value)
  }
  if (out.length === 0 || out.length > WIKI_FIELD_MAX_OPTIONS) throw new WikiConsoleError('invalid_args')
  return out
}
