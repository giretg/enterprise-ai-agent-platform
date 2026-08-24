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

check('beszélgetős agent fülei: Beszélgetés, Feladatok, Mini-appok, Adatlap', () => {
  assert.deepEqual(
    workspaceTabsForAgent(false).map((item) => item.key),
    ['chat', 'board', 'apps', 'profile'],
  )
  assert.equal(
    workspaceTabsForAgent(false).find((item) => item.key === 'board')?.label,
    'Feladatok',
  )
})

check('korlátozott agent fülei: Indítás, Feladatok, Mini-appok, Adatlap', () => {
  assert.deepEqual(
    workspaceTabsForAgent(true).map((item) => item.key),
    ['task', 'board', 'apps', 'profile'],
  )
})

check('a /board útvonal a munkaterület része', () => {
  const parsed = parseAgentWorkspacePath(
    `/control-plane/agents/${AGENT}/board`,
  )
  assert.deepEqual(parsed, { agentId: AGENT, tab: 'board' })
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
const workspace = readFileSync(
  resolve(process.cwd(), 'src/components/agents/agent-workspace.tsx'),
  'utf8',
)

check('a lista-szűrő a létrehozót és a végrehajtót is keresi', () => {
  assert.match(repo, /involvedAgentId/)
  assert.match(repo, /createdByAgentId/)
  assert.match(repo, /requesterAgentId/)
  assert.match(platform, /involvedAgentId/)
})

check('a sín Feladat gombja a board-fület nyitja, nem a létrehozó dialógust', () => {
  assert.match(railCard, /onOpenTab\('board'\)/)
  assert.doesNotMatch(railCard, /CreateBoardTicketForm/)
})

check('a munkaterület rendereli a board-fület', () => {
  assert.match(workspace, /tab === 'board'/)
})

if (failures > 0) {
  console.error(`\n${failures} teszt megbukott`)
  process.exit(1)
}
console.log('\nMinden teszt rendben.')
