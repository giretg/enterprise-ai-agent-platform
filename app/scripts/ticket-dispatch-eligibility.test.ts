/**
 * Folyamat-agent-lépés ticket: assigneeId üres, agentId tartalmazza a felelőst.
 * A manuális dispatch (canStartTicketDispatch + dispatchBoardTicket) agentId-t használ.
 */
import assert from 'node:assert/strict'
import { canStartTicketDispatch } from '../src/lib/ticket-display'

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
  } catch (err) {
    console.error(`  ✗ ${name}`)
    throw err
  }
}

async function main() {
  console.log('ticket-dispatch-eligibility')

  await test('folyamat ticket: agentId nélkül assigneeType=agent nem indítható', () => {
    assert.equal(
      canStartTicketDispatch({
        state: 'ready',
        assigneeType: 'agent',
        agentId: null,
      }),
      false,
    )
  })

  await test('folyamat ticket: assigneeId null, agentId megvan → indítható', () => {
    assert.equal(
      canStartTicketDispatch({
        state: 'ready',
        assigneeType: 'agent',
        agentId: '00000000-0000-4000-8000-000000000001',
      }),
      true,
    )
  })

  await test('board ticket: assigneeId és agentId egyezik → indítható', () => {
    const agentId = '00000000-0000-4000-8000-000000000002'
    assert.equal(
      canStartTicketDispatch({
        state: 'ready',
        assigneeType: 'agent',
        agentId,
      }),
      true,
    )
  })

  console.log('ok')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
