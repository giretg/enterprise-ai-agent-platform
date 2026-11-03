/**
 * #1061 F1 — kezelt kategória-fa a Control Plane-en: bekapcsolás (előnézettel),
 * létrehozás, átnevezés, áthelyezés, jóváhagyási szabály, törlés.
 *
 * A jogot a `WikiConsoleService.authorize` dönti el (`manage`: közösnél admin,
 * privátnál a tulajdonos; privátnál az admin `not_found`). Az oldalak kategória-
 * váltása emberi change-set (`WikiService.recategorizeAsHuman`), így revízió (NFR-4).
 * Az audit-sorba azonosítók kerülnek, név és leírás nem (NFR-3).
 */
import type { Connector, WikiPage } from '@prisma/client'
import type { AuditRepository, WikiRepository, WikiStructureRepository } from '@/repositories/interfaces'
import { redactKbAuditForVisibility } from '@/lib/audit/kb-private-redaction'
import {
  WIKI_CATEGORY_MAX_COUNT,
  WIKI_CATEGORY_MAX_DESCRIPTION,
  WIKI_CATEGORY_MAX_NAME,
  buildCategoryTree,
  flattenCategoryTree,
  isValidCategoryKey,
  linkedWikiItems,
  normalizeCategoryPath,
  planFreeCategoryImport,
  type WikiCategoryApprovalRule,
  type WikiCategoryRow,
} from '@/lib/wiki-categories'
import { WikiConsoleError, type WikiConsoleActor, type WikiConsoleService } from './wiki-console-service'
import type { WikiService } from './wiki-service'

export type WikiCategoryDeps = {
  wikiConsole: Pick<WikiConsoleService, 'authorize'> & Partial<Pick<WikiConsoleService, 'displayName' | 'listKnowledgeBases'>>
  wiki: Pick<WikiService, 'wikiIdForConnector' | 'recategorizeAsHuman'>
  wikis: Pick<WikiRepository, 'listPages'>
  structure: WikiStructureRepository
  audit: Pick<AuditRepository, 'append'>
}

export type WikiCategoryInput = {
  key: string
  name: string
  parentId?: string | null
  description?: string | null
  approval?: WikiCategoryApprovalRule
  /** #1061 F2: „kapcsolt wiki” menüpont — a másik tudástár, amelyre mutat. */
  linkedConnectorId?: string | null
}

export type WikiCategoryPatch = {
  name?: string
  parentId?: string | null
  description?: string | null
  sortOrder?: number
  approval?: WikiCategoryApprovalRule
}

/** A kategória-fa nem változhat úgy, hogy oldal vesszen el: ilyenkor `conflict`-tal áll meg. */
export class WikiCategoryError extends Error {
  constructor(
    readonly code: 'key_taken' | 'invalid_key' | 'too_deep' | 'not_empty' | 'too_many' | 'conflict',
  ) {
    super(code)
    this.name = 'WikiCategoryError'
  }
}

type PageCounts = { published: number; archived: number }

export class WikiCategoryService {
  constructor(private readonly deps: WikiCategoryDeps) {}

  private async open(actor: WikiConsoleActor, connectorId: string) {
    const { connector } = await this.deps.wikiConsole.authorize(actor, connectorId, 'manage')
    const wikiId = await this.deps.wiki.wikiIdForConnector(actor.tenantId, connector.id)
    if (!wikiId) throw new WikiConsoleError('not_found')
    return { connector, wikiId }
  }

  /** Minden oldal (archivált is) — egy kategória csak akkor üres, ha archivált oldal sincs benne. */
  private allPages(connectorId: string) {
    return this.deps.wikis.listPages(connectorId, { status: ['published', 'archived'] })
  }

  /** Beállítások-fül: a fa oldalszámokkal; kikapcsolt állapotban a bekapcsolás előnézete. */
  async get(actor: WikiConsoleActor, connectorId: string) {
    const { connector, wikiId } = await this.open(actor, connectorId)
    const [managed, rows, pages] = await Promise.all([
      this.deps.structure.isManaged(wikiId),
      this.deps.structure.listCategories(wikiId),
      this.allPages(connector.id),
    ])
    const counts = countByCategory(pages)
    const own = (path: string): PageCounts => counts.get(path) ?? { published: 0, archived: 0 }
    const tree = buildCategoryTree(rows).map((node) => {
      const children = node.children.map((child) => ({ ...nodeView(child), ...own(child.path), children: [] }))
      const self = own(node.path)
      return {
        ...nodeView(node),
        ...self,
        /** Az alkategóriákkal együtt (a szabály ezekre is érvényes). */
        totalPublished: self.published + children.reduce((sum, child) => sum + child.published, 0),
        children,
      }
    })
    const known = new Set(flattenCategoryTree(buildCategoryTree(rows)).map((node) => node.path))
    return {
      managed,
      maxCategories: WIKI_CATEGORY_MAX_COUNT,
      categories: tree,
      /** Oldalak, amelyek kategóriája nincs a fában (kategória nélküliek is). */
      outsideTree: pages.filter((page) => page.status === 'published' && !known.has(normalizeCategoryPath(page.category))).length,
      importPreview: managed
        ? []
        : planFreeCategoryImport(pages, rows).map(({ key, name, pageCount, exists }) => ({ key, name, pageCount, exists })),
      /** #1061 F2: „kapcsolt wiki” menüpontok; a cél neve csak annak látszik, aki azt a wikit is látja. */
      linkedWikis: await this.linkedViews(actor, rows),
      /** Amire kapcsolt wiki menüpont tehető: a kezelő által látott többi tudástár. */
      linkableWikis: ((await this.deps.wikiConsole.listKnowledgeBases?.(actor)) ?? [])
        .filter((row) => !row.metadataOnly && row.connectorId !== connector.id)
        .map((row) => ({ connectorId: row.connectorId, name: 'name' in row ? row.name : row.connectorId, kind: row.kind })),
    }
  }

  private async linkedViews(actor: WikiConsoleActor, rows: WikiCategoryRow[]) {
    const out = []
    for (const item of linkedWikiItems(rows)) {
      let targetName: string | null = null
      try {
        const { connector } = await this.deps.wikiConsole.authorize(actor, item.linkedConnectorId, 'view')
        targetName = (await this.deps.wikiConsole.displayName?.(connector)) ?? null
      } catch {
        targetName = null
      }
      out.push({ ...item, targetName, targetVisible: targetName !== null })
    }
    return out
  }

  /**
   * Bekapcsolás (AC1): a meglévő szabad kategóriákból felső szintű kategóriák
   * lesznek, és minden oldal a kategóriája kulcsát kapja — egyetlen oldal sem
   * marad kategória nélkül, ha korábban volt. Újrafuttatható (a meglévő kulcsot nem hozza létre újra).
   */
  async enable(actor: WikiConsoleActor, connectorId: string) {
    const { connector, wikiId } = await this.open(actor, connectorId)
    if (await this.deps.structure.isManaged(wikiId)) return { created: 0, movedPages: 0 }
    const [rows, pages] = await Promise.all([this.deps.structure.listCategories(wikiId), this.allPages(connector.id)])
    const plan = planFreeCategoryImport(pages, rows)
    const toCreate = plan.filter((row) => !row.exists)
    if (rows.length + toCreate.length > WIKI_CATEGORY_MAX_COUNT) throw new WikiCategoryError('too_many')
    let sortOrder = rows.reduce((max, row) => Math.max(max, row.sortOrder), 0)
    for (const row of toCreate) {
      sortOrder += 10
      await this.deps.structure.createCategory({
        wikiId,
        key: row.key,
        parentId: null,
        name: row.name.slice(0, WIKI_CATEGORY_MAX_NAME),
        description: null,
        sortOrder,
        approval: 'inherit',
      })
    }
    const keyFor = new Map(plan.flatMap((row) => row.values.map((value) => [value, row.key] as const)))
    const moves = pages
      .filter((page) => page.category?.trim() && keyFor.get(page.category.trim()) !== page.category)
      .map((page) => ({ path: page.path, category: keyFor.get(page.category!.trim()) ?? null }))
    const movedPages = await this.recategorize(actor, connector, wikiId, moves, 'Managed categories turned on')
    await this.deps.structure.setManaged(wikiId, true)
    await this.audit(connector, actor, 'kb.wiki.categories.enabled', wikiId, {
      wikiId,
      categoryCount: rows.length + toCreate.length,
      createdCount: toCreate.length,
      pageCount: movedPages,
    })
    return { created: toCreate.length, movedPages }
  }

  /** Kikapcsolás: minden úgy működik, mint korábban; az oldalak megtartják a kulcsutat, a fa megmarad. */
  async disable(actor: WikiConsoleActor, connectorId: string) {
    const { connector, wikiId } = await this.open(actor, connectorId)
    if (!(await this.deps.structure.isManaged(wikiId))) return { managed: false }
    await this.deps.structure.setManaged(wikiId, false)
    await this.audit(connector, actor, 'kb.wiki.categories.disabled', wikiId, { wikiId })
    return { managed: false }
  }

  async create(actor: WikiConsoleActor, connectorId: string, input: WikiCategoryInput) {
    const { connector, wikiId } = await this.open(actor, connectorId)
    const rows = await this.deps.structure.listCategories(wikiId)
    const key = input.key.trim().toLowerCase()
    if (!isValidCategoryKey(key)) throw new WikiCategoryError('invalid_key')
    if (rows.some((row) => row.key === key)) throw new WikiCategoryError('key_taken')
    if (rows.length >= WIKI_CATEGORY_MAX_COUNT) throw new WikiCategoryError('too_many')
    const parentId = input.parentId ?? null
    if (parentId) {
      const parent = rows.find((row) => row.id === parentId)
      if (!parent || parent.linkedConnectorId) throw new WikiConsoleError('invalid_args')
      if (parent.parentId) throw new WikiCategoryError('too_deep')
    }
    // #1061 F2: kapcsolt wiki — másik, a kezelő által is látott tudástár (a saját nem).
    const linkedConnectorId = input.linkedConnectorId?.trim().toLowerCase() || null
    if (linkedConnectorId) {
      if (linkedConnectorId === connector.id) throw new WikiConsoleError('invalid_args')
      await this.deps.wikiConsole.authorize(actor, linkedConnectorId, 'view')
    }
    const siblings = rows.filter((row) => (row.parentId ?? null) === parentId)
    const created = await this.deps.structure.createCategory({
      wikiId,
      key,
      parentId,
      name: cleanName(input.name),
      description: cleanDescription(input.description),
      sortOrder: siblings.reduce((max, row) => Math.max(max, row.sortOrder), 0) + 10,
      approval: linkedConnectorId ? 'inherit' : input.approval ?? 'inherit',
      ...(linkedConnectorId ? { linkedConnectorId } : {}),
    })
    await this.audit(connector, actor, 'kb.wiki.category.created', created.id, {
      wikiId,
      categoryId: created.id,
      ...(parentId ? { parentId } : {}),
      ...(linkedConnectorId ? { linkedConnectorId } : {}),
      approval: created.approval,
    })
    return { id: created.id, path: parentId ? `${rows.find((row) => row.id === parentId)!.key}/${key}` : key }
  }

  /**
   * Név, leírás, sorrend, szabály, szülő. Szülőváltásnál a kulcsút is változik,
   * ezért a benne lévő oldalak emberi change-settel átkerülnek az új kulcsútra.
   */
  async update(actor: WikiConsoleActor, connectorId: string, categoryId: string, patch: WikiCategoryPatch) {
    const { connector, wikiId } = await this.open(actor, connectorId)
    const rows = await this.deps.structure.listCategories(wikiId)
    const current = rows.find((row) => row.id === categoryId)
    if (!current) throw new WikiConsoleError('not_found')

    const parentChanged = patch.parentId !== undefined && (patch.parentId ?? null) !== (current.parentId ?? null)
    if (parentChanged && patch.parentId) {
      const parent = rows.find((row) => row.id === patch.parentId)
      if (!parent || parent.id === current.id || parent.linkedConnectorId) throw new WikiConsoleError('invalid_args')
      if (parent.parentId || rows.some((row) => row.parentId === current.id)) throw new WikiCategoryError('too_deep')
    }
    const oldPath = pathOf(rows, current)
    const next = {
      ...(patch.name !== undefined ? { name: cleanName(patch.name) } : {}),
      ...(patch.description !== undefined ? { description: cleanDescription(patch.description) } : {}),
      ...(patch.sortOrder !== undefined ? { sortOrder: Math.max(0, Math.min(100_000, Math.floor(patch.sortOrder))) } : {}),
      ...(patch.approval !== undefined ? { approval: patch.approval } : {}),
      ...(parentChanged ? { parentId: patch.parentId ?? null } : {}),
    }
    let movedPages = 0
    // A kapcsolt wiki menüpontjában nincs oldal — áthelyezéskor nincs mit átvinni.
    if (parentChanged && !current.linkedConnectorId) {
      const updated = { ...current, ...next }
      const newPath = pathOf(rows.map((row) => (row.id === updated.id ? updated : row)), updated)
      const pages = await this.allPages(connector.id)
      const moves = pages
        .filter((page) => normalizeCategoryPath(page.category) === oldPath)
        .map((page) => ({ path: page.path, category: newPath }))
      movedPages = await this.recategorize(actor, connector, wikiId, moves, `Category ${oldPath} moved to ${newPath}`, {
        id: categoryId, expectedParentId: current.parentId, patch: next,
      })
    } else if (!(await this.deps.structure.updateCategory(wikiId, categoryId, next))) {
      throw new WikiConsoleError('not_found')
    }

    if (patch.approval !== undefined && patch.approval !== current.approval) {
      await this.audit(connector, actor, 'kb.wiki.category.rule_changed', categoryId, {
        wikiId,
        categoryId,
        fromApproval: current.approval,
        toApproval: patch.approval,
      })
    }
    if (Object.keys(next).some((key) => key !== 'approval')) {
      await this.audit(connector, actor, 'kb.wiki.category.updated', categoryId, {
        wikiId,
        categoryId,
        ...(parentChanged ? { parentId: patch.parentId ?? null, pageCount: movedPages } : {}),
      })
    }
    return { id: categoryId, movedPages }
  }

  /** Csak üres kategória törölhető (alkategória és oldal nélkül, az archivált oldalt is beleértve). */
  async remove(actor: WikiConsoleActor, connectorId: string, categoryId: string) {
    const { connector, wikiId } = await this.open(actor, connectorId)
    const rows = await this.deps.structure.listCategories(wikiId)
    const current = rows.find((row) => row.id === categoryId)
    if (!current) throw new WikiConsoleError('not_found')
    if (rows.some((row) => row.parentId === categoryId)) throw new WikiCategoryError('not_empty')
    const path = pathOf(rows, current)
    const pages = current.linkedConnectorId ? [] : await this.allPages(connector.id)
    if (pages.some((page) => normalizeCategoryPath(page.category) === path)) throw new WikiCategoryError('not_empty')
    if (!(await this.deps.structure.deleteCategory(wikiId, categoryId))) throw new WikiCategoryError('not_empty')
    await this.audit(connector, actor, 'kb.wiki.category.deleted', categoryId, { wikiId, categoryId })
    return { deleted: true }
  }

  private async recategorize(
    actor: WikiConsoleActor,
    connector: Connector,
    wikiId: string,
    moves: Array<{ path: string; category: string | null }>,
    title: string,
    categoryUpdate?: Parameters<WikiService['recategorizeAsHuman']>[0]['categoryUpdate'],
  ): Promise<number> {
    if (moves.length === 0 && !categoryUpdate) return 0
    const result = await this.deps.wiki.recategorizeAsHuman({
      tenantId: actor.tenantId,
      userId: actor.userId,
      connector,
      wikiId,
      moves,
      categoryUpdate,
      title,
    })
    if (!result.ok) throw new WikiCategoryError('conflict')
    return result.result.pages
  }

  private async audit(
    connector: Connector,
    actor: WikiConsoleActor,
    action: string,
    targetId: string,
    metadata: Record<string, unknown>,
  ) {
    await this.deps.audit.append(
      redactKbAuditForVisibility(connector, {
        actorType: 'human',
        actorId: actor.userId,
        agentVersion: null,
        action,
        targetType: action.startsWith('kb.wiki.categories') ? 'wiki' : 'wiki_category',
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

function nodeView(node: ReturnType<typeof buildCategoryTree>[number]) {
  return {
    id: node.id,
    key: node.key,
    path: node.path,
    parentId: node.parentId,
    name: node.name,
    description: node.description,
    sortOrder: node.sortOrder,
    approval: node.approval,
    protected: node.protected,
  }
}

function countByCategory(pages: Array<Pick<WikiPage, 'category' | 'status'>>): Map<string, PageCounts> {
  const counts = new Map<string, PageCounts>()
  for (const page of pages) {
    const path = normalizeCategoryPath(page.category)
    if (!path) continue
    const row = counts.get(path) ?? { published: 0, archived: 0 }
    if (page.status === 'archived') row.archived++
    else row.published++
    counts.set(path, row)
  }
  return counts
}

function pathOf(rows: WikiCategoryRow[], row: WikiCategoryRow): string {
  const parent = row.parentId ? rows.find((candidate) => candidate.id === row.parentId) : null
  return parent ? `${parent.key}/${row.key}` : row.key
}

function cleanName(name: string): string {
  const value = name.replace(/\s+/g, ' ').trim().slice(0, WIKI_CATEGORY_MAX_NAME)
  if (!value) throw new WikiConsoleError('invalid_args')
  return value
}

function cleanDescription(description: string | null | undefined): string | null {
  const value = (description ?? '').trim().slice(0, WIKI_CATEGORY_MAX_DESCRIPTION)
  return value || null
}
