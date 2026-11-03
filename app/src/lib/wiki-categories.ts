/**
 * #1061 F1 — kezelt kategória-fa (legfeljebb 2 szint), DB-mentes rész.
 *
 * - kulcs-szabály és szabad szövegből képzett kulcs (bekapcsoláskor),
 * - fa és kulcsút (`partners/payment` — ez kerül az oldal `category` mezőjébe),
 * - kategória-szabály: `always` a kategóriára és az alkategóriáira is érvényes,
 * - oldalak csoportosítása a fa szerint (menü, `index.md`, `kb_list_index`).
 */
import type { WikiIndexPage } from './kb-wiki'

/** = `kb-wiki` `WIKI_UNCATEGORIZED`; itt nem importáljuk, mert a felület is használja ezt a modult (node:crypto). */
const WIKI_UNCATEGORIZED = 'Uncategorized'

export const WIKI_CATEGORY_KEY_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export const WIKI_CATEGORY_MAX_KEY = 60
export const WIKI_CATEGORY_MAX_NAME = 120
export const WIKI_CATEGORY_MAX_DESCRIPTION = 500
/** Egy wikiben ennyi kategória lehet (a briefing és a menü olvasható maradjon). */
export const WIKI_CATEGORY_MAX_COUNT = 200

export type WikiCategoryApprovalRule = 'inherit' | 'always'

export type WikiCategoryRow = {
  id: string
  key: string
  parentId: string | null
  name: string
  description: string | null
  sortOrder: number
  approval: WikiCategoryApprovalRule
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

function byOrder(a: WikiCategoryRow, b: WikiCategoryRow) {
  return a.sortOrder - b.sortOrder || a.name.localeCompare(b.name) || a.key.localeCompare(b.key)
}

/** Fa a sorokból. Árva (nem létező szülőjű) sor felső szintre kerül, hogy semmi ne tűnjön el. */
export function buildCategoryTree(rows: WikiCategoryRow[]): WikiCategoryNode[] {
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
  let fallback = 0
  for (const page of pages) {
    const value = page.category?.trim()
    if (!value) continue
    const existingNode = index.get(normalizeCategoryPath(value))
    const key = existingNode?.path ?? (slugifyCategory(value) || `category-${++fallback}`)
    const row = byKey.get(key) ?? { key, name: existingNode?.name ?? value, pageCount: 0, values: [], exists: !!existingNode }
    row.pageCount++
    if (!row.values.includes(value)) row.values.push(value)
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
  /** Az oldalak száma az alkategóriákkal együtt. */
  pageCount: number
  pages: P[]
  children: Array<Omit<WikiTreeGroup<P>, 'children'>>
}

/**
 * Oldalak a fa szerint. Az üres kategóriák is megjelennek (a menüben látszik, hová
 * lehet írni); a fában nem szereplő kategóriájú oldalak a végén, „Uncategorized” alatt.
 */
export function groupPagesByTree<P extends Pick<WikiIndexPage, 'path' | 'category'>>(
  pages: P[],
  rows: WikiCategoryRow[],
): Array<WikiTreeGroup<P>> {
  const tree = buildCategoryTree(rows)
  const buckets = new Map<string, P[]>()
  const rest: P[] = []
  const known = new Set(flattenCategoryTree(tree).map((node) => node.path))
  for (const page of [...pages].sort((a, b) => a.path.localeCompare(b.path))) {
    const path = normalizeCategoryPath(page.category)
    if (path && known.has(path)) buckets.set(path, [...(buckets.get(path) ?? []), page])
    else rest.push(page)
  }
  const groups: Array<WikiTreeGroup<P>> = tree.map((node) => {
    const children = node.children.map((child) => {
      const own = buckets.get(child.path) ?? []
      return {
        path: child.path,
        name: child.name,
        description: child.description,
        protected: child.protected,
        pageCount: own.length,
        pages: own,
      }
    })
    const own = buckets.get(node.path) ?? []
    return {
      path: node.path,
      name: node.name,
      description: node.description,
      protected: node.protected,
      pageCount: own.length + children.reduce((sum, child) => sum + child.pageCount, 0),
      pages: own,
      children,
    }
  })
  if (rest.length > 0) {
    groups.push({ path: null, name: WIKI_UNCATEGORIZED, description: null, protected: false, pageCount: rest.length, pages: rest, children: [] })
  }
  return groups
}

/** `index.md` a fa szerint: `## Kategória` → `### Alkategória` (D8 determinisztikus). */
export function renderWikiTreeIndex(pages: WikiIndexPage[], rows: WikiCategoryRow[]): string {
  const line = (page: WikiIndexPage) => `- [[${page.path.replace(/\.md$/, '')}]] — ${page.title}: ${page.summary}`
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
