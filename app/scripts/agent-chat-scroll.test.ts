/**
 * Chat görgetés: csak „rácsatolva" állapotban auto-scroll.
 *
 * Futtatás: npx tsx scripts/agent-chat-scroll.test.ts
 */
import assert from 'node:assert/strict'
import { isChatPinnedToBottom } from '../src/lib/agent-chat-scroll'

assert.equal(isChatPinnedToBottom(920, 1000, 100), true, 'alján van')
assert.equal(isChatPinnedToBottom(0, 1000, 100), false, 'felül van')
assert.equal(isChatPinnedToBottom(820, 1000, 100), true, 'a küszöbön belül')
assert.equal(isChatPinnedToBottom(819, 1000, 100), false, 'a küszöbön kívül')

console.log('agent-chat-scroll.test.ts: ok')
