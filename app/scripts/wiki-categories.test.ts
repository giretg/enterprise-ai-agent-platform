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
console.log('wiki-categories: ok')
