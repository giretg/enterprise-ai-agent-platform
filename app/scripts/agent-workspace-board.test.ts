/**
 * Agent munkaterület: Feladatok-fül + az agent által érintett ticketek.
 * Futtatás: npm run test:agent-workspace-board
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  parseAgentWorkspacePath,
  workspaceTabsForAgent,
} from '../src/lib/agent-workspace-routes'
import { ticketInvolvesAgent } from '../src/lib/ticket-display'

let failures = 0
function check(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  OK  ${name}`)
  } catch (e: unknown) {
    failures++
    console.log(`  FAIL ${name}: ${e instanceof Error ? e.message : e}`)
  }
}

const AGENT = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'

function ticket(
  patch: Partial<Parameters<typeof ticketInvolvesAgent>[0]> = {},
): Parameters<typeof ticketInvolvesAgent>[0] {
  return {
    agentId: null,
    assigneeType: null,
    assigneeId: null,
    payload: {},
    ...patch,
  }
}

check('végrehajtó: ticket.agentId egyezik', () => {
  assert.equal(ticketInvolvesAgent(ticket({ agentId: AGENT }), AGENT), true)
})

check('végrehajtó: agent assignee', () => {
  assert.equal(
    ticketInvolvesAgent(
      ticket({ assigneeType: 'agent', assigneeId: AGENT }),
      AGENT,
    ),
    true,
  )
})

check('létrehozó: createdByAgentId a payloadban', () => {
  assert.equal(
    ticketInvolvesAgent(ticket({ payload: { createdByAgentId: AGENT } }), AGENT),
    true,
  )
})

check('létrehozó: requesterAgentId a payloadban', () => {
  assert.equal(
    ticketInvolvesAgent(ticket({ payload: { requesterAgentId: AGENT } }), AGENT),
    true,
  )
})

check('más agent ticketje nem számít érintettnek', () => {
  assert.equal(
    ticketInvolvesAgent(
      ticket({
        agentId: OTHER,
        assigneeType: 'agent',
        assigneeId: OTHER,
        payload: { createdByAgentId: OTHER },
      }),
      AGENT,
    ),
    false,
  )
})

check('beszélgetős agent fülei: Beszélgetés, Feladatok, Mini-appok, Tanítás, Adatlap', () => {
  assert.deepEqual(
    workspaceTabsForAgent(false).map((item) => item.key),
    ['chat', 'board', 'apps', 'training', 'profile'],
  )
  assert.equal(
    workspaceTabsForAgent(false).find((item) => item.key === 'board')?.label,
    'Feladatok',
  )
  assert.equal(
    workspaceTabsForAgent(false).find((item) => item.key === 'training')?.label,
    'Tanítás',
  )
})

check('korlátozott agent fülei: Indítás, Feladatok, Mini-appok, Tanítás, Adatlap', () => {
  assert.deepEqual(
    workspaceTabsForAgent(true).map((item) => item.key),
    ['task', 'board', 'apps', 'training', 'profile'],
  )
})

check('a /board útvonal a munkaterület része', () => {
  const parsed = parseAgentWorkspacePath(
    `/control-plane/agents/${AGENT}/board`,
  )
  assert.deepEqual(parsed, { agentId: AGENT, tab: 'board' })
})

check('a /training útvonal a munkaterület része, az Adatlap előtt', () => {
  const parsed = parseAgentWorkspacePath(
    `/control-plane/agents/${AGENT}/training`,
  )
  assert.deepEqual(parsed, { agentId: AGENT, tab: 'training' })
  const keys = workspaceTabsForAgent(false).map((item) => item.key)
  assert.ok(keys.indexOf('training') < keys.indexOf('profile'))
})

const repo = readFileSync(
  resolve(process.cwd(), 'src/repositories/postgres/ticket-repository.ts'),
  'utf8',
)
const platform = readFileSync(
  resolve(process.cwd(), 'src/app/actions/platform.ts'),
  'utf8',
)
const railCard = readFileSync(
  resolve(process.cwd(), 'src/components/agents/agent-rail-card.tsx'),
  'utf8',
)
const railCompose = readFileSync(
  resolve(process.cwd(), 'src/lib/agent-rail-compose.ts'),
  'utf8',
)
const workspace = readFileSync(
  resolve(process.cwd(), 'src/components/agents/agent-workspace.tsx'),
  'utf8',
)
const rail = readFileSync(
  resolve(process.cwd(), 'src/components/agents/agent-rail.tsx'),
  'utf8',
)
const composer = readFileSync(
  resolve(process.cwd(), 'src/components/agents/agent-chat-composer.tsx'),
  'utf8',
)
const identityPage = readFileSync(
  resolve(process.cwd(), 'src/app/control-plane/agents/[agentId]/page.tsx'),
  'utf8',
)

check('a lista-szűrő a létrehozót és a végrehajtót is keresi', () => {
  assert.match(repo, /involvedAgentId/)
  assert.match(repo, /createdByAgentId/)
  assert.match(repo, /requesterAgentId/)
  assert.match(platform, /involvedAgentId/)
})

check('a sín kártyáján nincs külön Beszélgetés/Feladat gombsor', () => {
  assert.doesNotMatch(railCard, /ACTION_PRIMARY/)
  assert.doesNotMatch(railCard, /className=\{ACTION_SECONDARY\}/)
  assert.match(railCard, /További műveletek/)
  assert.match(railCard, /workspaceTabsForAgent/)
})

check('a sín kártyája a bemutatkozást mutatja, mellette nyílik a munkaköri leírás', () => {
  assert.match(railCard, /persona\.greeting/)
  assert.match(railCard, /AgentRoleDescriptionButton/)
  assert.doesNotMatch(railCard, /showRolePopover/)
  assert.doesNotMatch(railCard, /AgentRailRolePopover/)
  assert.doesNotMatch(railCard, /card\.roleLabel/)
})

check('a munkaterület fejléce csak a fülsort mutatja, az agent-nevet a sín kijelölése adja', () => {
  assert.doesNotMatch(workspace, /AgentRoleDescriptionButton/)
  assert.doesNotMatch(workspace, /persona\.greeting/)
  assert.doesNotMatch(workspace, /workspaceSubtitle/)
  assert.match(workspace, /Munkaterület fülek/)
})

check('mobilon egyértelmű a munkatársváltás és nem vágódik le a fülsor', () => {
  assert.match(workspace, /Munkatárs váltása/)
  assert.match(workspace, /overflow-x-auto/)
  // A görgethető fülsorban az aktív fül különben kicsúszhat a képből.
  assert.match(workspace, /activeTabRef/)
  assert.match(workspace, /scrollIntoView/)
  // A lebegő csempe csak asztali gépen működik.
  assert.match(workspace, /hidden sm:grid/)
  assert.match(rail, /Munkatárslista bezárása/)
  assert.match(rail, /Munkatársak/)
  // A projekt/mód/képesség választó egy "+" menübe költözött, a beviteli sor mobilon is egy sorban fér el.
  assert.match(composer, /flex items-end gap-1\.5/)
  assert.doesNotMatch(composer, /grid-cols-1/)
})

check('a fejléc mobilon nem torlódik: a logó nem zsugorodik, a futás-gomb ikonos', () => {
  const shell = readFileSync(resolve(process.cwd(), 'src/components/ui/shell.tsx'), 'utf8')
  assert.match(shell, /flex min-w-0 shrink-0 items-center/)
  const runs = readFileSync(
    resolve(process.cwd(), 'src/components/active-runs/active-runs-panel.tsx'),
    'utf8',
  )
  assert.match(runs, /aria-label="Futások"/)
  assert.match(runs, /hidden sm:inline">Futások/)
})

check('a feladat-tábla szűrői mobilon összecsukva indulnak', () => {
  const board = readFileSync(
    resolve(process.cwd(), 'src/components/tickets/kanban-board.tsx'),
    'utf8',
  )
  assert.match(board, /const \[filtersOpen, setFiltersOpen\] = useState\(false\)/)
  assert.match(board, /Keresés és szűrők/)
  assert.match(board, /sm:mt-0 sm:flex/)
})

check('az adatlap fejlécében a bemutatkozás mellett nyílik a munkaköri leírás', () => {
  assert.match(identityPage, /AgentRoleDescriptionButton/)
  assert.match(identityPage, /agent\.roleInstruction/)
})

check('a sín-állapot tartalmazza a bemutatkozást', () => {
  assert.match(railCompose, /personaGreeting: agent\.personaGreeting/)
})

check('a sín menüje a board-fület nyitja, nem a létrehozó dialógust', () => {
  assert.match(railCard, /onOpenTab\(tab\.key\)/)
  assert.doesNotMatch(railCard, /CreateBoardTicketForm/)
})

check('a munkaterület rendereli a board-fület', () => {
  assert.match(workspace, /board:\s*children \?\? loading/)
})

check('a Feladatok-fül a board-tab badge-et a kapu/futó számból rajzolja', () => {
  assert.match(workspace, /getAgentBoardTabBadge/)
  assert.match(workspace, /boardTabBadge/)
  assert.match(workspace, /item\.key === 'board'/)
  assert.match(workspace, /badge\.count\} \$\{badge\.spoken\}/)
  assert.match(workspace, /tone === 'wait'/)
})

check('a badge action az érintett ticketeket számolja, dátumszűrő nélkül', () => {
  const fn = platform.slice(platform.indexOf('export async function getAgentBoardTabBadge'))
  const body = fn.slice(0, fn.indexOf('export async function listChatTaskCards'))
  assert.match(body, /involvedAgentId: agentId/)
  assert.match(body, /excludeTest: true/)
  assert.match(body, /awaiting_human/)
  assert.match(body, /needs_info/)
  assert.match(body, /in_progress/)
  assert.doesNotMatch(body, /updatedAtGte|updatedFrom/)
  assert.doesNotMatch(body, /['"]ready['"]/)
  assert.doesNotMatch(body, /['"]backlog['"]/)
})

check('a munkaterület rendereli a Tanítás-fület az Adatlap előtt', () => {
  assert.match(workspace, /training:\s*children \?\? loading/)
})

const tabPage = readFileSync(
  resolve(
    process.cwd(),
    'src/app/control-plane/agents/[agentId]/(workspace)/[tab]/page.tsx',
  ),
  'utf8',
)
const agentLayout = readFileSync(
  resolve(process.cwd(), 'src/app/control-plane/agents/[agentId]/(workspace)/layout.tsx'),
  'utf8',
)
const detailPage = readFileSync(
  resolve(process.cwd(), 'src/app/control-plane/agents/[agentId]/page.tsx'),
  'utf8',
)

check('a fejléc a tabváltáskor megőrzött agent-layoutban marad', () => {
  assert.match(agentLayout, /<AgentWorkspace>[\s\S]*\{children\}[\s\S]*<\/AgentWorkspace>/)
  assert.doesNotMatch(tabPage, /<AgentWorkspace(?:\s|>)/)
})

check('az Adatlap-fül a teljes agent-beállítást mutatja (modell is)', () => {
  assert.match(tabPage, /profile:\s*\(\)\s*=>/)
  assert.match(tabPage, /AgentDetailPage/)
  assert.match(tabPage, /embedded/)
  assert.match(detailPage, /UpdateModelConfigForm/)
  assert.match(detailPage, /id: 'motor'/)
})

check('a Tanítás-fül az adott agentet tanítja, nem a tenant-katalógust', () => {
  assert.match(tabPage, /training:\s*\(\)\s*=>/)
  assert.match(tabPage, /AgentWorkspaceTraining/)
  assert.match(detailPage, /\/control-plane\/agents\/\$\{agent\.id\}\/training/)
})

if (failures > 0) {
  console.error(`\n${failures} teszt megbukott`)
  process.exit(1)
}
console.log('\nMinden teszt rendben.')
