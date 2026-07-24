/**
 * A chat élő aktivitás-dobozának regressziója: ha a POST SSE nem szállít
 * `activity` eseményeket (buffer / szakadás), a DB-pillanatkép pollnak
 * fel kell töltenie a buborékot — különben a UI üres buborék + „…” marad,
 * miközben a modell toolokat futtat.
 *
 * Futtatás: npm run test:chat-turn-progress
 */
import assert from 'node:assert/strict'
import {
  chatMessageShowsAgentActivity,
  mergeTurnProgressIntoMessages,
  type ChatTurnActivity,
  type ChatTurnProgressMessage,
} from '../src/lib/chat-turn-progress'

let failures = 0
function check(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  OK ${name}`)
  } catch (e) {
    failures++
    console.log(`  FAIL ${name}: ${e instanceof Error ? e.message : e}`)
  }
}

function activity(id: string, title: string, status: ChatTurnActivity['status'] = 'running'): ChatTurnActivity {
  return { id, kind: 'tool', title, status }
}

const emptyAgent: ChatTurnProgressMessage = {
  id: 'optimistic-agent-pending-1',
  role: 'agent',
  text: '',
  activities: [],
}

console.log('chat-turn-progress')

check('tünet: üres buborék = nincs aktivitás-doboz (typing marad)', () => {
  assert.equal(chatMessageShowsAgentActivity(emptyAgent), false)
})

check('SSE-nélküli DB-poll feltölti az aktivitásokat a buborékba', () => {
  const remote = [
    activity('skill-slash-tulajdoni-lap-egyeztetes', 'Skill betöltve: tulajdoni-lap-egyeztetes', 'done'),
    activity('reasoning-0', 'Üzenet feldolgozása', 'running'),
  ]
  const next = mergeTurnProgressIntoMessages(
    [
      { id: 'user-1', role: 'user', text: '/tulajdoni-lap-egyeztetes' },
      emptyAgent,
    ],
    {
      agentMessageId: 'turn-agent-504bae26',
      activities: remote,
    },
  )
  const agent = next[next.length - 1]
  assert.equal(agent.id, 'turn-agent-504bae26')
  assert.equal(chatMessageShowsAgentActivity(agent), true, 'aktivitás-doboznak meg kell jelennie')
  assert.equal(agent.activities?.length, 2)
  assert.equal(agent.activities?.[1]?.title, 'Üzenet feldolgozása')
})

check('élő SSE előrébb járhat a DB-nél — a helyi running nem vész el', () => {
  const local: ChatTurnProgressMessage = {
    id: 'turn-agent-1',
    role: 'agent',
    text: '',
    activities: [activity('tool-1', 'file_read', 'running')],
  }
  const next = mergeTurnProgressIntoMessages([local], {
    agentMessageId: 'turn-agent-1',
    activities: [activity('tool-1', 'file_read', 'running')],
  })
  assert.equal(next[0].activities?.[0]?.status, 'running')
})

check('DB későbbi done felülírja a helyi runningot', () => {
  const local: ChatTurnProgressMessage = {
    id: 'turn-agent-1',
    role: 'agent',
    text: '',
    activities: [activity('tool-1', 'file_read', 'running')],
  }
  const next = mergeTurnProgressIntoMessages([local], {
    agentMessageId: 'turn-agent-1',
    activities: [activity('tool-1', 'file_read', 'done')],
  })
  assert.equal(next[0].activities?.[0]?.status, 'done')
})

check('partialText csak hosszabbít, nem vág vissza streamelt szöveget', () => {
  const local: ChatTurnProgressMessage = {
    id: 'turn-agent-1',
    role: 'agent',
    text: 'Hello world',
    activities: [],
  }
  const next = mergeTurnProgressIntoMessages([local], {
    agentMessageId: 'turn-agent-1',
    activities: [],
    partialText: 'Hello',
  })
  assert.equal(next[0].text, 'Hello world')
})

if (failures > 0) {
  console.error(`\n${failures} failed`)
  process.exit(1)
}
console.log('\nall passed')
