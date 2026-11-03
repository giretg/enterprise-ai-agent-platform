/**
 * #1075 — a konfig-javaslat műveleteinek szimulációja (tiszta függvények).
 * Futtatás: npm run test:wiki-config
 */
import assert from 'node:assert/strict'
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js'
import { kbWikiConfigGetObject, kbWikiConfigProposeObject, kbWikiConfigWithdrawInputSchema } from '../src/domain/enterprise-tools/tool-definitions'
import {
  configVersionOf,
  diffConfig,
  simulateConfigOperations,
  type WikiConfigPage,
  type WikiConfigState,
} from '../src/lib/wiki-config'
import { inboundMailBlocksTool } from '../src/auth/inbound-mail-tool-guard'

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

const empty: WikiConfigState = {
  name: 'Régi',
  collect: null,
  wikiMd: '# WIKI\n',
  managedCategories: true,
  managedFields: true,
  categories: [],
  fields: [],
}
const run = (operations: unknown[], state = empty, pages: WikiConfigPage[] = [], nameEditable = true) =>
  simulateConfigOperations({ state, pages, operations, nameEditable })
const codes = (result: ReturnType<typeof run>) => result.issues.map((issue) => issue.code)
const page = (path: string, category: string | null, frontmatter: Record<string, unknown> = {}, status: WikiConfigPage['status'] = 'published'): WikiConfigPage => ({ id: path, version: 1, path, category, status, frontmatter })

const base = run([
  { op: 'upsertMetadataField', key: 'direction', label: 'Irány', type: 'single_select', options: ['in', 'out'] },
  { op: 'upsertMetadataField', key: 'tags', label: 'Címkék', type: 'multi_select', options: ['a', 'b', 'c'] },
  { op: 'upsertTemplate', id: 'partner', requiredFields: ['direction', 'owner'], requiredSections: ['Summary', '## Sources'], skeleton: '## Summary' },
  { op: 'upsertGroup', key: 'partners', label: 'Partnerek', order: 60 },
  { op: 'upsertCategory', key: 'partners/acceptance', label: 'Elfogadás', order: 10, pageSort: 'newest', template: 'partner', reviewCycleDays: 180 },
  { op: 'upsertCategory', key: 'partners/other', label: 'Egyéb' },
])
const state = base.next

console.log('=== #1075 wiki-konfig szimuláció ===')

check('sorrendben validál: mező → sablon → csoport → kategória egy javaslatban', () => {
  assert.equal(base.ok, true, JSON.stringify(base.issues))
  const child = state.categories.find((row) => row.key === 'acceptance')!
  assert.equal(child.parentKey, 'partners')
  assert.deepEqual(child.requiredFields, ['direction', 'owner'])
  assert.deepEqual(child.requiredSections, ['Summary', 'Sources'])
  assert.equal(child.templateKey, 'partner')
  assert.equal(child.pageSort, 'date_desc')
  assert.equal(state.fields[0].type, 'select')
})

check('a sorrend számít: a később létrehozott csoportra hivatkozó kategória hiba', () => {
  const result = run([
    { op: 'upsertCategory', key: 'x/y', label: 'Y' },
    { op: 'upsertGroup', key: 'x', label: 'X' },
  ])
  assert.deepEqual(codes(result), ['unknown_group'])
  assert.equal(result.issues[0].index, 0)
})

check('minden hibát egyszerre jelez, indexszel', () => {
  const result = run([
    { op: 'nincsilyen' },
    { op: 'setName', name: '' },
    { op: 'upsertCategory', key: 'Rossz Kulcs', label: 'x' },
    { op: 'upsertTemplate', id: 't', requiredFields: ['docStatus'], requiredSections: [] },
    { op: 'setName', name: 'Jó' },
  ])
  assert.deepEqual(result.issues.map((issue) => [issue.index, issue.code]), [
    [0, 'unknown_operation'],
    [1, 'invalid_operation'],
    [2, 'invalid_key'],
    [3, 'unknown_field'],
  ])
})

check('a gyerek-kulcs a wikin belül egyedi, a csoport nem teszi azzá', () => {
  const result = run([{ op: 'upsertGroup', key: 'other', label: 'x' }, { op: 'upsertGroup', key: 'g', label: 'g' }, { op: 'upsertCategory', key: 'g/acceptance', label: 'y' }], state)
  assert.deepEqual(codes(result), ['key_taken', 'key_taken'])
})

check('removeCategory: oldallal (archivált is) vagy alkategóriával category_not_empty', () => {
  const pages = [page('a.md', 'partners/acceptance', {}, 'archived')]
  assert.deepEqual(codes(run([{ op: 'removeCategory', key: 'partners/acceptance' }], state, pages)), ['category_not_empty'])
  assert.deepEqual(codes(run([{ op: 'removeCategory', key: 'partners' }], state)), ['category_not_empty'])
  assert.equal(run([{ op: 'removeCategory', key: 'partners/other' }], state).ok, true)
})

check('mergeCategory: az oldalak átkerülnek, a forrás megszűnik, és jelzi a rombolást', () => {
  const pages = [page('a.md', 'Partners/Other'), page('b.md', 'partners/acceptance')]
  const result = run([{ op: 'mergeCategory', from: 'partners/other', to: 'partners/acceptance' }], state, pages)
  assert.equal(result.ok, true)
  assert.deepEqual(result.pageChanges.map((row) => [row.path, row.toCategory]), [['a.md', 'partners/acceptance']])
  assert.equal(result.next.categories.some((row) => row.key === 'other'), false)
  assert.deepEqual(result.destructive, [{ kind: 'merge', from: 'partners/other', to: 'partners/acceptance', pageCount: 1 }])
})

check('merge után a forrás már üres: ugyanabban a javaslatban a csoport is törölhető', () => {
  const twoGroups = run([{ op: 'upsertGroup', key: 'old', label: 'Régi' }], state).next
  const pages = [page('a.md', 'old')]
  const result = run([
    { op: 'mergeCategory', from: 'old', to: 'partners/other' },
    { op: 'upsertGroup', key: 'old', label: 'Újra' },
    { op: 'removeCategory', key: 'old' },
  ], twoGroups, pages)
  assert.equal(result.ok, true, JSON.stringify(result.issues))
})

check('renameFieldOption: frontmatter átíródik egy- és többértékű mezőben, mást nem érint', () => {
  const pages = [page('a.md', null, { direction: 'in', other: 'in' }), page('b.md', null, { tags: ['a', 'b'] }), page('c.md', null, { direction: 'out' })]
  const single = run([{ op: 'renameFieldOption', field: 'direction', from: 'in', to: 'inbound' }], state, pages)
  assert.deepEqual(single.pageChanges.map((row) => row.frontmatter), [{ direction: 'inbound', other: 'in' }])
  assert.deepEqual(single.next.fields[0].options, ['inbound', 'out'])
  const multi = run([{ op: 'renameFieldOption', field: 'tags', from: 'a', to: 'z' }], state, pages)
  assert.deepEqual(multi.pageChanges[0].frontmatter, { tags: ['z', 'b'] })
})

check('removeFieldOption: használtnál remapTo kell; többértékűnél nem duplikál', () => {
  const pages = [page('a.md', null, { tags: ['a', 'b'] })]
  assert.deepEqual(codes(run([{ op: 'removeFieldOption', field: 'tags', option: 'a' }], state, pages)), ['option_in_use'])
  const remap = run([{ op: 'removeFieldOption', field: 'tags', option: 'a', remapTo: 'b' }], state, pages)
  assert.equal(remap.ok, true)
  assert.deepEqual(remap.pageChanges[0].frontmatter, { tags: ['b'] })
  assert.equal(run([{ op: 'removeFieldOption', field: 'tags', option: 'c' }], state, pages).ok, true)
  assert.deepEqual(codes(run([{ op: 'removeFieldOption', field: 'tags', option: 'a', remapTo: 'nincs' }], state, pages)), ['unknown_option'])
})

check('upsertMetadataField: típus nem változik, használt opció így nem vehető el', () => {
  assert.deepEqual(codes(run([{ op: 'upsertMetadataField', key: 'direction', label: 'x', type: 'text' }], state)), ['field_type_immutable'])
  const pages = [page('a.md', null, { direction: 'in' })]
  assert.deepEqual(codes(run([{ op: 'upsertMetadataField', key: 'direction', label: 'x', type: 'select', options: ['out'] }], state, pages)), ['option_in_use'])
})

check('opcióhasználat és átképzés kis-nagybetűtől független, többértékűnél is', () => {
  const pages = [page('a.md', null, { tags: ['A', 'B'] })]
  const result = run([{ op: 'removeFieldOption', field: 'tags', option: 'a', remapTo: 'b' }], state, pages)
  assert.deepEqual(result.pageChanges[0].frontmatter, { tags: ['b'] })
})

check('upsertTemplate frissíti a rá hivatkozó kategóriákat; removeTemplate csak hivatkozás nélkül', () => {
  const updated = run([{ op: 'upsertTemplate', id: 'partner', requiredFields: ['owner'], requiredSections: ['Új'] }], state)
  assert.deepEqual(updated.next.categories.find((row) => row.key === 'acceptance')!.requiredSections, ['Új'])
  assert.deepEqual(codes(run([{ op: 'removeTemplate', id: 'partner' }], state)), ['template_in_use'])
  const cleared = run([{ op: 'updateCategory', key: 'partners/acceptance', template: null }, { op: 'removeTemplate', id: 'partner' }], state)
  assert.equal(cleared.ok, true, JSON.stringify(cleared.issues))
  const child = cleared.next.categories.find((row) => row.key === 'acceptance')!
  assert.deepEqual([child.templateKey, child.requiredFields], [null, []])
  assert.deepEqual(codes(run([{ op: 'upsertCategory', key: 'partners/x', label: 'x', template: 'nincs' }], state)), ['unknown_template'])
})

check('setPinned: élő oldal a kategóriában, max 3; setManualOrder csak manual mellett', () => {
  const pages = ['a', 'b', 'c', 'd'].map((name) => page(`${name}.md`, 'partners/other'))
  assert.equal(run([{ op: 'setPinned', category: 'partners/other', paths: ['a.md'] }], state, pages).ok, true)
  assert.deepEqual(codes(run([{ op: 'setPinned', category: 'partners/other', paths: ['x.md'] }], state, pages)), ['page_not_in_category'])
  assert.deepEqual(codes(run([{ op: 'setPinned', category: 'partners/other', paths: ['a.md', 'b.md', 'c.md', 'd.md'] }], state, pages)), ['too_many_pinned'])
  assert.deepEqual(codes(run([{ op: 'setManualOrder', category: 'partners/other', paths: ['a.md'] }], state, pages)), ['not_manual_sort'])
  assert.equal(run([{ op: 'updateCategory', key: 'partners/other', pageSort: 'manual' }, { op: 'setManualOrder', category: 'partners/other', paths: ['b.md', 'a.md'] }], state, pages).ok, true)
  // A javaslat oldalmozgatása után a céloldal már ott van.
  assert.equal(run([{ op: 'mergeCategory', from: 'partners/other', to: 'partners/acceptance' }, { op: 'setPinned', category: 'partners/acceptance', paths: ['a.md'] }], state, pages).ok, true)
})

check('kapcsolt wiki menüpontja nem módosítható', () => {
  const linked = { ...state.categories[0], key: 'link', parentKey: null, linkedConnectorId: 'c1' }
  const withLink = { ...state, categories: [...state.categories, linked] }
  assert.deepEqual(codes(run([{ op: 'upsertGroup', key: 'link', label: 'x' }], withLink)), ['linked_wiki_item'])
  assert.deepEqual(codes(run([{ op: 'upsertCategory', key: 'link/y', label: 'x' }], withLink)), ['linked_wiki_item'])
  assert.deepEqual(codes(run([{ op: 'mergeCategory', from: 'link', to: 'partners/other' }], withLink)), ['linked_wiki_item'])
  assert.deepEqual(codes(run([{ op: 'removeCategory', key: 'link' }], withLink)), ['linked_wiki_item'])
})

check('név: munkatárs saját KB-jánál és a katalógusnál nem írható', () => {
  assert.deepEqual(codes(run([{ op: 'setName', name: 'Új' }], empty, [], false)), ['name_not_editable'])
})

check('a kimenet nem változtatja a bemenetet', () => {
  const pages = [page('a.md', 'partners/other', { direction: 'in' })]
  const snapshot = JSON.stringify([state, pages])
  run([{ op: 'mergeCategory', from: 'partners/other', to: 'partners/acceptance' }, { op: 'renameFieldOption', field: 'direction', from: 'in', to: 'x' }], state, pages)
  assert.equal(JSON.stringify([state, pages]), snapshot)
})

check('configVersion: sorrend-független, bármely változásra új', () => {
  const reversed = { ...state, categories: [...state.categories].reverse(), fields: [...state.fields].reverse() }
  assert.equal(configVersionOf(state), configVersionOf(reversed))
  assert.notEqual(configVersionOf(state), configVersionOf({ ...state, wikiMd: '# Más\n' }))
  assert.notEqual(configVersionOf(state), configVersionOf({ ...state, collect: 'x' }))
})

check('diff: csoportok, kategóriák, mezők és sablonok külön', () => {
  const diff = diffConfig(empty, state)
  assert.deepEqual(diff.groups.added, ['partners'])
  assert.deepEqual(diff.categories.added.sort(), ['partners/acceptance', 'partners/other'])
  assert.deepEqual(diff.fields.added, ['direction', 'tags'])
  assert.deepEqual(diff.templates.added, ['partner'])
})

check('figyelmeztet, ha a kezelt kategóriák vagy mezők ki vannak kapcsolva', () => {
  const off = { ...empty, managedCategories: false, managedFields: false }
  const result = run([{ op: 'upsertGroup', key: 'g', label: 'G' }, { op: 'upsertMetadataField', key: 'f', label: 'F', type: 'text' }], off)
  assert.deepEqual(result.warnings, ['managed_categories_off', 'managed_fields_off'])
})

check('az MCP-nek kiadott konfiguráció-sémák nem tartalmaznak tömböt', () => {
  for (const schema of [kbWikiConfigGetObject, kbWikiConfigProposeObject, kbWikiConfigWithdrawInputSchema]) {
    const json = toJsonSchemaCompat(schema, { strictUnions: true, pipeStrategy: 'input' })
    assert.ok(!JSON.stringify(json).includes('"type":"array"'))
  }
})

check('bejövő levél feldolgozásakor nem küldhető és nem vonható vissza javaslat, olvasni lehet', () => {
  const principal = { forceWriteApproval: true as const }
  assert.equal(inboundMailBlocksTool(principal, 'kb_wiki_config_propose'), true)
  assert.equal(inboundMailBlocksTool(principal, 'kb_wiki_config_withdraw'), true)
  assert.equal(inboundMailBlocksTool(principal, 'kb_wiki_config_get'), false)
})

if (failures > 0) {
  console.log(`\n${failures} FAIL`)
  process.exit(1)
}
console.log('\nminden OK')
