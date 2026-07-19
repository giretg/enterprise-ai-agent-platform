/**
 * Regression: board ticket form + fájlcsatolás → deferDispatch után
 * `dispatchBoardTicket({ ticketId })` hívás. A régi ticketIdSchema `{ id }`-t várt,
 * ezért Zod: expected string, received undefined @ path ["id"].
 */
import assert from 'node:assert/strict'
import {
  dispatchBoardTicketSchema,
  ticketIdSchema,
} from '../src/lib/validators/actions'

const TICKET_ID = '00000000-0000-4000-8000-000000000001'

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
  console.log('dispatch-board-ticket-schema')

  await test('form payload { ticketId } átmegy a dispatch sémán', () => {
    const parsed = dispatchBoardTicketSchema.parse({ ticketId: TICKET_ID })
    assert.equal(parsed.ticketId, TICKET_ID)
  })

  await test('régi ticketIdSchema elutasítja a form payloadot (bug repro)', () => {
    const result = ticketIdSchema.safeParse({ ticketId: TICKET_ID })
    assert.equal(result.success, false)
    if (!result.success) {
      assert.equal(result.error.issues[0]?.path[0], 'id')
      assert.match(result.error.message, /expected string, received undefined/)
    }
  })

  await test('{ id } nem fogadható el a dispatch sémában', () => {
    const result = dispatchBoardTicketSchema.safeParse({ id: TICKET_ID })
    assert.equal(result.success, false)
  })

  console.log('ok')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
