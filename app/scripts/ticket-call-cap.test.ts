import assert from 'node:assert/strict'
import {
  TICKET_CALL_CAP_ERROR_CODE,
  formatTicketCallCapUserMessage,
  isTicketCallCapErrorMessage,
  isTicketCallCapReason,
  readTicketCallCapMessageFromPayload,
  ticketCallCapExceededMessage,
  ticketCallCapReason,
} from '../src/lib/ticket-call-cap'

assert.equal(ticketCallCapReason(30, 30), 'ticket_call_cap:30/30')
assert.equal(isTicketCallCapReason('ticket_call_cap:30/30'), true)
assert.equal(isTicketCallCapReason('Call limit exceeded'), false)

const message = formatTicketCallCapUserMessage({ calls: 30, maxCalls: 30 })
assert.match(message, /Keret kimerült/)
assert.match(message, /NEM áll vissza holnap/)
assert.match(message, /GATEWAY_MAX_CALLS_PER_TICKET/)
assert.match(message, /új ticketet/)

assert.equal(
  isTicketCallCapErrorMessage('Gateway guardrail: ticket x reached 30 model calls'),
  true,
)
assert.equal(isTicketCallCapErrorMessage('temporary network timeout'), false)

assert.equal(
  readTicketCallCapMessageFromPayload({
    error: { code: TICKET_CALL_CAP_ERROR_CODE, message },
  }),
  message,
)
assert.equal(readTicketCallCapMessageFromPayload({ error: { code: 'OTHER' } }), null)

assert.equal(
  ticketCallCapExceededMessage({ calls: 30 }, { GATEWAY_MAX_CALLS_PER_TICKET: '30' }),
  formatTicketCallCapUserMessage({ calls: 30, maxCalls: 30 }),
)
assert.equal(
  ticketCallCapExceededMessage({ calls: 29 }, { GATEWAY_MAX_CALLS_PER_TICKET: '30' }),
  null,
)

console.log('ticket-call-cap helper tests passed')
