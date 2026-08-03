/**
 * Contract: control-plane listák pagináltak (perf issue 003).
 * DB nélkül: forrásellenőrzés a shared helper + repo/action wiringre.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BOARD_LIST_LIMIT,
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
  prismaPageArgs,
  resolveListLimit,
  toListPage,
} from '../src/lib/list-pagination'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// --- Helper unit -------------------------------------------------------------

assert.equal(resolveListLimit(), DEFAULT_LIST_LIMIT)
assert.equal(resolveListLimit({ limit: 10 }), 10)
assert.equal(resolveListLimit({ limit: 999 }), MAX_LIST_LIMIT)
assert.equal(resolveListLimit({ unbounded: true }), undefined)

const capped = prismaPageArgs({ limit: 50 })
assert.equal(capped.take, 51)
assert.equal(capped.pageLimit, 50)
assert.deepEqual(prismaPageArgs({ unbounded: true }), {})

const page = toListPage([1, 2, 3, 4], 3, 0)
assert.deepEqual(page.items, [1, 2, 3])
assert.equal(page.hasMore, true)
assert.equal(page.nextOffset, 3)

const full = toListPage([1, 2], undefined, 0)
assert.deepEqual(full.items, [1, 2])
assert.equal(full.hasMore, false)

assert.equal(BOARD_LIST_LIMIT, 100)

// --- Source contracts --------------------------------------------------------

function read(rel: string): string {
  return readFileSync(join(root, rel), 'utf8')
}

const iface = read('src/repositories/interfaces/index.ts')
assert.match(iface, /listPage\(filter\?: TicketFilter\)/, 'TicketRepository.listPage')
assert.match(iface, /count\(filter\?: TicketFilter\)/, 'TicketRepository.count')
assert.match(iface, /listPage\(filter\?: AgentListFilter\)/, 'AgentRepository.listPage')
assert.match(iface, /listProcessesPage\(/, 'ProcessRepository.listProcessesPage')
assert.match(iface, /PlaybookListOpts/, 'PlaybookListOpts type')
assert.match(iface, /listDefaultAssignments\(/, 'listDefaultAssignments')
assert.match(iface, /RecipeListOpts/, 'RecipeListOpts type')

const ticketRepo = read('src/repositories/postgres/ticket-repository.ts')
assert.match(ticketRepo, /prismaPageArgs/, 'ticket repo uses shared pagination')
assert.match(ticketRepo, /async listPage/, 'ticket listPage impl')
assert.match(ticketRepo, /async count/, 'ticket count impl')

const agentRepo = read('src/repositories/postgres/agent-repository.ts')
assert.match(agentRepo, /async listPage/, 'agent listPage impl')
assert.match(agentRepo, /async count/, 'agent count impl')

const playbookRepo = read('src/repositories/postgres/playbook-v2-repository.ts')
assert.match(playbookRepo, /includeVersions/, 'playbook slim/full versions mode')
assert.match(playbookRepo, /_count:\s*\{\s*select:\s*\{\s*versions:\s*true/, 'playbook versionCount via _count')
assert.match(playbookRepo, /async listDefaultAssignments/, 'playbook listDefaultAssignments')

const recipeRepo = read('src/repositories/postgres/recipe-repository.ts')
assert.match(recipeRepo, /versionsMode === 'latest'/, 'recipe default latest-only versions')

const platform = read('src/app/actions/platform.ts')
assert.match(platform, /BOARD_LIST_LIMIT/, 'board tickets use BOARD_LIST_LIMIT')
assert.match(platform, /repositories\.tickets\.listPage/, 'board/list tickets paginated')
assert.match(platform, /repositories\.agents\.listPage/, 'listAgents paginated')
assert.match(platform, /repositories\.agents\.count/, 'dashboard agent count')
assert.match(platform, /repositories\.tickets\.count/, 'dashboard ticket count')
assert.doesNotMatch(
  platform,
  /getDashboardStats[\s\S]{0,400}repositories\.agents\.findMany\(\)/,
  'dashboard must not dump all agents',
)

const activeRunsRoute = read('src/app/api/v1/active-runs/route.ts')
assert.match(activeRunsRoute, /loadActiveRuns/, 'active-runs route delegates to shared loader')

const activeRunsLoad = read('src/lib/active-runs-load.ts')
assert.match(activeRunsLoad, /tickets\.listPage/, 'active-runs uses listPage')
assert.match(activeRunsLoad, /createdById/, 'active-runs scopes chat turns to the viewer')
assert.match(activeRunsLoad, /belongingToUserId/, 'active-runs includes created or assigned tickets')
assert.doesNotMatch(activeRunsLoad, /\.slice\(0,\s*50\)/, 'active-runs no client-side slice after full fetch')

const startable = read('src/domain/playbook/playbook-v2-service.ts')
assert.match(startable, /listDefaultAssignments/, 'startable uses batch assignments')
assert.match(startable, /findVersionsByIds/, 'startable loads versions by id')
assert.doesNotMatch(
  startable,
  /listStartablePlaybooks[\s\S]{0,800}listPlaybooks\(tenantId\)/,
  'startable must not load all playbook versions via listPlaybooks()',
)

const boardPage = read('src/app/control-plane/board/page.tsx')
assert.match(boardPage, /ticketsRes\.data\.tickets/, 'board reads paginated tickets envelope')
assert.match(boardPage, /listProcesses\(\{\s*limit:\s*RECENT_PROCESS_LIMIT/, 'board limits processes in DB')

console.log('list-pagination contract OK')
