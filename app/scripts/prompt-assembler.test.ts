import assert from 'node:assert/strict'
import { assembleGatewayMessages, type PromptSegments } from '../src/domain/agent/prompt-assembler'

function fixture(variable: string): PromptSegments {
  return {
    stablePreamble: [
      { role: 'system', content: 'agent prompt' },
      { role: 'system', content: 'org roster' },
      { role: 'system', content: 'tool instruction' },
      { role: 'system', content: 'memory policy' },
      { role: 'system', content: 'KB answer instruction' },
    ],
    variableContext: [
      { role: 'system', content: `Project memory context: ${variable}` },
      { role: 'system', content: `Tudásbázis találatok: ${variable}` },
      { role: 'system', content: `Workspace fájlok: ${variable}` },
      { role: 'system', content: `/skill prompt: ${variable}` },
    ],
    history: [{ role: 'user', content: 'kérdés' }],
    toolTail: [{ role: 'tool', toolCallId: 'call-1', toolName: 'kb_search', content: 'eredmény' }],
  }
}

const first = assembleGatewayMessages(fixture('A'))
const second = assembleGatewayMessages(fixture('B'))

assert.deepEqual(first.slice(0, 5), second.slice(0, 5), 'a változó adatok nem módosíthatják a stabil prefixet')
assert.deepEqual(first, assembleGatewayMessages(fixture('A')), 'azonos bemenet determinisztikus kimenetet ad')
assert.deepEqual(
  first.map((message) => ('content' in message ? message.content : message.role)),
  [
    'agent prompt',
    'org roster',
    'tool instruction',
    'memory policy',
    'KB answer instruction',
    'Project memory context: A',
    'Tudásbázis találatok: A',
    'Workspace fájlok: A',
    '/skill prompt: A',
    'kérdés',
    'eredmény',
  ],
)

console.log('prompt assembler tests passed')
