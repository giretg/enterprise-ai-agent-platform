/**
 * Munkatárs-doboz gombjai: csak az kap gombot, ami létezik, és a gomb a helyes oldalra visz.
 *
 * Futtatás: npm run test:agent-product-links
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { buildAgentProductLinks } from '../src/lib/agent-product-links'
import { emptyNavVisibilityPolicy, isNavChildHiddenFor } from '../src/lib/nav-visibility'
import { parseWorkFileDeepLink } from '../src/lib/work-file-link'

// A gomb nem visz olyan oldalra, amit a menüből elrejtettek: se a pontot, se az egész csoportját.
const groupHidden = { ...emptyNavVisibilityPolicy(), viewer: ['staff'] }
const childHidden = { ...emptyNavVisibilityPolicy(), viewer: ['staff.knowledge'] }
assert.equal(isNavChildHiddenFor(groupHidden, 'viewer', 'staff', 'staff.knowledge'), true, 'rejtett csoport')
assert.equal(isNavChildHiddenFor(childHidden, 'viewer', 'staff', 'staff.knowledge'), true, 'rejtett menüpont')
assert.equal(isNavChildHiddenFor(childHidden, 'viewer', 'staff', 'staff.projects'), false, 'más menüpont látszik')
assert.equal(isNavChildHiddenFor(groupHidden, 'operator', 'staff', 'staff.knowledge'), false, 'más szerepkörnél látszik')
assert.equal(
  isNavChildHiddenFor({ ...emptyNavVisibilityPolicy(), viewer: ['projects'] }, 'viewer', 'staff', 'staff.projects'),
  true,
  'a régi menükulcs továbbra is rejt',
)

const AGENT = '11111111-1111-4111-8111-111111111111'
const base = { agentId: AGENT, miniApps: [], wikis: [], scheduledTaskCount: 0 }

assert.deepEqual(buildAgentProductLinks(base), [], 'üres munkatársnál nincs gomb')

const single = buildAgentProductLinks({
  ...base,
  miniApps: [{ id: 'app-1', name: 'Heti riport' }],
  wikis: [{ connectorId: 'kb-1', name: 'Kínálat', hasPages: true }],
})
assert.deepEqual(
  single.map((link) => link.kind),
  ['miniApps', 'knowledge'],
)
assert.equal(single[0]!.items[0]!.href, '/control-plane/mini-apps/app-1', 'egy app: közvetlenül megnyílik')
assert.equal(single[1]!.items[0]!.href, '/control-plane/knowledge/kb-1?tab=reader', 'kész oldalakkal az olvasó nézet nyílik')

const noPages = buildAgentProductLinks({
  ...base,
  wikis: [{ connectorId: 'kb-2', name: 'Céges', hasPages: false }],
})
assert.equal(noPages[0]!.items[0]!.href, '/control-plane/knowledge/kb-2', 'oldalak nélkül nincs üres olvasó nézet')

const many = buildAgentProductLinks({
  ...base,
  miniApps: Array.from({ length: 9 }, (_, index) => ({ id: `app-${index}`, name: `App ${index}` })),
})[0]!
assert.equal(many.count, 9)
assert.equal(many.items.length, 6, 'a menü rövid marad')
assert.equal(many.href, `/control-plane/agents/${AGENT}?section=miniappok`, 'a többi a munkatárs adatlapján érhető el')

const shared = buildAgentProductLinks({ ...base, latestWorkFileProjectKey: 'ugyfel x', scheduledTaskCount: 3 })
assert.deepEqual(
  shared.map((link) => link.kind),
  ['workFiles', 'scheduledTasks'],
)
const workFilesQuery = new URLSearchParams(shared[0]!.href.split('?')[1])
assert.deepEqual(
  parseWorkFileDeepLink({ project: workFilesQuery.get('project')!, tab: workFilesQuery.get('tab')! }),
  { project: 'ugyfel x', tab: 'files', file: null },
  'a munkafájl-gomb a projekt fájllistáját nyitja, fájl nélkül',
)
assert.equal(shared[0]!.count, 0, 'a közös munkafájlok számát nem tüntetjük fel a munkatárs számaként')
assert.equal(shared[1]!.href, `/control-plane/scheduled-tasks?agent=${AGENT}`)
assert.equal(shared[1]!.count, 3)

// A szövegkulcsok mindkét nyelven megvannak, és a kártya, az adatlap, a chat is használja a gombsort.
const root = resolve(import.meta.dirname, '..')
const read = (rel: string) => readFileSync(resolve(root, rel), 'utf8')
for (const language of ['hu', 'en']) {
  const messages = JSON.parse(read(`src/messages/${language}.json`)).ControlPlane
  for (const key of [
    'aria',
    'miniApps',
    'miniAppsHint',
    'knowledge',
    'knowledgeHint',
    'workFiles',
    'workFilesHint',
    'scheduledTasks',
    'scheduledTasksHint',
    'companyKnowledge',
    'showAll',
  ]) {
    assert.ok(messages.agents.products[key], `${language}: products.${key}`)
  }
  assert.ok(messages.scheduledTasks.clearFilter, `${language}: scheduledTasks.clearFilter`)
  assert.ok(messages.scheduledTasks.filteredBy, `${language}: scheduledTasks.filteredBy`)
}
for (const page of [
  'src/components/agents/agent-catalog-card.tsx',
  'src/app/control-plane/agents/[agentId]/page.tsx',
  'src/components/platform-chat/platform-chat.tsx',
]) {
  assert.match(read(page), /<AgentProductLinks/, page)
}
assert.match(
  read('src/app/control-plane/agents/[agentId]/page.tsx'),
  /<SettingsSectionShell\s+key=/,
  'a gombsor linkje az adatlapon is témát vált',
)

console.log('agent-product-links: OK')
