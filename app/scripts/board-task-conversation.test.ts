/**
 * Tábla → beszélgetés nyomvonal: mikor nyíljon szál a kiosztáskor.
 * Futtatás: npm run test:board-task-conversation
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createBoardTicketSchema } from '../src/lib/validators/actions'
import { shouldLinkBoardTaskConversation } from '../src/lib/board-task-conversation'

let failures = 0
function test(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  OK  ${name}`)
  } catch (error) {
    failures += 1
    console.error(`  FAIL ${name}`)
    console.error(error)
  }
}

const AGENT = '11111111-1111-4111-8111-111111111111'

test('munkaterület + beszélgetős agent: szál nyílik', () => {
  assert.equal(
    shouldLinkBoardTaskConversation({
      linkConversation: true,
      assigneeType: 'agent',
      taskOnly: false,
    }),
    true,
  )
})

test('korlátozott agentnek nincs chat-füle — nincs szál', () => {
  assert.equal(
    shouldLinkBoardTaskConversation({
      linkConversation: true,
      assigneeType: 'agent',
      taskOnly: true,
    }),
    false,
  )
})

test('globális tábla (nincs linkConversation) nem nyit szálat', () => {
  assert.equal(
    shouldLinkBoardTaskConversation({
      assigneeType: 'agent',
      taskOnly: false,
    }),
    false,
  )
})

test('ember-hozzárendelésnek nincs agent-beszélgetése', () => {
  assert.equal(
    shouldLinkBoardTaskConversation({
      linkConversation: true,
      assigneeType: 'human',
      taskOnly: false,
    }),
    false,
  )
})

test('createBoardTicketSchema elfogadja a linkConversation jelzőt', () => {
  const parsed = createBoardTicketSchema.safeParse({
    title: 'Havi riport',
    assigneeType: 'agent',
    assigneeId: AGENT,
    linkConversation: true,
  })
  assert.equal(parsed.success, true)
  if (parsed.success) assert.equal(parsed.data.linkConversation, true)
})

const form = readFileSync(
  resolve(process.cwd(), 'src/components/tickets/create-board-ticket-form.tsx'),
  'utf8',
)
const action = readFileSync(resolve(process.cwd(), 'src/app/actions/platform.ts'), 'utf8')
const taskOnly = readFileSync(
  resolve(process.cwd(), 'src/components/agents/agent-task-button.tsx'),
  'utf8',
)
const boardPage = readFileSync(
  resolve(process.cwd(), 'src/app/control-plane/board/page.tsx'),
  'utf8',
)
const workspaceBoard = readFileSync(
  resolve(process.cwd(), 'src/components/agents/agent-workspace-board.tsx'),
  'utf8',
)

test('a munkaterület-tábla űrlapja kéri a beszélgetés-kötést', () => {
  assert.match(form, /Boolean\(initialAgentId\) && assigneeType === 'agent'/)
  assert.match(form, /linkConversation: true/)
  assert.match(form, /openLinkedBoardConversation/)
  assert.match(form, /boardTaskConversationHref/)
  assert.match(workspaceBoard, /initialAgentId=\{agentId\}/)
})

test('a globális tábla és a korlátozott Indítás-fül nem kéri', () => {
  assert.doesNotMatch(boardPage, /initialAgentId/)
  assert.doesNotMatch(taskOnly, /linkConversation/)
})

test('a board-create a beszélgetős agentnél új szálat és feladat-kártyát ír', () => {
  const fn = action.slice(action.indexOf('export async function createBoardTicket'))
  const body = fn.slice(0, fn.indexOf('export async function dispatchBoardTicket'))
  assert.match(body, /shouldLinkBoardTaskConversation/)
  assert.match(body, /createConversation/)
  assert.match(body, /postTaskCard/)
  assert.match(body, /conversationId/)
  assert.doesNotMatch(body, /params\.conversationId/)
})

if (failures > 0) {
  console.error(`\n${failures} teszt elbukott`)
  process.exit(1)
}
console.log('\nboard-task-conversation: ok')
