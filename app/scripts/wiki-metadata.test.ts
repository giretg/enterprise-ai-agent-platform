/**
 * #1061 F3/F4 — a metaadat-mezők DB-mentes része: egyedi mezőérték ellenőrzése (AC14),
 * kategória-szabályok öröklése, átnézési esedékesség (AC11), kötelező fejezetek (AC15),
 * nézet-szűrők (`kb_list_index`), régi frontmatter átemelése.
 * Futtatás: npm run test:wiki-metadata
 */
import assert from 'node:assert/strict'
import {
  categoryMatches,
  categoryRulesFor,
  effectiveReviewCycle,
  fieldValueMatches,
  isReviewOverdue,
  isValidFieldKey,
  legacyMetaFromFrontmatter,
  missingSections,
  normalizeFieldValue,
  overdueDays,
  parseWikiViewFilter,
  readWikiMeta,
  reviewDueAt,
  skeletonFor,
} from '../src/lib/wiki-metadata'
import type { WikiCategoryRow } from '../src/lib/wiki-categories'

let failures = 0
function check(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  OK  ${name}`)
  } catch (e) {
    failures++
    console.log(`  FAIL ${name}: ${e instanceof Error ? e.stack : e}`)
  }
}

console.log('=== #1061 F3/F4 metaadat (tiszta függvények) ===')

const country = { key: 'country', type: 'select' as const, options: ['HU', 'SK'] }
const products = { key: 'products', type: 'multi_select' as const, options: ['Card', 'Fuel'] }

check('AC14: listán kívüli érték hiba; az engedett érték kanonikus írásmódot kap', () => {
  assert.deepEqual(normalizeFieldValue(country, 'hu'), { ok: true, value: 'HU' })
  const bad = normalizeFieldValue(country, 'RO')
  assert.equal(bad.ok, false)
  assert.match((bad as { message: string }).message, /Allowed: HU, SK/)
  assert.deepEqual(normalizeFieldValue(country, ''), { ok: true, value: null })
})

check('több-választós lista: tömb vagy vesszős szöveg, ismétlés nélkül', () => {
  assert.deepEqual(normalizeFieldValue(products, 'card, Fuel, CARD'), { ok: true, value: ['Card', 'Fuel'] })
  assert.deepEqual(normalizeFieldValue(products, ['Fuel']), { ok: true, value: ['Fuel'] })
  assert.equal(normalizeFieldValue(products, ['Card', 'Gas']).ok, false)
})

check('dátum és szöveg mező', () => {
  assert.deepEqual(normalizeFieldValue({ key: 'd', type: 'date', options: [] }, '2026-11-03'), { ok: true, value: '2026-11-03' })
  assert.equal(normalizeFieldValue({ key: 'd', type: 'date', options: [] }, '2026-02-30').ok, false)
  assert.deepEqual(normalizeFieldValue({ key: 't', type: 'text', options: [] }, 42), { ok: true, value: '42' })
  assert.equal(normalizeFieldValue({ key: 't', type: 'text', options: [] }, 'x'.repeat(501)).ok, false)
})

check('mezőkulcs: a beépített mezők régi nevei foglaltak', () => {
  assert.equal(isValidFieldKey('country'), true)
  assert.equal(isValidFieldKey('owner'), false)
  assert.equal(isValidFieldKey('status'), false)
  assert.equal(isValidFieldKey('Country'), false)
  assert.equal(isValidFieldKey('1x'), false)
})

const rows: WikiCategoryRow[] = [
  { id: 'p', key: 'policies', parentId: null, name: 'Policies', description: null, sortOrder: 10, approval: 'inherit', reviewCycleDays: 30, requiredFields: ['owner'], requiredSections: ['Summary'], sectionRule: 'warn', templateMd: null },
  { id: 'c', key: 'contracts', parentId: 'p', name: 'Contracts', description: null, sortOrder: 10, approval: 'inherit', reviewCycleDays: null, requiredFields: ['country'], requiredSections: ['Parties', 'summary'], sectionRule: 'error', templateMd: '## Summary\n\n## Parties' },
  { id: 'x', key: 'linked', parentId: null, name: 'Linked', description: null, sortOrder: 20, approval: 'inherit', linkedConnectorId: '00000000-0000-4000-8000-000000000000' },
]

check('kategória-szabály: az alkategória örököl (mezők, fejezetek uniója, szigorúbb szabály, szülő ciklusa)', () => {
  const child = categoryRulesFor('Policies / Contracts', rows)!
  assert.equal(child.reviewCycleDays, 30)
  assert.deepEqual(child.requiredFields, ['owner', 'country'])
  assert.deepEqual(child.requiredSections, ['Summary', 'Parties'])
  assert.equal(child.sectionRule, 'error')
  assert.equal(skeletonFor(child), '## Summary\n\n## Parties')
  assert.equal(skeletonFor(categoryRulesFor('policies', rows)!), '## Summary')
  assert.equal(categoryRulesFor('unknown', rows), null)
  assert.equal(categoryRulesFor('linked', rows), null)
  assert.equal(categoryRulesFor(null, rows), null)
})

check('AC11: esedékesség = utolsó átnézés (vagy létrehozás) + ciklus; „< ma” naptári napra', () => {
  const created = new Date('2026-08-01T10:00:00Z')
  const due = reviewDueAt({ reviewedAt: '2026-09-01T10:00:00Z', createdAt: created, cycleDays: 30 })!
  assert.equal(due.toISOString().slice(0, 10), '2026-10-01')
  assert.equal(isReviewOverdue(due, new Date('2026-10-01T23:00:00Z')), false)
  assert.equal(isReviewOverdue(due, new Date('2026-10-02T00:00:01Z')), true)
  assert.equal(overdueDays(due, new Date('2026-10-05T08:00:00Z')), 4)
  assert.equal(reviewDueAt({ reviewedAt: null, createdAt: created, cycleDays: 10 })!.toISOString().slice(0, 10), '2026-08-11')
  assert.equal(reviewDueAt({ reviewedAt: null, createdAt: created, cycleDays: null }), null)
  assert.equal(isReviewOverdue(null, new Date()), false)
  assert.equal(effectiveReviewCycle({ reviewCycleDays: 7 }, categoryRulesFor('policies', rows)), 7)
  assert.equal(effectiveReviewCycle({ reviewCycleDays: null }, categoryRulesFor('policies', rows)), 30)
})

check('AC15: hiányzó kötelező fejezet bármely címsorszinten', () => {
  const body = '# Cím\n\n### summary ###\n\nx\n\n## Kapcsolat\n'
  assert.deepEqual(missingSections(body, ['Summary', 'Parties']), ['Parties'])
  assert.deepEqual(missingSections(body, []), [])
})

check('nézet-szűrő: vesszős értékek, field.<kulcs> és fields, szűrő nélkül null', () => {
  assert.equal(parseWikiViewFilter({ wikiId: 'x', definitionId: 'y' }), null)
  const filter = parseWikiViewFilter({
    docStatus: 'draft, tervezet,approved,bogus',
    owner: 'me, a@b.hu',
    reviewOverdue: 'true',
    category: 'Policies / Contracts,partners',
    orphans: true,
    'field.country': 'HU,SK',
    fields: 'products=Card;country=RO',
  })!
  assert.deepEqual(filter.docStatus, ['draft', 'approved'])
  assert.deepEqual(filter.owner, ['me', 'a@b.hu'])
  assert.equal(filter.reviewOverdue, true)
  assert.deepEqual(filter.category, ['policies/contracts', 'partners'])
  assert.equal(filter.orphans, true)
  assert.deepEqual(filter.fields, [
    { key: 'products', values: ['Card'] },
    { key: 'country', values: ['RO', 'HU', 'SK'] },
  ])
  assert.deepEqual(parseWikiViewFilter({ reviewOverdue: false }), { reviewOverdue: false })
})

check('szűrő-egyezés: kategória alkategóriával, mező tömbben is', () => {
  assert.equal(categoryMatches('policies/contracts', ['policies']), true)
  assert.equal(categoryMatches('policies-old', ['policies']), false)
  assert.equal(fieldValueMatches(['Card', 'Fuel'], ['fuel']), true)
  assert.equal(fieldValueMatches('HU', ['SK']), false)
})

check('átállás: régi status / owner / last_reviewed értelmezése', () => {
  assert.deepEqual(legacyMetaFromFrontmatter({ status: 'Jóváhagyott', owner: ' anna@x.hu ', last_reviewed: '2026-10-01', product: 'Card' }), {
    docStatus: 'approved',
    owner: 'anna@x.hu',
    reviewedAt: '2026-10-01T00:00:00.000Z',
    consumedKeys: ['status', 'owner', 'last_reviewed'],
  })
  assert.deepEqual(legacyMetaFromFrontmatter({ status: 'whatever' }), { consumedKeys: [] })
  assert.deepEqual(legacyMetaFromFrontmatter({ status: 'draft' }).docStatus, 'draft')
})

check('revízió-pillanatkép olvasása (régi revíziónál null)', () => {
  assert.equal(readWikiMeta(null), null)
  assert.deepEqual(readWikiMeta({ docStatus: 'approved', ownerUserId: 'u', reviewCycleDays: 0 }), {
    docStatus: 'approved',
    ownerUserId: 'u',
    ownerRole: null,
    reviewedAt: null,
    reviewedByUserId: null,
    reviewCycleDays: null,
  })
})

if (failures > 0) {
  console.log(`\n${failures} FAIL`)
  process.exit(1)
}
console.log('\nminden OK')
