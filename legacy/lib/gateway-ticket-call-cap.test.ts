import assert from 'node:assert/strict'
import {
  DEFAULT_MAX_CALLS_PER_TICKET,
  resolveMaxCallsPerTicket,
} from './gateway-ticket-call-cap'

assert.equal(resolveMaxCallsPerTicket({}), DEFAULT_MAX_CALLS_PER_TICKET)
assert.equal(
  resolveMaxCallsPerTicket({ env: { GATEWAY_MAX_CALLS_PER_TICKET: '45' } }),
  45,
)
assert.equal(resolveMaxCallsPerTicket({ platformMax: 60 }), 60)
assert.equal(
  resolveMaxCallsPerTicket({
    platformMax: 60,
    env: { GATEWAY_MAX_CALLS_PER_TICKET: '45' },
  }),
  60,
)
assert.equal(
  resolveMaxCallsPerTicket({ env: { GATEWAY_MAX_CALLS_PER_TICKET: 'nem-szam' } }),
  DEFAULT_MAX_CALLS_PER_TICKET,
)

console.log('gateway-ticket-call-cap tests passed')
