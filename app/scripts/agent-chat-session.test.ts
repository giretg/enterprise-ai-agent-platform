/**
 * A chat-session store túléli az oldalnavigációt: open/close + ugyanazon
 * agent újboli nyitása restoreSignal-t növel (tálcáról vissza).
 *
 * Futtatás: npm run test:agent-chat-session
 */
import assert from 'node:assert/strict'
import {
  clearAgentChatSessions,
  closeAgentChat,
  getAgentChatSessions,
  openAgentChat,
} from '../src/components/agents/agent-chat-session-store'

const agentA = {
  id: 'agent-a',
  name: 'Agent A',
  personaNickname: 'Ági',
}
const agentB = {
  id: 'agent-b',
  name: 'Agent B',
  personaNickname: 'Béla',
}

clearAgentChatSessions()

openAgentChat({ agent: agentA })
openAgentChat({ agent: agentB })
assert.deepEqual(
  getAgentChatSessions().map((s) => s.id),
  ['agent-a', 'agent-b'],
  'több agent chat egyszerre nyitva',
)

openAgentChat({ agent: agentA, initialConversationId: 'conv-1' })
const revived = getAgentChatSessions().find((s) => s.id === 'agent-a')
assert.equal(getAgentChatSessions().length, 2, 'nem nyit második ablakot ugyanarra az agentre')
assert.equal(revived?.restoreSignal, 1)
assert.equal(revived?.initialConversationId, 'conv-1')

closeAgentChat('agent-b')
assert.deepEqual(
  getAgentChatSessions().map((s) => s.id),
  ['agent-a'],
)

clearAgentChatSessions()
assert.deepEqual(getAgentChatSessions(), [])

console.log('agent-chat-session.test.ts: ok')
