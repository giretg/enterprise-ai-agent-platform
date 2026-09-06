/**
 * Ticket memória projectKey feloldás — olvasás és írás közös szabálya.
 * Futtatás: npx tsx scripts/memory-project-key.test.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { resolveTicketMemoryProjectKey } from '../src/lib/memory-project-key'

let failures = 0
function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ✓ ${name}`))
    .catch((error) => {
      failures += 1
      console.error(`  ✗ ${name}`)
      console.error(error)
    })
}

async function main() {
  console.log('memory-project-key')

  await test('folyamat-ticket: ProcessDefinition.id győz a ticket.projectKey=__general__ fölött', async () => {
    const key = await resolveTicketMemoryProjectKey({
      projectKey: '__general__',
      processInstanceId: 'proc-inst-1',
      resolveProcessDefinitionId: async () => 'playbook-def-42',
    })
    assert.equal(key, 'playbook-def-42')
  })

  await test('folyamat-ticket: hiányzó definition után a ticket projectKey marad', async () => {
    const key = await resolveTicketMemoryProjectKey({
      projectKey: 'acme-q3',
      processInstanceId: 'proc-inst-1',
      resolveProcessDefinitionId: async () => null,
    })
    assert.equal(key, 'acme-q3')
  })

  await test('ad-hoc ticket: munka-projekt projectKey', async () => {
    const key = await resolveTicketMemoryProjectKey({
      projectKey: 'acme-q3',
      processInstanceId: null,
    })
    assert.equal(key, 'acme-q3')
  })

  await test('ad-hoc ticket: üres projectKey → __general__', async () => {
    const key = await resolveTicketMemoryProjectKey({
      projectKey: '   ',
      processInstanceId: null,
    })
    assert.equal(key, '__general__')
  })

  await test('GeneralTaskRuntime a közös feloldót hívja (ne legyen újra regresszió)', () => {
    const src = readFileSync(
      resolve(import.meta.dirname, '../src/domain/agent/general-task-runtime.ts'),
      'utf8',
    )
    assert.match(src, /resolveTicketMemoryProjectKey/)
    assert.match(src, /processDefinitionId/)
  })

  await test('memory_propose írás a közös feloldót hívja', () => {
    const src = readFileSync(
      resolve(import.meta.dirname, '../src/domain/tool-broker/tool-broker-delegation.ts'),
      'utf8',
    )
    assert.match(src, /resolveTicketMemoryProjectKey/)
    assert.match(src, /ticket\.projectKey/)
  })

  if (failures > 0) {
    console.error(`\n${failures} failed`)
    process.exit(1)
  }
  console.log('\nall passed')
}

main()
