/** Gateway agent API ticket-tulajdonosi kapu regressziója. */
import assert from 'node:assert/strict'
import { POST } from '../src/app/api/v1/gateway/v1/chat/completions/route'
import { services } from '../src/domain'
import { repositories } from '../src/repositories/postgres'

const agent = {
  id: '11111111-1111-4111-8111-111111111111',
  tenantId: null,
  currentVersion: 1,
  modelConfig: { provider: 'stub', model: 'stub-model' },
}
const ownTicket = { id: '22222222-2222-4222-8222-222222222222', agentId: agent.id, tenantId: null }
const foreignTicketId = '33333333-3333-4333-8333-333333333333'
const missingTicketId = '44444444-4444-4444-8444-444444444444'
const audits: Array<{ action: string; actorId: string | null; outputRef: string | null }> = []
const ticketLookups: string[] = []
let gatewayCalls = 0

const agentRepo = repositories.agents as unknown as Record<string, unknown>
const ticketRepo = repositories.tickets as unknown as Record<string, unknown>
const auditRepo = repositories.audit as unknown as Record<string, unknown>
const gateway = services.gateway as unknown as Record<string, unknown>

agentRepo.authenticateApiKey = async () => ({ agentId: agent.id, scopes: ['tool:invoke'] })
agentRepo.findById = async () => agent
ticketRepo.findById = async (ticketId: string) => {
  ticketLookups.push(ticketId)
  return ticketId === ownTicket.id
    ? ownTicket
    : ticketId === foreignTicketId
      ? { ...ownTicket, agentId: '55555555-5555-4555-8555-555555555555' }
      : null
}
auditRepo.append = async (entry: (typeof audits)[number]) => {
  audits.push(entry)
  return entry
}
gateway.call = async () => {
  gatewayCalls += 1
  return { content: 'ok', model: 'stub-model', usage: { promptTokens: 1, completionTokens: 1 } }
}

function request(ticketId?: string): Request {
  return new Request('http://localhost/api/v1/gateway/v1/chat/completions', {
    method: 'POST',
    headers: {
      authorization: 'Bearer test-key',
      'content-type': 'application/json',
      ...(ticketId ? { 'x-ticket-id': ticketId } : {}),
    },
    body: JSON.stringify({ model: 'stub-model', messages: [{ role: 'user', content: 'teszt' }] }),
  })
}

async function main() {
  for (const ticketId of [foreignTicketId, missingTicketId, 'nem-uuid']) {
    const response = await POST(request(ticketId))
    assert.equal(response.status, 403, `${ticketId}: idegen/hiányzó ticket fail-closed`)
  }
  assert.equal(gatewayCalls, 0, 'elutasított ticket nem indíthat modellhívást')
  assert.deepEqual(ticketLookups, [foreignTicketId, missingTicketId], 'hibás UUID nem jut el az adatbázisig')
  assert.deepEqual(
    audits.map((entry) => [entry.action, entry.actorId, entry.outputRef]),
    [
      ['model.call.denied', agent.id, 'agent_api_context_not_accessible'],
      ['model.call.denied', agent.id, 'agent_api_context_not_accessible'],
      ['model.call.denied', agent.id, 'agent_api_context_not_accessible'],
    ],
  )

  const ownResponse = await POST(request(ownTicket.id))
  assert.equal(ownResponse.status, 200, 'saját ticket eléri a gatewayt')
  assert.equal(gatewayCalls, 1)
  console.log('gateway ticket-context route tests passed')
}

void main()
