/**
 * #1061 F1: kezelt kategória-fa — tiszta függvények (kulcs, fa, védettség, index, átállás).
 * Futtatás: npm run test:wiki-categories
 */
import assert from 'node:assert/strict'
import {
  allowedCategoryPaths,
  buildCategoryTree,
  groupPagesByTree,
  normalizeCategoryPath,
  planFreeCategoryImport,
  renderWikiTreeIndex,
  slugifyCategory,
  sortCategoryPages,
  wikiPageDate,
  type WikiCategoryRow,
} from '../src/lib/wiki-categories'

const row = (id: string, key: string, parentId: string | null, name: string, extra: Partial<WikiCategoryRow> = {}): WikiCategoryRow => ({
  id,
  key,
  parentId,
  name,
  description: null,
  sortOrder: 0,
  approval: 'inherit',
  ...extra,
})

const rows: WikiCategoryRow[] = [
  row('b', 'partners', null, 'Partnerek', { sortOrder: 20 }),
  row('a', 'policies', null, 'Szabályzatok', { sortOrder: 10, approval: 'always' }),
  row('c', 'payment', 'b', 'Fizetés'),
  row('d', 'contracts', 'a', 'Szerződések'),
  row('e', 'orphan', 'missing', 'Árva', { sortOrder: 30 }),
]

assert.equal(slugifyCategory('Fizetési partnerek'), 'fizetesi-partnerek')
assert.equal(slugifyCategory('  Ügyfél / Szerződés!! '), 'ugyfel-szerzodes')
assert.equal(slugifyCategory('💳'), '')
assert.equal(normalizeCategoryPath(' Partners / Payment '), 'partners/payment')
assert.equal(normalizeCategoryPath(null), '')

const tree = buildCategoryTree(rows)
assert.deepEqual(tree.map((node) => node.path), ['policies', 'partners', 'orphan'])
assert.deepEqual(allowedCategoryPaths(rows), ['policies', 'policies/contracts', 'partners', 'partners/payment', 'orphan'])
// A szülő „mindig jóváhagyás” szabálya az alkategóriára is érvényes, fordítva nem.
assert.equal(tree[0].children[0].protected, true)
assert.equal(tree[1].protected, false)
assert.equal(tree[1].children[0].protected, false)

const pages = [
  { path: 'p/dkv.md', title: 'DKV', summary: 'kártya', category: 'partners/payment', type: 'entity' },
  { path: 'p/teya.md', title: 'Teya', summary: 't', category: 'partners', type: 'entity' },
  { path: 'x/free.md', title: 'Free', summary: 'f', category: 'Régi kategória', type: 'entity' },
  { path: 'x/none.md', title: 'None', summary: 'n', category: null, type: 'entity' },
]
const groups = groupPagesByTree(pages, rows)
assert.deepEqual(groups.map((group) => [group.path, group.pageCount]), [
  ['policies', 0],
  ['partners', 2],
  ['orphan', 0],
  [null, 2],
])
assert.equal(groups[1].children[0].pages[0].path, 'p/dkv.md')
const index = renderWikiTreeIndex(pages, rows)
assert.match(index, /^# Index\n\n4 pages\.\n\n## Partnerek\n\n- \[\[p\/teya\]\] — Teya: t\n\n### Fizetés\n\n- \[\[p\/dkv\]\] — DKV: kártya\n\n## Uncategorized\n/)
assert.doesNotMatch(index, /Szabályzatok/)

const plan = planFreeCategoryImport(
  [{ category: 'Fizetési partnerek' }, { category: 'fizetési partnerek ' }, { category: 'partners/payment' }, { category: null }, { category: '💳' }],
  rows,
)
assert.deepEqual(
  plan.map(({ key, pageCount, exists }) => [key, pageCount, exists]),
  [
    ['category-1', 1, false],
    ['partners/payment', 1, true],
    ['fizetesi-partnerek', 2, false],
  ],
)

const tricky = [{ category: 'Payment' }, { category: '💳' }, { category: '💳' }, { category: 'category-1' }, { category: 'fizetési partnerek' }, { category: 'Fizetési partnerek' }]
const imported = planFreeCategoryImport(tricky, rows)
assert.deepEqual(imported, planFreeCategoryImport([...tricky].reverse(), rows))
assert.equal(imported.find((row) => row.name === 'Fizetési partnerek')?.pageCount, 2)
assert.equal(imported.find((row) => row.name === '💳')?.pageCount, 2)
assert.equal(new Set(imported.map((row) => row.key)).size, imported.length)
assert.ok(imported.every((item) => !rows.some((row) => row.key === item.key)))
assert.equal(planFreeCategoryImport([{ category: 'Fizetési partnerek' }], [row('f', 'fizetesi-partnerek', null, 'Partnerek')])[0].exists, true)
// --- Menüsorrend: explicit sorrend, „nincs megadva” a végén név szerint ---------------
const ordered = buildCategoryTree([
  row('s', 'sources', null, 'Sources', { sortOrder: null }),
  row('z', 'zeta', null, 'Zeta', { sortOrder: 20 }),
  row('n', 'alpha', null, 'Alpha', { sortOrder: null }),
  row('m', 'mid', null, 'Mid', { sortOrder: 25 }),
  row('y', 'start', null, 'Start here', { sortOrder: 10 }),
  row('k2', 'b', 'z', 'Bé', { sortOrder: null }),
  row('k1', 'a', 'z', 'Á', { sortOrder: 5 }),
])
// 25 a 20 és a 30 közé kerül átszámozás nélkül; a sorrend nélküliek a végén, név szerint.
assert.deepEqual(ordered.map((node) => node.key), ['start', 'zeta', 'mid', 'alpha', 'sources'])
assert.deepEqual(ordered[1].children.map((node) => node.key), ['a', 'b'])

// --- Oldalak sorrendje kategórián belül -------------------------------------------------
const decision = [
  { path: 'd/a.md', title: 'Alpha', updatedAt: new Date('2026-01-05'), createdAt: new Date('2026-01-01'), frontmatter: { date: '2026-03-01' } },
  { path: 'd/b.md', title: 'Beta', updatedAt: new Date('2026-02-05'), createdAt: new Date('2026-01-02'), frontmatter: { source_date: '2026-04-01' } },
  { path: 'd/c.md', title: 'Charlie', updatedAt: new Date('2026-01-01'), createdAt: new Date('2026-05-01'), frontmatter: {} },
  { path: 'd/how.md', title: 'How to use this wiki', updatedAt: new Date('2025-01-01'), createdAt: new Date('2025-01-01'), frontmatter: { date: 'nem dátum' } },
]
const order = (pages: Array<{ path: string }>) => pages.map((page) => page.path)
assert.deepEqual(order(sortCategoryPages(decision, null)), ['d/a.md', 'd/b.md', 'd/c.md', 'd/how.md'])
assert.deepEqual(order(sortCategoryPages(decision, { pageSort: 'updated_desc' })), ['d/b.md', 'd/a.md', 'd/c.md', 'd/how.md'])
// date_desc: frontmatter `date` → `source_date` → létrehozás; a hibás dátum is a létrehozásra esik vissza.
assert.equal(wikiPageDate(decision[3]), new Date('2025-01-01').getTime())
assert.deepEqual(order(sortCategoryPages(decision, { pageSort: 'date_desc' })), ['d/c.md', 'd/b.md', 'd/a.md', 'd/how.md'])
// Kiemelt oldal a rendezéstől függetlenül felül, a megadott sorrendben; a nem létező path nem számít.
assert.deepEqual(
  order(sortCategoryPages(decision, { pageSort: 'date_desc', pinnedPages: ['d/how.md', 'missing.md', 'd/a.md'] })),
  ['d/how.md', 'd/a.md', 'd/c.md', 'd/b.md'],
)
// Kézi sorrend: a listán nem szereplő (új) oldal a végére, cím szerint.
assert.deepEqual(order(sortCategoryPages(decision, { pageSort: 'manual', pageOrder: ['d/c.md', 'd/a.md'] })), ['d/c.md', 'd/a.md', 'd/b.md', 'd/how.md'])

// A csoport hordozza a sorrendet, a becsukást és a ténylegesen kiemelt oldalakat (menü + agent ugyanazt kapja).
const menuRows = [
  row('r1', 'decisions', null, 'Decision log', { sortOrder: 20, pageSort: 'date_desc', pinnedPages: ['d/how.md', 'gone.md'] }),
  row('r2', 'sources', null, 'Sources', { sortOrder: null, collapsed: true }),
  row('r3', 'start', null, 'Start here', { sortOrder: 10 }),
]
const menuGroups = groupPagesByTree(
  [...decision.map((page) => ({ ...page, summary: '', type: 'concept', category: 'decisions' })), { path: 's/x.md', title: 'X', summary: '', type: 'source', category: 'sources' }],
  menuRows,
)
assert.deepEqual(menuGroups.map((group) => [group.path, group.order, group.collapsed]), [['start', 10, false], ['decisions', 20, false], ['sources', null, true]])
assert.deepEqual(menuGroups[1].pinned, ['d/how.md'])
assert.deepEqual(order(menuGroups[1].pages), ['d/how.md', 'd/c.md', 'd/b.md', 'd/a.md'])
const menuIndex = renderWikiTreeIndex(menuGroups.flatMap((group) => group.pages), menuRows)
assert.ok(menuIndex.indexOf('## Decision log') < menuIndex.indexOf('## Sources'))
assert.ok(menuIndex.indexOf('[[d/how]]') < menuIndex.indexOf('[[d/c]]'))
console.log('wiki-categories: ok')
