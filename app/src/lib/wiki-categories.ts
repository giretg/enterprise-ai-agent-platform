/**
 * #1061 F1 — kezelt kategória-fa (legfeljebb 2 szint), DB-mentes rész.
 *
 * - kulcs-szabály és szabad szövegből képzett kulcs (bekapcsoláskor),
 * - fa és kulcsút (`partners/payment` — ez kerül az oldal `category` mezőjébe),
 * - kategória-szabály: `always` a kategóriára és az alkategóriáira is érvényes,
 * - oldalak csoportosítása a fa szerint (menü, `index.md`, `kb_list_index`),
 * - menüsorrend: explicit `sortOrder` (nincs → név szerint, a sorrendezettek után),
 *   kategóriánként oldalrendezés (`pageSort`) és kiemelt oldalak (`pinnedPages`).
 */
import { isUnknownSourceDate, wikiIndexLine, type WikiIndexPage } from './kb-wiki'

/** = `kb-wiki` `WIKI_UNCATEGORIZED`; itt nem importáljuk, mert a felület is használja ezt a modult (node:crypto). */
const WIKI_UNCATEGORIZED = 'Uncategorized'

export const WIKI_CATEGORY_KEY_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export const WIKI_CATEGORY_MAX_KEY = 60
export const WIKI_CATEGORY_MAX_NAME = 120
export const WIKI_CATEGORY_MAX_DESCRIPTION = 500
/** Egy wikiben ennyi kategória lehet (a briefing és a menü olvasható maradjon). */
export const WIKI_CATEGORY_MAX_COUNT = 200

export type WikiCategoryApprovalRule = 'inherit' | 'always'

/** Oldalak sorrendje egy kategórián belül. */
export const WIKI_PAGE_SORTS = ['title', 'updated_desc', 'date_desc', 'manual'] as const
export type WikiPageSort = (typeof WIKI_PAGE_SORTS)[number]
/** Ennyi oldal emelhető ki egy kategória tetejére. */
export const WIKI_CATEGORY_MAX_PINNED = 3
/** Kézi sorrendnél ennyi oldal sorrendje tárolódik (a többi utánuk, cím szerint). */
export const WIKI_CATEGORY_MAX_PAGE_ORDER = 500
/** Az új kategória sorrend-lépésköze: 10, 20, 30… — közé renumbering nélkül beszúrható (pl. 25). */
export const WIKI_CATEGORY_ORDER_STEP = 10

export type WikiCategoryRow = {
  id: string
  key: string
  parentId: string | null
  name: string
  description: string | null
  /** Menüsorrend a testvérek között; `null` = nincs megadva (a sorrendezettek után, név szerint). */
  sortOrder: number | null
  approval: WikiCategoryApprovalRule
  /** Oldalak sorrendje a kategórián belül (alapból cím szerint). */
  pageSort?: WikiPageSort
  /** Kiemelt oldalak path-jai: a rendezéstől függetlenül felül, ebben a sorrendben. */
  pinnedPages?: string[]
  /** `manual` rendezésnél az oldalak sorrendje (path-lista). */
  pageOrder?: string[]
  /** Alapból becsukott csoport a menüben. */
  collapsed?: boolean
  /**
   * #1061 F2: „kapcsolt wiki” menüpont — egy másik tudástárra mutat. Nem tartalmi
   * kategória: oldal nem kerülhet bele, az `index.md`-be, a briefingbe és a fába sem kerül.
   */
  linkedConnectorId?: string | null
  /** #1061 F3: alapértelmezett átnézési ciklus (nap); az alkategória felülírja. */
  reviewCycleDays?: number | null
  /** #1061 F3: kötelező mezők kulcsai (egyedi mező vagy `owner`); az alkategória örökli. */
  requiredFields?: string[]
  /** #1061 F4: kötelező fejezetek, a hiányuk súlya és az induló váz. */
  requiredSections?: string[]
  sectionRule?: 'warn' | 'error'
  templateMd?: string | null
  /** #1075: a névvel ellátott sablon, amelyből a szabályok jöttek (agent-javaslat); felületi szerkesztés után `null`. */
  templateKey?: string | null
}

export type WikiCategoryNode = WikiCategoryRow & {
  /** Kulcsút: `partners` vagy `partners/payment`. */
  path: string
  /** A saját vagy a szülő szabálya miatt minden oldalművelet jóváhagyással megy. */
  protected: boolean
  children: WikiCategoryNode[]
}

export function isValidCategoryKey(key: string): boolean {
  return key.length <= WIKI_CATEGORY_MAX_KEY && WIKI_CATEGORY_KEY_RE.test(key)
}

/** Az agent / felület által adott kategória összevetéshez (kisbetű, perjelek körül szóköz nélkül). */
export function normalizeCategoryPath(value: string | null | undefined): string {
  return (value ?? '')
    .split('/')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)
    .join('/')
}

/** Szabad kategórianévből kulcs: ékezet nélkül, kötőjellel („Fizetési partnerek” → `fizetesi-partnerek`). */
export function slugifyCategory(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, WIKI_CATEGORY_MAX_KEY)
    .replace(/-+$/g, '')
}

/** A sorrendezett elemek elöl (növekvő `sortOrder`), utánuk a többi név szerint. */
export function byOrder(a: Pick<WikiCategoryRow, 'sortOrder' | 'name' | 'key'>, b: Pick<WikiCategoryRow, 'sortOrder' | 'name' | 'key'>) {
  const ao = a.sortOrder ?? Number.POSITIVE_INFINITY
  const bo = b.sortOrder ?? Number.POSITIVE_INFINITY
  return (ao === bo ? 0 : ao < bo ? -1 : 1) || a.name.localeCompare(b.name) || a.key.localeCompare(b.key)
}

/** Ami az oldal-rendezéshez kell; a hiányzó mező a cím / path szerinti sorrendre esik vissza. */
export type WikiSortablePage = {
  path: string
  title?: string
  updatedAt?: Date | string
  createdAt?: Date | string
  frontmatter?: unknown
}

function time(value: unknown): number | null {
  if (!(value instanceof Date) && typeof value !== 'string') return null
  const ms = new Date(value).getTime()
  return Number.isFinite(ms) ? ms : null
}

/**
 * A `date_desc` dátuma: a frontmatter `date` vagy `source_date` mezője, különben a létrehozás.
 * #1077: az ismeretlen dátum a lista végére kerül (két ilyen különbsége `NaN`, ott a cím dönt).
 */
export function wikiPageDate(page: WikiSortablePage): number {
  const fm = page.frontmatter && typeof page.frontmatter === 'object' ? (page.frontmatter as Record<string, unknown>) : {}
  return time(fm.date) ?? (isUnknownSourceDate(fm.source_date) ? Number.NEGATIVE_INFINITY : time(fm.source_date) ?? time(page.createdAt) ?? 0)
}

const byTitle = (a: WikiSortablePage, b: WikiSortablePage) =>
  (a.title ?? a.path).localeCompare(b.title ?? b.path) || a.path.localeCompare(b.path)

/**
 * Egy kategória oldalai menüsorrendben: előbb a kiemeltek (a megadott sorrendben),
 * aztán a `pageSort` szerint. Kézi sorrendnél a listán nem szereplő oldal a végére, cím szerint.
 */
export function sortCategoryPages<P extends WikiSortablePage>(
  pages: P[],
  rule: Pick<WikiCategoryRow, 'pageSort' | 'pinnedPages' | 'pageOrder'> | null,
): P[] {
  const pinned = rule?.pinnedPages ?? []
  const pinRank = new Map(pinned.map((path, i) => [path, i]))
  const manual = new Map((rule?.pageOrder ?? []).map((path, i) => [path, i]))
  const sort = rule?.pageSort ?? 'title'
  const compare = (a: P, b: P): number => {
    if (sort === 'updated_desc') return (time(b.updatedAt) ?? 0) - (time(a.updatedAt) ?? 0) || byTitle(a, b)
    if (sort === 'date_desc') return wikiPageDate(b) - wikiPageDate(a) || byTitle(a, b)
    if (sort === 'manual') {
      const am = manual.get(a.path) ?? Number.POSITIVE_INFINITY
      const bm = manual.get(b.path) ?? Number.POSITIVE_INFINITY
      return (am === bm ? 0 : am < bm ? -1 : 1) || byTitle(a, b)
    }
    return byTitle(a, b)
  }
  return [...pages].sort((a, b) => {
    const ap = pinRank.get(a.path) ?? Number.POSITIVE_INFINITY
    const bp = pinRank.get(b.path) ?? Number.POSITIVE_INFINITY
    return (ap === bp ? 0 : ap < bp ? -1 : 1) || compare(a, b)
  })
}

/** A kiemelt path-ok közül azok, amelyek ténylegesen az oldalak között vannak. */
function pinnedAmong(pages: WikiSortablePage[], rule: Pick<WikiCategoryRow, 'pinnedPages'>): string[] {
  const present = new Set(pages.map((page) => page.path))
  return (rule.pinnedPages ?? []).filter((path) => present.has(path))
}

/**
 * Fa a sorokból. Árva (nem létező szülőjű) sor felső szintre kerül, hogy semmi ne tűnjön el.
 * A „kapcsolt wiki” menüpontok nem részei (lásd `linkedWikiItems`).
 */
export function buildCategoryTree(allRows: WikiCategoryRow[]): WikiCategoryNode[] {
  const rows = allRows.filter((row) => !row.linkedConnectorId)
  const ids = new Set(rows.map((row) => row.id))
  const roots = rows.filter((row) => !row.parentId || !ids.has(row.parentId)).sort(byOrder)
  return roots.map((root) => {
    const rootProtected = root.approval === 'always'
    return {
      ...root,
      parentId: null,
      path: root.key,
      protected: rootProtected,
      children: rows
        .filter((row) => row.parentId === root.id)
        .sort(byOrder)
        .map((child) => ({
          ...child,
          path: `${root.key}/${child.key}`,
          protected: rootProtected || child.approval === 'always',
          children: [],
        })),
    }
  })
}

export type WikiLinkedItem = {
  id: string
  key: string
  name: string
  sortOrder: number | null
  linkedConnectorId: string
  /** A felső szintű kategória kulcsa, ha alatta van; `null` = felső szintű menüpont. */
  parentKey: string | null
}

/** #1061 F2: a „kapcsolt wiki” menüpontok (a láthatóságot a hívó szűri). */
export function linkedWikiItems(rows: WikiCategoryRow[]): WikiLinkedItem[] {
  const roots = new Map(rows.filter((row) => !row.linkedConnectorId && !row.parentId).map((row) => [row.id, row.key]))
  return rows
    .filter((row): row is WikiCategoryRow & { linkedConnectorId: string } => !!row.linkedConnectorId)
    .sort(byOrder)
    .map((row) => ({
      id: row.id,
      key: row.key,
      name: row.name,
      sortOrder: row.sortOrder,
      linkedConnectorId: row.linkedConnectorId,
      parentKey: row.parentId ? roots.get(row.parentId) ?? null : null,
    }))
}

export function flattenCategoryTree(tree: WikiCategoryNode[]): WikiCategoryNode[] {
  return tree.flatMap((node) => [node, ...node.children])
}

/** Kulcsút → csomópont (normalizált kulccsal). */
export function categoryIndex(rows: WikiCategoryRow[]): Map<string, WikiCategoryNode> {
  return new Map(flattenCategoryTree(buildCategoryTree(rows)).map((node) => [node.path, node]))
}

/** Az engedélyezett kulcsutak (hibaüzenethez, briefinghez). */
export function allowedCategoryPaths(rows: WikiCategoryRow[]): string[] {
  return flattenCategoryTree(buildCategoryTree(rows)).map((node) => node.path)
}

/**
 * Bekapcsoláskor: a meglévő szabad kategóriákból felső szintű kategóriák.
 * Azonos kulcsra jutó nevek egy kategóriába olvadnak; a már létező kulcs nem jön létre újra.
 */
export function planFreeCategoryImport(
  pages: Array<{ category: string | null }>,
  existing: WikiCategoryRow[],
): Array<{ key: string; name: string; pageCount: number; values: string[]; exists: boolean }> {
  const index = categoryIndex(existing)
  const byKey = new Map<string, { key: string; name: string; pageCount: number; values: string[]; exists: boolean }>()
  // Stable names and fallback keys regardless of database collation / row order.
  const counts = new Map<string, number>()
  for (const page of pages) {
    const value = page.category?.trim()
    if (value) counts.set(value, (counts.get(value) ?? 0) + 1)
  }
  const values = [...counts.keys()].sort()
  const reserved = new Set([...existing.map((row) => row.key), ...values.map(slugifyCategory)])
  const allocated = new Map<string, string>()
  let fallback = 0
  for (const value of values) {
    const slug = slugifyCategory(value)
    const node = index.get(normalizeCategoryPath(value)) ?? index.get(slug)
    const token = slug || normalizeCategoryPath(value)
    let key = node?.path ?? allocated.get(token) ?? slug
    if (!key || (!node && !allocated.has(token) && existing.some((row) => row.key === key))) {
      do { key = `category-${++fallback}` } while (reserved.has(key))
      reserved.add(key)
    }
    allocated.set(token, key)
    const row = byKey.get(key) ?? { key, name: node?.name ?? value, pageCount: 0, values: [], exists: !!node }
    row.pageCount += counts.get(value)!
    row.values.push(value)
    byKey.set(key, row)
  }
  return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export type WikiTreeGroup<P> = {
  /** Kulcsút; `null` = kategória nélküli / ismeretlen kategóriájú oldalak. */
  path: string | null
  name: string
  description: string | null
  protected: boolean
  /** Menüsorrend (`null` = nincs megadva); az „Uncategorized” csoportnál mindig `null`. */
  order: number | null
  pageSort: WikiPageSort
  collapsed: boolean
  /** A `pages` elején álló kiemelt oldalak path-jai. */
  pinned: string[]
  /** Az oldalak száma az alkategóriákkal együtt. */
  pageCount: number
  pages: P[]
  children: Array<Omit<WikiTreeGroup<P>, 'children'>>
}

/**
 * Oldalak a fa szerint. Az üres kategóriák is megjelennek (a menüben látszik, hová
 * lehet írni); a fában nem szereplő kategóriájú oldalak a végén, „Uncategorized” alatt.
 */
export function groupPagesByTree<P extends Pick<WikiIndexPage, 'path' | 'category'> & WikiSortablePage>(
  pages: P[],
  rows: WikiCategoryRow[],
): Array<WikiTreeGroup<P>> {
  const tree = buildCategoryTree(rows)
  const buckets = new Map<string, P[]>()
  const rest: P[] = []
  const known = new Set(flattenCategoryTree(tree).map((node) => node.path))
  for (const page of pages) {
    const path = normalizeCategoryPath(page.category)
    if (path && known.has(path)) buckets.set(path, [...(buckets.get(path) ?? []), page])
    else rest.push(page)
  }
  const groups: Array<WikiTreeGroup<P>> = tree.map((node) => {
    const view = (category: WikiCategoryNode) => {
      const own = sortCategoryPages(buckets.get(category.path) ?? [], category)
      return {
        path: category.path,
        name: category.name,
        description: category.description,
        protected: category.protected,
        order: category.sortOrder,
        pageSort: category.pageSort ?? 'title',
        collapsed: !!category.collapsed,
        pinned: pinnedAmong(own, category),
        pageCount: own.length,
        pages: own,
      }
    }
    const children = node.children.map(view)
    const self = view(node)
    return { ...self, pageCount: self.pageCount + children.reduce((sum, child) => sum + child.pageCount, 0), children }
  })
  if (rest.length > 0) {
    groups.push({
      path: null,
      name: WIKI_UNCATEGORIZED,
      description: null,
      protected: false,
      order: null,
      pageSort: 'title',
      collapsed: false,
      pinned: [],
      pageCount: rest.length,
      pages: sortCategoryPages(rest, null),
      children: [],
    })
  }
  return groups
}

/** `index.md` a fa szerint: `## Kategória` → `### Alkategória` (D8 determinisztikus). */
export function renderWikiTreeIndex(pages: Array<WikiIndexPage & WikiSortablePage>, rows: WikiCategoryRow[]): string {
  const line = wikiIndexLine
  const lines = ['# Index', '', `${pages.length} page${pages.length === 1 ? '' : 's'}.`]
  for (const group of groupPagesByTree(pages, rows)) {
    if (group.pageCount === 0) continue
    lines.push('', `## ${group.name}`)
    if (group.pages.length) lines.push('', ...group.pages.map(line))
    for (const child of group.children) {
      if (child.pageCount === 0) continue
      lines.push('', `### ${child.name}`, '', ...child.pages.map(line))
    }
  }
  return `${lines.join('\n')}\n`
}
