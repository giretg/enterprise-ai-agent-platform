/**
 * #1061 F2 — tiszta függvények: „csak a kijelöltek” láthatóság és közönség-szabály,
 * a snapshot élő névsorral való feltöltése, emberi rögzítés és másik tudástár forrása,
 * wikik közti link, validátor, WIKI.md sablonverzió.
 * Futtatás: npm run test:wiki-sources
 */
import assert from 'node:assert/strict'
import {
  audienceCovers,
  canDecideWikiChange,
  canManageKnowledgeBaseLink,
  isKnowledgeBaseVisibleTo,
  resolveWikiApprover,
  scopeSnapshotConnectorsToUser,
  withLiveKbAudience,
  withoutKbMemberLists,
  type WikiSnapshotConnector,
} from '../src/lib/wiki-access'
import {
  extractCrossWikiLinks,
  extractWikiLinks,
  wikiLinkTitles,
  isDefaultWikiSchema,
  mergeWikiSources,
  readWikiSources,
  wikiOutLinks,
} from '../src/lib/kb-wiki'
import { renderWikiTemplate } from '../src/lib/wiki-templates'
import { validateWikiPages } from '../src/lib/kb-validator'
import { linkifyWikiLinks, resolveRelativeWikiLink } from '../src/lib/wiki-markdown-links'
import { hashSnapshot } from '../src/domain/agent-definition'
import { buildCategoryTree, categoryIndex, linkedWikiItems, renderWikiTreeIndex, type WikiCategoryRow } from '../src/lib/wiki-categories'

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

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const C = '33333333-3333-4333-8333-333333333333'
const KB = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const WIKI = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

console.log('=== #1061 F2 források és névsoros wiki (tiszta függvények) ===')

check('láthatóság: névsor nélkül senki (fail-closed), névsorral csak a tagok', () => {
  assert.equal(isKnowledgeBaseVisibleTo({ visibility: 'members', ownerUserId: A }, A), false)
  assert.equal(isKnowledgeBaseVisibleTo({ visibility: 'members', ownerUserId: A, kbMemberUserIds: [A, B] }, B), true)
  assert.equal(isKnowledgeBaseVisibleTo({ visibility: 'members', ownerUserId: A, kbMemberUserIds: [A, B] }, C), false)
  assert.equal(isKnowledgeBaseVisibleTo({ visibility: 'shared' }, C), true)
})

check('közönség-szabály: shared ⊇ névsor ⊇ privát; szűkebbet idézni tilos', () => {
  const shared = { visibility: 'shared' }
  const members = { visibility: 'members', ownerUserId: A, kbMemberUserIds: [A, B] }
  const wider = { visibility: 'members', ownerUserId: A, kbMemberUserIds: [A, B, C] }
  const privA = { visibility: 'private_to_user', ownerUserId: A }
  assert.equal(audienceCovers(shared, members), true)
  assert.equal(audienceCovers(members, shared), false)
  assert.equal(audienceCovers(wider, members), true)
  assert.equal(audienceCovers(members, wider), false)
  assert.equal(audienceCovers(members, privA), true)
  assert.equal(audienceCovers(privA, members), false)
  assert.equal(audienceCovers(privA, { visibility: 'private_to_user', ownerUserId: B }), false)
  assert.equal(audienceCovers(members, { visibility: 'weird' }), false)
})

check('snapshot: a névsoros sor az élő névsort kapja; közben közössé vált sor névsor nélkül marad', () => {
  const rows: WikiSnapshotConnector[] = [
    { connectorId: KB, type: 'knowledge_base', accessMode: 'read', visibility: 'members', ownerUserId: A },
    { connectorId: C, type: 'http_api', accessMode: 'read' },
  ]
  const hydrated = withLiveKbAudience(rows, [{ id: KB, visibility: 'members', ownerUserId: A, kbMemberUserIds: [A, B] }])
  assert.deepEqual(hydrated[0].kbMemberUserIds, [A, B])
  assert.equal(scopeSnapshotConnectorsToUser(hydrated, B).length, 2)
  assert.equal(scopeSnapshotConnectorsToUser(hydrated, C).length, 1)
  // Névsor nélkül (nincs élő sor) senkinek.
  assert.equal(scopeSnapshotConnectorsToUser(rows, A).length, 1)
  const shared = withLiveKbAudience(rows, [{ id: KB, visibility: 'shared', ownerUserId: null }])
  assert.equal(shared[0].visibility, undefined)
  assert.equal(scopeSnapshotConnectorsToUser(shared, C).length, 2)
  const priv = withLiveKbAudience(rows, [{ id: KB, visibility: 'private_to_user', ownerUserId: B }])
  assert.deepEqual([priv[0].visibility, priv[0].ownerUserId], ['private_to_user', B])
  // Kifelé a névsor nem megy ki, és a publikált snapshot hash-ét sem változtatja.
  assert.equal(withoutKbMemberLists({ connectors: hydrated }).connectors[0].kbMemberUserIds, undefined)
  const snap = (connectors: WikiSnapshotConnector[]) =>
    ({ agentId: A, version: 1, connectors, skills: [], capabilities: [] }) as unknown as Parameters<typeof hashSnapshot>[0]
  assert.equal(hashSnapshot(snap(hydrated)), hashSnapshot(snap(rows)))
})

check('jóváhagyó és kötés-kezelés: névsorosnál csak élő tag (az admin is)', () => {
  const live = { visibility: 'members', ownerUserId: A, kbMemberUserIds: [A, B] }
  const scope = resolveWikiApprover({ connector: live })
  assert.deepEqual(scope, { kind: 'members', ownerUserId: A, approverUserId: null })
  assert.equal(canDecideWikiChange({ userId: A, role: 'operator' }, scope, live), true)
  assert.equal(canDecideWikiChange({ userId: C, role: 'admin' }, scope, live), false)
  assert.equal(canDecideWikiChange({ userId: A, role: 'operator' }, scope), false, 'élő sor nélkül senki')
  assert.equal(canManageKnowledgeBaseLink(live, { userId: B, role: 'admin' }), true)
  assert.equal(canManageKnowledgeBaseLink(live, { userId: C, role: 'admin' }), false)
  assert.equal(canManageKnowledgeBaseLink(live, { userId: B, role: 'operator' }), false)
})

check('források: emberi rögzítés és másik tudástár dokumentuma beolvasva, egyedileg', () => {
  const refs = readWikiSources([
    { kind: 'human_note', occasion: '  sales  ', participants: 'Alice', recordedByUserId: A, recordedAt: '2026-11-03T10:00:00Z' },
    { documentId: B, connectorId: KB.toUpperCase() },
    { documentId: B },
    { kind: 'human_note', occasion: 'sales', participants: 'Alice', recordedByUserId: A, recordedAt: '2026-11-03T10:00:00Z' },
  ])
  assert.deepEqual(refs, [
    { kind: 'human_note', recordedByUserId: A, recordedAt: '2026-11-03T10:00:00Z', occasion: 'sales', participants: 'Alice' },
    { documentId: B, connectorId: KB },
    { documentId: B },
  ])
  assert.equal(mergeWikiSources(refs, refs).length, 3)
})

check('wikik közti link: [[wiki:<wikiId>/<path>]] — a helyi linkek közé nem kerül, az outLinks-be igen', () => {
  const body = `Lásd [[wiki:${WIKI.toUpperCase()}/contracts/acme|ACME]] és [[partners/dkv]] [[wiki:nem-uuid/x]]`
  assert.deepEqual(extractCrossWikiLinks(body), [{ wikiId: WIKI, path: 'contracts/acme.md' }])
  assert.deepEqual(extractWikiLinks(body, 'a.md'), ['partners/dkv.md'])
  assert.deepEqual(wikiOutLinks(body, 'a.md'), ['partners/dkv.md', `wiki:${WIKI}/contracts/acme.md`])
  assert.equal(
    linkifyWikiLinks(`[[wiki:${WIKI}/contracts/acme|ACME]]`),
    `[ACME](#xwiki:${WIKI}/contracts%2Facme.md)`,
  )
})

check('escape-elt pipe: a [[path\\|címke]] ugyanaz, mint a [[path|címke]] (Obsidian táblában így írja)', () => {
  const row = '| [[entities/x.md\\|Díjkeret]] | [[entities/y\\|Y]] |'
  assert.deepEqual(extractWikiLinks(row, 'a.md'), ['entities/x.md', 'entities/y.md'])
  assert.equal(linkifyWikiLinks(row), '| [Díjkeret](#wiki:entities%2Fx.md) | [Y](#wiki:entities%2Fy.md) |')
  assert.equal(linkifyWikiLinks('[[entities/x.md#fees\\|Díjak]]'), '[Díjak](#wiki:entities%2Fx.md)')
  const cross = `[[wiki:${WIKI}/contracts/acme.md\\|ACME]]`
  assert.deepEqual(extractCrossWikiLinks(cross), [{ wikiId: WIKI, path: 'contracts/acme.md' }])
  assert.equal(linkifyWikiLinks(cross), `[ACME](#xwiki:${WIKI}/contracts%2Facme.md)`)
  // A címkében maradó `\|`-t a markdown oldja fel, így a táblacella nem esik szét.
  assert.equal(linkifyWikiLinks('[[a\\|b\\|c]]'), '[b\\|c](#wiki:a.md)')
})

check('címke nélküli link: az oldal címe, escape-elve; a címke elsőbbséget élvez; ismeretlen oldalnál marad az útvonal', () => {
  const titles = { 'entities/x.md': 'Díj | *fontos*', [`wiki:${WIKI}/contracts/acme.md`]: 'ACME szerződés' }
  assert.equal(linkifyWikiLinks('[[entities/x]]', titles), '[Díj \\| \\*fontos\\*](#wiki:entities%2Fx.md)')
  assert.equal(linkifyWikiLinks('[[entities/x|Saját]]', titles), '[Saját](#wiki:entities%2Fx.md)')
  assert.equal(linkifyWikiLinks('[[entities/nincs]]', titles), '[entities/nincs](#wiki:entities%2Fnincs.md)')
  assert.equal(linkifyWikiLinks(`[[wiki:${WIKI}/contracts/acme]]`, titles), `[ACME szerződés](#xwiki:${WIKI}/contracts%2Facme.md)`)
})

check('wikiLinkTitles: csak az oldalról hivatkozott, címmel rendelkező oldalak', () => {
  const pages = [
    { path: 'entities/x.md', title: 'X' },
    { path: 'entities/y.md', title: 'Y' },
    { path: 'entities/z.md', title: 'Z' },
    { path: 'entities/torolt.md', title: '' },
  ]
  assert.deepEqual(
    wikiLinkTitles('[[entities/x]] [Y](../entities/y.md) [[entities/torolt]] [[entities/nincs]]', 'analyses/a.md', pages),
    { 'entities/x.md': 'X', 'entities/y.md': 'Y' },
  )
})

check('relatív markdown link: a felület és a szerver ugyanarra az oldalra oldja fel', () => {
  assert.equal(resolveRelativeWikiLink('analyses/a.md', '../entities/x.md'), 'entities/x.md')
  assert.equal(resolveRelativeWikiLink('analyses/a.md', 'b.md'), 'analyses/b.md')
  assert.equal(resolveRelativeWikiLink('analyses/a.md', './b.md#resz'), 'analyses/b.md')
  assert.equal(resolveRelativeWikiLink('analyses/a.md', '/entities/x.md?v=1'), 'entities/x.md')
  assert.equal(resolveRelativeWikiLink('a.md', '../../x.md'), 'x.md')
  for (const href of ['https://a.hu/x.md', 'mailto:a@b.md', '//a.hu/x.md', 'x.pdf', '#wiki:x.md', '#resz', '']) {
    assert.equal(resolveRelativeWikiLink('analyses/a.md', href), null, href)
  }
  assert.deepEqual(extractWikiLinks('[a](../entities/x.md) [b](//a.hu/y.md)', 'analyses/a.md'), ['entities/x.md'])
})

check('validátor: emberi rögzítés teljesíti a forrás-szabályt; hiányzó szerző/alkalom hiba; másik tudástár állapota', () => {
  const page = (sources: unknown[], body = 'törzs') => ({
    path: 'a.md',
    action: 'upsert' as const,
    state: { path: 'a.md', type: 'entity' as const, title: 'A', summary: 's', category: null, frontmatter: {}, body, sources: readWikiSources(sources) },
  })
  const base = { knownSourceIds: new Set<string>(), pathsAfterWrite: new Set<string>() }
  const ok = validateWikiPages({ ...base, pages: [page([{ kind: 'human_note', occasion: 'x', recordedByUserId: A, recordedAt: 't' }])] })
  assert.equal(ok.ok, true, JSON.stringify(ok.issues))
  const noSession = validateWikiPages({ ...base, pages: [page([{ kind: 'human_note', occasion: 'x' }])] })
  assert.deepEqual(noSession.issues.map((issue) => issue.code), ['human_note_requires_session'])
  const noOccasion = validateWikiPages({ ...base, pages: [page([{ kind: 'human_note', occasion: ' ', recordedByUserId: A, recordedAt: 't' }])] })
  assert.deepEqual(noOccasion.issues.map((issue) => issue.code), ['missing_field'])
  const cross = (status?: 'ok' | 'unknown_source' | 'source_audience_narrower') =>
    validateWikiPages({
      ...base,
      pages: [page([{ documentId: B, connectorId: KB }])],
      ...(status ? { crossSources: new Map([[`${KB}/${B}`, status]]) } : {}),
    }).issues.map((issue) => issue.code)
  assert.deepEqual(cross('ok'), [])
  assert.deepEqual(cross('source_audience_narrower'), ['source_audience_narrower'])
  assert.deepEqual(cross(), ['unknown_source'], 'ellenőrzés nélkül fail-closed')
  const link = (status?: 'ok' | 'missing_page' | 'unknown_source') =>
    validateWikiPages({
      ...base,
      pages: [page([{ kind: 'human_note', occasion: 'x', recordedByUserId: A, recordedAt: 't' }], `[[wiki:${WIKI}/x]]`)],
      ...(status ? { crossLinks: new Map([[`${WIKI}/x.md`, status]]) } : {}),
    }).issues.map((issue) => `${issue.severity}:${issue.code}`)
  assert.deepEqual(link('ok'), [])
  assert.deepEqual(link('missing_page'), ['warning:broken_link'])
  assert.deepEqual(link(), ['error:unknown_wiki_link'])
})

check('kapcsolt wiki menüpont: nem tartalmi kategória — a fába, a kulcsokba és az index.md-be nem kerül', () => {
  const rows: WikiCategoryRow[] = [
    { id: '1', key: 'partners', parentId: null, name: 'Partnerek', description: null, sortOrder: 10, approval: 'inherit' },
    { id: '2', key: 'contracts', parentId: '1', name: 'Szerződések', description: null, sortOrder: 20, approval: 'inherit', linkedConnectorId: KB },
    { id: '3', key: 'pricing', parentId: null, name: 'Árazás', description: null, sortOrder: 30, approval: 'inherit', linkedConnectorId: C },
  ]
  assert.deepEqual(buildCategoryTree(rows).map((node) => [node.path, node.children.length]), [['partners', 0]])
  assert.deepEqual([...categoryIndex(rows).keys()], ['partners'])
  assert.deepEqual(linkedWikiItems(rows).map((item) => [item.key, item.parentKey, item.linkedConnectorId]), [
    ['contracts', 'partners', KB],
    ['pricing', null, C],
  ])
  const index = renderWikiTreeIndex([{ path: 'p.md', title: 'P', summary: 's', category: 'partners', type: 'entity' }], rows)
  assert.ok(!index.includes('Szerződések') && !index.includes('Árazás'), index)
})

check('WIKI.md: a 2. sablonverzió leírja az új forrásfajtákat; a régi alapszöveg sem „módosított”', () => {
  for (const language of ['hu', 'en'] as const) {
    const current = renderWikiTemplate('general', language)
    assert.match(current, /human_note/)
    assert.match(current, /\[\[wiki:<wikiId>\/<path>\]\]/)
    assert.ok(isDefaultWikiSchema(current, language))
    assert.ok(isDefaultWikiSchema(renderWikiTemplate('general', language, 1), language))
    assert.ok(!renderWikiTemplate('general', language, 1).includes('human_note'))
    assert.ok(!isDefaultWikiSchema(`${current}\nsaját szabály`, language))
  }
})

if (failures > 0) {
  console.log(`\n${failures} FAIL`)
  process.exit(1)
}
console.log('\nminden OK')
