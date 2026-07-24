/**
 * Több tálcára tett beszélgetés egyszerre látszódjon — ne takarják egymást.
 *
 * Futtatás: npx tsx scripts/agent-chat-dock.test.ts
 */
import assert from 'node:assert/strict'
import {
  clearAgentChatDockEntries,
  getAgentChatDockEntries,
  removeAgentChatDockEntry,
  upsertAgentChatDockEntry,
} from '../src/components/agents/agent-chat-dock-store'

function noop() {}

clearAgentChatDockEntries()

upsertAgentChatDockEntry({
  id: 'a',
  agentName: 'Agent A',
  displayName: 'Ági',
  isTyping: false,
  onRestore: noop,
  onClose: noop,
})
upsertAgentChatDockEntry({
  id: 'b',
  agentName: 'Agent B',
  displayName: 'Béla',
  isTyping: true,
  onRestore: noop,
  onClose: noop,
})

assert.deepEqual(
  getAgentChatDockEntries().map((e) => e.id),
  ['a', 'b'],
  'több beszélgetés egyszerre a tálcán',
)

upsertAgentChatDockEntry({
  id: 'a',
  agentName: 'Agent A',
  displayName: 'Ági',
  isTyping: true,
  onRestore: noop,
  onClose: noop,
})

assert.deepEqual(
  getAgentChatDockEntries().map((e) => e.id),
  ['a', 'b'],
  'upsert nem rakja a végére a meglévő elemet',
)
assert.equal(getAgentChatDockEntries()[0]?.isTyping, true)

removeAgentChatDockEntry('a')
assert.deepEqual(
  getAgentChatDockEntries().map((e) => e.id),
  ['b'],
)

clearAgentChatDockEntries()
assert.deepEqual(getAgentChatDockEntries(), [])

console.log('agent-chat-dock.test.ts: ok')
